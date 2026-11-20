/**
 * Harness —— 评测模型。
 *
 * 一个 eval case = 一段任务 + 一组**从 trace 就能断言**的期望。刻意不用 LLM 当裁判：
 * 裁判本身不确定，RSI 就没法判断自己的改动是不是真的变好了（会把随机波动当成进步）。
 *
 * 断言分三类，覆盖「结果对不对」「过程对不对」：
 * - `contains` / `matches`：最终文本（结果）
 * - `tools`：主循环调用过的工具序列（过程）—— 断言「先查再改」这类顺序，只能从 trace 读
 * - `ok`：是否正常收尾（缺省 true）
 */
export interface EvalExpect {
  readonly contains?: readonly string[];
  readonly matches?: string;
  /** 必须出现的工具名，按出现顺序（子序列匹配，允许中间夹别的调用） */
  readonly tools?: readonly string[];
  readonly ok?: boolean;
  /** 最多允许多少 token（超了算失败）—— 用它把「靠堆循环混过去」挡在门外 */
  readonly maxTokens?: number;
}

export interface EvalCase {
  readonly name: string;
  readonly task: string;
  readonly expect: EvalExpect;
  /** 来源文件（报错定位） */
  readonly path: string;
}

export interface CaseResult {
  readonly name: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly tokens: number;
  readonly iterations: number;
  readonly durationMs: number;
  readonly stopReason: string;
  /** 断言失败时给出最终文本，便于人眼看（裁剪到 400 字） */
  readonly excerpt: string;
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
  return {
    total: cases.length,
    passed,
    passRate: cases.length === 0 ? 0 : passed / cases.length,
    tokens: cases.reduce((sum, c) => sum + c.tokens, 0),
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
