import type { GateResult } from '../evals/gate.js';
import type { EvalReport } from '../evals/types.js';
import type { CodeJournal } from './code/types.js';

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
  /** 这条用例实际走过的技能 —— 归因据此判断「该改哪个文件」 */
  readonly skills: readonly string[];
  readonly subagents: readonly string[];
}

/**
 * 「这个失败模式该改哪个资产」的候选，按走过它的用例数降序。
 *
 * 这是把「提案改谁」从猜测变成数据的那一步：此前只能改第一个 agent，因为报告里
 * 没有「哪条用例走了哪个技能」的映射。现在有了，提案就不该再猜。
 */
export interface TargetHint {
  /** `skill:name` / `agent:name` */
  readonly target: string;
  /** 有哪些失败用例走过它 */
  readonly cases: readonly string[];
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
  /** 该改的资产候选（空 = 没有任何资产被调用过，只能改主 agent 的 system） */
  readonly targets: readonly TargetHint[];
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
  /**
   * `asset` = 文本资产补丁（L1）；`code` = 代码补丁（L2）。
   *
   * 可选是因为**老记录没有这个字段**（2026-11-20 之前只有 L1）。读取侧统一补成
   * `asset`，这样「回滚哪一条」的判定不必到处写 `=== undefined` 的分支。
   */
  readonly kind?: 'asset' | 'code';
  /** `kind === 'code'` 时才有：补丁本身与逐文件指纹 */
  readonly code?: CodeJournal;
}

/**
 * 预算闸 —— 一轮 RSI 最多花多少钱。
 *
 * 存在理由很具体：一轮闭环要跑**两遍以上**评测（基线 + 每个候选各一遍），而在真模型
 * 上这是最贵的一步。没有上限时，「这轮花了 $12 结果什么都没采纳」是很容易发生的。
 *
 * `spentUsd` 只累加**已知**成本：模型没定价时它是偏低的，所以 `costKnown=false` 时
 * 闸不生效（并如实记下来），而不是拿着偏低的数字假装闸住了。
 */
export interface CycleBudget {
  readonly limitUsd: number;
  readonly spentUsd: number;
  /** true = 因超限提前收工（基线之后或验证中途） */
  readonly stopped: boolean;
}

export interface CycleReport {
  /** 本轮 id（时间戳 + 序号），也是落盘文件名 |
   *  有它才能把「CLI 打印的这一轮」与「.workspace 里那份记录」对上 */
  readonly cycleId: string;
  readonly modes: readonly FailureMode[];
  readonly proposals: readonly Proposal[];
  readonly verified: readonly VerifyOutcome[];
  readonly accepted: readonly Proposal[];
  readonly rejected: readonly { proposal: Proposal; reason: string }[];
  /** 本轮开始前的基线报告（未采集到失败时为 undefined） */
  readonly baseline: EvalReport | undefined;
  /** 只验证不落盘（人审模式）—— 落盘记录里必须自证，否则事后分不清「采纳了没」 */
  readonly dryRun: boolean;
  /** 本轮累计美元成本（提案 + 基线 + 已验证的候选） */
  readonly costUsd: number;
  /** 所有参与比较的报告都有成本读数；false 时 `costUsd` 偏低，预算闸不可用 */
  readonly costKnown: boolean;
  /** 预算闸的结论；没设上限时为 undefined */
  readonly budget: CycleBudget | undefined;
  /** 本轮记录的落盘路径（dryRun 也写：人审需要证据） */
  readonly path: string;
}
