import type { ModelClient } from '@migor/agentia';
import type { AssetSet } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import { type GateResult, gate } from '../evals/gate.js';
import { runSuite, type SuiteTuning } from '../evals/run.js';
import { HOLDOUT_GATE_OPTIONS } from '../evals/split.js';
import type { EvalReport } from '../evals/types.js';
import type { CaseRunner } from '../run/case-runner.js';
import { withStage } from './stage.js';
import type { HoldoutResult, Proposal, StageHook } from './types.js';
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
  /** 与 `verifyProposal` 同一个钩子：留出集跑的是同一个候选，必须同样搬上台 */
  readonly stage?: StageHook | undefined;
  readonly runner?: CaseRunner | undefined;
  /** 留出集视图（由 `splitReport(report).holdout` 得来） */
  readonly baseline: EvalReport;
  readonly cases: readonly string[];
  readonly agent?: string | undefined;
  readonly client?: ModelClient | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * 低于这个条数时，成本/token 判据的结论不可靠。
 *
 * 一个实测到的形状：远程留出集只有 1 条用例时，候选几乎必被
 * `token_regression` 拒掉 —— 不是因为改动真的更贵，而是**单条用例的 token 逐次波动
 * 常常就超过 10% 的阈值**。判据本身没错（没变好还更贵就该拒），错的是把它当成
 * 「这条改动更差」的结论。
 *
 * 处理方式是**加一句置信度说明，不放宽阈值**：放宽会在真有大样本时也该拦的时候放过，
 * 而假阳性说清楚之后，人能自己去补用例（那是唯一真正的解法）。
 */
const SMALL_SAMPLE = 3;

export function noteSmallSample(g: GateResult, n: number): GateResult {
  if (n >= SMALL_SAMPLE) return g;
  if (g.code !== 'token_regression' && g.code !== 'cost_regression') return g;
  return {
    ...g,
    reason:
      `${g.reason}｜留出集只有 ${n} 条：这个规模上 token/成本的逐次波动常常大于阈值本身，` +
      `这条结论置信度低（补到 ≥${SMALL_SAMPLE} 条再看才有意义）`,
  };
}

export async function validateHoldout(opts: HoldoutOptions): Promise<HoldoutResult> {
  if (opts.cases.length === 0) {
    throw new HarnessError('rsi.no_signal', '留出集验证需要至少一条 holdout 用例');
  }
  const patched = applyPatch(opts.assets, opts.proposal.patch);
  const candidate = await withStage(opts.stage, { proposal: opts.proposal, patched }, () =>
    runSuite({
      config: opts.config,
      assets: patched,
      ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
      ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
      ...(opts.client !== undefined ? { client: opts.client } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
      ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
      ...(opts.repeat !== undefined ? { repeat: opts.repeat } : {}),
      only: opts.cases,
    }),
  );
  return {
    baseline: opts.baseline,
    candidate,
    gate: noteSmallSample(gate(opts.baseline, candidate, HOLDOUT_GATE_OPTIONS), opts.cases.length),
  };
}
