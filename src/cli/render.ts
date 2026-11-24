import type { DiffEntry, Span, Trace, TraceDiff } from '@migor/agentia';
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

/** `undefined` = 无读数，打空串而不是 `$0.0000`（那会被读成「免费」） */
function fmtCost(usd: number | undefined): string {
  if (usd === undefined) return '';
  return usd < 0.01 ? ` $${usd.toFixed(5)}` : ` $${usd.toFixed(3)}`;
}

export function renderReport(report: EvalReport): string {
  const lines: string[] = [];
  for (const c of report.cases) {
    lines.push(
      `${c.passed ? 'PASS' : 'FAIL'}  ${c.name}  (${c.tokens} token${fmtCost(c.costUsd)}, ${c.iterations} 轮)` +
        // 只给失败用例附上 traceId：成功用例也可以有，但打出来全是噪声
        (c.passed || c.traceId === undefined ? '' : `  trace ${c.traceId}`),
    );
    for (const f of c.failures) lines.push(`      - ${f}`);
  }
  lines.push(
    `\n${report.passed}/${report.total} 通过（${(report.passRate * 100).toFixed(1)}%）· ` +
      `${report.tokens} token${report.costKnown ? fmtCost(report.costUsd) : ''} · 资产 ${report.assetFingerprint}`,
  );
  if (!report.costKnown) {
    // 条件刻意**不是** `costUsd > 0`：模型不在价格表里时总成本恰好是 0，而那正是
    // 「这轮根本没有读数」的常态 —— 按 >0 判会让最该看到这句话的人看不到它。
    lines.push(
      '注意：有成本读数缺失的用例（模型不在价格表里 / 端点没报计量），总成本不可用于跨轮比较，' +
        '回归门会退回按 token 判。',
    );
  }
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
    `基线  ${baseline.passed}/${baseline.total}（${(baseline.passRate * 100).toFixed(1)}%）· ${baseline.tokens} token${baseline.costKnown ? fmtCost(baseline.costUsd) : ''} · ${baseline.assetFingerprint}`,
    `候选  ${candidate.passed}/${candidate.total}（${(candidate.passRate * 100).toFixed(1)}%）· ${candidate.tokens} token${candidate.costKnown ? fmtCost(candidate.costUsd) : ''} · ${candidate.assetFingerprint}`,
    `环境  模型 ${fmtModel(baseline)} → ${fmtModel(candidate)} · ` +
      `agent ${baseline.agent} → ${candidate.agent} · ` +
      `harness ${baseline.harnessVersion ?? '未记录'} → ${candidate.harnessVersion ?? '未记录'}`,
    '',
    `门：${g.ok ? 'PASS' : 'BLOCK'} (${g.code}) —— ${g.reason}`,
  ];
  if (g.sameAssets && g.sameCaseSet !== false) {
    // 用例集不同时差异有明确来源（新/删用例），再喊「只是采样随机性」就是误导
    lines.push('注意：两次跑分的资产指纹相同 —— 差异只反映采样随机性，不能当结论。');
  }
  if (g.sameModel === false) {
    // 跨模型对比是合法实验，但阈值是按「同一个模型」的噪声水平定的
    lines.push('注意：两次跑分用的不是同一个模型 —— 通过率与成本的增减不能直接读成改动效果。');
  }
  if (!g.sameAgent) {
    lines.push('注意：两次跑分的 agent 不同（name@version 不一致）—— 比的可能不是同一个东西。');
  }
  if (g.sameCaseSet === false) {
    if (g.onlyInBaseline.length === 0 && g.onlyInCandidate.length === 0) {
      lines.push(
        '注意：用例名相同但任务/断言被改过 —— 通过率变化反映的是判定标准变了，不是 agent 变了。',
      );
    } else {
      lines.push(
        `注意：用例集不同（仅基线有 ${g.onlyInBaseline.length} 条，仅候选有 ${g.onlyInCandidate.length} 条）—— ` +
          '通过率的分母不一样，只有同名用例可比。',
      );
    }
  } else if (g.sameCaseSet === undefined && g.onlyInBaseline.length === 0) {
    lines.push('注意：报告没记用例集指纹（老报告）—— 只能确认用例名相同，断言是否一致无从判断。');
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

/**
 * 报告里的模型集合 + 降级次数。
 *
 * 打印集合而不是单值：配了 fallback 链之后「用了哪个模型」可能不是一个名字。
 * 只在真有降级时写次数 —— 每份报告都挂个「降级 0 次」只会让人忽略这一栏。
 */
function fmtModel(r: EvalReport): string {
  const set =
    r.models !== undefined && r.models.length > 0
      ? r.models
      : r.model !== undefined
        ? [r.model]
        : [];
  if (set.length === 0) return '未记录';
  const fb =
    r.fallbackUsed !== undefined && r.fallbackUsed > 0 ? `（降级 ${r.fallbackUsed} 次）` : '';
  return set.join(' + ') + fb;
}

/** span 级差异最多打这么多条 —— 再多的部分交给 `--json`，终端里刷屏等于没有输出 */
const DIFF_SPAN_LIMIT = 40;

/**
 * `harness diff` 的渲染 —— 两份 trace 差在哪。
 *
 * 与 `renderTrace` 的分工：那个回答「这次发生了什么」，这个回答「两次差在哪」。
 * 归因真正需要的是后者：`case 3 从通过变失败` 只是结论，`第 2 回合少了 search`
 * 才是能改的东西。
 *
 * 缺侧单独一行说清是「仅 A 有」还是「仅 B 有」—— 用 `undefined → undefined` 那种
 * 字段级写法表达缺侧，人会读成「两边都没值」。
 */
export function renderDiff(a: Trace, b: Trace, d: TraceDiff): string {
  const lines = [
    `A ${a.traceId}  ${a.status}  ${a.spans.length} span`,
    `B ${b.traceId}  ${b.status}  ${b.spans.length} span`,
  ];
  if (d.equal) {
    lines.push('', '无差异 —— 结构、字段与用量都一致（时序默认忽略）');
    return lines.join('\n');
  }
  if (d.summary.length > 0) {
    lines.push('', 'run 级');
    for (const e of d.summary) lines.push(`  ${e.field}  ${sided(e)}`);
  }
  if (d.spans.length > 0) {
    lines.push('', `span 级（${d.spans.length} 处）`);
    for (const s of d.spans.slice(0, DIFF_SPAN_LIMIT)) {
      lines.push(`  ${s.path}`);
      lines.push(`    ${presence(s)}`);
      for (const e of s.fields) lines.push(`    ${e.field}  ${sided(e)}`);
    }
    if (d.spans.length > DIFF_SPAN_LIMIT) {
      lines.push(`  …还有 ${d.spans.length - DIFF_SPAN_LIMIT} 处（用 --json 看全部）`);
    }
  }
  return lines.join('\n');
}

/** 缺侧的那一行 —— 说「谁没有」比说「字段为空」有用 */
function presence(s: { a: Span | undefined; b: Span | undefined }): string {
  if (s.a === undefined) return `仅 B 有：${s.b?.kind ?? '?'} ${s.b?.name ?? ''}`;
  if (s.b === undefined) return `仅 A 有：${s.a.kind} ${s.a.name}`;
  return '两侧都有，字段差异：';
}

function sided(e: DiffEntry): string {
  return `${fmtSide(e.a)} → ${fmtSide(e.b)}`;
}

function fmtSide(v: unknown): string {
  if (v === undefined) return '（无）';
  if (typeof v === 'string') return truncate(v);
  if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
  if (typeof v === 'boolean') return String(v);
  try {
    return truncate(JSON.stringify(v) ?? String(v));
  } catch {
    return String(v);
  }
}

function truncate(text: string): string {
  const MAX = 90;
  return text.length <= MAX ? text : `${text.slice(0, MAX)}…`;
}
