import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HarnessConfig } from '../config.js';
import { isRevertEntry } from './revert-note.js';
import type { JournalEntry } from './types.js';

/**
 * Journal —— RSI 的唯一审计线索。
 *
 * 抽成独立模块的理由不是「文件太长」，是**它有两个写入者**：文本资产（`accept.ts`）
 * 与代码补丁（`code/apply.ts`）。两份 journal 会让「这一轮到底改了什么」分裂成两个
 * 需要对齐的真相，而回滚顺序恰恰依赖它们在同一条时间线上。
 *
 * 读取侧刻意**宽容**：老记录没有 `kind` 字段（那时只有文本资产），一律按 `asset` 读；
 * 文件不存在返回空数组（第一次跑 RSI 之前的正常状态），但**解析失败要炸** —— 半截
 * JSON 意味着有人中断过写入，静默跳过会让回滚基于不完整的历史做决定。
 */
export function journalPath(config: HarnessConfig): string {
  return join(config.workspaceDir, 'rsi', 'journal.jsonl');
}

export function readJournal(config: HarnessConfig): JournalEntry[] {
  const path = journalPath(config);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => withKind(JSON.parse(l) as JournalEntry));
}

export function appendJournal(config: HarnessConfig, entry: JournalEntry): void {
  const path = journalPath(config);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
}

/** 老记录没有 `kind`（2026-11-20 之前只有文本资产）—— 补上默认值，读侧不必到处判空 */
function withKind(e: JournalEntry): JournalEntry {
  return e.kind === undefined ? { ...e, kind: 'asset' } : e;
}

/**
 * 仍生效的采纳 —— 「最近一条采纳」的**唯一**判法。
 *
 * journal 是 append-only：回滚不改原行，只追加一条回滚记录，所以原 `accepted` 行
 * 永远留在 journal 里。只看 `status === 'accepted'` 会把**已作废**的采纳当成还有效，
 * 三个症状都真实存在过：
 * - 回滚之后 `rsi regress` 仍拿已回滚的提案当基准 ⇒ 把「回滚的预期结果」报成回归；
 * - 二次 `revertLast` 撞上指纹校验，报错说「采纳之后资产又被改过」—— 真相是「已经回过了」；
 * - code 通道同款（它的回滚记录此前连 `reverted` 字段都没有）。
 *
 * 判法：`status === 'accepted'` 且**不存在**同 `kind`、同 proposalId 的回滚记录。
 * 键带 kind：手写提案的 id 与 code 提案的 id（`code-*`）字面可能相撞，
 * 一条文本回滚不该作废同名的 code 采纳。
 */
export function liveAccepted(
  entries: readonly JournalEntry[],
  kind: 'asset' | 'code',
): JournalEntry[] {
  const reverted = revertedKeys(entries);
  return entries.filter(
    (e) => e.status === 'accepted' && (e.kind ?? 'asset') === kind && !reverted.has(keyOf(kind, e)),
  );
}

/** 这条采纳**已经被回滚过**吗（报错要区分「已经回过」与「有人手改」，两者修法不同） */
export function wasReverted(
  entries: readonly JournalEntry[],
  kind: 'asset' | 'code',
  proposalId: string,
): boolean {
  return revertedKeys(entries).has(`${kind}:${proposalId}`);
}

function revertedKeys(entries: readonly JournalEntry[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const e of entries) {
    if (isRevertEntry(e)) out.add(keyOf(e.kind ?? 'asset', e));
  }
  return out;
}

function keyOf(kind: 'asset' | 'code', e: JournalEntry): string {
  return `${kind}:${e.proposalId}`;
}

/** tmp + rename：写到一半崩了不会留下半个文件 */
export function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.rsi-tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}
