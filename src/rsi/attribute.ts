import { type AgentStopReason, isSuccessStopReason } from '@migor/agentia';
import type { EvalReport } from '../evals/types.js';
import { fingerprint } from '../util/hash.js';
import type { FailureKind, FailureMode, FailureSample } from './types.js';

/**
 * 采集 —— 从一份评测报告里取出失败样本。
 *
 * 刻意只吃 `EvalReport` 而不去吃原始 trace 文件：报告里的用例名与断言失败文本
 * 已经是**面向失败**的投影，直接进归因；trace 留给「需要看某条具体链路」的时候
 * （`harness trace <id>`）。
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
    });
  }
  // 失败最多的先处理：一次改动能修好更多用例的价值更高
  return modes.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
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
