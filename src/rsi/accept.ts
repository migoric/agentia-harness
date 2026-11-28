import { join } from 'node:path';
import { discoverAssets } from '../assets/discover.js';
import { buildLock, writeLock } from '../assets/lockfile.js';
import type { AssetSet } from '../assets/types.js';
import { findAsset } from '../assets/types.js';
import type { WorkspacePaths } from '../config.js';
import { HarnessError } from '../errors.js';
import { loadEvalCases } from '../evals/load.js';
import { commitAccept } from './commit.js';
import {
  appendJournal,
  atomicWrite,
  journalPath,
  liveAccepted,
  readJournal,
  wasReverted,
} from './journal.js';
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
/** 采纳的产物：审计记录 + **采纳之后的资产集**（调用方不必再自己 `discover` 一遍） */
export interface AcceptResult {
  readonly entry: JournalEntry;
  /**
   * 写盘后重新发现的资产集（不是内存推算）。
   *
   * 返回值带上它的理由：采纳是本仓唯一改资产的动作，改完之后的「资产是什么」
   * 只有这一刻知道。此前调用方（如 `rounds`）只能重新扫一遍磁盘来避免下一轮用
   * 旧快照 —— 那是对的，但它是**调用方替实现的缺口兜底**，而不是设计。
   */
  readonly assets: AssetSet;
}

export interface AcceptOptions {
  /**
   * 追加到 journal 理由后面的那一句 —— 用来解释「这一次采纳为什么不受常规判据约束」。
   *
   * 目前只有一个使用者：简化轮。它采纳的是"通过率没变、但资产确实变小"的改动，
   * 而 journal 里只写门的话会变成 `无变化` —— 三个月后回看的人会以为这条是误采纳。
   * 审计线索的价值全在"当时凭什么"，缺这一句就等于缺了那一半。
   */
  readonly reasonSuffix?: string | undefined;
}

export function acceptProposal(
  config: WorkspacePaths,
  assets: AssetSet,
  outcome: VerifyOutcome,
  opts: AcceptOptions = {},
): AcceptResult {
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
  const reason =
    opts.reasonSuffix === undefined
      ? outcome.gate.reason
      : `${outcome.gate.reason}；${opts.reasonSuffix}`;
  const { entry, assets: after } = commitAccept(config, assets, proposal, reason);
  return { entry, assets: after };
}

/** 直接落一个提案（人工审批通过后调用，不经 gate 判定） */
export function acceptManually(
  config: WorkspacePaths,
  assets: AssetSet,
  proposal: Proposal,
  reason: string,
): AcceptResult {
  return commitAccept(config, assets, proposal, reason);
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
export function revertLast(config: WorkspacePaths, id?: string): RevertResult {
  // 只认**仍生效**的文本采纳：代码补丁有自己的回滚入口（`revertLastCode`），
  // 混在一起会让一条资产回滚顺手把代码也退了；已回滚的采纳由 liveAccepted 排除 ——
  // 否则二次回滚会撞上指纹校验，把「已经回过了」报成「有人手改过资产」
  const journal = readJournal(config);
  const entries = liveAccepted(journal, 'asset');
  const last = entries[entries.length - 1];
  if (last === undefined) {
    if (id !== undefined && wasReverted(journal, 'asset', id)) {
      throw new HarnessError('rsi.no_signal', `${id} 已经被回滚过 —— 没有可重复回滚的采纳`);
    }
    throw new HarnessError('rsi.no_signal', 'journal 里没有可回滚的采纳记录');
  }
  if (id !== undefined && last.proposalId !== id) {
    if (wasReverted(journal, 'asset', id)) {
      throw new HarnessError(
        'rsi.no_signal',
        `${id} 已经被回滚过（最近一条仍生效的采纳是 ${last.proposalId}）—— 没有可重复回滚的采纳`,
      );
    }
    throw new HarnessError(
      'rsi.no_signal',
      `指定回滚 ${id}，但最近一条可回滚的采纳是 ${last.proposalId} —— 拒绝（期间若有新采纳，先退最近那条）`,
    );
  }

  const current = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
  if (current.fingerprint !== last.assetsAfter) {
    /**
     * 「资产已经是采纳前」= 上一次回滚写完了文件、却没来得及记 journal。
     *
     * 不加这个分支，那次中断会把人锁死：再次回滚会撞上指纹校验（当前 ≠ 采纳后），
     * 报「采纳之后资产又被改过」—— 而真相是「已经回过了」。补记一条回滚记录即可，
     * 因为账面缺的正是这一条，资产内容已经完全正确。
     *
     * 只认**精确等于** `assetsBefore`：别的任何不一致都还是「有人手改过」，仍然拒绝。
     */
    if (last.assetsBefore !== '' && current.fingerprint === last.assetsBefore) {
      const replayed: JournalEntry = {
        ...last,
        at: Date.now(),
        status: 'rejected',
        reverted: true,
        reason: revertNoteOf(last.proposalId, last.reason),
        assetsBefore: last.assetsAfter,
        assetsAfter: current.fingerprint,
      };
      appendJournal(config, replayed);
      return { entry: replayed, restored: last.before };
    }
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
