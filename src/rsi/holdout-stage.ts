import { pickTuning } from '../evals/run.js';
import { subsetReport } from '../evals/split.js';
import type { EvalReport } from '../evals/types.js';
import type { CycleOptions } from './cycle-options.js';
import { validateHoldout } from './holdout.js';
import { appendHoldoutUse, holdoutProgress, pickHoldoutBatch } from './holdout-batch.js';
import type { CycleReport, HoldoutResult, Proposal, VerifyOutcome } from './types.js';

/**
 * 留出集验证 —— 只在赢家身上跑一次。
 *
 * 跑完即使发现过拟合，也**不回头试第二候选**：否则留出集就成了第二个调参集，
 * 这一整层验证的意义会归零。「一次」是**每一批**一次（见 `holdout-batch.ts`）：
 * 留出集不变而轮次无限时，30 轮 × 每轮 5% 的累积假阳性约 78% —— 每一轮的门都
 * 「合法地」放过一点噪声。
 *
 * 单独成模块的理由与 `alternate.ts` 相同：它是「候选选定之后的那一道关」，有自己
 * 的失败分支（预算不够 / 批次用完 / 验证崩了），而每一种都对应一句不同的人话。
 * 埋在编排里既撑破文件行数上限，也只能靠端到端才验得到。
 */
export interface HoldoutStageOptions {
  /** 原样透传（`stage` / `runner` / `agent` / `client` / `signal` / 调优参数） */
  readonly opts: CycleOptions;
  readonly cycleId: string;
  readonly winner: VerifyOutcome;
  /** 整份留出集基线（批次收窄在函数内部做） */
  readonly baseline: EvalReport;
  readonly budgetExceeded: boolean;
  /** 预算读数的说明（只在「没钱做留出集」时用） */
  readonly describeBudget: () => string;
  readonly charge: (usd: number | undefined, known: boolean, tokens?: number) => Promise<void>;
}

export interface HoldoutStageResult {
  /**
   * 通过留出集的赢家（已带上 `holdout` 读数）；`undefined` = 被这一关否掉。
   *
   * 否掉的理由在 `rejection` 里 —— 调用方要把它写进 `rejected`，否则「明明选了候选
   * 却没采纳」在记录里没有原因。
   */
  readonly winner?: VerifyOutcome | undefined;
  readonly rejection?: { readonly proposal: Proposal; readonly reason: string } | undefined;
  readonly batch?: CycleReport['holdoutBatch'] | undefined;
  /** 因为预算不够而没收尾 —— 调用方据此把 `budget.stopped` 标上 */
  readonly budgetStopped: boolean;
}

export async function runHoldoutStage(o: HoldoutStageOptions): Promise<HoldoutStageResult> {
  const { opts, winner } = o;
  const reject = (reason: string): HoldoutStageResult => ({
    rejection: { proposal: winner.proposal, reason },
    budgetStopped: false,
  });

  if (o.budgetExceeded) {
    return {
      ...reject(`train 已选出候选，但预算不足以做留出集验证（${o.describeBudget()}），拒绝采纳`),
      budgetStopped: true,
    };
  }

  const progress = holdoutProgress(opts.config, o.baseline.cases);
  const pick = pickHoldoutBatch(progress);
  if (!pick.ok) {
    // 用完就停，不"退回第一批发重新用"：同一批第二次被用来验候选时，
    // 它已经被候选挑选过一遍，事实上已经是第二个 train
    return reject(`留出集不可用：${pick.reason}`);
  }

  let holdout: HoldoutResult;
  try {
    holdout = await validateHoldout({
      config: opts.config,
      assets: opts.assets,
      proposal: winner.proposal,
      ...(opts.stage !== undefined ? { stage: opts.stage } : {}),
      ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
      // 基线跟着批次一起收窄：候选只跑这一批，拿整份留出集当基线会被门判成
      // 「用例集不一致」—— 那不是判定标准变了，是两边比的不是同一批
      baseline: subsetReport(o.baseline, pick.batch.cases),
      cases: pick.batch.cases,
      ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
      ...(opts.client !== undefined ? { client: opts.client } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...pickTuning(opts),
    });
  } catch (e) {
    // 验证本身崩掉（补丁过期、装配错）**不消耗批次**：那不是一次观测。
    // 这条缝的代价是「重试一次坏掉的验证」，收益是「配置错误不会烧掉一整批留出集」
    return reject(`留出集验证失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  await o.charge(holdout.candidate.costUsd, holdout.candidate.costKnown, holdout.candidate.tokens);

  // 消耗记账：**与结果无关**。通过也消耗、否决也消耗 —— 只在"通过"时记账，
  // 等于把没通过的尝试变成免费的重复抽样，而那正是假阳性的来源。
  //
  // dry-run 也消耗：验一眼就是看一眼，资产没动不代表数据没被看过。
  appendHoldoutUse(opts.config, {
    at: Date.now(),
    cycleId: o.cycleId,
    proposalId: winner.proposal.id,
    phase: pick.batch.phase,
    cases: pick.batch.cases,
    passed: holdout.gate.ok,
    reason: holdout.gate.reason,
  });
  return {
    winner: { ...winner, holdout },
    budgetStopped: false,
    batch: {
      phase: pick.batch.phase,
      cases: pick.batch.cases,
      priorUses: pick.batch.used,
      enforced: progress.enforced,
    },
  };
}
