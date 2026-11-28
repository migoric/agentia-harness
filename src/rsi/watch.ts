import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import { type AcquiredLock, acquireWorkerLock, HEARTBEAT_MS } from './worker-lock.js';

/**
 * 常驻 worker：`rsi --watch`。
 *
 * 它存在的理由不是「省得手敲命令」——cron / systemd timer 已经能定时敲了。它存在的
 * 理由是 **D9 的前提**：RSI 的写权限必须留在进程里，而「一个进程、串行、有节流、
 * 有停手条件」这件事需要一个常驻宿主来保证。把这件事交给「定时器每隔 5 分钟敲一次
 * `rsi`」，会遇到两个具体问题：
 *
 * 1. **两轮会重叠**。上一轮跑到 7 分钟，定时器又敲了一次，于是两个进程同时写
 *    `journal` 与资产 —— 归因失效，而报告看起来完全正常。锁能挡住，但那时第二个
 *    进程是「启动即失败」，cron 会把它记成一次失败，噪音大于信息。
 * 2. **没人知道它在跑**。定时器模式下「在跑」和「卡住了」看起来一样。心跳 + 锁
 *    文件让只读看板能回答这个问题。
 *
 * 三条纪律：
 *
 * - **一轮一改**（不变量 4）：每轮只申请一个采纳名额，轮内语义完全交给 `runCycle`。
 *   这个文件不碰资产、不碰评测 —— 它只决定「什么时候开始下一轮」。
 * - **停止条件先于继续**：预算、无进展、到点、信号，四条都在**开下一轮之前**判断。
 *   判断晚一步的代价是「预算已经超了还在开新一轮」，而预算是硬约束。
 * - **被 kill 也要能续**：锁是陈旧的会被回收（`worker-lock.ts`），资产写入是原子的，
 *   journal 的末行截断有 `journal --repair`。三者合起来保证「中断」不会变成
 *   「半完成状态」。这个文件不自己发明恢复协议。
 */
export interface RoundTick {
  /** 这一轮采纳了几条（≥1 才算「有推进」） */
  readonly accepted: number;
  readonly costUsd: number;
  readonly costKnown: boolean;
  /** 这一轮自己声明该停（预算用尽 / 没有失败样本 / 简化轮卡住） */
  readonly stop?: 'budget' | 'no_failures' | 'shrink_stalled' | undefined;
}

export type WatchStopReason =
  | 'max_rounds'
  | 'until'
  | 'no_progress'
  | 'no_failures'
  | 'shrink_stalled'
  | 'budget'
  | 'signal'
  /** 连续失败到上限 —— 不是「这一轮没变好」，是「每一轮都跑不起来」 */
  | 'error';

export interface WatchOptions {
  readonly config: HarnessConfig;
  /**
   * 跑一轮。
   *
   * 做成注入而不是在这里直接调 `runRounds`：这个文件的职责是**调度**（串行、节流、
   * 停手），而调度这件事最该被测的恰恰是「第二个实例会被挡住」「陈旧锁能回收」
   * 「信号来了不再开下一轮」。这些测试一个模型都不该花。
   */
  readonly runRound: (signal: AbortSignal, round: number) => Promise<RoundTick>;
  readonly signal?: AbortSignal | undefined;
  /** 轮与轮之间的间隔秒数（缺省 900 = 15 分钟）。0 = 跑完立刻下一轮（CI 用） */
  readonly everySec?: number | undefined;
  /** 最多跑几轮（缺省不限，靠停止条件与外部信号收尾） */
  readonly maxRounds?: number | undefined;
  /** 到这个毫秒时刻就停（`--until`） */
  readonly until?: number | undefined;
  /** 睡眠实现；测试注入假实现避免真等 */
  readonly sleep?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
  readonly onRound?: ((tick: RoundTick, round: number) => void) | undefined;
  readonly onReclaim?: ((reason: string) => void) | undefined;
  /**
   * 某一轮抛错时的回调 —— 用来把原因说出来（否则只有「退避重试」一行，人不知道
   * 为什么慢）。不传也可以，失败会记进报告的 `failures`。
   */
  readonly onRoundError?: ((err: unknown, round: number) => void) | undefined;
  /**
   * 连续失败几次后放弃（默认 3）。
   *
   * 常驻进程**不能因为一次网络抖动就退出**：那是无人值守场景最常见的死法，而
   * 「它死了」只有看板能看出来。但也不能永远重试——配置错误（key 失效、用例路径
   * 写错）会变成永不停止的烧钱循环。三次是「足以排除瞬时故障，又不至于让人等太久」。
   */
  readonly maxConsecutiveFailures?: number | undefined;
  /**
   * 已经拿到的锁 —— 调用方在**装配远端之前**就拿了锁时传进来（`rsi --watch` 就是
   * 这样：`recoverPending` / `push` 都会写文件，把它们留在锁外等于留一个并发窗口）。
   *
   * 传了它，本函数不释放锁（谁拿谁还）；不传就自己拿、自己还。
   */
  readonly lock?: AcquiredLock | undefined;
  /** 锁里记的命令名，抢锁失败时说明对手用 */
  readonly command?: string | undefined;
}

export interface WatchReport {
  /** 真正跑完的轮数（被信号打断的那一轮不计） */
  readonly rounds: number;
  readonly accepted: number;
  readonly stopReason: WatchStopReason;
  readonly costUsd: number;
  readonly costKnown: boolean;
  /** 抛错的轮次数（不计入 `rounds` —— 那一轮没有完成） */
  readonly failures: number;
}

const DEFAULT_EVERY_SEC = 900;
const DEFAULT_MAX_FAILURES = 3;
/** 退避上限：15 分钟。再长就等于「悄悄停了」，而人还在等它自己好 */
const MAX_BACKOFF_MS = 15 * 60_000;

export async function runWatch(opts: WatchOptions): Promise<WatchReport> {
  const everySec = opts.everySec ?? DEFAULT_EVERY_SEC;
  if (!Number.isFinite(everySec) || everySec < 0) {
    throw new HarnessError('config.invalid', `--every 必须是非负数（收到 ${everySec}）`);
  }
  if (opts.maxRounds !== undefined && (!Number.isInteger(opts.maxRounds) || opts.maxRounds < 1)) {
    throw new HarnessError('config.invalid', `--max-rounds 必须是正整数（收到 ${opts.maxRounds}）`);
  }
  const maxFailures = opts.maxConsecutiveFailures ?? DEFAULT_MAX_FAILURES;
  if (!Number.isInteger(maxFailures) || maxFailures < 1) {
    throw new HarnessError(
      'config.invalid',
      `maxConsecutiveFailures 必须是正整数（收到 ${maxFailures}）`,
    );
  }

  const controller = new AbortController();
  const signal =
    opts.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, opts.signal]);
  const lock =
    opts.lock ??
    acquireWorkerLock(opts.config, {
      ...(opts.command !== undefined ? { command: opts.command } : { command: 'rsi --watch' }),
    });
  const ownsLock = opts.lock === undefined;
  if (ownsLock && lock.reclaimed !== null) opts.onReclaim?.(lock.reclaimed.reason);

  const state: { rounds: number; current: number | undefined } = { rounds: 0, current: undefined };

  // 心跳定时器：一轮可能跑十几分钟（单条用例分钟级超时），只靠轮首轮尾刷新的话，
  // 看板会在正常运行时显示「worker 已死」。unref 让它不拖住进程退出。
  const beat = setInterval(() => lock.heartbeat(state.rounds, state.current), HEARTBEAT_MS);
  beat.unref();

  const sleep = opts.sleep ?? realSleep;
  let accepted = 0;
  let costUsd = 0;
  let costKnown = true;
  let failures = 0;
  let consecutive = 0;
  let attempts = 0;
  let waitMs = everySec * 1000;
  let stopReason: WatchStopReason = 'max_rounds';

  try {
    for (;;) {
      const pre = preStop(opts, state.rounds);
      if (pre !== null) {
        stopReason = pre;
        break;
      }
      // 间隔只在**轮与轮之间**生效：第一轮立刻开跑，否则 cron 敲一下还要干等 15 分钟。
      // 失败后 `waitMs` 会退避变大，走的是同一个睡眠点。
      if (attempts > 0 && waitMs > 0) {
        await sleep(waitMs, signal);
        if (signal.aborted) {
          stopReason = 'signal';
          break;
        }
        // 睡醒之后要**再判一次**停止条件：`--until` 很可能正好落在这段间隔里，
        // 不重判就会在「到点之后」再开一轮，白烧一次钱（间隔 15 分钟时尤其明显）
        const afterSleep = preStop(opts, state.rounds);
        if (afterSleep !== null) {
          stopReason = afterSleep;
          break;
        }
      }
      state.current = state.rounds + 1;
      lock.heartbeat(state.rounds, state.current);
      attempts += 1;
      try {
        const tick = await opts.runRound(signal, state.current);
        state.rounds += 1;
        state.current = undefined;
        consecutive = 0;
        waitMs = everySec * 1000;
        accepted += tick.accepted > 0 ? 1 : 0;
        costUsd += tick.costUsd;
        costKnown = costKnown && tick.costKnown;
        lock.heartbeat(state.rounds);
        opts.onRound?.(tick, state.rounds);
        if (signal.aborted) {
          stopReason = 'signal';
          break;
        }
        if (tick.stop !== undefined) {
          stopReason = tick.stop;
          break;
        }
        if (tick.accepted === 0) {
          // 和 `runRounds` 同一个口径：没有推进就不再开下一轮。继续跑只会更贵，不会更聪明
          stopReason = 'no_progress';
          break;
        }
      } catch (err) {
        // 信号打断不算失败：那一轮是被要求停的，不是跑不起来
        if (signal.aborted) {
          stopReason = 'signal';
          break;
        }
        failures += 1;
        consecutive += 1;
        state.current = undefined;
        // 心跳要跟上：否则一轮 10 分钟的失败会让人以为整个 worker 卡死了
        lock.heartbeat(state.rounds);
        opts.onRoundError?.(err, state.rounds + 1);
        if (consecutive >= maxFailures) {
          stopReason = 'error';
          break;
        }
        const base = Math.min(Math.max(everySec * 1000, 1000), 60_000);
        waitMs = Math.min(base * 2 ** consecutive, MAX_BACKOFF_MS);
      }
    }
  } finally {
    clearInterval(beat);
    // 谁拿谁还：外部传进来的锁由外部释放（它还要包住后面的远端装配）
    if (ownsLock) lock.release();
  }

  return { rounds: state.rounds, accepted, stopReason, costUsd, costKnown, failures };
}

/** 开新一轮之前的几道闸；返 non-null 就是该停的理由 */
function preStop(opts: WatchOptions, done: number): WatchStopReason | null {
  if (opts.signal?.aborted === true) return 'signal';
  if (opts.maxRounds !== undefined && done >= opts.maxRounds) return 'max_rounds';
  if (opts.until !== undefined && Date.now() >= opts.until) return 'until';
  return null;
}

/** 可被 abort 打断的 sleep：信号来了立刻返回，而不是把 15 分钟等完 */
export function realSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
