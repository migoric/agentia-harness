import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HarnessError } from '../errors.js';
import { type AssetSet, assetKey } from './types.js';

/**
 * 资产锁 —— `harness.lock.json`。
 *
 * 存在理由：RSI 采纳一个提案之后，「新版本资产」必须变成一个**可提交、可回滚、
 * 可被 CI 校验**的事实。锁文件就是那个事实：它记 `{ kind:name → { version, fingerprint } }`。
 *
 * 三个使用面：
 * 1. `harness lock`：采纳后重写；
 * 2. `harness lock --check`：CI 门 —— 资产改了但没重新锁，直接失败（防「偷偷改提示词」）；
 * 3. 回滚后同步重写（`rsi/accept.ts`）—— 锁本身**不保存历史正文**，回滚读的是
 *    journal 里的 before；指定 id 的回滚也只是核对 journal 里最近一条的 proposalId。
 *
 * 刻意**不存正文**：锁是索引，正文在 git 里。存正文会让「锁」变成第二份真相，
 * 两者不一致时没人知道该信谁。
 */
export interface LockEntry {
  readonly version: string;
  readonly fingerprint: string;
}

export interface AssetLock {
  readonly version: 1;
  readonly assets: Readonly<Record<string, LockEntry>>;
}

export interface AssetDrift {
  /** 资产存在但锁里没有 */
  readonly added: readonly string[];
  /** 两边都有但指纹不一致 */
  readonly changed: readonly { key: string; locked: LockEntry; current: LockEntry }[];
  /** 锁里有但资产已删 */
  readonly removed: readonly string[];
}

const EMPTY_LOCK: AssetLock = { version: 1, assets: {} };

export function lockPath(root: string): string {
  return join(root, 'harness.lock.json');
}

export function buildLock(set: AssetSet): AssetLock {
  const assets: Record<string, LockEntry> = {};
  for (const a of [...set.skills, ...set.agents]) {
    assets[assetKey(a)] = { version: a.version, fingerprint: a.fingerprint };
  }
  return { version: 1, assets };
}

export function readLock(path: string): AssetLock {
  if (!existsSync(path)) return EMPTY_LOCK;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new HarnessError('lock.mismatch', `${path} 不是合法 JSON`, e);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HarnessError('lock.mismatch', `${path} 顶层必须是对象`);
  }
  const lock = parsed as Partial<AssetLock>;
  if (lock.version !== 1 || typeof lock.assets !== 'object' || lock.assets === null) {
    throw new HarnessError('lock.mismatch', `${path} 形状不对：需要 { version: 1, assets: {...} }`);
  }
  const assets: Record<string, LockEntry> = {};
  for (const [key, v] of Object.entries(lock.assets)) {
    if (
      typeof v !== 'object' ||
      v === null ||
      typeof (v as LockEntry).version !== 'string' ||
      typeof (v as LockEntry).fingerprint !== 'string'
    ) {
      throw new HarnessError('lock.mismatch', `${path}: 条目 "${key}" 形状不对`);
    }
    assets[key] = { version: (v as LockEntry).version, fingerprint: (v as LockEntry).fingerprint };
  }
  return { version: 1, assets };
}

/** 原子写：先写临时文件再 rename，避免半个锁文件把 CI 卡在「JSON 都不合法」 */
export function writeLock(path: string, lock: AssetLock): void {
  mkdirSync(dirname(path), { recursive: true });
  const sorted: Record<string, LockEntry> = {};
  for (const key of Object.keys(lock.assets).sort()) {
    const entry = lock.assets[key];
    if (entry !== undefined) sorted[key] = entry;
  }
  const text = `${JSON.stringify({ version: 1, assets: sorted }, null, 2)}\n`;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

/** 比锁与当前资产集；`--check` 用 `.length === 0` 判通过 */
export function diffLock(lock: AssetLock, set: AssetSet): AssetDrift {
  const added: string[] = [];
  const changed: { key: string; locked: LockEntry; current: LockEntry }[] = [];
  const current: Record<string, LockEntry> = {};
  for (const a of [...set.skills, ...set.agents]) {
    const key = assetKey(a);
    const entry = { version: a.version, fingerprint: a.fingerprint };
    current[key] = entry;
    const locked = lock.assets[key];
    if (locked === undefined) {
      added.push(key);
    } else if (locked.fingerprint !== entry.fingerprint) {
      changed.push({ key, locked, current: entry });
    }
  }
  const removed = Object.keys(lock.assets).filter((k) => current[k] === undefined);
  return { added, changed, removed };
}

export function driftIsEmpty(d: AssetDrift): boolean {
  return d.added.length === 0 && d.changed.length === 0 && d.removed.length === 0;
}

/** 人类可读的一行摘要（CLI 输出用） */
export function describeDrift(d: AssetDrift): string {
  if (driftIsEmpty(d)) return '资产与锁一致';
  const parts: string[] = [];
  if (d.added.length > 0) parts.push(`新增 ${d.added.length}（${d.added.join(', ')}）`);
  if (d.changed.length > 0) {
    parts.push(
      `变更 ${d.changed.length}（${d.changed.map((c) => `${c.key} ${c.locked.fingerprint}→${c.current.fingerprint}`).join(', ')}）`,
    );
  }
  if (d.removed.length > 0) parts.push(`删除 ${d.removed.length}（${d.removed.join(', ')}）`);
  return parts.join('；');
}
