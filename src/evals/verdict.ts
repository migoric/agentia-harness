import type { GateResult } from './gate.js';

/** `gate` 已算好、与「哪条判据成立」无关的那些字段 */
export type VerdictBase = Omit<GateResult, 'ok' | 'code' | 'reason'>;

/**
 * 「有原本通过的用例变失败」这一条判据 —— 整条门里唯一能指名到用例的否决。
 *
 * 单拆一个模块的理由是它能**被历史改写**：同样一句「3 条用例变失败」，在知道其中两条
 * 历史上就忽过忽挂之后，结论应该不同。把这份判断留在 `gate.ts` 里，等于让一个纯函数
 * （两份报告的差）承担一件它看不见的事（用例的既往表现）—— 那会变成靠注入全局状态
 * 才能测的代码。
 *
 * 判据的顺序是刻意的：**只要有一条「稳的」用例变失败，就否决**。原因是这两种错误的
 * 代价不对称 —— 放过一次真退步，它会被写进账本、成为下一轮的先验，错误就此复利；
 * 而错误地否决一次，损失只是这一轮白跑（且 `--dry-run` 下连文件都没改）。
 */
export function regressionVerdict(
  common: VerdictBase,
  regressed: readonly string[],
  flaky: ReadonlySet<string> | undefined,
): GateResult {
  const unstable = flaky === undefined ? [] : regressed.filter((n) => flaky.has(n));
  const solid = regressed.filter((n) => !unstable.includes(n));
  if (solid.length > 0) {
    return {
      ...common,
      ok: false,
      code: 'case_regression',
      reason:
        `${solid.length} 条原本通过的用例变失败：${solid.join(', ')}` +
        // 把被排除的那几条**写进理由**，而不是静默剔除：读的人要能自己复核
        // 「排除得对不对」，否则这个机制会变成一块谁也不敢动的黑箱
        (unstable.length === 0
          ? ''
          : `（另有 ${unstable.length} 条历史上不稳定，未计入：${unstable.join(', ')}）`),
    };
  }
  return {
    ...common,
    ok: true,
    code: 'case_regression_flaky',
    reason:
      `${regressed.length} 条用例变失败，但它们历史上都不稳定（同样的资产与用例集下既过又挂）：` +
      `${regressed.join(', ')} —— 单次结果不能作为退步判据。要做的是先让它们稳定` +
      '（加大 --repeat、查明抖动源），或把它们从判定集里移出去，而不是据此改提示词',
  };
}
