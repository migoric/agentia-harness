import type { ModelClient } from '@migor/agentia';
import { describeError } from '../../errors.js';
import { readJournal, revertLast } from '../../rsi/accept.js';
import { readLedger, revertNote } from '../../rsi/ledger.js';
import { checkRegression } from '../../rsi/regress.js';
import { boolFlag } from '../args.js';
import { assetsOf, type CliContext } from '../context.js';
import { json, say, warn } from '../output.js';
import { tuningOf } from './run.js';

/**
 * `rsi` 的**只读**子命令：`status` / `ledger` / `regress`。
 *
 * 与 `rsi.ts`（提案 → 验证 → 采纳/回滚，会动资产）分开放，是一条刻意的边界：
 * 「看历史」和「改资产」混在一个模块里时，读路径迟早会顺手写点什么。唯一的例外是
 * `regress --revert`，但那也是显式开关，且仍然走 `revertLast` 的指纹校验。
 */

/**
 * `rsi regress [--revert]` —— 采纳之后，当初通过的那些用例现在还通过吗。
 *
 * 默认**只报告不动手**：检测到回归返回退出码 1，回滚要显式 `--revert`。
 * 这不是保守 —— 自动回滚会改资产，而「改资产」是这套系统里唯一不可无声发生的事。
 */
export async function regress(ctx: CliContext, client?: ModelClient): Promise<number> {
  const asJson = boolFlag(ctx.flags, 'json');
  const report = await checkRegression({
    config: ctx.config,
    assets: assetsOf(ctx),
    ...(client !== undefined ? { client } : {}),
    ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
    ...tuningOf(ctx),
  });
  const assetsChanged = report.assetsNow !== report.assetsAtAccept;
  const regressed = report.regressed.length > 0;
  // 用例被删/改名同样「监测不到」—— 不能因为「找不到失败」就报绿
  const bad = regressed || report.missingCases.length > 0;

  // 回滚**在输出之后**做（但错误要捕获）：资产被人手改过时 revertLast 会拒绝，
  // 而那正是最需要看回归报告的场景 —— 先回滚再打印会把报告整个吞掉
  let reverted: string | undefined;
  let revertError: string | undefined;
  if (regressed && boolFlag(ctx.flags, 'revert')) {
    try {
      reverted = revertLast(ctx.config, report.proposalId).entry.proposalId;
    } catch (e) {
      revertError = describeError(e);
    }
  }

  if (asJson) {
    json({
      proposalId: report.proposalId,
      cycleId: report.cycleId,
      expected: report.expected,
      actual: report.actual,
      regressed: report.regressed,
      missingCases: report.missingCases,
      assetsAtAccept: report.assetsAtAccept,
      assetsNow: report.assetsNow,
      passRate: report.current.passRate,
      ...(reverted === undefined ? {} : { reverted }),
      ...(revertError === undefined ? {} : { revertError }),
    });
  } else {
    say(
      `监测 ${report.proposalId}（轮次 ${report.cycleId}）：` +
        `采纳时通过 ${report.expected.length} 条，现在通过 ${report.actual.length} 条`,
    );
    // 资产被手改过时，退步未必是这次采纳造成的 —— 报出来，别让人顺着错误的线索查
    if (assetsChanged) {
      warn('采纳之后资产又被改过：这次退步可能来自那次改动，不是这次采纳');
    }
    for (const r of report.regressed) {
      say(`  回归 ${r.case}：${r.failures.join('；')}`);
    }
    for (const name of report.missingCases) {
      say(`  缺失 ${name}：采纳时通过，但现在没有这条用例（被删或改名）`);
    }
    if (!bad) say('没有回归');
    else if (reverted !== undefined) {
      say(`已回滚 ${reverted} —— 回滚依据是 journal 里的 before`);
    } else if (revertError !== undefined) {
      warn(`回滚失败：${revertError}（回归仍然存在，请手动处理）`);
    } else {
      say('加 --revert 才会自动回滚');
    }
  }

  // 回滚失败是「动作没做成」（2）；回归/缺失是「检查没通过」（1）
  return revertError !== undefined ? 2 : bad ? 1 : 0;
}

/**
 * `rsi ledger` —— 预测 vs 门结论。
 *
 * 刻意叫「门结论」而不是「逐条对账」：`prediction` 是一句话（「a 应转为通过」），
 * 验证给出的是一组用例的门结果，两者只能整体对照，没有一条一条的对齐关系。
 * 假装能逐条对账，读的人会以为账本能算出「预测命中率」那种精确数字。
 */
export function ledger(ctx: CliContext): number {
  const entries = readLedger(ctx.config);
  if (boolFlag(ctx.flags, 'json')) {
    json(entries);
    return 0;
  }
  if (entries.length === 0) {
    say('还没有采纳记录');
    return 0;
  }
  for (const e of entries) {
    const when = new Date(e.at).toISOString().replace('T', ' ').slice(0, 19);
    // 回滚在 journal 里也记成 `status: rejected`（复用同一个 proposalId）；dry-run 的
    // 「本会采纳」在 journal 里根本没有记录。两种都得靠 outcome/dryRun 标出来，
    // 否则账本会给出与事实相反的审计结论
    const label = e.outcome === 'reverted' ? 'reverted' : e.dryRun ? 'dry-run' : e.status;
    say(`${when}  ${label.padEnd(8)}  ${e.proposalId} → ${e.target}  [${e.outcome}]`);
    if (e.prediction !== undefined) say(`            预测：${e.prediction}`);
    // 回滚条目的门结论是**采纳当时**写下的，标成「结果」会让人以为验证判定它失败过
    if (e.gateReason !== undefined) {
      say(`            ${e.outcome === 'reverted' ? '采纳时' : '结果'}：${e.gateReason}`);
    }
    if (e.holdoutReason !== undefined) say(`            留出：${e.holdoutReason}`);
    if (e.outcome === 'reverted') {
      say(`            说明：${revertNote(e.journalReason) ?? '无记录'}`);
    } else if (e.dryRun) {
      say(`            说明：${e.journalReason ?? 'dry-run，没有落盘'}`);
    }
    if (e.cycleId !== undefined) say(`            轮次：${e.cycleId}`);
  }
  return 0;
}

/** `rsi status` —— journal 原样（含回滚记录与当初写下的清单） */
export function status(ctx: CliContext): number {
  const entries = readJournal(ctx.config);
  if (boolFlag(ctx.flags, 'json')) {
    json(entries);
    return 0;
  }
  if (entries.length === 0) {
    say('还没有任何采纳记录');
    return 0;
  }
  for (const e of entries) {
    const when = new Date(e.at).toISOString().replace('T', ' ').slice(0, 19);
    say(`${when}  ${e.status.padEnd(8)}  ${e.proposalId}  ${e.target}`);
    say(`            ${e.reason}`);
    if (e.manifest !== undefined) {
      say(`            假设：${e.manifest.hypothesis}`);
      say(`            预测：${e.manifest.prediction}`);
      say(`            风险：${e.manifest.risk}`);
      say(`            证据：${e.manifest.evidence.join(', ') || '无'}`);
    }
  }
  return 0;
}
