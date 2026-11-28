/**
 * 「已写盘、待判定」的记录 —— 远程验证的崩溃安全带。
 *
 * 本地 RSI 的写盘顺序是「验证通过 → 落盘」，所以中途崩掉最多丢一轮工作。远程不一样：
 * 候选必须先**写到服务读的那个文件**才可能被看见，于是顺序反过来成了「先写盘 → 再验证」。
 * 中间任何一步崩掉，盘上就留着一个**没被验证过**的提示词，而 `journal` 里没有任何记录
 * （它只记已采纳）。人在第二天看到的现象是「服务的话术好像不太对」，而账本是干净的。
 *
 * 所以这里记两件事：**要还原哪个文件、从哪份备份还原**。恢复的动作是幂等的
 * （把备份内容写回去 + 重载），重复执行没有副作用 —— 崩溃点落在「已还原但还没删记录」
 * 之间时，下次启动会再还原一遍，这是对的。
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { WorkspacePaths } from '../config.js';
import { HarnessError } from '../errors.js';
import { atomicWrite } from './journal.js';

export interface PendingStage {
  readonly schema: 1;
  readonly proposalId: string;
  /** 资产目标，如 `agent:report` */
  readonly target: string;
  /** 被写入的文件（绝对路径） */
  readonly file: string;
  /** 原内容的备份（绝对路径） */
  readonly backup: string;
  readonly startedAt: string;
}

export function pendingPaths(p: WorkspacePaths): { record: string; dir: string } {
  const dir = join(p.workspaceDir, 'rsi', 'pending');
  return { record: join(p.workspaceDir, 'rsi', 'pending.json'), dir };
}

export function readPending(p: WorkspacePaths): PendingStage | undefined {
  const { record } = pendingPaths(p);
  if (!existsSync(record)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(record, 'utf8'));
  } catch (err) {
    // 半截 JSON 意味着「崩溃点正好在写这条记录时」—— 但我们用原子写，正常不会发生。
    // 发生了就说明有人手改或磁盘出问题：拒绝继续，让人看一眼，别自动猜
    throw new HarnessError(
      'rsi.bad_record',
      `${record} 不是合法 JSON（${err instanceof Error ? err.message : String(err)}）。` +
        '它记录「哪个提示词被写过、该怎么还原」—— 修好它之前不要继续，' +
        '否则远程可能停在一个没被验证过的版本上',
    );
  }
  const o = raw as Partial<PendingStage>;
  if (o.schema !== 1 || typeof o.file !== 'string' || typeof o.backup !== 'string') {
    throw new HarnessError('rsi.bad_record', `${record} 缺少必要字段（schema/file/backup）`);
  }
  return {
    schema: 1,
    proposalId: String(o.proposalId ?? 'unknown'),
    target: String(o.target ?? 'unknown'),
    file: o.file,
    backup: o.backup,
    startedAt: String(o.startedAt ?? ''),
  };
}

/** 备份原内容 + 写记录。**顺序固定**：先备份，再写记录 —— 反过来会留下「有记录、无备份」 */
export function beginPending(
  p: WorkspacePaths,
  info: { proposalId: string; target: string; file: string },
): PendingStage {
  // 已有一条未回收的记录 ⇒ 拒绝覆盖。覆盖的后果不是「多写一份备份」，而是
  // **上一份备份的路径从此没有任何引用**：那个文件停在一个没被验证过的版本上，
  // 而新记录声称该还原的是另一个文件。恢复协议只能处理一条记录，所以这里必须停。
  const existing = readPending(p);
  if (existing !== undefined) {
    throw new HarnessError(
      'rsi.bad_record',
      `上一次远程验证没有收尾：提案 ${existing.proposalId} 的候选还留在 ${existing.file}，` +
        `备份在 ${existing.backup}。先让它自动回收（再跑一次 rsi / rsi accept 即可），` +
        '或人工确认该文件内容后删掉 pending.json —— 不要直接开始新一轮覆盖它。',
    );
  }
  const { record, dir } = pendingPaths(p);
  mkdirSync(dir, { recursive: true });
  sweepOrphanBackups(p);
  const backup = join(dir, `${info.proposalId.replace(/[^\w.-]/g, '_')}-${Date.now()}.bak`);
  const original = readFileSync(info.file, 'utf8');
  writeFileSync(backup, original, 'utf8');
  const stage: PendingStage = {
    schema: 1,
    proposalId: info.proposalId,
    target: info.target,
    file: info.file,
    backup,
    startedAt: new Date().toISOString(),
  };
  atomicWrite(record, `${JSON.stringify(stage, null, 2)}\n`);
  return stage;
}

export function clearPending(p: WorkspacePaths): void {
  const { record } = pendingPaths(p);
  try {
    unlinkSync(record);
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') throw err;
  }
}

/** 从备份还原文件内容；备份没了就是真出事，不猜 */
export function restoreFromPending(stage: PendingStage): void {
  if (!existsSync(stage.backup)) {
    throw new HarnessError(
      'rsi.bad_record',
      `备份不见了：${stage.backup}。${stage.file} 可能停在一个没被验证过的版本上 —— ` +
        '手工确认该文件的期望内容后，删掉 pending.json 再继续',
    );
  }
  atomicWrite(stage.file, readFileSync(stage.backup, 'utf8'));
}

/**
 * 收尾：**先删记录，再删备份**。
 *
 * 顺序反过来（旧实现）会造出一个不可恢复的死锁：删完备份、还没来得及删记录时被
 * kill，下次启动 `recoverPending` → `restoreFromPending` 发现「备份不见了」→ 抛
 * `rsi.bad_record`，于是每次启动都失败，而文件其实早就还原过了。人只能手动删
 * pending.json 才能继续 —— 一个纯由清理顺序造成的、要求人工介入的故障。
 *
 * 现在崩在这个窗口里只会留下一个**孤儿备份**（无害，`sweepOrphanBackups` 会清），
 * 而「记录指向不存在的备份」这个状态不再可能产生。
 */
export function finishPending(p: WorkspacePaths, stage: PendingStage): void {
  clearPending(p);
  rmSync(stage.backup, { force: true });
}

/**
 * 清掉过期的备份文件 —— 让「先删记录」的安全代价不累积。
 *
 * 只删 `.bak`，只删超过一天的：一天之内还有可能是正在用、只是记录被手删了的那种，
 * 留给人一点反应时间。清不掉不报错：孤儿备份占的是磁盘，不是正确性。
 */
export function sweepOrphanBackups(p: WorkspacePaths, keepMs = 24 * 60 * 60_000): number {
  const { dir } = pendingPaths(p);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - keepMs;
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.bak')) continue;
    const file = join(dir, name);
    try {
      if (statSync(file).mtimeMs > cutoff) continue;
      unlinkSync(file);
      removed += 1;
    } catch {
      // 并发删除/权限问题都不该让一次正常的 RSI 启动失败
    }
  }
  return removed;
}
