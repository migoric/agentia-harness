import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HarnessConfig } from '../config.js';
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

/** tmp + rename：写到一半崩了不会留下半个文件 */
export function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.rsi-tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}
