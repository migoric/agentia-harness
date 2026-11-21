import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import type { EvalReport, EvalSplit } from '../evals/types.js';
import { readTraceLines, type TraceLine } from '../run/trace-read.js';
import { fingerprint } from '../util/hash.js';
import { attribute, collectFailures } from './attribute.js';
import { atomicWrite } from './journal.js';
import type { FailureMode } from './types.js';

/**
 * 经验可观测 —— 把一堆 trace 蒸馏成**分层证据语料**。
 *
 * 不把原始 trace 整坨塞进提案器提示词：真实 trace 动辄几十万 token，塞进去的结果是
 * 关键失败被噪声淹没，而且成本爆炸。这里产出三层：
 * - `overview.md`：失败模式分布 + 指向明细的链接（提案器读这一层）；
 * - `detail/*.md`：每条用例的任务、断言失败、工具序列、技能命中（人/提案器按需读）；
 * - `raw/*.jsonl`：原始 trace，原样保留（要查 span 细节时回看）。
 *
 * 每份语料带 `id`、不可覆盖：证据是事后审计物，覆盖等于销毁历史。
 */
export interface EvidenceItem {
  readonly case: string;
  readonly task: string;
  readonly split: EvalSplit;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly traceId: string | undefined;
  /** 多轮用例的计划轮数；单轮缺席 */
  readonly turns?: number | undefined;
  readonly detail: string;
  readonly raw: string | undefined;
}

export interface EvidenceCorpus {
  readonly id: string;
  readonly dir: string;
  readonly indexPath: string;
  readonly overviewPath: string;
  readonly createdAt: number;
  readonly items: readonly EvidenceItem[];
  /** 报告说有 traceId、但 traces.jsonl 里已经找不到的用例（可能被轮转/截断） */
  readonly missingTraces: readonly string[];
  /** traces.jsonl 里跳过的坏行数（进程被杀留下的半截 JSON） */
  readonly badLines: number;
  /**
   * 读不到 traces.jsonl 时的原因（例如评测没开 `--keep-traces`）。
   * 不抛错：报告里的 traceId 会逐条落进 missingTraces，证据仍然可用。
   */
  readonly traceReadError: string | undefined;
  readonly modes: readonly FailureMode[];
}

export interface EvidenceOptions {
  /** 语料 id；缺省按时间生成。只允许字母数字 _ -（会当目录名） */
  readonly id?: string | undefined;
  readonly now?: number | undefined;
}

export function buildEvidenceCorpus(
  config: HarnessConfig,
  report: EvalReport,
  opts: EvidenceOptions = {},
): EvidenceCorpus {
  const id = opts.id ?? `ev-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    throw new HarnessError(
      'config.invalid',
      `证据语料 id "${id}" 含非法字符（只认字母数字 _ -，它会当目录名）`,
    );
  }
  const dir = join(config.workspaceDir, 'evidence', id);
  if (existsSync(dir)) {
    throw new HarnessError('rsi.no_signal', `证据语料 ${id} 已存在（${dir}）—— 不覆盖历史证据`);
  }
  mkdirSync(join(dir, 'detail'), { recursive: true });
  mkdirSync(join(dir, 'raw'), { recursive: true });

  // 只在报告真带 traceId 时读 trace 文件：没开 --keep-traces 的评测也该能导出证据
  const withTrace = report.cases.filter((c) => c.traceId !== undefined);
  const rawByTrace = new Map<string, string>();
  let badLines = 0;
  let traceReadError: string | undefined;
  if (withTrace.length > 0) {
    let entries: TraceLine[] = [];
    try {
      const loaded = readTraceLines(config.tracesPath);
      entries = loaded.entries;
      badLines = loaded.bad;
    } catch (e) {
      traceReadError = e instanceof Error ? e.message : `读不到 ${config.tracesPath}`;
    }
    // 用解析器已经配对好的 (trace,line)：坏行被跳过后按下标硬配会把下一条的 raw 存成坏行
    for (const e of entries) rawByTrace.set(e.trace.traceId, e.line);
  }

  const missingTraces: string[] = [];
  const items: EvidenceItem[] = report.cases.map((c) => {
    const traceId = c.traceId;
    const rawLine = traceId === undefined ? undefined : rawByTrace.get(traceId);
    const raw = rawLine === undefined ? undefined : `raw/${safeFile(traceId as string)}.jsonl`;
    if (traceId !== undefined && raw === undefined) missingTraces.push(c.name);
    const detail = `detail/${safeFile(c.name)}.md`;
    writeFileSync(join(dir, detail), renderDetail(c, raw, traceId), 'utf8');
    if (raw !== undefined && rawLine !== undefined) {
      writeFileSync(join(dir, raw), `${rawLine}\n`, 'utf8');
    }
    return {
      case: c.name,
      task: c.task,
      ...(c.turns === undefined ? {} : { turns: c.turns }),
      split: c.split ?? 'train',
      passed: c.passed,
      failures: c.failures,
      traceId,
      detail,
      raw,
    };
  });

  const modes = attribute(collectFailures(report));
  const corpus: EvidenceCorpus = {
    id,
    dir,
    indexPath: join(dir, 'index.json'),
    overviewPath: join(dir, 'overview.md'),
    createdAt: opts.now ?? Date.now(),
    items,
    missingTraces,
    badLines,
    traceReadError,
    modes,
  };
  atomicWrite(corpus.indexPath, `${JSON.stringify(corpus, null, 2)}\n`);
  writeFileSync(corpus.overviewPath, renderOverview(corpus), 'utf8');
  return corpus;
}

/** 文件名永远带内容指纹：不同用例同名清洗后不会互相覆盖 */
function safeFile(name: string): string {
  const stem = name
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${stem || 'case'}-${fingerprint(name)}`;
}

function renderDetail(
  c: EvalReport['cases'][number],
  raw: string | undefined,
  traceId: string | undefined,
): string {
  return [
    `# 证据：${c.name}`,
    '',
    `- 分组：${c.split ?? 'train'} · 结果：${c.passed ? '通过' : '失败'} · stop=${c.stopReason}`,
    `- token=${c.tokens} · iterations=${c.iterations}${c.costUsd === undefined ? '' : ` · $${c.costUsd}`}`,
    `- trace：${traceId ?? '无'}${raw === undefined ? '' : `（原样存于 ${raw}）`}`,
    ...(c.turns === undefined
      ? []
      : [`- 轮次：${c.turns}（多轮会话；上面的 trace 只是最后一轮，不是整段）`]),
    `- 技能：${c.skills.join(', ') || '无'} · 子 agent：${c.subagents.join(', ') || '无'}`,
    '',
    '## 任务原文',
    '',
    c.task,
    '',
    '## 断言失败',
    '',
    ...(c.failures.length === 0 ? ['无'] : c.failures.map((f) => `- ${f}`)),
    '',
    '## 实际输出（截断）',
    '',
    '```',
    c.excerpt,
    '```',
    '',
  ].join('\n');
}

function renderOverview(c: EvidenceCorpus): string {
  const failed = c.items.filter((i) => !i.passed).length;
  const holdout = c.items.filter((i) => i.split === 'holdout').length;
  const lines = [
    `# 证据语料 ${c.id}`,
    '',
    `- 生成时间：${new Date(c.createdAt).toISOString()}`,
    `- 用例：${c.items.length}（失败 ${failed}；train ${c.items.length - holdout} / holdout ${holdout}）`,
    '',
    '## 失败模式（规则式归因，与提案输入同源）',
    '',
  ];
  if (c.modes.length === 0) lines.push('无');
  for (const m of c.modes.slice(0, 10)) {
    lines.push(
      `- \`mode:${m.id}\` [${m.kind}] ×${m.count}：${m.signature} — ${m.cases.join(', ')}`,
    );
  }
  lines.push('', '## 明细', '');
  for (const i of c.items) {
    // 多轮用例的 raw 只存最后一轮（traceId 是合并视图的锚点）—— 不标注会让人
    // 以为这一段就是全部证据，然后照着半截会话去改提示词
    const extra = i.turns === undefined ? '' : `（${i.turns} 轮，raw 仅末轮）`;
    lines.push(`- [${i.case}](${i.detail}) — ${i.passed ? 'pass' : 'FAIL'}${extra}`);
  }
  if (c.badLines > 0) lines.push('', `跳过了 ${c.badLines} 行无法解析的 trace 记录。`);
  if (c.traceReadError !== undefined) lines.push('', `原始 trace 读取失败：${c.traceReadError}`);
  if (c.missingTraces.length > 0) {
    lines.push('', '## 找不到原始 trace 的用例', '', ...c.missingTraces.map((n) => `- ${n}`));
  }
  lines.push('', '索引：`index.json`（机器可读）', '');
  return lines.join('\n');
}
