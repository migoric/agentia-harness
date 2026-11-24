import { usd } from '../util/usd.js';
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
 * | 通过率没升，成本还涨超阈值 | 否决 | 没变好还更贵 |
 * | 通过率没升、成本不可比，token 涨超阈值 | 否决 | 同上，用代理指标判 |
 * | 其余 | 通过 | 变好，或同等好且没更贵 |
 *
 * 判「更贵」优先用**成本**，两边都有读数时不再看 token：token 只对同一个模型
 * 可比，而 RSI 的提案里出现「换模型」是完全合法的。成本不可比（未定价模型 /
 * 脚本客户端）才退回 token —— 那是代理指标，方向一致但精度差。
 *
 * 两个刻意的宽容：
 * - 通过率提升时，token 涨多少都放行（只记录）。用预算换能力是合理交易，把上限定死
 *   会让所有「更努力」的改动一律被拒，那 RSI 就只能学会偷懒。
 * - 同名用例集合不同时（新用例/删用例），只比较**交集**的回归，别拿新用例的失败
 *   去否决一个提议 —— 那是评测集自己的问题，不是提案的。
 *
 * 但「只比交集」不等于「静默地比一部分」：用例集变了本身要作为**独立结论**报出来
 * （`case_set_changed`），因为此时两份报告的通过率分母不同，`passRate` 的高低根本不是
 * 同一件事。此前这一步缺失，表现为「加了一条用例 ⇒ 通过率下降 ⇒ 否决」，理由写着
 * 「整体退步」，而真相是基线过期了 —— 结论对、归因错，人照着修会去改提示词。
 * 想比还是能比（`allowCaseSetChange`），只是结论里必须带着这个前提。
 */
export interface GateOptions {
  /** 通过率不变时，允许的 token 增幅（0.1 = 10%） */
  readonly maxTokenGrowth?: number;
  /** 通过率不变时，允许的成本增幅（缺省与 token 同值） */
  readonly maxCostGrowth?: number;
  /**
   * 允许用例集不同（只比交集，不否决）。
   *
   * 缺省 false：默认拒绝 —— 拿过期的基线比出来的「变好/变差」没有依据。
   * CI 里比对两份历史报告时若确实改过评测集，显式开这个口子，等于声明
   * 「我知道分子分母变了，只看交集」。
   */
  readonly allowCaseSetChange?: boolean;
}

export interface GateResult {
  readonly ok: boolean;
  readonly code:
    | 'pass'
    | 'case_set_changed'
    | 'case_regression'
    | 'pass_rate_dropped'
    | 'cost_regression'
    | 'token_regression'
    | 'not_comparable';
  readonly reason: string;
  /** 由过变挂的用例名 */
  readonly regressedCases: readonly string[];
  /** 由挂变过的用例名（提案的真实价值在此） */
  readonly fixedCases: readonly string[];
  readonly passRateDelta: number;
  readonly tokenDelta: number;
  /**
   * 成本增幅；`undefined` = 两边至少一边没有成本读数（未定价模型 / 脚本客户端）。
   *
   * 读法很重要：`undefined` 不是「没涨」，是「不知道」。这时才退回 token 判据 ——
   * token 只是成本的代理，而对同一模型同一个提示词，两者的方向总是一致的，
   * 所以「退回去」不会得出相反结论，只是精度差一些。
   */
  readonly costDelta: number | undefined;
  /** 用来判「没变好还更贵」的究竟是哪一个 —— 结论可复核的前提 */
  readonly costBasis: 'cost' | 'tokens';
  /**
   * 基线/候选的资产指纹相同 —— 说明这次比对**没有改动任何资产**，结论只反映
   * 模型采样的随机性。调用方见到 true 应该重跑而不是下结论。
   */
  readonly sameAssets: boolean;
  /**
   * 两边跑的是同一份用例集（名字、任务、断言、分组全同）。
   *
   * 判据优先用 `caseFingerprint`（能抓到「名字没变、断言改了」），两边都没这个字段
   * 的老报告退化成「名字集合相同」。**退化的判据会漏掉断言改动**，所以 `undefined`
   * 表示「无法确认」，它与 `true` 不是一回事。
   */
  readonly sameCaseSet: boolean | undefined;
  /** 只在基线里有的用例名（基线过期，或候选用了 `--only`） */
  readonly onlyInBaseline: readonly string[];
  /** 只在候选里有的用例名（新加的用例；它进不了交集的通过率） */
  readonly onlyInCandidate: readonly string[];
  /**
   * 两边模型相同。`undefined` = 至少一边没记（老报告）。
   *
   * 不据此否决：跨模型对比是合法实验（「换个便宜模型还过不过」）。但**成本/通过率
   * 的增减必须带着它读** —— 换模型后 token 与单价的基准都变了。
   */
  readonly sameModel: boolean | undefined;
  /** 两边 agent 相同（`name@version`）。不同则比的根本不是同一个 agent */
  readonly sameAgent: boolean;
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

  // 用例集差异：这三种情况都让「通过率」不再是同一个比值（分母变了）
  const onlyInBaseline = [...base.keys()].filter((n) => !cand.has(n)).sort();
  const onlyInCandidate = [...cand.keys()].filter((n) => !base.has(n)).sort();
  const namesEqual = onlyInBaseline.length === 0 && onlyInCandidate.length === 0;
  const fpB = baseline.caseFingerprint;
  const fpC = candidate.caseFingerprint;
  const sameCaseSet: boolean | undefined = !namesEqual
    ? false
    : fpB !== undefined && fpC !== undefined
      ? // 名字相同但指纹不同 = 断言/任务被改过，判定标准已经不是同一个
        fpB === fpC
      : undefined; // 老报告没有指纹：只能确认名字相同，断言是否一致「不知道」

  // 集合不同时只统计交集 —— 否则「新加的用例候选没做」会被算成通过率下降
  const shared = namesEqual ? null : [...base.keys()].filter((n) => cand.has(n)).sort();
  const compared = shared ?? [...base.keys()].sort();

  const passRateDelta =
    shared === null
      ? candidate.passRate - baseline.passRate
      : shared.length === 0
        ? 0
        : shared.filter((n) => cand.get(n)?.passed === true).length / shared.length -
          shared.filter((n) => base.get(n)?.passed === true).length / shared.length;

  // token/成本也要在**同一批用例**上比：集合变了还比总和，等于拿「多了几条用例的开销」
  // 当成「这条用例变贵了」。成本还要求两边每个被比对的用例都有读数。
  const baseTokens = compared.reduce((sum, n) => sum + (base.get(n)?.tokens ?? 0), 0);
  const candTokens = compared.reduce((sum, n) => sum + (cand.get(n)?.tokens ?? 0), 0);
  const tokenDelta = ratioDelta(baseTokens, candTokens);
  const costUsable =
    compared.length > 0 &&
    compared.every((n) => base.get(n)?.costUsd !== undefined) &&
    compared.every((n) => cand.get(n)?.costUsd !== undefined);
  const costDelta = costUsable
    ? ratioDelta(
        compared.reduce((sum, n) => sum + (base.get(n)?.costUsd ?? 0), 0),
        compared.reduce((sum, n) => sum + (cand.get(n)?.costUsd ?? 0), 0),
      )
    : undefined;
  const costBasis: 'cost' | 'tokens' = costDelta === undefined ? 'tokens' : 'cost';
  const sameAssets = baseline.assetFingerprint === candidate.assetFingerprint;
  const sameModel =
    baseline.model !== undefined && candidate.model !== undefined
      ? baseline.model === candidate.model
      : undefined;

  const common = {
    regressedCases,
    fixedCases,
    passRateDelta,
    tokenDelta,
    costDelta,
    costBasis,
    sameAssets,
    sameCaseSet,
    onlyInBaseline,
    onlyInCandidate,
    sameModel,
    sameAgent: baseline.agent === candidate.agent,
  } as const;

  const setDiff = caseSetDiff(onlyInBaseline, onlyInCandidate);
  // 名字全同却判定「集合变了」只可能是指纹不同（任务或断言被改过）—— 此时说
  // 「仅基线有 0 条，仅候选有 0 条」等于什么都没说
  const setIssue =
    onlyInBaseline.length === 0 && onlyInCandidate.length === 0
      ? '用例名相同，但任务或断言被改过'
      : setDiff;
  // 结论里的分子分母要跟着「实际比了哪些用例」走，否则读起来像整份评测集都过了
  const baseRate =
    shared === null ? `${baseline.passed}/${baseline.total}` : sharedPassed(base, compared);
  const candRate =
    shared === null ? `${candidate.passed}/${candidate.total}` : sharedPassed(cand, compared);
  const scopeNote = shared === null ? '' : '，只算同名用例';
  const baseCost = compared.reduce((sum, n) => sum + (base.get(n)?.costUsd ?? 0), 0);
  const candCost = compared.reduce((sum, n) => sum + (cand.get(n)?.costUsd ?? 0), 0);

  if (sameCaseSet === false && opts.allowCaseSetChange !== true) {
    return {
      ...common,
      ok: false,
      code: 'case_set_changed',
      reason:
        `两次跑分的用例集不一致：${setIssue} —— 通过率的分母与判定标准可能都不是同一个，` +
        '「变好还是变差」无从谈起。重跑基线，或显式只比交集',
    };
  }
  if (compared.length === 0) {
    return {
      ...common,
      ok: false,
      code: 'not_comparable',
      reason: `两份报告没有同名用例（${setIssue}）—— 无从比较`,
    };
  }
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
      reason: `通过率下降 ${(passRateDelta * 100).toFixed(1)}pt（${baseRate} → ${candRate}${scopeNote}）`,
    };
  }
  if (passRateDelta === 0) {
    const maxCostGrowth = opts.maxCostGrowth ?? maxTokenGrowth;
    if (costDelta !== undefined && costDelta > maxCostGrowth) {
      return {
        ...common,
        ok: false,
        code: 'cost_regression',
        reason:
          `通过率没变（${(candidate.passRate * 100).toFixed(1)}%）但成本涨了 ${(costDelta * 100).toFixed(1)}%` +
          `（${usd(baseCost)} → ${usd(candCost)}，阈值 ${(maxCostGrowth * 100).toFixed(0)}%${scopeNote}）`,
      };
    }
    if (costDelta === undefined && tokenDelta > maxTokenGrowth) {
      return {
        ...common,
        ok: false,
        code: 'token_regression',
        reason:
          `通过率没变（${(candidate.passRate * 100).toFixed(1)}%）但 token 涨了 ${(tokenDelta * 100).toFixed(1)}%` +
          `（阈值 ${(maxTokenGrowth * 100).toFixed(0)}%；成本不可比，按 token 判）`,
      };
    }
  }

  const parts: string[] = [];
  if (fixedCases.length > 0) parts.push(`修好 ${fixedCases.length} 条（${fixedCases.join(', ')}）`);
  if (passRateDelta > 0) parts.push(`通过率 +${(passRateDelta * 100).toFixed(1)}pt`);
  if (costDelta !== undefined && costDelta !== 0) {
    parts.push(`成本 ${costDelta > 0 ? '+' : ''}${(costDelta * 100).toFixed(1)}%`);
  } else if (costDelta === undefined && tokenDelta !== 0) {
    parts.push(`token ${tokenDelta > 0 ? '+' : ''}${(tokenDelta * 100).toFixed(1)}%`);
  }
  // 比了交集就必须说出来，否则「通过」会被读成「整份评测集都过了」
  if (shared !== null) parts.push(`只比对 ${shared.length} 条同名用例（${setDiff}）`);
  return {
    ...common,
    ok: true,
    code: 'pass',
    reason: parts.length > 0 ? parts.join('，') : '无变化',
  };
}

/** 增幅；基线为 0 时只能区分「还是 0」与「不是 0」 */
function ratioDelta(baseValue: number, candValue: number): number {
  if (baseValue === 0) return candValue === 0 ? 0 : 1;
  return candValue / baseValue - 1;
}

function caseSetDiff(baselineOnly: readonly string[], candidateOnly: readonly string[]): string {
  const parts: string[] = [];
  if (baselineOnly.length > 0) parts.push(`仅基线有：${baselineOnly.join(', ')}`);
  if (candidateOnly.length > 0) parts.push(`仅候选有：${candidateOnly.join(', ')}`);
  return parts.join('；');
}

function sharedPassed(
  cases: ReadonlyMap<string, { readonly passed: boolean }>,
  names: readonly string[],
): string {
  const passed = names.filter((n) => cases.get(n)?.passed === true).length;
  return `${passed}/${names.length}`;
}
