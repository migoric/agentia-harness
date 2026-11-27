import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import type { WorkspacePaths } from '../config.js';
import { HarnessError } from '../errors.js';
import { atomicWrite } from './journal.js';

/**
 * 常驻 worker 的**单实例锁**。
 *
 * 抽成独立模块的理由是它有两个使用者，而这两者对「活着」的定义必须一致：
 * `rsi --watch` 用它决定能不能开跑，只读看板用它回答「谁在跑、还活着吗」。
 * 两边各写一份判定，最典型的后果是看板显示「有 worker 在跑」而实际早就死了
 * （或者反过来，看板说空着、新 worker 却启动失败）—— 这种矛盾会让人直接怀疑工具坏了。
 *
 * 三条设计取舍：
 *
 * 1. **pid + 心跳，缺一不可**。只看 pid 会把「进程号被复用」当成活着；只看心跳会把
 *    「进程被 SIGKILL 而锁文件无害地留在盘上」当成一直在跑。两者同时判，误判窗口
 *    就是心跳间隔（60s）。
 * 2. **陈旧锁自动回收，不要求人手删文件**。这条是踩出来的：容器/CI 里被 SIGKILL
 *    是常态，而「删个文件再启动」在自动化里没人做，结果就是监控显示 worker 一直在
 *    但轮次永远不推进。回收时把旧锁**改名留存**（`.stale-<ts>`），事后还能查是谁卡住的。
 * 3. **判定不做跨机推断**。锁里记了 `host`，但发现是另一台机器时不假装知道它还活着：
 *    心跳新鲜就当作活着（同一工作区被两台机器挂载是用户自己的配置问题），
 *    心跳过期就回收。跨主机探测（SSH、租约）不属于这个工具的职责。
 */
export interface WorkerLock {
  readonly pid: number;
  readonly host: string;
  /** ISO 8601 */
  readonly startedAt: string;
  /** ISO 8601；worker 每轮开始/结束与心跳定时器都会刷新 */
  readonly heartbeatAt: string;
  /** 这个进程已经跑完几轮 */
  readonly rounds: number;
  /** 当前在跑的那一轮（没跑就是 undefined）—— 看板用它说「正在跑第 N 轮」 */
  readonly currentRound?: number | undefined;
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

export function workerLockPath(p: WorkspacePaths): string {
  return join(p.workspaceDir, 'rsi', 'worker.lock');
}

/** 读锁文件。不存在 ⇒ null；存在但读不动/不是对象 ⇒ `corrupt` 的判定结果（不抛） */
export function readWorkerLock(p: WorkspacePaths): LockState | null {
  const path = workerLockPath(p);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // 半截写入（被 kill 在写锁的瞬间）不该让看板 500：返回一个「活着但说不清」的
    // 判定，让新 worker 走正常回收路径，而不是让人先手删文件
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
  };
  return { lock, ...judge(lock) };
}

/** 心跳新鲜度 + 进程是否存在 */
function judge(lock: WorkerLock): { alive: boolean; reason: string } {
  const beat = Date.parse(lock.heartbeatAt);
  if (Number.isNaN(beat)) return { alive: false, reason: '心跳时间解析不了' };
  const age = Date.now() - beat;
  if (age > STALE_MS) {
    return {
      alive: false,
      reason: `心跳已过期 ${Math.round(age / 1000)}s（上限 ${STALE_MS / 1000}s）`,
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

/**
 * 拿锁。
 *
 * 活着 ⇒ 抛 `rsi.gate_blocked`（**不是**静默排队：两个 worker 同时推进轮次会毁掉
 * 归因，而它毁得很安静 —— 报告看起来仍然正常）。
 */
export function acquireWorkerLock(p: WorkspacePaths): AcquiredLock {
  const path = workerLockPath(p);
  const existing = readWorkerLock(p);
  if (existing?.alive === true) {
    throw new HarnessError(
      'rsi.gate_blocked',
      `已经有一个 worker 在推进轮次（pid ${existing.lock.pid}@${existing.lock.host}，` +
        `${existing.reason}）。同一工作区同时跑两个 worker 会让轮次并发、归因失效。\n` +
        '如果确认那个进程已经不在了，删掉 ' +
        `${path} 再启动；或等到心跳过期（${STALE_MS / 60_000} 分钟）自动回收。`,
    );
  }
  // 陈旧锁改名留存：事后要能查「上一次是谁卡住的」
  if (existing !== null) {
    try {
      renameSync(path, `${path}.stale-${Date.now()}`);
    } catch {
      // 改名失败（权限/竞态）不影响正确性：下一次写入会覆盖它
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  let lock: WorkerLock = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    rounds: 0,
  };
  const write = (): void => {
    atomicWrite(path, `${JSON.stringify(lock)}\n`);
  };
  write();
  return {
    path,
    reclaimed: existing,
    heartbeat(rounds: number, currentRound?: number): void {
      lock = {
        pid: lock.pid,
        host: lock.host,
        startedAt: lock.startedAt,
        heartbeatAt: new Date().toISOString(),
        rounds,
        ...(currentRound !== undefined ? { currentRound } : {}),
      };
      write();
    },
    release(): void {
      // 只删自己的锁：期间若被判定陈旧并由另一个进程接手，删掉别人的锁会让
      // 「单实例」这个保证在交接窗口里失效
      const now = readWorkerLock(p);
      if (now !== null && now.lock.pid !== process.pid) return;
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
      reason: '没有 worker 在跑',
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
