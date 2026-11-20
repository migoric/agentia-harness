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
  };
}
