function loadOutcomes(config: WorkspacePaths): {
  verified: Map<
    string,
    VerifyOutcome & { cycleId: string; at?: string | undefined; timeMs: number }
  >;
  /** 被 cycle 记进 `accepted` 的提案 —— 用来认出 dry-run（它没有 journal 记录） */
  accepted: Map<string, { cycleId: string; dryRun: boolean }>;
} {
  const verified = new Map<
    string,
    VerifyOutcome & { cycleId: string; at?: string | undefined; timeMs: number }
  >();
  const accepted = new Map<string, { cycleId: string; dryRun: boolean }>();
  // 读目录与「坏记录怎么办」都归 cycles.ts 一处（曾经这里漏了 verified 是数组的校验，
  // 同一条坏记录在 regress 报 HarnessError、在这里抛原生 TypeError）
  for (const record of readCycles(config)) {
    for (const v of record.verified) {
      // `at` 缺席 = 旧记录（字段 2026-11-22 才有）；条件展开是为了满足
      // exactOptionalPropertyTypes —— 显式 `at: undefined` 与「没有这个属性」不是一回事
      verified.set(v.proposal.id, {
        ...v,
        cycleId: record.cycleId,
        timeMs: record.timeMs,
        ...(record.at === undefined ? {} : { at: record.at }),
      });
    }
    for (const p of record.accepted) {
      accepted.set(p.id, { cycleId: record.cycleId, dryRun: record.dryRun });
    }
  }
  return { verified, accepted };
}

import type { WorkspacePaths } from '../config.js';
import { readCycles } from './cycles.js';
import { readJournal } from './journal.js';
import { isRevertEntry, revertNote } from './revert-note.js';
import type { ChangeManifest, JournalEntry, LessonEntry, VerifyOutcome } from './types.js';

/**
 * 生成在 `revert-note.ts`（与解析同处一地），这里 re-export 是为了账本的取用面不变：
 * `rsi-inspect` 一直从账本取它。
 */
export { revertNote };

/**
 * 决策账本 —— 把「当初的预测」和「实际观察到的结果」接到同一行上。
 *
 * journal 回答「改了什么」，cycle JSON 回答「那次验证看到了什么」，但两者分开存时
 * 很难回答最关键的一句：**当时那份判断是对的还是运气好？** 账本显式做这件事。
 *
 * 只读、不改写任何历史：半截 cycle JSON 会让读取失败（而不是跳过），原因与
 * journal 相同 —— 静默跳过坏记录会让「预测兑现率」这个数字失去意义。
 */
export interface LedgerEntry {
  readonly at: number;
  readonly proposalId: string;
  readonly status: JournalEntry['status'];
  readonly target: string;
  readonly manifest: ChangeManifest | undefined;
  readonly prediction: string | undefined;
  readonly evidence: readonly string[];
  /**
   * realized = 预测兑现并采纳；not_realized = 验过但没兑现；
   * dropped = 验过且兑现但因预算/单变量/dry-run 未采纳；reverted = 采纳后回滚；
   * unverified = 没找到那次验证记录。
   */
  readonly outcome: 'realized' | 'not_realized' | 'dropped' | 'reverted' | 'unverified';
  /**
   * 这条是 dry-run 里的「本会采纳」（`--dry-run` 过了门但刻意不落盘）。
   *
   * 单独标出来的原因：dry-run 不写 journal，账本只能从 cycle JSON 的 `accepted`
   * 认出它。不标就等于把它当成「被门拒的提案」—— 而这两件事的结论正好相反。
   */
  readonly dryRun: boolean;
  readonly gateReason: string | undefined;
  readonly holdoutReason: string | undefined;
  readonly cycleId: string | undefined;
  /**
   * journal 那条记录自己写的理由（原文）。
   *
   * 与 `gateReason` 是**两个不同时刻**的判断：`gateReason` 来自 cycle JSON，是验证当刻
   * 门说了什么；journal 的 reason 是**落盘决定**时的措辞。回滚条目上这两者恰好相反 ——
   * 它的 `gateReason` 仍是当初**通过**的理由，只有 journal 的 reason 记得「这条被回滚了」。
   * 不保留它，`lessonsOf` 就只能拿成功理由去解释失败。
   */
  readonly journalReason: string | undefined;
}

export function readLedger(config: WorkspacePaths): LedgerEntry[] {
  const { verified, accepted } = loadOutcomes(config);
  const journal = readJournal(config);
  const fromJournal = journal.map((entry) => entryOf(entry, verified.get(entry.proposalId)));

  // 被拒的提案也进账本：RSI 最有价值的知识往往是「试过但没兑现」的那一条。
  // journal 只记落盘的决定，cycle JSON 才记完整的尝试，两边并起来才是决策史。
  const recorded = new Set(journal.map((e) => e.proposalId));
  const rejected: LedgerEntry[] = [...verified.entries()]
    .filter(([id]) => !recorded.has(id))
    .map(([id, hit]) => {
      // `accepted` 里却没有 journal 记录 ⇒ 它是 dry-run（过了门，刻意没落盘）。
      // 一律当「被门拒」写进账本，`rsi ledger` 会给出与事实相反的审计结论。
      const runner = accepted.get(id);
      return entryOf(
        {
          // 用轮次的**时刻**而不是写 0：`lessonsOf` 按时间取最近的 N 条，
          // at=0 会让「被门拒的提案」永远排在最后 —— 而它们恰恰是最该被记住的教训
          at: hit.timeMs,
          proposalId: id,
          status: runner === undefined ? 'rejected' : 'accepted',
          target: hit.proposal.patch.target,
          before: hit.proposal.patch.before,
          after: hit.proposal.patch.after,
          reason:
            runner === undefined
              ? hit.gate.reason
              : 'dry-run：过了门但没有落盘（不是被门拒的，也不是自动回滚）',
          assetsBefore: '',
          assetsAfter: '',
          manifest: hit.proposal.manifest,
        },
        hit,
        runner?.dryRun === true,
      );
    });
  return [...fromJournal, ...rejected];
}

function entryOf(
  entry: JournalEntry,
  hit: (VerifyOutcome & { cycleId: string }) | undefined,
  dryRun = false,
): LedgerEntry {
  const realized =
    hit !== undefined &&
    (hit.gate.fixedCases.length > 0 || hit.gate.passRateDelta > 0) &&
    (hit.holdout === undefined || hit.holdout.gate.ok);
  // 回滚识别只有 isRevertEntry 一个判法（reverted 标记 + 兼容老记录的 reason 前缀）
  const isRevert = isRevertEntry(entry);
  const outcome: LedgerEntry['outcome'] =
    hit === undefined
      ? 'unverified'
      : isRevert
        ? 'reverted'
        : // dry-run 的提案兑现了预测，但**刻意**没落盘 —— 归到 dropped（「该采纳却没采纳」）
          // 而不是 realized（那个词的含义是「已经写进资产了」）
          dryRun || (entry.status === 'rejected' && realized)
          ? 'dropped'
          : realized
            ? 'realized'
            : 'not_realized';
  return {
    at: entry.at,
    proposalId: entry.proposalId,
    status: entry.status,
    target: entry.target,
    manifest: entry.manifest,
    prediction: entry.manifest?.prediction,
    evidence: entry.manifest?.evidence ?? [],
    outcome,
    dryRun,
    gateReason: hit?.gate.reason,
    holdoutReason: hit?.holdout?.gate.reason,
    cycleId: hit?.cycleId,
    journalReason: entry.reason,
  };
}

/**
 * 账本 → 提案器的教训清单。
 *
 * 只取 `not_realized`（验过没兑现）与 `reverted`（采纳后回滚）两类：
 * - `realized` 是成功的，没有「别再试」的含义；
 * - `dropped` 是「兑现了但因为预算/单变量没采纳」，方向本身是对的，排除它会误导；
 * - `unverified` 没有验证记录，不能当成「试过」的证据。
 *
 * `limit` 不是性能考虑，是提示词预算：教训段落挤占的是失败证据的篇幅，
 * 而失败证据才是这次改动的直接依据。
 */
export function lessonsOf(config: WorkspacePaths, limit = 8): LessonEntry[] {
  const failed = readLedger(config).filter(
    (e): e is LedgerEntry & { outcome: 'not_realized' | 'reverted' } =>
      e.outcome === 'not_realized' || e.outcome === 'reverted',
  );
  return failed
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((e) => ({
      proposalId: e.proposalId,
      target: e.target,
      prediction: e.prediction,
      // reverted 走 journal 的措辞：它的 gate/holdout 结论是**当初通过**时写下的，
      // 拿来讲「为什么失败」会把成功理由说成失败证据。其余两类留出集结论优先 ——
      // 它是「训练集看着变好了、但换个用例就露馅」的那条证据。
      reason:
        e.outcome === 'reverted' ? revertNote(e.journalReason) : (e.holdoutReason ?? e.gateReason),
      outcome: e.outcome,
    }));
}

/**
 * 轮次的毫秒时刻 —— 由 `cycles.ts` 在读记录时算好（`at` 优先、文件名兜底）。
 *
 * 曾经这段逻辑只在本文件里、且只用文件名：那等于把**命名格式**变成数据接口，
 * 改一次命名（加前缀、换分隔符），解析就失败并回落 0，于是 `lessonsOf` 按时间取
 * 最近 N 条时把这些记录排到最后，最该记住的教训被静默丢掉。现在时刻是记录的一个字段。
 */
