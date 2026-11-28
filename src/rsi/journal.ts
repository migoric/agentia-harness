import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorkspacePaths } from '../config.js';
import { HarnessError } from '../errors.js';
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
 *
 * 「炸」也分两种，这是 2026-11-24 补的：此前一律让 `JSON.parse` 的原生 `SyntaxError`
 * 冒到调用方，症状是 `Unterminated string in JSON` 且没有 `code`、没有修复建议。
 * append-only 文件被杀在写系统调用中间，只会产出**末行半截**（前面的行是完整的），
 * 那是「中断的追加」，不是「历史损坏」—— 它不该让 `rsi accept/regress/ledger/cycle`
 * 永久失效，而 `repairJournal` 正是为这一种情况准备的。中间行坏了才是真损坏，仍然炸。
 */
export function journalPath(config: WorkspacePaths): string {
  return join(config.workspaceDir, 'rsi', 'journal.jsonl');
}

export function readJournal(config: WorkspacePaths): JournalEntry[] {
  const path = journalPath(config);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return parseJournal(text, path);
}

/** 文本 → 记录。抽出来是为了 `repairJournal` 能「先试读截断结果再落盘」，不靠复制一套判定 */
function parseJournal(text: string, path: string): JournalEntry[] {
  // 每行都以 \n 收尾是正常形态；结尾没有换行 = 最后一次追加可能被截断
  const terminated = text.endsWith('\n');
  const lines = text.split('\n');
  const out: JournalEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    const isLast = i === lines.length - 1;
    try {
      const parsed: unknown = JSON.parse(line);
      out.push(withKind(entryAt(parsed, path, i)));
    } catch (e) {
      if (e instanceof HarnessError) throw e;
      if (isLast && !terminated) {
        throw new HarnessError(
          'rsi.no_signal',
          `journal 的最后一行是半截的（追加写到一半就中断了）：${path}\n` +
            '这不是历史损坏，前面每一行都是完整的。先备份，再执行 ' +
            '`harness rsi journal --repair` 截掉那半行',
          e,
        );
      }
      throw new HarnessError(
        'rsi.no_signal',
        `journal 第 ${i + 1} 行不是合法 JSON（${path}）—— 拒绝跳过坏记录`,
        e,
      );
    }
  }
  return out;
}

/** 一条记录的最小形状。「不是对象 / 没有 proposalId」在这里就该停，而不是让下游解引用崩 */
function entryAt(v: unknown, path: string, i: number): JournalEntry {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new HarnessError(
      'rsi.no_signal',
      `journal 第 ${i + 1} 行不是对象（${path}）—— 拒绝读坏记录`,
    );
  }
  const o = v as Record<string, unknown>;
  if (typeof o.proposalId !== 'string' || o.proposalId === '') {
    throw new HarnessError(
      'rsi.no_signal',
      `journal 第 ${i + 1} 行缺少 proposalId（${path}）—— 拒绝读坏记录`,
    );
  }
  if (o.status !== 'accepted' && o.status !== 'rejected') {
    throw new HarnessError(
      'rsi.no_signal',
      `journal 第 ${i + 1} 行的 status 只能是 accepted/rejected（实为 ${String(o.status)}）`,
    );
  }
  return o as unknown as JournalEntry;
}

export interface JournalRepair {
  /** 截掉了半行（false = 本来就没有半行，什么都没做） */
  readonly truncated: boolean;
  /** 备份文件路径（没截断时为 undefined） */
  readonly backupPath: string | undefined;
  /** 截断前 / 后的行数 */
  readonly linesBefore: number;
  readonly linesAfter: number;
}

/**
 * 修掉「末行半截」—— **只允许截尾**，不重写任何历史行。
 *
 * 为什么不是「读的时候宽容跳过」：那会让「回滚基于不完整的历史」变成静默行为。
 * 修复必须是**显式动作**，且留下备份，事后能证明「截掉的确实只有半行」。
 *
 * 结尾有换行却解析不了 ⇒ 拒绝修：那不是中断的追加，是内容真的坏了（手改、磁盘错误），
 * 自动化去截它只会把「数据坏了」变成「数据少了一行」。
 */
export function repairJournal(config: WorkspacePaths): JournalRepair {
  const path = journalPath(config);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { truncated: false, backupPath: undefined, linesBefore: 0, linesAfter: 0 };
  }
  const linesBefore = text.split('\n').filter((l) => l.trim() !== '').length;
  if (text.endsWith('\n') || text.trim() === '') {
    return { truncated: false, backupPath: undefined, linesBefore, linesAfter: linesBefore };
  }
  const cut = text.lastIndexOf('\n');
  if (cut < 0) {
    throw new HarnessError(
      'rsi.no_signal',
      `${path} 只有半行、没有任何完整记录 —— 这不是「截断末行」能修的，请人工检查`,
    );
  }
  const kept = text.slice(0, cut + 1);
  // 截完仍要能读通：否则说明坏的不止末行，拒绝继续（把「数据坏了」做成「少一行」是最坏的自动化）
  try {
    parseJournal(kept, path);
  } catch (e) {
    throw new HarnessError(
      'rsi.no_signal',
      `${path} 截掉末行之后仍然读不通 —— 坏的不止最后半行，请人工检查（未做任何修改）`,
      e,
    );
  }
  const backupPath = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  writeFileSync(backupPath, text, 'utf8');
  atomicWrite(path, kept);
  return {
    truncated: true,
    backupPath,
    linesBefore,
    linesAfter: kept.split('\n').filter((l) => l.trim() !== '').length,
  };
}

export function appendJournal(config: WorkspacePaths, entry: JournalEntry): void {
  const path = journalPath(config);
  mkdirSync(dirname(path), { recursive: true });
  appendDurable(path, `${JSON.stringify(entry)}\n`);
}

/**
 * 追加一行并 `fsync`。
 *
 * `appendFileSync` 把正确性交给了「进程正常退出」，而 RSI 的常态恰恰是**被 kill**：
 * 常驻 worker 被 OOM 杀、容器重启、CI 超时。没 fsync 的追加在掉电/崩溃后可能整条消失，
 * 而它记录的正是「我改了这个资产」—— 资产已经改了，账本却没有这一条，回滚与账本
 * 从此对不上。一次采纳一条 fsync，成本可以忽略。
 *
 * 用 `O_APPEND` 而不是读改写：两个进程同时追加时，各自的整行不会互相截断
 * （锁会挡住并发写，但 journal 是唯一线索，值得再独立成立一次）。
 */
function appendDurable(path: string, line: string): void {
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * 目录 `fsync` —— 让 rename 本身也落到盘上。
 *
 * 只在 POSIX 有意义（Windows 打不开目录），所以失败一律忽略：那里没有这个语义，
 * 而不是出错了。
 */
function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // 见上：不是所有平台都允许对目录 fsync
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 关不掉一个只读目录句柄不影响已经落盘的 rename
      }
    }
  }
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

/**
 * tmp + rename：写到一半崩了不会留下半个文件。
 *
 * 三个细节都踩过或差点踩过：
 *
 * 1. **tmp 名唯一**。此前是 `${path}.rsi-tmp` 固定名 —— 两个进程（常驻 worker 与
 *    人手一次 `rsi accept`）同时写同一个目标时会共用同一个 tmp，A 的 rename 可能
 *    搬走 B 还没写完的内容，或者 B 的写入在 A 的 rename 之后落地成一个孤儿。
 *    唯一名让「同时写」退化成「后写的赢」，而不是「内容串台」。
 * 2. **写完 fsync 文件本身**。rename 只保证目录项原子，不保证数据块已经落盘；
 *    ext4 的延迟分配下，掉电后 rename 成功而内容全零是真实存在的。资产有 git 兜底，
 *    但 journal / cycles 没有 —— 那恰好是 RSI 唯一的审计依据。
 * 3. **rename 之后 fsync 目录**，否则「文件名指向新 inode」这件事本身可能没落盘。
 *
 * 代价是每个原子写多两次系统调用。RSI 的写入频率是「每轮几次」，不是热路径。
 */
export function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDir(dirname(path));
}
