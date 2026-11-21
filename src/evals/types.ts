/**
 * Harness —— 评测模型。
 *
 * 一个 eval case = 一段任务 + 一组**从 trace 就能断言**的期望。刻意不用 LLM 当裁判：
 * 裁判本身不确定，RSI 就没法判断自己的改动是不是真的变好了（会把随机波动当成进步）。
 *
 * 断言覆盖「结果对不对」「过程对不对」：
 * - 结果：`contains` / `notContains` / `matches` —— 最终文本
 * - 过程：`tools`（顺序）、`toolCounts`（次数）、`toolArgs`（入参）、`skills`（命中能力）
 * - 边界：`ok`（收尾状态）、`maxTokens`、`maxIterations`
 *
 * 全部是规则式判定，没有一条依赖模型 —— 裁判不确定，RSI 就会把随机波动当进步。
 */
export interface ToolArgExpect {
  readonly tool: string;
  /** 入参文本里必须出现的子串 */
  readonly substring: string;
}

export interface EvalExpect {
  readonly contains?: readonly string[];
  readonly notContains?: readonly string[];
  readonly matches?: string;
  /** 必须出现的工具名，按出现顺序（子序列匹配，允许中间夹别的调用） */
  readonly tools?: readonly string[];
  /** 工具名 → **精确**调用次数（与 `tools` 的子序列语义不同，刻意分开） */
  readonly toolCounts?: Readonly<Record<string, number>>;
  /** 某工具的入参必须包含某子串（至少一次） */
  readonly toolArgs?: readonly ToolArgExpect[];
  /** 必须命中的技能（去重集合的子集，不看次数） */
  readonly skills?: readonly string[];
  readonly ok?: boolean;
  /** 最多允许多少 token（超了算失败）—— 用它把「靠堆循环混过去」挡在门外 */
  readonly maxTokens?: number;
  readonly maxIterations?: number;
}

/**
 * 用例的分组。`train` 参与归因与提案；`holdout` 只在候选选定后验一次。
 *
 * 两者不分的后果不是「评测不够多」，而是**闭环必然过拟合**：提案照着验收用例改，
 * 验收门当然会放行。留出集一旦被用来挑候选，它就变成了 train —— 所以
 * `runCycle` 里留出集只跑一次，且不参与排序。
 */
export type EvalSplit = 'train' | 'holdout';

export interface EvalCase {
  readonly name: string;
  /** 首轮任务原文。多轮用例的后续轮次在 `followUps` 里 */
  readonly task: string;
  /**
   * 后续轮次（只有多轮用例才有）。首轮永远是 `task`，这里存第 2 轮起的用户输入。
   *
   * 为什么单独一个字段而不是把整段塞进 `task`：`task` 被 harvest、报告、evidence
   * 三处当成「一句话任务」消费，变成数组会让这三处全部失真。多轮是**增量**语义。
   */
  readonly followUps?: readonly string[] | undefined;
  readonly expect: EvalExpect;
  /** 缺省 `train`：老用例不必改一个字也能继续用 */
  readonly split?: EvalSplit | undefined;
  /** 来源文件（报错定位） */
  readonly path: string;
}

export interface CaseResult {
  readonly name: string;
  /**
   * 这条用例的任务原文。
   *
   * 存在理由：`harness harvest --from-report` 要按 traceId 反查任务，而 trace 里
   * 没有任务原文 —— 报告是唯一能把它带回来的地方。缺了它，回流只能靠人手打一遍。
   */
  readonly task: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly tokens: number;
  /**
   * 这条用例花了多少美元；`undefined` = 没有读数（脚本客户端，或模型不在价格表内）。
   *
   * 与 `tokens` 并列而不是取代它：token 是**可比**的（跨模型、跨时间都稳定），
   * 成本是**可决策**的（预算、报价、值不值得再跑一轮）。两者回答的不是一个问题。
   * 这里刻意不用 `0` 表示「没读数」—— 那会让「免费」与「不知道」变成同一个数，
   * 而回归门必须能区分它们。
   */
  readonly costUsd: number | undefined;
  readonly iterations: number;
  readonly durationMs: number;
  readonly stopReason: string;
  /** 断言失败时给出最终文本，便于人眼看（裁剪到 400 字） */
  readonly excerpt: string;
  /**
   * 本次运行的 traceId —— 报告与 `harness trace <id>` 的交叉引用。
   * 跑崩 / 超时时没有可用 trace，此字段缺席（不是空串）。
   */
  readonly traceId?: string | undefined;
  /**
   * 实际跑了几轮。单轮用例缺席（老报告兼容），多轮用例 ≥ 2。
   *
   * 存在的理由：报告只记 `task`（首轮），不带这个数时人看不出「这条用例失败在第
   * 二轮追问」——而多轮失败与单轮失败的修法完全不同。
   */
  readonly turns?: number | undefined;
  /** 第一处非正常收尾的轮次（1-based）。全部正常时缺席 */
  readonly failedTurn?: number | undefined;
  /**
   * 这条用例属于哪个分组。缺席 = `train`（老报告兼容），由 `runOne` 透传。
   * 报告是 `harness evidence` / `harvest --from-report` 的唯一任务来源，分组也必须随它落盘。
   */
  readonly split?: EvalSplit | undefined;
  /** 本次实际调用过的技能（去重）—— RSI 据此判断「该改哪个文件」 */
  readonly skills: readonly string[];
  /** 本次实际委派过的子 agent（去重） */
  readonly subagents: readonly string[];
}

/**
 * 某个资产在一轮评测里被用到的统计。
 *
 * 存在理由：`EvalReport` 若只记「哪条用例挂了」，提案只能猜该改哪个文件（改错文件
 * 比不改更糟 —— 评测还可能碰巧通过）。带上命中统计之后，「这条失败该改 `skill:x`」
 * 是**数据**，不是猜测。
 */
export interface AssetHit {
  /** `skill:name` / `agent:name` */
  readonly target: string;
  /** 出现在多少条用例里 */
  readonly cases: readonly string[];
}

export interface EvalReport {
  readonly total: number;
  readonly passed: number;
  readonly passRate: number;
  readonly tokens: number;
  /** 全轮美元成本；`costKnown` 为 false 时这个 0 不代表免费（见 `costKnown`） */
  readonly costUsd: number;
  /**
   * 是否所有用例都给出了成本读数。
   *
   * 存在的理由：`costEstimate` 为 `undefined`（模型不在价格表内）与真 0 长得一样。
   * 拿总和 > 0 当「有读数」是错的 —— 一轮里只要有一条没定价，总和就偏低，
   * 而按偏低的总和判「更贵了」会漏掉真实的成本回退。所以由**逐条**读数推导。
   */
  readonly costKnown: boolean;
  readonly cases: readonly CaseResult[];
  /** 跑分时的全体资产指纹 —— 两个报告只有在指纹相同的语义下才可比 */
  readonly assetFingerprint: string;
  readonly agent: string;
  /** 本轮被用到的资产（按用例数降序）—— 提案选目标的数据来源 */
  readonly skillHits: readonly AssetHit[];
}

export function summarize(
  cases: readonly CaseResult[],
  assetFingerprint: string,
  agent: string,
): EvalReport {
  const passed = cases.filter((c) => c.passed).length;
  const priced = cases.filter((c) => c.costUsd !== undefined);
  return {
    total: cases.length,
    passed,
    passRate: cases.length === 0 ? 0 : passed / cases.length,
    tokens: cases.reduce((sum, c) => sum + c.tokens, 0),
    costUsd: priced.reduce((sum, c) => sum + (c.costUsd ?? 0), 0),
    // 一条用例没定价就让整轮「成本不可比」—— 总和偏低会漏判成本回退
    costKnown: cases.length > 0 && priced.length === cases.length,
    cases,
    assetFingerprint,
    agent,
    skillHits: aggregateHits(cases),
  };
}

/**
 * 按资产聚合命中。同一个资产出现在 N 条用例里就是 N 条 `cases`。
 *
 * 重复调用（同一技能在一轮里被调 3 次）**不**重复计数：这里要回答的是「哪条用例
 * 走过它」，不是「调了几次」。调了几次看 trace，那才是它的位置。
 */
function aggregateHits(cases: readonly CaseResult[]): AssetHit[] {
  const byTarget = new Map<string, Set<string>>();
  for (const c of cases) {
    for (const name of c.skills) add(byTarget, `skill:${name}`, c.name);
    for (const name of c.subagents) add(byTarget, `agent:${name}`, c.name);
  }
  return [...byTarget.entries()]
    .map(([target, set]) => ({ target, cases: [...set].sort() }))
    .sort((a, b) => b.cases.length - a.cases.length || a.target.localeCompare(b.target));
}

function add(map: Map<string, Set<string>>, target: string, caseName: string): void {
  const set = map.get(target);
  if (set === undefined) map.set(target, new Set([caseName]));
  else set.add(caseName);
}
