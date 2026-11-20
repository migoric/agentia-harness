import type { Span, Trace } from '@migor/agentia';
import type { GateResult } from '../evals/gate.js';
import type { EvalReport } from '../evals/types.js';

/**
 * 终端渲染 —— 纯函数，不碰 IO。
 *
 * 抽出来的理由是可测：`harness trace` 的输出本身就是诊断结论的载体，如果它只能靠
 * 「人看一眼」验证，那它坏了也没人知道。这里的每个函数都对着一份现成的 Trace /
 * EvalReport 断言。
 */

export function renderTrace(trace: Trace, opts: { maxDepth?: number } = {}): string {
  const maxDepth = opts.maxDepth ?? 12;
  const children = new Map<string | null, Span[]>();
  for (const s of [...trace.spans].sort((a, b) => a.startedAt - b.startedAt)) {
    const list = children.get(s.parentSpanId);
    if (list === undefined) children.set(s.parentSpanId, [s]);
    else list.push(s);
  }

  const u = trace.totalUsage;
  const lines = [
    `trace ${trace.traceId}  ${trace.status}  ${trace.spans.length} span  ` +
      `in ${u.inputTokens} / out ${u.outputTokens} token`,
  ];

  const walk = (parent: string | null, prefix: string, depth: number): void => {
    const list = children.get(parent) ?? [];
    // 整层折叠成一行，而不是每层都印一个 `…`：截断是为了看清骨架，不是制造噪声
    if (depth > maxDepth) {
      if (list.length > 0) lines.push(`${prefix}└─ …（还有 ${list.length} 个 span）`);
      return;
    }
    list.forEach((s, i) => {
      const last = i === list.length - 1;
      lines.push(`${prefix}${last ? '└─' : '├─'} ${spanLabel(s)}`);
      const nextPrefix = `${prefix}${last ? '   ' : '│  '}`;
      for (const e of s.events) lines.push(`${nextPrefix}· ${e.name}`);
      walk(s.spanId, nextPrefix, depth + 1);
    });
  };

  // 根 span 可能是多个（正常只有一个 run）；没有根时整片平铺，不假装有层级
  const roots = children.get(null) ?? [];
  if (roots.length === 0) {
    for (const s of trace.spans) lines.push(`· ${spanLabel(s)}`);
    return lines.join('\n');
  }
  walk(null, '', 0);
  return lines.join('\n');
}

function spanLabel(s: Span): string {
  const bits: string[] = [s.kind];
  if (s.name !== '') bits.push(s.name);
  bits.push(s.status === 'error' ? 'ERROR' : 'ok');
  bits.push(s.endedAt === undefined ? '未闭合' : fmtMs(s.endedAt - s.startedAt));
  const marks = marksOf(s);
  if (marks.length > 0) bits.push(`[${marks.join(' ')}]`);
  if (s.error !== undefined) bits.push(`— ${s.error.message}`);
  return bits.join('  ');
}

function marksOf(s: Span): string[] {
  const attrs = s.attributes as Record<string, unknown>;
  const marks: string[] = [];
  if (attrs.skill !== undefined) marks.push('skill');
  if (attrs.subagent !== undefined) marks.push('subagent');
  const from = attrs['agentia.handoff.from'];
  const to = attrs['agentia.handoff.to'];
  if (typeof from === 'string' && typeof to === 'string') marks.push(`${from}→${to}`);
  return marks;
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

export function renderReport(report: EvalReport): string {
  const lines: string[] = [];
  for (const c of report.cases) {
    lines.push(`${c.passed ? 'PASS' : 'FAIL'}  ${c.name}  (${c.tokens} token, ${c.iterations} 轮)`);
    for (const f of c.failures) lines.push(`      - ${f}`);
  }
  lines.push(
    `\n${report.passed}/${report.total} 通过（${(report.passRate * 100).toFixed(1)}%）· ` +
      `${report.tokens} token · 资产 ${report.assetFingerprint}`,
  );
  if (report.skillHits.length > 0) {
    lines.push('命中：');
    for (const h of report.skillHits) {
      lines.push(`  ${h.target}  ${h.cases.length} 条用例（${h.cases.join(', ')}）`);
    }
  }
  return lines.join('\n');
}

/**
 * 两份报告 + 门结论。
 *
 * 刻意把 gate 的 code 也打出来（不只是 ok/否）：`case_regression` 与
 * `token_regression` 的处理方式完全不同 —— 前者要回退，后者可以商量。
 */
export function renderComparison(
  baseline: EvalReport,
  candidate: EvalReport,
  g: GateResult,
): string {
  const lines = [
    `基线  ${baseline.passed}/${baseline.total}（${(baseline.passRate * 100).toFixed(1)}%）· ${baseline.tokens} token · ${baseline.assetFingerprint}`,
    `候选  ${candidate.passed}/${candidate.total}（${(candidate.passRate * 100).toFixed(1)}%）· ${candidate.tokens} token · ${candidate.assetFingerprint}`,
    '',
    `门：${g.ok ? 'PASS' : 'BLOCK'} (${g.code}) —— ${g.reason}`,
  ];
  if (g.sameAssets) {
    lines.push('注意：两次跑分的资产指纹相同 —— 差异只反映采样随机性，不能当结论。');
  }
  const before = new Map(baseline.cases.map((c) => [c.name, c]));
  const after = new Map(candidate.cases.map((c) => [c.name, c]));
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const tag = (name: string): string => {
    const b = before.get(name)?.passed;
    const a = after.get(name)?.passed;
    if (b === true && a === false) return `- ${name}  PASS → FAIL`;
    if (b === false && a === true) return `+ ${name}  FAIL → PASS`;
    if (b === undefined) return `? ${name}  仅候选有`;
    if (a === undefined) return `? ${name}  仅基线有`;
    return `= ${name}  ${b ? 'PASS' : 'FAIL'}`;
  };
  for (const n of names) lines.push(`  ${tag(n)}`);
  return lines.join('\n');
}
