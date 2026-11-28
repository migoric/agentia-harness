import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { discoverAssets } from '../assets/discover.js';
import { buildLock, writeLock } from '../assets/lockfile.js';
import { type AssetSet, findAsset } from '../assets/types.js';
import type { WorkspacePaths } from '../config.js';
import { HarnessError } from '../errors.js';
import { parseFrontmatter } from '../util/frontmatter.js';
import { appendJournal, atomicWrite, readJournal } from './journal.js';
import type { ChangeManifest, JournalEntry, Proposal } from './types.js';
import { renderFile } from './verify.js';

/**
 * 采纳的**两阶段提交** —— 让「资产已改、账本没记」变成一个可自动修复的中间态。
 *
 * 原来的顺序是「写资产 → 重建 lock → 追加 journal」，三步之间任何一次崩溃
 * （磁盘满、进程被 kill、lock 写入失败）都会留下同一个坏状态：**资产换了，journal 里
 * 没有这一条**。它的后果不是报错，而是三件安静的事：
 *
 * - `rsi regress` 找不到基准，这次改动永远不被监测；
 * - `rsi ledger` 把它算成「没采纳过」，下一轮可能重复提同一个方向；
 * - 有人 `rsi revert` 时得到「没有可回滚的记录」，而资产确实被改过。
 *
 * 反过来「先记 journal 再写资产」也不行：那会得到「记了但没改」，回滚会把 before
 * 写回去（幂等、无害），但 `regress` 会拿一条根本没生效的改动当基准去查回归，
 * 得到一堆假警报。
 *
 * 所以引入一份**意图记录**：写盘之前先把「要写什么、写完之后 journal 该多哪一条」
 * 落下来。崩在任何一步之后，下一次开跑都能靠**磁盘上的正文**判断走到了哪一阶段：
 * 正文等于 after ⇒ 补 journal；等于 before ⇒ 清掉意图。两条都幂等，且判据是
 * 「实际内容」而不是「以为走到了哪」。
 *
 * 刻意**不**做的：把意图记录做成通用的 WAL（那会把一次采纳变成多次 fsync 的
 * 事务系统）。这里只有一种写操作、一个文件、一个读者，够用即可。
 */
export interface AcceptIntent {
  readonly schema: 1;
  readonly at: number;
  readonly proposalId: string;
  readonly target: string;
  /** 采纳前 / 采纳后的正文（含 frontmatter 之外的 body） */
  readonly before: string;
  readonly after: string;
  /** 采纳携带的白名单 frontmatter 覆盖（可空 —— 旧意图没有这个字段） */
  readonly settings?: Readonly<Record<string, string>> | undefined;
  /** 采纳前这些字段的原值（回滚据此恢复，只记 settings 涉及的键） */
  readonly settingsBefore?: Readonly<Record<string, string>> | undefined;
  readonly reason: string;
  readonly manifest?: ChangeManifest | undefined;
  readonly assetsBefore: string;
}

export function acceptIntentPath(p: WorkspacePaths): string {
  return join(p.workspaceDir, 'rsi', 'accept-intent.json');
}

export interface CommitResult {
  readonly entry: JournalEntry;
  /** 写盘后重新发现的资产集（磁盘真相，不是内存推算） */
  readonly assets: AssetSet;
}

/**
 * 落一次采纳。
 *
 * 校验（乐观锁）仍在写盘之前：意图记录不是用来掩盖「有人手改过资产」的，它只保证
 * **自己这几步**要么全成、要么留下可推导的痕迹。
 */
export function commitAccept(
  p: WorkspacePaths,
  assets: AssetSet,
  proposal: Proposal,
  reason: string,
): CommitResult {
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

  // 采纳前这些字段的原值 —— 回滚要据此把 frontmatter 恢复到采纳前。
  // 只记 settings 涉及的键；老资产没写某个键时值为 undefined，回滚会删掉那一行。
  const settings = proposal.patch.settings;
  const settingsBefore = settings === undefined ? undefined : oldSettings(current, settings);

  const intent: AcceptIntent = {
    schema: 1,
    at: Date.now(),
    proposalId: proposal.id,
    target: proposal.patch.target,
    before: proposal.patch.before,
    after: proposal.patch.after,
    ...(settings !== undefined ? { settings } : {}),
    ...(settingsBefore !== undefined ? { settingsBefore } : {}),
    reason,
    ...(proposal.manifest !== undefined ? { manifest: proposal.manifest } : {}),
    assetsBefore: assets.fingerprint,
  };
  // ① 意图（幂等：重复写只会覆盖成同一份）。目录要自己建：第一次采纳时
  // `.workspace/rsi/` 可能还不存在（journal 那边会建，但这里在它之前）
  const intentPath = acceptIntentPath(p);
  mkdirSync(dirname(intentPath), { recursive: true });
  atomicWrite(intentPath, `${JSON.stringify(intent, null, 2)}\n`);
  // ② 资产（正文 + 白名单 frontmatter 覆盖一起落盘）
  atomicWrite(asset.path, renderFile(asset.path, proposal.patch.after, proposal.patch.settings));
  // ③ lock 与 journal：lock 是「磁盘现状」的派生数据，journal 才是审计依据
  const after = discoverAssets({ skills: p.skillsDir, agents: p.agentsDir });
  writeLock(join(p.root, 'harness.lock.json'), buildLock(after));
  const entry = entryOf(intent, after.fingerprint);
  appendJournal(p, entry);
  // ④ 清意图：到这一步账本已经记上了，意图再留着只会让下次误以为是中断
  clearIntent(p);
  return { entry, assets: after };
}

/** 从意图还原一条 journal 条目（恢复路径也用它，保证两条路写出的记录逐字段一致） */
function entryOf(intent: AcceptIntent, assetsAfter: string): JournalEntry {
  return {
    at: intent.at,
    proposalId: intent.proposalId,
    status: 'accepted',
    target: intent.target,
    before: intent.before,
    after: intent.after,
    ...(intent.settings !== undefined ? { settings: intent.settings } : {}),
    ...(intent.settingsBefore !== undefined ? { settingsBefore: intent.settingsBefore } : {}),
    reason: intent.reason,
    ...(intent.manifest !== undefined ? { manifest: intent.manifest } : {}),
    assetsBefore: intent.assetsBefore,
    assetsAfter,
  };
}

function clearIntent(p: WorkspacePaths): void {
  rmSync(acceptIntentPath(p), { force: true });
}

/**
 * 采纳前磁盘上这些白名单键的原值（只取 settings 涉及的键）。
 * 值为字符串 = 原来写过；缺席 = 原来没写（回滚时 renderFile 会不覆盖，恢复成没有该行）。
 */
function oldSettings(
  text: string,
  settings: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const fm = parseFrontmatter(text, 'asset');
  const out: Record<string, string> = {};
  for (const key of Object.keys(settings)) {
    const v = fm.data[key];
    if (typeof v === 'string') out[key] = v;
  }
  return out;
}

/**
 * 只读地看一眼「有没有中断的采纳」。给 `rsi doctor` 用 —— 它不该触发任何写入，
 * 但也不能对「文件在、内容坏了」这种情况说「没事」（那正是 doctor 要消灭的体验）。
 */
export function readAcceptIntent(p: WorkspacePaths): AcceptIntent | undefined {
  const path = acceptIntentPath(p);
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new HarnessError(
      'rsi.bad_record',
      `${path} 不是合法 JSON（${err instanceof Error ? err.message : String(err)}）。` +
        '它记录「上一次采纳写到哪一步」—— 修好它或人工确认资产内容后删掉它，再继续',
    );
  }
  const o = raw as Partial<AcceptIntent>;
  if (
    o.schema !== 1 ||
    typeof o.target !== 'string' ||
    typeof o.before !== 'string' ||
    typeof o.after !== 'string' ||
    typeof o.proposalId !== 'string'
  ) {
    throw new HarnessError('rsi.bad_record', `${path} 缺少必要字段（schema/target/before/after）`);
  }
  return {
    schema: 1,
    at: typeof o.at === 'number' ? o.at : Date.now(),
    proposalId: o.proposalId,
    target: o.target,
    before: o.before,
    after: o.after,
    ...(o.settings !== undefined && typeof o.settings === 'object' && o.settings !== null
      ? { settings: o.settings as Readonly<Record<string, string>> }
      : {}),
    ...(o.settingsBefore !== undefined &&
    typeof o.settingsBefore === 'object' &&
    o.settingsBefore !== null
      ? { settingsBefore: o.settingsBefore as Readonly<Record<string, string>> }
      : {}),
    reason: typeof o.reason === 'string' ? o.reason : '',
    ...(o.manifest !== undefined ? { manifest: o.manifest } : {}),
    assetsBefore: typeof o.assetsBefore === 'string' ? o.assetsBefore : '',
  };
}

/**
 * 上次采纳崩在中间吗 —— 崩了就把账面补到与磁盘一致。返回一句人话（没有残留时 `undefined`）。
 *
 * 三个分支的判据都是**磁盘正文**，不是「意图文件在不在」：
 *
 * - 正文是 after ⇒ 写盘成功了，只差 journal。若 journal 里没有这条就补一条
 *   （重复检查按 `proposalId + status`，所以「已经补过」不会补第二遍）。
 * - 正文是 before ⇒ 写盘没发生（或被回滚了），删意图即可。
 * - 正文是别的 ⇒ 期间有人手改。**不猜**：保留意图并抛错，让人看一眼 —— 自动把
 *   一条手改的内容记成「RSI 采纳的」是最坏的一种自动化。
 */
/**
 * 只读地把「上次采纳走到哪一步」分成四类 —— **doctor 和恢复路径共用同一个判据**。
 *
 * 只校验意图文件本身是不够的：最危险的一种中间态是「意图完好、但资产正文被人
 * 手改过」，此时开跑必失败。doctor 若只看文件在不在，就会说出「可以开跑」，
 * 而下一秒写入口抛 `rsi.bad_record` —— 诊断工具因此失去全部意义。
 */
export type AcceptRecoveryState =
  | { readonly kind: 'none' }
  | { readonly kind: 'after'; readonly intent: AcceptIntent }
  | { readonly kind: 'before'; readonly intent: AcceptIntent }
  | { readonly kind: 'unknown'; readonly intent: AcceptIntent; readonly reason: string };

export function classifyAcceptRecovery(p: WorkspacePaths): AcceptRecoveryState {
  const intent = readAcceptIntent(p);
  if (intent === undefined) return { kind: 'none' };

  const current = discoverAssets({ skills: p.skillsDir, agents: p.agentsDir });
  const asset = findAsset(current, intent.target);
  if (asset === undefined) {
    return {
      kind: 'unknown',
      intent,
      reason: `上一次采纳的目标 "${intent.target}" 已经不存在了`,
    };
  }
  const text = readFileSync(asset.path, 'utf8');
  if (text === renderFile(asset.path, intent.after, intent.settings))
    return { kind: 'after', intent };
  if (text === renderFile(asset.path, intent.before)) return { kind: 'before', intent };
  return {
    kind: 'unknown',
    intent,
    reason: `${intent.target} 的内容既不是采纳前、也不是采纳后 —— 期间有人手改过`,
  };
}

/** 上次采纳崩在中间吗 —— 崩了就把账面补到与磁盘一致。返回一句人话（没有残留时 `undefined`）。 */
export function recoverAccept(p: WorkspacePaths): string | undefined {
  const state = classifyAcceptRecovery(p);
  if (state.kind === 'none') return undefined;
  const { intent } = state;

  if (state.kind === 'unknown') {
    throw new HarnessError(
      'rsi.bad_record',
      `${state.reason}。请确认期望内容后删掉 ${acceptIntentPath(p)}；` +
        '在没有确认之前不要继续跑 RSI（否则这次改动可能被记成 RSI 的采纳）',
    );
  }

  const current = discoverAssets({ skills: p.skillsDir, agents: p.agentsDir });
  if (state.kind === 'after') {
    const journal = readJournal(p);
    const recorded = journal.some(
      (e) => e.status === 'accepted' && e.proposalId === intent.proposalId,
    );
    if (recorded) {
      clearIntent(p);
      return `清理了一次已完成的采纳留下的中间记录（${intent.proposalId}）`;
    }
    writeLock(join(p.root, 'harness.lock.json'), buildLock(current));
    appendJournal(p, entryOf(intent, current.fingerprint));
    clearIntent(p);
    return (
      `补齐了一条上次中断的采纳记录：${intent.proposalId} → ${intent.target}` +
      '（资产已改、账本缺条目，已按磁盘内容补记）'
    );
  }
  clearIntent(p);
  return `清理了一次未生效的采纳（${intent.proposalId}：资产在写盘前就中断了）`;
}
