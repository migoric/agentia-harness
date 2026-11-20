import type { GateResult } from '../evals/gate.js';
import type { EvalReport } from '../evals/types.js';

/**
 * Harness —— RSI 的数据模型。
 *
 * 五步：采集（collect）→ 归因（attribute）→ 提案（propose）→ 验证（verify）→
 * 采纳/回滚（accept/revert）。每一步都有一个**显式的数据结构**，因为 RSI 最怕的
 * 是「不可审计」：调了 20 轮之后没人知道第 7 轮凭什么采纳了那条改动。
 *
 * 所有中间产物都落 `.workspace/rsi/`（journal + proposals），任何一轮都能重放。
 */
export type FailureKind =
  /** 正常收尾但结果不对 */
  | 'wrong_answer'
  /** 该调的工具没调，或顺序错 */
  | 'tool_misuse'
  /** 工具抛错 */
  | 'tool_error'
  /** 循环失控 / 超步数 */
  | 'loop'
  /** 超 token 预算 */
  | 'budget'
  /** 非正常收尾（max_tokens / aborted 等） */
  | 'stop_abnormal'
  | 'unknown';

/** 一条失败样本：来自某个 eval case 的一次真实运行 */
export interface FailureSample {
  readonly case: string;
  readonly failures: readonly string[];
  readonly stopReason: string;
  readonly tokens: number;
  readonly iterations: number;
  readonly excerpt: string;
}

/** 聚类后的失败模式 —— 提案的输入单位 */
export interface FailureMode {
  /** 稳定 id：`<kind>:<signature 的短指纹>` */
  readonly id: string;
  readonly kind: FailureKind;
  /** 归一化后的失败描述（同类失败的共同形态） */
  readonly signature: string;
  readonly count: number;
  readonly cases: readonly string[];
  readonly samples: readonly FailureSample[];
}

/** 一次资产改写：只允许改**正文**（frontmatter 由 harness 维护） */
export interface AssetPatch {
  /** `skill:repo-triage` 或 `agent:triage` */
  readonly target: string;
  readonly before: string;
  readonly after: string;
}

export interface Proposal {
  /** `p-<时间戳>-<序号>`，人可读、可排序 */
  readonly id: string;
  readonly modeId: string;
  readonly kind: FailureKind;
  readonly rationale: string;
  readonly patch: AssetPatch;
  /** L1 = 只改文本资产。L2（改代码）刻意不在首版 */
  readonly layer: 'L1';
}

export interface VerifyOutcome {
  readonly proposal: Proposal;
  readonly baseline: EvalReport;
  readonly candidate: EvalReport;
  readonly gate: GateResult;
}

export type ProposalStatus = 'accepted' | 'rejected';

/** 采纳记录 —— journal 的一行，回滚就读它 */
export interface JournalEntry {
  readonly at: number;
  readonly proposalId: string;
  readonly status: ProposalStatus;
  readonly target: string;
  readonly before: string;
  readonly after: string;
  readonly reason: string;
  /** 采纳前后的资产指纹（回滚时校验：中间被手改过就不许自动回退） */
  readonly assetsBefore: string;
  readonly assetsAfter: string;
}

export interface CycleReport {
  readonly modes: readonly FailureMode[];
  readonly proposals: readonly Proposal[];
  readonly verified: readonly VerifyOutcome[];
  readonly accepted: readonly Proposal[];
  readonly rejected: readonly { proposal: Proposal; reason: string }[];
  /** 本轮开始前的基线报告（未采集到失败时为 undefined） */
  readonly baseline: EvalReport | undefined;
}
