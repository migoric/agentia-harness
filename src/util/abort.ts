/**
 * 取消信号的组合与超时。
 *
 * 不用 `AbortSignal.any`：它在 Node 20.3 才有，而 `engines` 声明的下限是 20.0。
 * 自己组合还能拿到两样东西：
 *
 * - `timedOut()` —— 「这条用例是被超时掐掉的」与「用户按了 Ctrl-C」在结果里必须能分开，
 *   否则一次误配的超时会看起来像模型不稳定；
 * - `expired` —— 一个在超时那一刻 reject 的 promise。**超时必须由调用方自己兑现**，
 *   不能只靠把 signal 传下去：下游是否真会因 abort 而提前返回，是下游的自由
 *   （测试替身、不消费 signal 的客户端、卡在 DNS 的请求都可能不配合）。用
 *   `Promise.race([work, gate.expired])` 才能保证「超时就是超时」。
 */
export class TimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`超时 ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/** 永远不会 settle —— 没有超时约束时放进 `Promise.race` 里是个空操作 */
const NEVER: Promise<never> = new Promise<never>(() => undefined);

export interface AbortGate {
  /** 交给下游的合成信号；没有任何约束时就是原信号（可能为 undefined） */
  readonly signal: AbortSignal | undefined;
  /** 是不是**本 gate 的**超时触发的（区别于调用方取消） */
  timedOut(): boolean;
  /** 超时那一刻以 `TimeoutError` reject；未设超时时永不 settle */
  readonly expired: Promise<never>;
  dispose(): void;
}

export function combineAbort(signal: AbortSignal | undefined, ms: number | undefined): AbortGate {
  if (ms === undefined) {
    return { signal, timedOut: () => false, expired: NEVER, dispose: () => undefined };
  }

  const ctrl = new AbortController();
  let fired = false;
  let expire: (e: Error) => void = () => undefined;
  const expired = new Promise<never>((_, reject) => {
    expire = reject;
  });
  // 有人 race 才会消费它；没人 race 时不该冒出一个 unhandled rejection
  expired.catch(() => undefined);

  const timer = setTimeout(() => {
    fired = true;
    const e = new TimeoutError(ms);
    ctrl.abort(e);
    expire(e);
  }, ms);
  // 不因为这个 timer 让进程无法退出（评测跑完就该能结束）
  timer.unref();

  const relay = (): void => ctrl.abort(signal?.reason);
  if (signal !== undefined) {
    if (signal.aborted) relay();
    else signal.addEventListener('abort', relay, { once: true });
  }

  return {
    signal: ctrl.signal,
    timedOut: () => fired,
    expired,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', relay);
    },
  };
}
