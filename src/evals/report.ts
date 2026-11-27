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
  return {
    schemaVersion: EVAL_REPORT_SCHEMA_VERSION,
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
