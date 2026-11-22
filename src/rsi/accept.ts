import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverAssets } from '../assets/discover.js';
import { buildLock, writeLock } from '../assets/lockfile.js';
import type { AssetSet } from '../assets/types.js';
import { findAsset } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import { loadEvalCases } from '../evals/load.js';
import { appendJournal, atomicWrite, journalPath, readJournal } from './journal.js';
import { revertNoteOf } from './revert-note.js';
import type { JournalEntry, Proposal, VerifyOutcome } from './types.js';
import { renderFile } from './verify.js';

// 审计线索只有一条：journal 的读写收在 `journal.ts`（代码补丁也写它）
export { journalPath, readJournal };

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
  // 第二道闸在唯一写盘入口上：调用方即使拿到 verifyProposal 的结果后自己改了判定，
  // 也没法带着「留出集退步」的候选落盘。
  if (outcome.holdout !== undefined && !outcome.holdout.gate.ok) {
    throw new HarnessError(
      'rsi.gate_blocked',
      `留出集未通过，拒绝采纳：${outcome.holdout.gate.reason}`,
    );
  }
  // 反过来也要挡：工程配了 holdout，却拿来一份没验过留出集的 outcome ——
  // 这不是「可选字段缺席」，是有人绕过了 runCycle / rsi accept --from。
  if (
    outcome.holdout === undefined &&
    loadEvalCases(config.evalsDir).some((c) => c.split === 'holdout')
  ) {
    throw new HarnessError(
      'rsi.gate_blocked',
      '本工程配置了 holdout 用例，但验证结果没有留出集记录 —— 拒绝采纳',
    );
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
    ...(proposal.manifest !== undefined ? { manifest: proposal.manifest } : {}),
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
 * 防护两层：
 * 1. 给了 `id` 时必须是**最近一条**采纳的 id。指定 id 不是为了「退任意一条」——
 *    当前实现只存了逐条 before 正文，退中间一条会覆盖后续改动；它是给人一个
 *    「期间若又采纳了别的，就别误退」的确认阀。
 * 2. 当前资产指纹必须等于当初采纳后的指纹。不等说明之后又有手改，此时回滚会
 *    把中间那些改动一起抹掉 —— 拒绝，并让人自己决定。
 */
export function revertLast(config: HarnessConfig, id?: string): RevertResult {
  // 只认文本资产：代码补丁有自己的回滚入口（`revertLastCode`），
  // 混在一起会让一条资产回滚顺手把代码也退了
  const entries = readJournal(config).filter((e) => e.status === 'accepted' && e.kind !== 'code');
  const last = entries[entries.length - 1];
  if (last === undefined) {
    throw new HarnessError('rsi.no_signal', 'journal 里没有可回滚的采纳记录');
  }
  if (id !== undefined && last.proposalId !== id) {
    throw new HarnessError(
      'rsi.no_signal',
      `指定回滚 ${id}，但最近一条可回滚的采纳是 ${last.proposalId} —— 拒绝（期间若有新采纳，先退最近那条）`,
    );
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
    reverted: true,
    reason: revertNoteOf(last.proposalId, last.reason),
    assetsBefore: current.fingerprint,
    assetsAfter: restored.fingerprint,
  };
  appendJournal(config, reverted);
  return { entry: reverted, restored: last.before };
}
