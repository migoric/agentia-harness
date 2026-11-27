import type { AssetHit, CaseResult } from './types.js';

/**
 * `CaseResult[]` 的**聚合读数** —— 从单条结果拼出一轮的环境事实。
 *
 * 与 `types.ts` 分开，是因为两者回答的不是一个问题：那边定义「一条结果长什么样」，
 * 这边定义「多条结果并起来说什么」。混在一个文件里时，第一个超过 400 行上限的
 * 一定是它（本仓的 `单文件不超过 400 行` 守卫就是为这种时刻准备的）。
 *
 * 三条聚合各有各的"不知道"口径，不要统一：模型集合**缺一条就整体缺席**（假结论比
 * 不知道贵），菜单/版本表**分三档**（合法地没有 ≠ 不知道），命中统计没有缺席概念。
 */

/**
 * 全轮的模型事实 —— 并集与降级次数。
 *
 * **只要有一条用例没记，就整体返回空**（与 `costKnown` 同一条纪律）：并集少一个模型、
 * 次数少算几次，都会让 `sameModel` 得出「两边一样」的假结论；而假结论比「不知道」
 * 贵得多 —— 它会让人照着去改提示词。
 *
 * 两种「不知道」的处理不同，因为病因不同：
 * - 某条用例没有 trace（首轮就抛）⇒ 本轮确实无法确认模型集合；
 * - 有 trace 但一个 `llm.turn` 都没有 ⇒ 集合为空，不算「不知道」，只是没跑回合。
 */
export function aggregateModels(cases: readonly CaseResult[]): {
  models?: readonly string[] | undefined;
  fallbackUsed?: number | undefined;
} {
  if (cases.length === 0 || cases.some((c) => c.models === undefined)) return {};
  const seen = new Set<string>();
  const models: string[] = [];
  for (const c of cases) {
    for (const m of c.models ?? []) {
      if (seen.has(m)) continue;
      seen.add(m);
      models.push(m);
    }
  }
  const fallbackUsed = cases.reduce((sum, c) => sum + (c.fallbackUsed ?? 0), 0);
  return models.length === 0 ? { fallbackUsed } : { models, fallbackUsed };
}

/**
 * 把一个「每条用例各有一个值」的事实并成一轮的集合 —— 三条读法见 `EvalReport.menuHashes`。
 *
 * 为什么这里不像 `aggregateModels` 那样**任何一条缺席就整体缺席**：菜单与版本表有
 * 「合法地没有」这一档（裸用例没工具、资产没写 `version`），把它也当成「不知道」
 * 会让每个轻量工程每次跑分都自带一条「无法确认」的告警，告警一多就没人读了。
 * 所以分三档：全有 ⇒ 集合；全无 ⇒ `[]`；**有有有无 ⇒ 不知道**（这才是真缺口）。
 */
export function unionOrUnknown(
  cases: readonly CaseResult[],
  pick: (c: CaseResult) => string | undefined,
): readonly string[] | undefined {
  if (cases.length === 0) return undefined;
  const values = cases.map(pick);
  const known = values.filter((v): v is string => v !== undefined);
  if (known.length === 0) return [];
  if (known.length !== values.length) return undefined;
  return [...new Set(known)].sort();
}

/**
 * 按资产聚合命中。同一个资产出现在 N 条用例里就是 N 条 `cases`。
 *
 * 重复调用（同一技能在一轮里被调 3 次）**不**重复计数：这里要回答的是「哪条用例
 * 走过它」，不是「调了几次」。调了几次看 trace，那才是它的位置。
 */
export function aggregateHits(cases: readonly CaseResult[]): AssetHit[] {
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
