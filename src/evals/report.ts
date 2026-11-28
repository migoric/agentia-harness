/**
 * 报告汇总：把逐条 `CaseResult` 聚成一份 `EvalReport`。
 *
 * 为什么从 `types.ts` 拆出来：那个文件是**类型**的单一来源，而这里是「怎么算」。
 * 两者混住会让类型文件越过 400 行的架构上限（也确实是这么被顶破的），
 * 而按「类型 / 聚合」切开之后，两个文件各自的内聚反而更清楚。
 *
 * 一条纪律贯穿全文件：**缺席 ≠ 零**。`costUsd` 缺席是「没有读数」不是「免费」；
 * `routeAccuracy` 缺席是「没测路由」不是「全派错」；`menuHashes` 缺席是「不知道」，
 * 而 `[]` 是「确认一条都没挂工具」。把两者压成一个数，回归门就会开始对噪声下结论。
 */
import { aggregateHits, aggregateModels, unionOrUnknown } from './aggregate.js';
import type { CaseResult, EvalReport, ReportEnv } from './types.js';

/**
 * 全部用例采了同样多次才有共同的区间分母；任何一条缺席或数值不同 ⇒ `undefined`。
 *
 * 为什么不允许「取最大/取平均」：区间回答的是「这个通过率有多稳」，而分母不一致时
 * 那个问题本身没有答案 —— 三条用例各跑 3 次与一条跑 3 次、两条跑 1 次，后者的
 * 有效样本量不是一个整数，硬凑一个数就会算出一个看不出问题的区间。
 */
function uniformSamples(cases: readonly CaseResult[]): number | undefined {
  const first = cases[0]?.samples;
  if (first === undefined) return undefined;
  return cases.every((c) => c.samples === first) ? first : undefined;
}

/**
 * Wilson score 区间（95%）。
 *
 * 选它而不是 `p ± 1.96·√(p(1-p)/n)`：后者在 p 贴近 0 或 1 时会算出越界的上下限
 * （负数或 >100%），而 RSI 长期运行在「几乎全过」这个角落。Wilson 在极端比例与
 * 小样本下都不越界，且 n 很小时会自动给出一个诚实的宽区间。
 *
 * `n === 0` 时返回 `[0, 1]` —— 「什么都不知道」的正确表达，而不是 0。
 */
export function wilsonInterval(
  passed: number,
  total: number,
  z = 1.96,
): { readonly low: number; readonly high: number } {
  if (total <= 0) return { low: 0, high: 1 };
  const p = passed / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  // 夹紧到 [0,1]：浮点误差在 p=0 / p=1 时可能让边界偏出一个 ulp
  return {
    low: Math.max(0, Math.min(1, center - margin)),
    high: Math.max(0, Math.min(1, center + margin)),
  };
}

/**
 * 报告结构版本。
 *
 * 为什么要它：报告是**跨版本**消费的（基线可能是上个版本写的，读取方是今天这个版本）。
 * 靠「字段都在就没事」来判断，会在下次加必填字段时让所有老报告一起读不出来。
 *
 * 读侧口径（`reportSchemaVersion`）：**缺席按 1 处理**，不炸、也不假装它是新版。
 * v1 = 没有这个字段的历史报告；v2 = 加 `routeAccuracy` / `schemaVersion` 的这一版。
 */
export const EVAL_REPORT_SCHEMA_VERSION = 2;

/**
 * 读一份报告的结构版本。缺席 / 非正整数 ⇒ 1（老报告）。
 *
 * 单独一个函数而不是各处 `?? 1`：写三遍就有一条会写成 `?? 0`，
 * 而 0 会让「老报告」和「坏报告」变成同一个读数。
 */
export function reportSchemaVersion(raw: { schemaVersion?: unknown }): number {
  const v = raw.schemaVersion;
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 1;
}

/**
 * 路由准确率：只在**两边都有值**的用例上计算。
 *
 * 为什么不留空位补 0：把「这条没声明 route」算成「派错了」，会让一份混了单 agent
 * 用例的报告永远显示低准确率，而那个数字没有任何含义。
 */
function aggregateRoute(cases: readonly CaseResult[]): {
  routeAccuracy?: number;
  routeCases?: number;
} {
  const known = cases.filter(
    (c) => typeof c.expectRoute === 'string' && typeof c.routedTo === 'string',
  );
  if (known.length === 0) return {};
  const hit = known.filter((c) => c.routedTo === c.expectRoute).length;
  return { routeAccuracy: hit / known.length, routeCases: known.length };
}

export function summarize(
  cases: readonly CaseResult[],
  assetFingerprint: string,
  agent: string,
  env: ReportEnv = {},
): EvalReport {
  const passed = cases.filter((c) => c.passed).length;
  const priced = cases.filter((c) => c.costUsd !== undefined);
  const modelFacts = aggregateModels(cases);
  const menuHashes = unionOrUnknown(cases, (c) => c.menuHash);
  const route = aggregateRoute(cases);
  const promptVersions = unionOrUnknown(cases, (c) => c.promptVersions);

  // 采样口径：**全部用例一致**才算有共同分母，否则整体缺席（见 EvalReport.samples）
  const samples = uniformSamples(cases);
  const totalSamples = cases.reduce((sum, c) => sum + (c.samples ?? 1), 0);
  // 老报告没有 passedSamples：按 `passed ? 1 : 0` 回填，与 samples=1 完全等价
  const passedSamples = cases.reduce((sum, c) => sum + (c.passedSamples ?? (c.passed ? 1 : 0)), 0);
  const ci =
    samples !== undefined && samples > 1 && totalSamples > 0
      ? wilsonInterval(passedSamples, totalSamples)
      : undefined;

  return {
    schemaVersion: EVAL_REPORT_SCHEMA_VERSION,
    total: cases.length,
    passed,
    // 样本级微平均：samples=1 时与 `passed / total` 逐位相同，老口径不变
    passRate: totalSamples === 0 ? 0 : passedSamples / totalSamples,
    ...(samples === undefined ? {} : { samples }),
    ...(ci === undefined ? {} : { passRateLow: ci.low, passRateHigh: ci.high }),
    tokens: cases.reduce((sum, c) => sum + c.tokens, 0),
    costUsd: priced.reduce((sum, c) => sum + (c.costUsd ?? 0), 0),
    // 一条用例没定价就让整轮「成本不可比」—— 总和偏低会漏判成本回退
    costKnown: cases.length > 0 && priced.length === cases.length,
    cases,
    assetFingerprint,
    agent,
    // 条件展开而不是写 `model: env.model`：`exactOptionalPropertyTypes` 下
    // 「键存在但值为 undefined」与「键缺席」是两件事，而老报告里这两者要能区分
    ...(env.caseFingerprint !== undefined ? { caseFingerprint: env.caseFingerprint } : {}),
    ...(env.harnessVersion !== undefined ? { harnessVersion: env.harnessVersion } : {}),
    ...(env.finishedAt !== undefined ? { finishedAt: env.finishedAt } : {}),
    ...(env.model !== undefined ? { model: env.model } : {}),
    ...modelFacts,
    // 条件展开：`[]` 与缺席是两件事（「确认没挂工具」vs「不知道」），
    // 写成 `menuHashes: []` 会把两者压成同一个读数
    ...(menuHashes !== undefined ? { menuHashes } : {}),
    ...(promptVersions !== undefined ? { promptVersions } : {}),
    ...route,
    skillHits: aggregateHits(cases),
  };
}
