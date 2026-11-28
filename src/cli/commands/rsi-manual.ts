/**
 * 手写提案、手写采纳、回滚 —— 三条**不由模型驱动**的入口。
 *
 * 从 `rsi.ts` 拆出来：那个文件负责「一轮怎么跑」（提案 → 验证 → 门 → 留出集），
 * 而这三条是「人直接干预」。400 行守卫只是把这件事说出来了。
 *
 * 一条不变量必须跟着搬过来：**手写提案也过完整的两遍评测 + 回归门**。来源可以变，门不能变。
 */

import { resolve } from 'node:path';
import type { ModelClient } from '@migor/agentia';
import { describeError, HarnessError } from '../../errors.js';
import { runSuite } from '../../evals/run.js';
import { splitReport } from '../../evals/split.js';
import { acceptProposal, revertLast } from '../../rsi/accept.js';
import { Budget } from '../../rsi/budget.js';
import { writeCycle } from '../../rsi/cycles.js';
import { validateHoldout } from '../../rsi/holdout.js';
import { appendHoldoutUse, holdoutProgress, pickHoldoutBatch } from '../../rsi/holdout-batch.js';
import { makeCycleId } from '../../rsi/loop.js';
import { readProposal, writeProposal } from '../../rsi/manual.js';
import type { CycleReport, HoldoutResult } from '../../rsi/types.js';
import { isWorthAccepting, verifyProposal } from '../../rsi/verify.js';
import { boolFlag, strFlag } from '../args.js';
import { assetsOf, type CliContext } from '../context.js';
import { json, say, warn } from '../output.js';
import type { RemoteStage } from '../remote-stage.js';
import { tuningOf } from './run.js';

function fromFlag(ctx: CliContext, sub: string): string {
  const p = strFlag(ctx.flags, 'from');
  if (p === undefined) {
    throw new HarnessError('config.invalid', `rsi ${sub} 需要 --from <提案.json>`);
  }
  return resolve(ctx.root, p);
}

/** 登记一份手写的 L1 提案。只校验与落盘，不调模型、不改源文件 */
export function proposeFrom(ctx: CliContext): number {
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
export async function acceptFrom(
  ctx: CliContext,
  client?: ModelClient,
  remote?: RemoteStage,
): Promise<number> {
  const proposal = readProposal(fromFlag(ctx, 'accept'));
  // 轮次 id 先生成：留出集消耗账要用它，而记账发生在 `writeCycle` **之前** ——
  // 反过来的话，写记录失败会让这一批在账上"看起来没用过"，下一轮白送一次复用
  const cycleId = makeCycleId();
  const assets = assetsOf(ctx);
  const shared = {
    config: ctx.config,
    assets,
    ...(remote !== undefined ? { stage: remote.stage, runner: remote.runner } : {}),
    ...(client !== undefined ? { client } : {}),
    ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
    ...tuningOf(ctx),
  };
  const fullBaseline = await runSuite(shared);
  const views = splitReport(fullBaseline);
  let outcome = await verifyProposal({
    ...shared,
    baseline: views.train,
    proposal,
    only: views.trainCases,
  });
  if (!outcome.gate.ok) {
    warn(`train 验证门未通过，拒绝采纳 ${proposal.id}：${outcome.gate.reason}`);
    return 1;
  }
  // 与自动 RSI 同一道「必须真的变好」检查 —— 手写提案不许靠 no-op 改动混进 git 历史
  if (!isWorthAccepting(outcome)) {
    warn(`提案 ${proposal.id} 没有任何用例变好（仅"没变差"），拒绝采纳`);
    return 1;
  }
  let holdoutBatch: CycleReport['holdoutBatch'];
  if (views.holdout !== undefined) {
    // 与自动 RSI **同一条**分批规则：手写提案不是绕开消耗账的后门。
    // 否则「自动路径的留出集用完了」只对自动路径成立，人对同一条门就免费了
    const progress = holdoutProgress(ctx.config, views.holdout.cases);
    const pick = pickHoldoutBatch(progress);
    if (!pick.ok) {
      warn(`留出集不可用，拒绝采纳 ${proposal.id}：${pick.reason}`);
      return 1;
    }
    let holdout: HoldoutResult | undefined;
    try {
      holdout = await validateHoldout({
        ...shared,
        proposal,
        baseline: views.holdout,
        cases: pick.batch.cases,
      });
    } catch (e) {
      // 与 runCycle 同口径：验证本身出问题记为「拒绝」，不让命令以异常退出
      warn(
        `留出集验证失败，拒绝采纳 ${proposal.id}：${e instanceof Error ? e.message : String(e)}`,
      );
      return 1;
    }
    outcome = { ...outcome, holdout };
    if (!isWorthAccepting(outcome)) {
      warn(`留出集未通过，拒绝采纳 ${proposal.id}：${holdout.gate.reason}`);
      return 1;
    }
    // 消耗与结果无关：这一次观测已经发生，即使结论是"不通过"
    appendHoldoutUse(ctx.config, {
      at: Date.now(),
      cycleId,
      proposalId: proposal.id,
      phase: pick.batch.phase,
      cases: pick.batch.cases,
      passed: holdout.gate.ok,
      reason: holdout.gate.reason,
    });
    holdoutBatch = {
      phase: pick.batch.phase,
      cases: pick.batch.cases,
      priorUses: pick.batch.used,
      enforced: progress.enforced,
    };
    say(`留出集验证通过：${holdout.gate.reason}`);
  }
  const dryRun = boolFlag(ctx.flags, 'dry-run');
  // 成本口径与自动 RSI 一致：基线 + 候选（+ 留出集候选）。走同一个 `Budget` 而不是
  // 在这里再写一遍累加 —— 「花费怎么算」只能有一处定义，否则两条路径迟早对不上
  const budget = new Budget();
  budget.charge(fullBaseline.costUsd, fullBaseline.costKnown, fullBaseline.tokens);
  budget.charge(outcome.candidate.costUsd, outcome.candidate.costKnown, outcome.candidate.tokens);
  if (outcome.holdout !== undefined) {
    budget.charge(
      outcome.holdout.candidate.costUsd,
      outcome.holdout.candidate.costKnown,
      outcome.holdout.candidate.tokens,
    );
  }
  if (dryRun) {
    say(`dry-run：${proposal.id} 过了门，未落盘（${outcome.gate.reason}）`);
  } else {
    const { entry } = acceptProposal(ctx.config, assets, outcome);
    say(`已采纳 ${entry.proposalId} → ${entry.target}（${entry.reason}）`);
    // 本地落盘完成之后才推远端：反过来的话「推送成功、采纳失败」会让远端跑着
    // 一个账本里没有的版本。推送失败会抛出来 —— 本地已采纳而远端是旧的，下一轮
    // 预检会报漂移，能修（--sync-remote）
    if (remote !== undefined) {
      await remote.push(assetsOf(ctx));
      say('已推到远端并重载');
    }
  }
  // 手工采纳也要落一份轮次记录：`rsi regress` 的基准取自 cycle JSON 的 candidate，
  // 没有记录就只能报「找不到基准」—— 而那意味着手工采纳的改动永远监测不到
  try {
    writeCycle(
      ctx.config,
      {
        modes: [],
        proposals: [proposal],
        verified: [outcome],
        accepted: [proposal],
        rejected: [],
        baseline: fullBaseline,
        dryRun,
        costUsd: budget.spentUsd,
        costKnown: budget.costKnown,
        tokens: budget.spentTokens,
        budget: undefined,
        ...(holdoutBatch === undefined ? {} : { holdoutBatch }),
      },
      cycleId,
    );
  } catch (e) {
    // 采纳已经落盘了，记录写失败不能反过来把这条命令判死 —— 但要喊出来：
    // 缺这条记录等于这条改动以后没法做回归监测
    warn(`轮次记录写入失败（采纳已生效，但 rsi regress 将找不到基准）：${describeError(e)}`);
  }
  return 0;
}

export function revert(ctx: CliContext, id: string | undefined): number {
  const r = revertLast(ctx.config, id);
  say(`已回滚 ${r.entry.proposalId}：${r.entry.target}`);
  // 回滚只改本地文件。配了 remote 的工程如果不说这一句，远端会继续跑被回滚掉的版本，
  // 而本地账本写着「已回滚」—— 两个真相，且都很容易让人相信
  if (ctx.config.remote !== undefined) {
    warn(
      '远端没有跟着回滚：它还在跑回滚前的提示词。要让它同步，先确认「本地这份就是要部署的」，' +
        '再跑 `rsi --remote <url> --sync-remote`（会写文件 + 重载）。',
    );
  }
  return 0;
}
