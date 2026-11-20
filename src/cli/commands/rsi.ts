import { resolve } from 'node:path';
import { HarnessError } from '../../errors.js';
import { runSuite } from '../../evals/run.js';
import { acceptProposal, readJournal, revertLast } from '../../rsi/accept.js';
import { runCycle } from '../../rsi/loop.js';
import { readProposal, writeProposal } from '../../rsi/manual.js';
import { LlmProposer } from '../../rsi/propose.js';
import { isWorthAccepting, verifyProposal } from '../../rsi/verify.js';
import { boolFlag, numFlag, strFlag } from '../args.js';
import { assetsOf, type CliContext } from '../context.js';
import { json, say, warn } from '../output.js';
import { tuningOf } from './run.js';

/** `harness rsi [revert|status|propose|accept]` —— 闭环的入口 */
export async function rsiCommand(
  ctx: CliContext,
  sub: string | undefined,
  argsId?: string,
): Promise<number> {
  if (sub === 'revert') return revert(ctx, argsId);
  if (sub === 'status') return status(ctx);
  if (sub === 'propose') return proposeFrom(ctx);
  if (sub === 'accept') return acceptFrom(ctx);
  if (sub !== undefined) {
    throw new HarnessError(
      'config.invalid',
      `rsi 没有子命令 "${sub}"（可用: revert, status, propose, accept）`,
    );
  }
  return cycle(ctx);
}

function fromFlag(ctx: CliContext, sub: string): string {
  const p = strFlag(ctx.flags, 'from');
  if (p === undefined) {
    throw new HarnessError('config.invalid', `rsi ${sub} 需要 --from <提案.json>`);
  }
  return resolve(ctx.root, p);
}

/** 登记一份手写的 L1 提案。只校验与落盘，不调模型、不改源文件 */
function proposeFrom(ctx: CliContext): number {
  const proposal = readProposal(fromFlag(ctx, 'propose'));
  const path = writeProposal(ctx.config, proposal);
  if (boolFlag(ctx.flags, 'json')) json({ id: proposal.id, path });
  else say(`已登记手写提案 ${proposal.id} → ${path}`);
  return 0;
}

/**
 * 采纳手写提案。**同样跑完整的两遍评测 + 回归门** —— 来源可以变，门不能变。
 *
 * 没有 `--yes` 之类的跳门开关是刻意的：`acceptManually` 作为库 API 存在，但把它
 * 暴露成 CLI 选项，等于给「评测门在 RSI 写权限之外」这条不变量开后门。
 */
async function acceptFrom(ctx: CliContext): Promise<number> {
  const proposal = readProposal(fromFlag(ctx, 'accept'));
  const assets = assetsOf(ctx);
  const shared = {
    config: ctx.config,
    assets,
    ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
    ...tuningOf(ctx),
  };
  const baseline = await runSuite(shared);
  const outcome = await verifyProposal({ ...shared, baseline, proposal });
  if (!outcome.gate.ok) {
    warn(`验证门未通过，拒绝采纳 ${proposal.id}：${outcome.gate.reason}`);
    return 1;
  }
  // 与自动 RSI 同一道「必须真的变好」检查 —— 手写提案不许靠 no-op 改动混进 git 历史
  if (!isWorthAccepting(outcome)) {
    warn(`提案 ${proposal.id} 没有任何用例变好（仅"没变差"），拒绝采纳`);
    return 1;
  }
  if (boolFlag(ctx.flags, 'dry-run')) {
    say(`dry-run：${proposal.id} 过了门，未落盘（${outcome.gate.reason}）`);
    return 0;
  }
  const entry = acceptProposal(ctx.config, assets, outcome);
  say(`已采纳 ${entry.proposalId} → ${entry.target}（${entry.reason}）`);
  return 0;
}

async function cycle(ctx: CliContext): Promise<number> {
  const maxModes = numFlag(ctx.flags, 'max-modes');
  const maxVerify = numFlag(ctx.flags, 'max-verify');
  const dryRun = boolFlag(ctx.flags, 'dry-run');
  // `--max-cost` 覆盖配置：CI 里想临时收紧预算不必改文件
  const maxCost = numFlag(ctx.flags, 'max-cost') ?? ctx.config.maxCostUsd;

  const report = await runCycle({
    config: ctx.config,
    assets: assetsOf(ctx),
    ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
    proposer: new LlmProposer(ctx.config, {
      ...(maxModes !== undefined ? { maxModes } : {}),
      // 提不出方案的模式要**说出来**：静默跳过会让「这轮为什么没改」无从解释
      onSkip: (modeId, reason) => warn(`  跳过 ${modeId}: ${reason}`),
    }),
    ...(maxVerify !== undefined ? { maxVerify } : {}),
    ...(maxCost !== undefined ? { maxCostUsd: maxCost } : {}),
    ...(dryRun ? { dryRun: true } : {}),
    ...tuningOf(ctx),
  });

  if (boolFlag(ctx.flags, 'json')) {
    json(report);
    return report.accepted.length > 0 ? 0 : 1;
  }

  say(`轮次 ${report.cycleId}（记录 ${report.path}）`);
  if (report.modes.length === 0) {
    say('没有失败样本，无需改进');
    return 0;
  }
  say(`失败模式 ${report.modes.length} 个：`);
  for (const m of report.modes) {
    const target = m.targets[0]?.target ?? '（无资产命中）';
    say(`  [${m.kind}] ${m.signature}  ×${m.count} → 偏向改 ${target}`);
  }
  say(
    report.costKnown
      ? `\n本轮成本 $${report.costUsd.toFixed(4)}`
      : `\n本轮成本未知（模型不在价格表内），token 只能当代理`,
  );
  if (report.budget !== undefined) {
    const b = report.budget;
    say(
      `预算 $${b.spentUsd.toFixed(4)} / $${b.limitUsd.toFixed(4)}` +
        (b.stopped ? ' —— 已超限，本轮提前收工' : ''),
    );
  }
  say(`\n提出 ${report.proposals.length} 个提案，验证 ${report.verified.length} 个：`);
  for (const v of report.verified) {
    say(
      `  ${v.gate.ok ? 'PASS ' : 'BLOCK'}  ${v.proposal.id} → ${v.proposal.patch.target}：${v.gate.reason}`,
    );
  }
  if (report.accepted.length > 0) {
    const suffix = report.dryRun ? '（dry-run，未落盘）' : '';
    say(
      `\n采纳 ${report.accepted.length} 个${suffix}：${report.accepted.map((p) => p.id).join(', ')}`,
    );
  }
  for (const r of report.rejected) say(`  拒绝 ${r.proposal.id}：${r.reason}`);
  return report.accepted.length > 0 ? 0 : 1;
}

function revert(ctx: CliContext, id: string | undefined): number {
  const r = revertLast(ctx.config, id);
  say(`已回滚 ${r.entry.proposalId}：${r.entry.target}`);
  return 0;
}

function status(ctx: CliContext): number {
  const entries = readJournal(ctx.config);
  if (entries.length === 0) {
    say('还没有任何采纳记录');
    return 0;
  }
  for (const e of entries) {
    const when = new Date(e.at).toISOString().replace('T', ' ').slice(0, 19);
    say(`${when}  ${e.status.padEnd(8)}  ${e.proposalId}  ${e.target}`);
    say(`            ${e.reason}`);
  }
  return 0;
}
