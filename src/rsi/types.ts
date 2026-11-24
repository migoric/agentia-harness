import type { GateResult } from '../evals/gate.js';
import type { EvalReport } from '../evals/types.js';
import type { CodeJournal } from './code/types.js';

/**
 * 变更清单（AHE 的 decision observability）—— 每一次采纳都要能回答四个问题：
 * 依据是什么、判断哪里坏了、期望发生什么、可能坏在哪里。
 *
 * 没有它时，journal 只留「before/after + 通过率涨了」：三个月后的人看到一个改动的
 * 文本，看不出当时为什么相信它有用，也就无法判断现在该不该保留。
 *
 * 清单在**提案时**就写好（验证之前），不是事后补的解释 —— 事后写等于让结果污染假设。
 *
 * 定义放在这里（而不是 `manifest.ts`）是为了断开 `types ↔ manifest` 的类型级环：
 * manifest.ts 要 `FailureMode`，types.ts 要 `ChangeManifest`，两边互指会让「哪个模块
 * 是数据模型的家」变得说不清。`manifest.ts` 继续 re-export，老调用方不用改。
 */
export interface ChangeManifest {
  /** 证据引用：`mode:<id>` / `case:<用例名>` / `trace:<traceId>` */
  readonly evidence: readonly string[];
  /**  hypothesis：我们判断哪个失败机制在起作用 */
  readonly hypothesis: string;
  /** prediction：改动后应该观察到什么（验证时逐条对照） */
  readonly prediction: string;
  /** risk：这次改动可能连带弄坏什么（由回归门兜底，但要先说出来） */
  readonly risk: string;
}

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

/** 外部提案校验用的枚举清单 —— 与上面的类型同源，避免两处各写一份而漂移 */
export const FAILURE_KINDS = [
  'wrong_answer',
  'tool_misuse',
  'tool_error',
  'loop',
  'budget',
  'stop_abnormal',
  'unknown',
] as const satisfies readonly FailureKind[];

/** 一条失败样本：来自某个 eval case 的一次真实运行 */
export interface FailureSample {
  readonly case: string;
  readonly failures: readonly string[];
  readonly stopReason: string;
  readonly tokens: number;
  readonly iterations: number;
  readonly excerpt: string;
  /**
   * 这次运行的 traceId（有 `--keep-traces` 时才有）。
   * 它是「证据」与「这次失败」之间的硬连接：manifest 引用它，evidence 语料按它找原始 trace。
   */
  readonly traceId?: string | undefined;
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

/**
 * 一条「试过但没成立」的教训 —— 提案器的输入。
 *
 * 从 `LedgerEntry` 映射过来而不是直接传账本：提案器只需要「改哪儿、当时预测什么、
 * 为什么没成」三件事，把整条账本（含 evidence / holdout 细节）塞进提示词只会挤占
 * 真正有用的失败证据。更重要的是解耦：propose 不该依赖 ledger（后者要读 cycle 目录）。
 */
export interface LessonEntry {
  readonly proposalId: string;
  /** `skill:x` / `agent:y` */
  readonly target: string;
  readonly prediction: string | undefined;
  /** 当时被否掉的原因（门结论 / 留出集结论） */
  readonly reason: string | undefined;
  /** `not_realized` = 验过没兑现；`reverted` = 采纳后又被回滚 */
  readonly outcome: 'not_realized' | 'reverted';
}

/** 一次资产改写：只允许改**正文**（frontmatter 由 harness 维护） */ export interface AssetPatch {
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
  /**
   * 变更前写下的依据 / 假设 / 预测 / 风险。缺席 = 外部提案没带（LLM 提案一定有），
   * 读取侧不得把它当成「有预测」—— 没有就是没有，审计记录要如实。
   */
  readonly manifest?: ChangeManifest | undefined;
  /** L1 = 只改文本资产。L2（改代码）刻意不在首版 */
  readonly layer: 'L1';
}

/** 留出集验证结果：候选在 train 上胜出之后才做，不参与候选排序 */
export interface HoldoutResult {
  readonly baseline: EvalReport;
  readonly candidate: EvalReport;
  readonly gate: GateResult;
}

export interface VerifyOutcome {
  readonly proposal: Proposal;
  /** train 视图（没有留出集时就是完整报告） */
  readonly baseline: EvalReport;
  /** train 视图下的候选 */
  readonly candidate: EvalReport;
  readonly gate: GateResult;
  /** 留出集最终验证；没有配置 holdout 用例时为 undefined */
  readonly holdout?: HoldoutResult | undefined;
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
  /** 当初写下的预测与依据，随采纳一起进审计线索 */
  readonly manifest?: ChangeManifest | undefined;
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
  /** 这条记录是回滚产生的（复用原 proposalId，但语义不是「又被拒了一次提案」） */
  readonly reverted?: boolean | undefined;
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
  /** true = 这一轮结束时预算已经用完（提前收工，或者跑完才发现超了）—— 调用方据此决定还开不开下一轮 */
  readonly stopped: boolean;
}

export interface CycleReport {
  /**
   * 记录格式版本（写入侧打标，读取侧据此迁移）。
   *
   * 可选**只为兼容旧记录**：版本化（2026-11-24）之前写下的 JSON 没有这个字段，
   * `cycles.ts` 按 0 处理。新增/改名字段时必须同时想「老记录怎么办」。
   */
  readonly schema?: number | undefined;
  /** 本轮 id（时间戳 + 序号），也是落盘文件名 |
   *  有它才能把「CLI 打印的这一轮」与「.workspace 里那份记录」对上 */
  readonly cycleId: string;
  /**
   * 本轮开始的时刻（ISO 8601）。
   *
   * 可选**只为兼容旧记录**（本字段 2026-11-22 起才写）：账本曾用文件名
   * （`2026-11-21T23-13-14-044Z`）正则反解时间 —— 那等于把**命名格式**变成隐式接口，
   * 改一次命名就让排序静默退化（解析失败回落 0，最该被记住的教训被排到最后）。
   * 新记录一律写字段；读的时候字段优先、文件名只作兜底。
   */
  readonly at?: string | undefined;
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
  /**
   * 本轮提案器**实际看到**的「试过但没成立」条目数。
   *
   * 三态，缺一不可：
   * - `undefined` = 本轮根本没提案（基线就超预算 / 没有失败模式可归因）；
   * - `0` = 提了案，但仓里还没有教训可参考；
   * - `N` = 提了案，提示词里带了 N 条历史。
   *
   * 刻意不用「早停时也写 N」的写法：那会让「提案器看到了 3 条历史」与「跑都没跑到
   * 提案那一步」在记录里长得一样，而这正是审计最想分开的两件事。
   *
   * 记它的理由：账本回灌是**软约束**（写进提示词），不落这个数就永远看不出
   * 「提案器到底有没有看到历史」—— 而它恰恰是最容易接线漏掉的一环。
   */
  readonly historyConsulted?: number | undefined;
  /** 本轮记录的落盘路径（dryRun 也写：人审需要证据） */
  readonly path: string;
}
