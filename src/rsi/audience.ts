import type { EvalReport } from '../evals/types.js';
import type { Audience, AudienceOf } from './propose-prompt.js';

/**
 * 「这个资产还被哪些用例用着」—— 从基线报告反查。
 *
 * 存在的理由是一条真机观测（2026-11-28）：连续两轮，提案都改对了目标、修好了目标用例，
 * 却各自弄坏**另一条原本通过**的用例（`triage-invoice` / `triage-outage`），被回归门
 * 整条否决。模型看得到的只有「失败的那一条」，它不知道这份正文同时服务着谁 ——
 * 于是它为修一条把另一条写坏，而那次评测的钱已经花了。
 *
 * 判据本身不变（任何一条通过变失败仍然否决）：这里只是把**同一批评测的结论提前告诉
 * 提案者**，把一次必然被打回的尝试省下来。
 *
 * 匹配规则与 `attribute.ts` 的 `targetsOf` 同源，否则会出现「模型被告知的是这批用例、
 * 门比较的却是另一批」：
 * - `skill:x` ⇒ 这次运行里调用过 `x` 的用例（`CaseResult.skills`）；
 * - `agent:x` ⇒ 派给过 `x` 的用例（`subagents` 含它），以及把活的 `routedTo` 是它的用例。
 *
 * 老报告（`routedTo` 与 `subagents` 都没有）里无法区分谁答的，此时把 agent 目标当作
 * 「全部用例都用它」—— 那是单 agent 工程的实际情况，而误报成「没人用」会让模型以为
 * 可以随便改，比保守更糟。
 */
export function audienceFrom(report: EvalReport): AudienceOf {
  const routedKnown = report.cases.some((c) => c.routedTo !== undefined);

  return (target: string): Audience | undefined => {
    const sep = target.indexOf(':');
    if (sep === -1) return undefined;
    const kind = target.slice(0, sep);
    const name = target.slice(sep + 1);
    if (kind !== 'skill' && kind !== 'agent') return undefined;

    const hit = report.cases.filter((c) =>
      kind === 'skill'
        ? c.skills.includes(name)
        : c.subagents.includes(name) || c.routedTo === name || !routedKnown,
    );
    if (hit.length === 0) return undefined;
    return {
      passing: hit.filter((c) => c.passed).map((c) => c.name),
      failing: hit.filter((c) => !c.passed).map((c) => c.name),
    };
  };
}
