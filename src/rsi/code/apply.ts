import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { WorkspacePaths } from '../../config.js';
import { HarnessError } from '../../errors.js';
import { fingerprint } from '../../util/hash.js';
import { appendJournal, liveAccepted, readJournal } from '../journal.js';
import { revertNoteOf } from '../revert-note.js';
import type { JournalEntry } from '../types.js';
import type { CodeFileState, CodePatch, CodeVerify } from './types.js';

/**
 * 代码补丁的落盘与回滚 —— 整个 harness 里**唯一**改 TS 源码的路径。
 *
 * 四道门，每一道都对应一次真实的失败模式：
 * 1. **验证必须已经通过**（`verify.ok`）。这里再判一次，是因为调用方可以绕过 CLI
 *    直接调库；「沙箱过了才落盘」不能只是 CLI 的约定。
 * 2. **必须显式审批**（`approved`）。L2 与 L1 的最大区别：改提示词坏了大不了回滚，
 *    改代码能弄坏构建本身。RSI 不该有「自己决定改代码」的权力。
 * 3. **目标文件必须干净**。工作区里那些未提交的改动，一旦被 `git apply` 撞上，
 *    报错信息说的是「patch does not apply」，而真正的原因是「你有本地改动」。
 * 4. **落盘前记 before 指纹**。回滚靠它判断「这期间有人动过吗」—— 用 git 自己的
 *    index 做不到这一点（文件可能已 stage）。
 */
export interface ApplyOptions {
  readonly config: WorkspacePaths;
  readonly patch: CodePatch;
  readonly verify: CodeVerify;
  readonly sandbox: string;
  readonly approved: boolean;
}

export function applyCodePatch(opts: ApplyOptions): JournalEntry {
  if (!opts.verify.ok) {
    throw new HarnessError(
      'code.verify_failed',
      `沙箱验证未通过（${describeVerify(opts.verify)}），拒绝落盘`,
    );
  }
  if (!opts.approved) {
    throw new HarnessError(
      'code.unapproved',
      '代码补丁必须人工确认后才落盘（CLI 用 --yes，库调用传 approved: true）',
    );
  }
  const repo = opts.config.root;
  assertClean(repo, opts.patch.files);

  // 先把「补丁前」的指纹全部取下来：apply 之后再取就晚了（那是 after）
  const beforeHashes = opts.patch.files.map((path) => hashOf(repo, path));
  applyDiff(repo, opts.patch.diff);
  const afterHashes = opts.patch.files.map((path) => {
    const hash = hashOf(repo, path);
    if (hash === null) {
      // 删除文件不在本层支持范围内：回滚语义会变成「凭空造回一个文件」，
      // 而 git apply -R 对删除的处理还要依赖 index 状态。先只做增量。
      throw new HarnessError('code.invalid', `补丁删除了 ${path} —— 本层不支持删除文件`);
    }
    return hash;
  });

  const files: CodeFileState[] = opts.patch.files.map((path, i) => ({
    path,
    // `null` 与 `''` 不同：前者是「补丁前不存在」，后者会与空文件撞上
    before: beforeHashes[i] ?? null,
    after: afterHashes[i] ?? '',
  }));

  const entry: JournalEntry = {
    at: Date.now(),
    proposalId: `code-${Date.now().toString(36)}`,
    status: 'accepted',
    target: `code:${opts.patch.files[0] ?? ''}`,
    // 代码补丁没有「一段正文」—— 留空而不是塞 diff（那是 code.diff 的职责）
    before: '',
    after: '',
    // 账本里的理由要**读得懂**：完整命令在 `code.verify.command` 里已经有了，
    // 把一条带临时路径的长命令抄进 reason，只会让 `rsi status` 的输出没法扫
    reason: verifyReason(opts.verify),
    assetsBefore: '',
    assetsAfter: '',
    kind: 'code',
    code: { diff: opts.patch.diff, files, verify: opts.verify, sandbox: opts.sandbox },
  };
  appendJournal(opts.config, entry);
  return entry;
}

export interface CodeRevertResult {
  readonly entry: JournalEntry;
  readonly files: readonly string[];
}

/**
 * 回滚最近一次代码补丁。
 *
 * 只认 `kind === 'code'` 的采纳记录 —— 文本资产的回滚走 `revertLast`，两者互不越界：
 * 一条资产补丁的回滚若顺手把代码也退了，`--dry-run` 那条「零副作用」的承诺就破了。
 */
export function revertLastCode(config: WorkspacePaths): CodeRevertResult {
  // 只认**仍生效**的 code 采纳：已回滚的由 liveAccepted 排除，否则二次回滚会撞
  // 指纹校验，把「已经回过了」报成「落盘后有人手改」
  const last = liveAccepted(readJournal(config), 'code').at(-1);
  if (last?.code === undefined) {
    throw new HarnessError('rsi.no_signal', 'journal 里没有可回滚的代码补丁');
  }
  const repo = config.root;
  for (const f of last.code.files) {
    const current = hashOf(repo, f.path);
    if (current !== f.after) {
      throw new HarnessError(
        'code.conflict',
        `${f.path} 在落盘之后被改动过（当前 ${current ?? '不存在'} ≠ 落盘后 ${f.after}）——` +
          ' 反向应用会连带抹掉那之后的改动，请手动处理',
      );
    }
  }

  applyDiff(repo, last.code.diff, true);

  for (const f of last.code.files) {
    const current = hashOf(repo, f.path);
    if (f.before === null) {
      if (current !== null) {
        throw new HarnessError('code.conflict', `回滚后 ${f.path} 仍存在 —— 补丁没能删掉新增文件`);
      }
    } else if (current !== f.before) {
      throw new HarnessError(
        'code.conflict',
        `回滚后 ${f.path} 的指纹是 ${current ?? '不存在'}，与补丁前 ${f.before} 不一致`,
      );
    }
  }

  const reverted: JournalEntry = {
    ...last,
    at: Date.now(),
    status: 'rejected',
    // 与文本资产同款的作废标记 —— 缺了它，这条回滚只能靠 reason 前缀识别，
    // 而前缀不在任何接口里（见 revert-note.ts）
    reverted: true,
    reason: revertNoteOf(last.proposalId, last.reason),
  };
  appendJournal(config, reverted);
  return { entry: reverted, files: last.code.files.map((f) => f.path) };
}

/** 落盘前的干净检查：只看**补丁要动的文件**，不要求整个工作区干净 */
function assertClean(repo: string, files: readonly string[]): void {
  let out: string;
  try {
    out = execFileSync('git', ['-C', repo, 'status', '--porcelain', '--', ...files], {
      encoding: 'utf8',
    });
  } catch {
    throw new HarnessError('code.invalid', `${repo} 不是 git 仓库 —— 无法安全地落盘/回滚`);
  }
  if (out.trim() !== '') {
    throw new HarnessError(
      'code.conflict',
      `这些文件有未提交的改动，拒绝落盘（会与本地修改混在一起）：\n${out.trim()}`,
    );
  }
}

function hashOf(repo: string, path: string): string | null {
  const full = join(repo, path);
  return existsSync(full) ? fingerprint(readFileSync(full, 'utf8')) : null;
}

function applyDiff(repo: string, diff: string, reverse = false): void {
  const dir = mkdtempSync(join(tmpdir(), 'harness-apply-'));
  const file = join(dir, 'change.diff');
  writeFileSync(file, diff, 'utf8');
  try {
    const args = ['-C', repo, 'apply', '--whitespace=nowarn', ...(reverse ? ['-R'] : []), file];
    execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    const err = e as { stderr?: unknown; message?: unknown };
    const detail = typeof err.stderr === 'string' ? err.stderr.trim() : String(err.message ?? e);
    throw new HarnessError(
      'code.conflict',
      `git apply ${reverse ? '-R ' : ''}失败：${detail}`,
      detail,
    );
  } finally {
    rmSync(dirname(file), { recursive: true, force: true });
  }
}

function describeVerify(v: CodeVerify): string {
  if (v.timedOut) return `超时，${v.durationMs}ms`;
  return v.exitCode === null ? '进程被信号终止' : `退出码 ${v.exitCode}`;
}

/** 一句话说清「凭什么采纳这条代码补丁」 */
function verifyReason(verify: CodeVerify): string {
  const e = verify.eval;
  if (e === undefined) {
    return `沙箱验证通过（${verify.command.join(' ')}，${verify.durationMs}ms）`;
  }
  const cost = e.costUsd !== undefined ? `，$${e.costUsd.toFixed(4)}` : '，成本未知';
  return (
    `评测门通过（${e.passed}/${e.total}，${(e.passRate * 100).toFixed(1)}%${cost}，` +
    `${verify.durationMs}ms）`
  );
}
