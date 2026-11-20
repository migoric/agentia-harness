import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { discoverAssets } from '../assets/discover.js';
import { buildLock, writeLock } from '../assets/lockfile.js';
import type { AssetSet } from '../assets/types.js';
import { findAsset } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import type { JournalEntry, Proposal, VerifyOutcome } from './types.js';
import { renderFile } from './verify.js';

/**
 * 采纳与回滚。
 *
 * 这是整个 harness 里**唯一会写源文件**的地方，所以纪律最严：
 *
 * - **写前二次校验**：落盘前重算「按 patch.before 渲染出的文件内容」，与实际文件
 *   逐字比对。验证阶段到采纳阶段之间可能有几分钟（跑评测），这期间人手改了文件，
 *   不加这一步就会静默覆盖。
 * - **原子写**：tmp + rename。写到一半崩了不会留下半个文件。
 * - **journal 先行**：先记录 before 再写文件？不 —— 反过来。先写文件成功、再记
 *   journal 才安全：如果记 journal 时崩了，文件已改但 journal 缺一条，`revert` 会
 *   说「没有可回滚的记录」而不是回滚到错误状态。这个方向选错，回滚会变成破坏。
 */
export function acceptProposal(
  config: HarnessConfig,
  assets: AssetSet,
  outcome: VerifyOutcome,
): JournalEntry {
  if (!outcome.gate.ok) {
    throw new HarnessError('rsi.gate_blocked', `回归门未通过，拒绝采纳：${outcome.gate.reason}`);
  }
  const { proposal } = outcome;
  const entry = writePatch(config, assets, proposal, outcome.gate.reason);
  appendJournal(config, entry);
  return entry;
}

/** 直接落一个提案（人工审批通过后调用，不经 gate 判定） */
export function acceptManually(
  config: HarnessConfig,
  assets: AssetSet,
  proposal: Proposal,
  reason: string,
): JournalEntry {
  const entry = writePatch(config, assets, proposal, reason);
  appendJournal(config, entry);
  return entry;
}

function writePatch(
  config: HarnessConfig,
  assets: AssetSet,
  proposal: Proposal,
  reason: string,
): JournalEntry {
  const asset = findAsset(assets, proposal.patch.target);
  if (asset === undefined) {
    throw new HarnessError('asset.missing', `提案指向不存在的资产 "${proposal.patch.target}"`);
  }
  const expected = renderFile(asset.path, proposal.patch.before);
  const current = readFileSync(asset.path, 'utf8');
  if (current !== expected) {
    throw new HarnessError(
      'asset.invalid',
      `${proposal.patch.target} 在验证之后被改动过（预期 ${expected.length} 字节，实际 ${current.length} 字节）` +
        ' —— 拒绝覆盖，请重新跑一轮 RSI',
    );
  }

  const nextText = renderFile(asset.path, proposal.patch.after);
  atomicWrite(asset.path, nextText);

  // 采纳后的资产集：重新发现一遍，让 lock 反映磁盘真相而不是内存推算
  const after = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
  writeLock(join(config.root, 'harness.lock.json'), buildLock(after));

  return {
    at: Date.now(),
    proposalId: proposal.id,
    status: 'accepted',
    target: proposal.patch.target,
    before: proposal.patch.before,
    after: proposal.patch.after,
    reason,
    assetsBefore: assets.fingerprint,
    assetsAfter: after.fingerprint,
  };
}

export interface RevertResult {
  readonly entry: JournalEntry;
  readonly restored: string;
}

/**
 * 回滚最近一次采纳。
 *
 * 防护：当前资产指纹必须等于当初采纳后的指纹。不等说明之后又有改动，
 * 此时回滚会把中间那些改动一起抹掉 —— 拒绝，并让人自己决定。
 */
export function revertLast(config: HarnessConfig): RevertResult {
  const entries = readJournal(config).filter((e) => e.status === 'accepted');
  const last = entries[entries.length - 1];
  if (last === undefined) {
    throw new HarnessError('rsi.no_signal', 'journal 里没有可回滚的采纳记录');
  }

  const current = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
  if (current.fingerprint !== last.assetsAfter) {
    throw new HarnessError(
      'asset.invalid',
      `采纳之后资产又被改过（当前 ${current.fingerprint} ≠ 采纳后 ${last.assetsAfter}），` +
        '自动回滚会连带抹掉那之后的改动 —— 请手动处理',
    );
  }

  const asset = findAsset(current, last.target);
  if (asset === undefined) {
    throw new HarnessError('asset.missing', `回滚目标 "${last.target}" 已不存在`);
  }
  atomicWrite(asset.path, renderFile(asset.path, last.before));

  const restored = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
  writeLock(join(config.root, 'harness.lock.json'), buildLock(restored));

  const reverted: JournalEntry = {
    ...last,
    at: Date.now(),
    status: 'rejected',
    reason: `回滚了 ${last.proposalId}（原采纳理由：${last.reason}）`,
    assetsBefore: current.fingerprint,
    assetsAfter: restored.fingerprint,
  };
  appendJournal(config, reverted);
  return { entry: reverted, restored: last.before };
}

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
    .map((l) => JSON.parse(l) as JournalEntry);
}

function appendJournal(config: HarnessConfig, entry: JournalEntry): void {
  const path = journalPath(config);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.rsi-tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}
