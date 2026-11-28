import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { WorkspacePaths } from '../config.js';
import { HarnessError } from '../errors.js';
import { atomicWrite } from './journal.js';

/**
 * 工作区写锁 —— **所有会推进 RSI 状态的进程共用一把**。
 *
 * 抽成独立模块的理由是它有多个使用者，而它们对「活着」的定义必须一致：
 * `rsi --watch`（常驻）、`rsi`（一次跑完）、`rsi accept`、`rsi regress --revert`、
 * `rsi journal --repair`，以及只读看板（它只读锁、回答「谁在跑」）。各写一份判定，
 * 最典型的后果是看板显示「有 worker 在跑」而实际早就死了（或者反过来，看板说空着、
 * 新进程却启动失败）—— 这种矛盾会让人直接怀疑工具坏了。
 *
 * 三条设计取舍：
 *
 * 1. **pid + 心跳 + 归属凭证，缺一不可**。只看 pid 会把「进程号被复用」当成活着；
 *    只看心跳会把「被 SIGKILL 而锁文件留在盘上」当成一直在跑；没有凭证，
 *    `release` 可能删掉**别人刚抢到**的锁。三者同时判，误判窗口就是心跳间隔（60s）。
 * 2. **抢锁必须原子**。旧实现是「读 → 判 → 改名 → 写」，两个进程同时启动会双双
 *    读到「没有锁」，然后互相覆盖 —— 两个进程同时推进轮次，报告却看起来正常。
 *    现在用 `O_CREAT|O_EXCL`（`wx`）独占创建作为唯一入口：创建成功即持有，
 *    失败才去判陈旧，陈旧则改名让路后重试。这是 POSIX 上最便宜的互斥原语。
 * 3. **陈旧锁自动回收，不要求人手删文件**。容器/CI 里被 SIGKILL 是常态，而
 *    「删个文件再启动」在自动化里没人做，结果就是监控显示 worker 一直在跑但轮次
 *    永远不推进。回收时把旧锁**改名留存**（`.stale-<ts>`），事后还能查是谁卡住的。
 *
 * 刻意**不**做的：跨主机探测（SSH、租约）。锁里记了 `host`，但发现是另一台机器时
 * 不假装知道它还活着：心跳新鲜就当作活着（同一工作区被两台机器挂载是用户自己的
 * 配置问题），心跳过期就回收。
 */
export interface WorkerLock {
  readonly pid: number;
  readonly host: string;
  /** ISO 8601 */
  readonly startedAt: string;
  /** ISO 8601；持有者每轮开始/结束与心跳定时器都会刷新 */
  readonly heartbeatAt: string;
  /** 这个进程已经跑完几轮 */
  readonly rounds: number;
  /** 当前在跑的那一轮（没跑就是 undefined）—— 看板用它说「正在跑第 N 轮」 */
  readonly currentRound?: number | undefined;
  /**
   * 归属凭证（随机串）。`release` 只删 token 相同的那份。
   *
   * 加它不是洁癖：旧实现按 pid 判归属，而 pid 会被复用 —— 进程 A 被 kill、锁被
   * 判定陈旧、进程 B 抢到，此时 A 迟到的 `release` 若按 pid 判据会删掉 B 的锁。
   * token 让「这是不是我那把锁」变成一个确定的事实。老锁没有这个字段，读侧回退到 pid。
   */
  readonly token?: string | undefined;
  /** 是谁拿的（`worker` / `rsi` / `rsi accept` …）—— 抢锁失败时要能说清对手是谁 */
  readonly command?: string | undefined;
}

export interface LockState {
  readonly lock: WorkerLock;
  readonly alive: boolean;
  /** 为什么这么判（看板要能解释，而不是只给一个布尔） */
  readonly reason: string;
}

/** 心跳间隔：60s 一次。它决定「误判为死」的最大延迟 */
export const HEARTBEAT_MS = 60_000;

/**
 * 超过这个时间没心跳 ⇒ 判定为死。
 *
 * 10 分钟 = 10 个心跳周期。不设更短：一轮 RSI 里单条用例的超时就是分钟级，
 * 心跳偶尔晚到几个周期是正常的；设 90 秒会让看板在正常运行时闪「worker 已死」。
 */
export const STALE_MS = 10 * 60_000;

/** 陈旧锁最多留几份归档（再多就没人看了，只是占目录条目） */
const STALE_KEEP = 5;

export function workerLockPath(p: WorkspacePaths): string {
  return join(p.workspaceDir, 'rsi', 'worker.lock');
}

/** 读锁文件。不存在 ⇒ null；存在但读不动/不是对象 ⇒ 按陈旧锁判定（不抛） */
export function readWorkerLock(p: WorkspacePaths, staleMs = STALE_MS): LockState | null {
  const path = workerLockPath(p);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // 半截写入（被 kill 在写锁的瞬间）不该让看板 500：返回一个「说不清」的判定，
    // 让新进程走正常回收路径，而不是让人先手删文件
    return {
      lock: { pid: -1, host: '?', startedAt: '', heartbeatAt: '', rounds: 0 },
      alive: false,
      reason: '锁文件读不出来（可能是写到一半被杀），按陈旧锁处理',
    };
  }
  const o = raw as Partial<WorkerLock> & Record<string, unknown>;
  if (typeof o.pid !== 'number' || typeof o.heartbeatAt !== 'string') {
    return {
      lock: { pid: -1, host: '?', startedAt: '', heartbeatAt: '', rounds: 0 },
      alive: false,
      reason: '锁文件缺 pid/heartbeatAt 字段，按陈旧锁处理',
    };
  }
  const lock: WorkerLock = {
    pid: o.pid,
    host: typeof o.host === 'string' ? o.host : '?',
    startedAt: typeof o.startedAt === 'string' ? o.startedAt : '',
    heartbeatAt: o.heartbeatAt,
    rounds: typeof o.rounds === 'number' ? o.rounds : 0,
    ...(typeof o.currentRound === 'number' ? { currentRound: o.currentRound } : {}),
    ...(typeof o.token === 'string' ? { token: o.token } : {}),
    ...(typeof o.command === 'string' ? { command: o.command } : {}),
  };
  return { lock, ...judge(lock, staleMs) };
}

/** 心跳新鲜度 + 进程是否存在 */
function judge(lock: WorkerLock, staleMs: number): { alive: boolean; reason: string } {
  const beat = Date.parse(lock.heartbeatAt);
  if (Number.isNaN(beat)) return { alive: false, reason: '心跳时间解析不了' };
  const age = Date.now() - beat;
  if (age > staleMs) {
    return {
      alive: false,
      reason: `心跳已过期 ${Math.round(age / 1000)}s（上限 ${staleMs / 1000}s）`,
    };
  }
  if (lock.pid <= 0) return { alive: false, reason: '没有有效 pid' };
  // 同机才探进程；异机只信心跳
  if (lock.host === hostname()) {
    try {
      process.kill(lock.pid, 0);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // EPERM = 进程存在但不属于当前用户：存在就是活着
      if (code !== 'EPERM') return { alive: false, reason: `pid ${lock.pid} 已不存在` };
    }
  }
  return { alive: true, reason: `心跳 ${Math.round(age / 1000)}s 前，pid ${lock.pid} 在跑` };
}

export interface AcquiredLock {
  readonly path: string;
  /** 被回收的旧锁（如果有）—— 调用方负责把这件事说出来 */
  readonly reclaimed: LockState | null;
  /**
   * 刷新心跳。`currentRound` 传数字 = 正在跑第几轮；传 `undefined` = 没在跑。
   *
   * 不能只做「有值才写」：那样轮次结束后旧值会一直留着，看板会永远显示
   * 「正在跑第 3 轮」而那一轮早就结束了 —— 一个宁可不显示也不能显示错的地方。
   */
  heartbeat(rounds: number, currentRound?: number): void;
  release(): void;
}

export interface AcquireOptions {
  /** 锁里记的命令名，供抢锁失败时说明对手（`worker` / `rsi` / `rsi accept` …） */
  readonly command?: string | undefined;
  /** 判陈旧的阈值；测试注入（默认 `STALE_MS`） */
  readonly staleMs?: number | undefined;
}

/**
 * 拿锁。
 *
 * 活着 ⇒ 抛 `rsi.gate_blocked`（**不是**静默排队：两个进程同时推进轮次会毁掉
 * 归因，而它毁得很安静 —— 报告看起来仍然正常）。
 *
 * 独占创建 + 陈旧回收最多尝试 5 轮：每一轮要么抢到，要么确认「有活人」，
 * 要么把一个陈旧锁改名让路。5 次仍失败说明锁文件在被高频创建（配置错、或
 * 同一个工作区有两个 supervisor 在抢），此时报错比继续空转有用。
 */
export function acquireWorkerLock(p: WorkspacePaths, opts: AcquireOptions = {}): AcquiredLock {
  const path = workerLockPath(p);
  mkdirSync(dirname(path), { recursive: true });
  const staleMs = opts.staleMs ?? STALE_MS;
  const mine: WorkerLock = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    rounds: 0,
    token: randomBytes(6).toString('hex'),
    ...(opts.command !== undefined ? { command: opts.command } : {}),
  };

  let reclaimed: LockState | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (claim(path, mine)) return handle(p, mine, reclaimed);
    const existing = readWorkerLock(p, staleMs);
    if (existing === null) continue; // 上一轮刚被删掉：直接重试独占创建
    if (existing.alive) throw blocked(path, existing);
    reclaimed ??= existing;
    // 陈旧锁改名留存：事后要能查「上一次是谁卡住的」。改名失败（权限/竞态）不阻塞，
    // 但此时不能 assume 自己拿到了锁 —— 循环会再试一次独占创建。
    try {
      renameSync(path, `${path}.stale-${Date.now()}`);
      sweepStaleLocks(path);
    } catch {
      // 别人同时改名/删除了它，重试即可
    }
  }
  throw new HarnessError(
    'rsi.gate_blocked',
    `拿不到工作区锁：${path} 连续 5 次都被抢占 —— ` +
      '通常意味着同一个工作区有多个 supervisor 在反复启动 RSI。' +
      '确认只有一个调度器在敲 `harness rsi`（或 `--watch`），再试一次。',
  );
}

/** 抢锁失败时说清「对手是谁、怎么处理」—— 这句话决定人是等还是去杀进程 */
function blocked(path: string, existing: LockState): HarnessError {
  const who = existing.lock.command ?? '未知命令';
  return new HarnessError(
    'rsi.gate_blocked',
    `已经有一个 RSI 进程在改这个工作区（${who}，pid ${existing.lock.pid}@${existing.lock.host}，` +
      `${existing.reason}）。两边同时写资产会让归因失效，而报告看起来仍然正常。\n` +
      `如果确认那个进程已经不在了，删掉 ${path} 再试；或等到心跳过期` +
      `（${STALE_MS / 60_000} 分钟）自动回收。`,
  );
}

/**
 * 原子发布一把**完整**的锁 —— 整个互斥的唯一判定点。
 *
 * 不用 `open(path,'wx')` 然后往里写：那条路有一个真实存在的窗口 —— 文件已经被
 * 创建、内容还没写进去。另一个进程在窗口里读到空文件，`readWorkerLock` 会按
 * 「写到一半被杀」判成陈旧锁并改名让路，于是**两个进程同时持锁**（真子进程并发
 * 测试里 5%~10% 会命中）。
 *
 * 改成：先在唯一临时文件里写完整内容并 fsync，再用 `linkSync` 建立硬链接。
 * `link` 与 `open('wx')` 一样由内核仲裁（目标已存在就 EEXIST），但被创建的那个
 * 名字从出现的**第一刻**起就是完整内容 —— 观察者在任何时点都不会看到空锁。
 *
 * 硬链接而非 `rename`：rename 会覆盖已有目标，两个进程都能成功，那正是要防的错。
 */
function claim(path: string, lock: WorkerLock): boolean {
  const tmp = `${path}.claim-${process.pid}-${randomBytes(4).toString('hex')}`;
  let fd: number;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(lock)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
    return true;
  } finally {
    // link 成功时删的是临时名字，硬链接指向的锁文件仍在；失败时清掉半成品
    try {
      unlinkSync(tmp);
    } catch {
      // 已经被清掉了，或路径本来就没建成
    }
  }
}

/** 只留最近几份 `.stale-*`：它们是给人查的，不是账本 */
function sweepStaleLocks(path: string): void {
  const dir = dirname(path);
  const prefix = `${basename(path)}.stale-`;
  const claimPrefix = `${basename(path)}.claim-`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const stale = names.filter((n) => n.startsWith(prefix)).sort();
  for (const name of stale.slice(0, Math.max(0, stale.length - STALE_KEEP))) {
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
      // 清理失败不影响正确性
    }
  }
  // 崩在 link 之前的半成品。一分钟的门槛远大于「写几十字节并 fsync」的耗时，
  // 不会碰到另一个进程正在写的那一份；它只是垃圾，不是需要保留的审计痕迹。
  const cutoff = Date.now() - 60_000;
  for (const name of names) {
    if (!name.startsWith(claimPrefix)) continue;
    try {
      if (statSync(join(dir, name)).mtimeMs < cutoff) {
        rmSync(join(dir, name), { force: true });
      }
    } catch {
      // 同上
    }
  }
}

function handle(p: WorkspacePaths, initial: WorkerLock, reclaimed: LockState | null): AcquiredLock {
  const path = workerLockPath(p);
  let lock = initial;
  return {
    path,
    reclaimed,
    heartbeat(rounds: number, currentRound?: number): void {
      // 显式重建而不是展开：`currentRound` 传 undefined 时必须**清掉**旧值，
      // 否则看板会一直显示「正在跑第 N 轮」而那一轮早已结束
      lock = {
        pid: lock.pid,
        host: lock.host,
        startedAt: lock.startedAt,
        heartbeatAt: new Date().toISOString(),
        rounds,
        ...(lock.token !== undefined ? { token: lock.token } : {}),
        ...(lock.command !== undefined ? { command: lock.command } : {}),
        ...(currentRound !== undefined ? { currentRound } : {}),
      };
      atomicWrite(path, `${JSON.stringify(lock)}\n`);
    },
    release(): void {
      // 只删自己的锁：期间若被判定陈旧并由另一个进程接手，删掉别人的锁会让
      // 「单实例」这个保证在交接窗口里失效。老锁没有 token，回退到 pid+host 比较。
      const now = readWorkerLock(p);
      if (now === null) return;
      const mine =
        initial.token !== undefined
          ? now.lock.token === initial.token
          : now.lock.pid === process.pid && now.lock.host === initial.host;
      if (!mine) return;
      rmSync(path, { force: true });
    },
  };
}

/** 供看板展示的合并视图（锁 + 判定 + 说明） */
export function describeWorker(p: WorkspacePaths): {
  running: boolean;
  reason: string;
  lock: WorkerLock | null;
  staleMs: number;
  heartbeatMs: number;
} {
  const state = readWorkerLock(p);
  if (state === null) {
    return {
      running: false,
      reason: '没有进程在跑',
      lock: null,
      staleMs: STALE_MS,
      heartbeatMs: HEARTBEAT_MS,
    };
  }
  return {
    running: state.alive,
    reason: state.reason,
    lock: state.lock,
    staleMs: STALE_MS,
    heartbeatMs: HEARTBEAT_MS,
  };
}
