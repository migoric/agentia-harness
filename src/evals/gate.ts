import type { EvalReport } from './types.js';

/**
 * 回归门 —— RSI 唯一的「否决权」。
 *
 * 判定**不是**一个加权总分。加权总分是最容易自欺的东西：把通过率 0.95→0.96 和
 * token 涨 40% 加权在一起，权重随手一调就能让任何结论成立。这里用**字典序 +
 * 硬否决**，每一条都能用一句人话解释：
 *
 * | 条件 | 结论 | 一句话 |
 * |---|---|---|
 * | 有「基线过、候选挂」的用例 | 否决 | 你改坏了一个原来能过的 |
 * | 通过率下降 | 否决 | 整体退步 |
 * | 通过率没升，token 还涨超阈值 | 否决 | 没变好还更贵 |
 * | 其余 | 通过 | 变好，或同等好且没更贵 |
 *
 * 两个刻意的宽容：
 * - 通过率提升时，token 涨多少都放行（只记录）。用预算换能力是合理交易，把上限定死
 *   会让所有「更努力」的改动一律被拒，那 RSI 就只能学会偷懒。
 * - 同名用例集合不同时（新用例/删用例），只比较**交集**的回归，别拿新用例的失败
 *   去否决一个提议 —— 那是评测集自己的问题，不是提案的。
 */
export interface GateOptions {
  /** 通过率不变时，允许的 token 增幅（0.1 = 10%） */
  readonly maxTokenGrowth?: number;
}

export interface GateResult {
  readonly ok: boolean;
  readonly code: 'pass' | 'case_regression' | 'pass_rate_dropped' | 'token_regression';
  readonly reason: string;
  /** 由过变挂的用例名 */
  readonly regressedCases: readonly string[];
  /** 由挂变过的用例名（提案的真实价值在此） */
  readonly fixedCases: readonly string[];
  readonly passRateDelta: number;
  readonly tokenDelta: number;
  /**
   * 基线/候选的资产指纹相同 —— 说明这次比对**没有改动任何资产**，结论只反映
   * 模型采样的随机性。调用方见到 true 应该重跑而不是下结论。
   */
  readonly sameAssets: boolean;
}

export function gate(
  baseline: EvalReport,
  candidate: EvalReport,
  opts: GateOptions = {},
): GateResult {
  const maxTokenGrowth = opts.maxTokenGrowth ?? 0.1;
  const base = new Map(baseline.cases.map((c) => [c.name, c]));
  const cand = new Map(candidate.cases.map((c) => [c.name, c]));

  const regressedCases = [...base.values()]
    .filter((b) => b.passed && cand.get(b.name)?.passed === false)
    .map((b) => b.name)
    .sort();
  const fixedCases = [...base.values()]
    .filter((b) => !b.passed && cand.get(b.name)?.passed === true)
    .map((b) => b.name)
    .sort();

  const passRateDelta = candidate.passRate - baseline.passRate;
  const tokenDelta =
    baseline.tokens === 0
      ? candidate.tokens === 0
        ? 0
        : 1
      : candidate.tokens / baseline.tokens - 1;
  const sameAssets = baseline.assetFingerprint === candidate.assetFingerprint;

  const common = {
    regressedCases,
    fixedCases,
    passRateDelta,
    tokenDelta,
    sameAssets,
  } as const;

  if (regressedCases.length > 0) {
    return {
      ...common,
      ok: false,
      code: 'case_regression',
      reason: `${regressedCases.length} 条原本通过的用例变失败：${regressedCases.join(', ')}`,
    };
  }
  if (passRateDelta < 0) {
    return {
      ...common,
      ok: false,
      code: 'pass_rate_dropped',
      reason: `通过率下降 ${(passRateDelta * 100).toFixed(1)}pt（${baseline.passed}/${baseline.total} → ${candidate.passed}/${candidate.total}）`,
    };
  }
  if (passRateDelta === 0 && tokenDelta > maxTokenGrowth) {
    return {
      ...common,
      ok: false,
      code: 'token_regression',
      reason: `通过率没变（${(candidate.passRate * 100).toFixed(1)}%）但 token 涨了 ${(tokenDelta * 100).toFixed(1)}%（阈值 ${(maxTokenGrowth * 100).toFixed(0)}%）`,
    };
  }

  const parts: string[] = [];
  if (fixedCases.length > 0) parts.push(`修好 ${fixedCases.length} 条（${fixedCases.join(', ')}）`);
  if (passRateDelta > 0) parts.push(`通过率 +${(passRateDelta * 100).toFixed(1)}pt`);
  if (tokenDelta !== 0) {
    parts.push(`token ${tokenDelta > 0 ? '+' : ''}${(tokenDelta * 100).toFixed(1)}%`);
  }
  return {
    ...common,
    ok: true,
    code: 'pass',
    reason: parts.length > 0 ? parts.join('，') : '无变化',
  };
}
