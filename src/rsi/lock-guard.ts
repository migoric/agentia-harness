import type { WorkspacePaths } from '../config.js';
import { type AcquiredLock, acquireWorkerLock, HEARTBEAT_MS } from './worker-lock.js';

/**
 * 「拿锁 → 干活 → 还锁」的三种形态。
 *
 * 抽出来的理由不是省两行：**锁的释放必须是 finally**，而 RSI 的写入口有好几个
 * （跑轮次 / 手写采纳 / 回滚 / 修 journal）。每个入口自己写一遍 `try/finally`，
 * 漏掉一处的症状是「一次异常之后整个工作区再也开不了跑」—— 锁还挂在盘上，
 * 而持有它的进程早就退出了。等 10 分钟自动回收也太久，人会以为工具坏了。
 *
 * 另一个必须收在一处的原因是**心跳**：跑一轮可能几十分钟，而陈旧阈值是 10 分钟。
 * 不刷心跳的话，一个正在正常推进的长轮次会被第二个进程判定为「死了」并抢走锁 ——
 * 于是真的并发写了。`watch` 自己管心跳（它还要报轮次），一次性的长任务用
 * `withRsiLockAsync`，短任务用同步版。
 *
 * 刻意**不**做的：排队等待。等锁意味着「两个进程都活着、只是先后写」，而归因
 * 失效的代价远高于「让人重跑一次」—— 拒绝比排队的语义更诚实。
 */
export interface LockWrapOptions {
  /** 被回收的旧锁说明（只有真的回收了才回调） */
  readonly onReclaim?: ((reason: string) => void) | undefined;
}

/** 只拿锁，由调用方负责释放（`watch` 的形态） */
export function holdRsiLock(
  config: WorkspacePaths,
  command: string,
  opts: LockWrapOptions = {},
): AcquiredLock {
  const lock = acquireWorkerLock(config, { command });
  if (lock.reclaimed !== null) opts.onReclaim?.(lock.reclaimed.reason);
  return lock;
}

/** 同步短任务（`rsi accept` / `revert` / `journal --repair`） */
export function withRsiLock<T>(
  config: WorkspacePaths,
  command: string,
  fn: () => T,
  opts: LockWrapOptions = {},
): T {
  const lock = holdRsiLock(config, command, opts);
  try {
    return fn();
  } finally {
    lock.release();
  }
}

/**
 * 异步长任务（一次 `rsi` / `rsi --rounds`）。
 *
 * 心跳用 `unref()`：它不该拖住进程退出 —— 任务结束（无论成功失败）都会在 `finally`
 * 里清掉定时器，而「进程该退出了却因为一个心跳还活着」是很难查的一类挂起。
 */
export async function withRsiLockAsync<T>(
  config: WorkspacePaths,
  command: string,
  fn: () => Promise<T>,
  opts: LockWrapOptions = {},
): Promise<T> {
  const lock = holdRsiLock(config, command, opts);
  const beat = setInterval(() => lock.heartbeat(0), HEARTBEAT_MS);
  beat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    lock.release();
  }
}
