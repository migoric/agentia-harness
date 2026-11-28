import { type AgentStopReason, isSuccessStopReason } from '@migor/agentia';
import type { EvalReport } from '../evals/types.js';
import { fingerprint } from '../util/hash.js';
import type { FailureKind, FailureMode, FailureSample, TargetHint } from './types.js';

/**
 * 采集 —— 从一份评测报告里取出失败样本。
 *
 * 刻意只吃 `EvalReport` 而不去吃原始 trace 文件：报告里的用例名与断言失败文本
 * 已经是**面向失败**的投影，直接进归因；trace 留给「需要看某条具体链路」的时候
 * （`harness trace <id>`）。
 *
 * 但**资产命中必须一起取**：`CaseResult.skills` 是「这条失败该改哪个文件」的唯一
 * 数据来源，丢了它提案就只能猜第一个 agent。
 */
export function collectFailures(report: EvalReport): FailureSample[] {
  return report.cases
    .filter((c) => !c.passed)
    .map((c) => ({
      case: c.name,
      failures: c.failures,
      stopReason: c.stopReason,
      tokens: c.tokens,
      iterations: c.iterations,
      excerpt: c.excerpt,
      ...(c.traceId !== undefined ? { traceId: c.traceId } : {}),
      skills: c.skills,
      subagents: c.subagents,
      // 谁答的 —— 提案的「主 system」候选靠它，而不是靠 assets.agents[0]
      ...(c.routedTo !== undefined ? { routedTo: c.routedTo } : {}),
    }));
}

/**
 * 归因 —— 把失败样本聚成失败模式。
 *
 * **规则式而非 LLM 式**，这是刻意的：归因是 RSI 的地基，如果它本身不确定，
 * 后面所有环节都在流沙上。规则能单测、能解释、零成本，且面对「工具没调」
 * 这类失败比 LLM 判得更准（LLM 容易给出「提示词不够清晰」这种万能结论）。
 *
 * LLM 该出场的地方是**提案**（怎么改），不是归因（哪里坏了）。
 */
export function attribute(samples: readonly FailureSample[]): FailureMode[] {
  const groups = new Map<string, FailureSample[]>();
  for (const s of samples) {
    const { kind, signature } = classify(s);
    const key = `${kind}::${signature}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [s]);
    else list.push(s);
  }

  const modes: FailureMode[] = [];
  for (const [key, list] of groups) {
    const idx = key.indexOf('::');
    const kind = key.slice(0, idx) as FailureKind;
    const signature = key.slice(idx + 2);
    modes.push({
      id: `${kind}:${fingerprint(key)}`,
      kind,
      signature,
      count: list.length,
      cases: [...new Set(list.map((s) => s.case))].sort(),
      samples: list.slice(0, 5),
      targets: targetsOf(list),
    });
  }
  // 失败最多的先处理：一次改动能修好更多用例的价值更高
  return modes.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

/**
 * 这个失败模式该改哪些资产 —— 按「走过它的失败用例数」降序。
 *
 * 排序里有一条额外的偏好：**同样多的用例时技能优先于 agent**。理由是精确性 ——
 * 一个被调用的技能出错，改技能正文比改整个 agent 的 system 影响面小得多，而
 * 影响面小正是 RSI 敢动的前提。
 *
 * **主 agent 刻意不在这张表里**（哪怕 `routedTo` 告诉我们是谁答的）：它几乎覆盖
 * 全部失败用例，按数量排必然第一，于是每一次提案都会去改最宽的那份提示词 ——
 * 上一条偏好就名存实亡了。它由 `targets.ts` 作为**候选表末尾**的兜底，只在前面
 * 那些目标试不出来时才轮到。
 */
function targetsOf(samples: readonly FailureSample[]): TargetHint[] {
  const byTarget = new Map<string, Set<string>>();
  const add = (target: string, c: string): void => {
    const set = byTarget.get(target);
    if (set === undefined) byTarget.set(target, new Set([c]));
    else set.add(c);
  };
  for (const s of samples) {
    for (const n of s.skills) add(`skill:${n}`, s.case);
    for (const n of s.subagents) add(`agent:${n}`, s.case);
  }
  return [...byTarget.entries()]
    .map(([target, cases]) => ({ target, cases: [...cases].sort() }))
    .sort(
      (a, b) =>
        b.cases.length - a.cases.length ||
        rank(a.target) - rank(b.target) ||
        a.target.localeCompare(b.target),
    );
}

function rank(target: string): number {
  return target.startsWith('skill:') ? 0 : 1;
}

/** 单条样本 → (kind, 归一化签名)。归一化是为了让「同样的坏法」能落到同一个桶里 */
export function classify(s: FailureSample): { kind: FailureKind; signature: string } {
  const pats = s.failures.map(normalizeFailure);
  const joined = [...new Set(pats)].sort().join(' | ');

  const kind: FailureKind = (() => {
    if (pats.some((p) => p === 'token 超预算')) return 'budget';
    if (pats.some((p) => p === '工具序列不符')) return 'tool_misuse';
    if (pats.some((p) => p.startsWith('run 抛出'))) return 'tool_error';
    if (s.stopReason === 'max_iterations') return 'loop';
    if (!isNormalStop(s.stopReason)) return 'stop_abnormal';
    if (pats.some((p) => p.startsWith('正文缺少') || p.startsWith('正文不匹配'))) {
      return 'wrong_answer';
    }
    return 'unknown';
  })();

  return { kind, signature: joined === '' ? `${s.stopReason}` : joined };
}

/**
 * 把具体的断言失败文本压成模式。
 *
 * 只压「值」，不压「种类」：`正文缺少 "严重"` 与 `正文缺少 "P1"` 是同一类坏法
 * （模型没给出结论），但 `正文缺少` 与 `工具序列不符` 不能合并 —— 修法完全不同。
 */
function normalizeFailure(text: string): string {
  if (text.startsWith('token 超预算')) return 'token 超预算';
  if (text.startsWith('工具序列不符')) return '工具序列不符';
  if (text.startsWith('正文缺少')) return '正文缺少内容';
  if (text.startsWith('正文不匹配')) return '正文不匹配模式';
  if (text.startsWith('期望正常收尾')) return '期望正常收尾但未收尾';
  if (text.startsWith('期望非正常收尾')) return '期望非正常收尾但正常收尾';
  if (text.startsWith('run 抛出')) return 'run 抛出异常';
  return text;
}

function isNormalStop(reason: string): boolean {
  // 单源：不在 harness 里另维护一份「哪些算正常收尾」的表
  return isSuccessStopReason(reason as AgentStopReason);
}
