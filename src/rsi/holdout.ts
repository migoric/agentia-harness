import type { ModelClient } from '@migor/agentia';
import type { AssetSet } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import { gate } from '../evals/gate.js';
import { runSuite, type SuiteTuning } from '../evals/run.js';
import { HOLDOUT_GATE_OPTIONS } from '../evals/split.js';
import type { EvalReport } from '../evals/types.js';
import type { HoldoutResult, Proposal } from './types.js';
import { applyPatch } from './verify.js';

/**
 * 留出集验证 —— 候选在 train 上**已经被选中之后**才跑，且只跑一次。
 *
 * 三条纪律，缺一条留出集就退化成第二份 train：
 * 1. 不参与排序：即使别的候选在留出集上更好，也不许回头换人（那是在拟合留出集）。
 * 2. 不复用 train 的门阈值：留出集用默认硬门，放宽过的阈值只属于调参阶段。
 * 3. 与采纳绑定：结果写进 `VerifyOutcome.holdout`，`isWorthAccepting` 与 `acceptProposal`
 *    都认它，调用方没法「验了但不当回事」。
 */
export interface HoldoutOptions extends SuiteTuning {
  readonly config: HarnessConfig;
  readonly assets: AssetSet;
  readonly proposal: Proposal;
  /** 留出集视图（由 `splitReport(report).holdout` 得来） */
  readonly baseline: EvalReport;
  readonly cases: readonly string[];
  readonly agent?: string | undefined;
  readonly client?: ModelClient | undefined;
  readonly signal?: AbortSignal | undefined;
}

export async function validateHoldout(opts: HoldoutOptions): Promise<HoldoutResult> {
  if (opts.cases.length === 0) {
    throw new HarnessError('rsi.no_signal', '留出集验证需要至少一条 holdout 用例');
  }
  const patched = applyPatch(opts.assets, opts.proposal.patch);
  const candidate = await runSuite({
    config: opts.config,
    assets: patched,
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.client !== undefined ? { client: opts.client } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
    only: opts.cases,
  });
  return {
    baseline: opts.baseline,
    candidate,
    gate: gate(opts.baseline, candidate, HOLDOUT_GATE_OPTIONS),
  };
}
