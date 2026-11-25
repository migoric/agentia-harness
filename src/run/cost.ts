import { type Trace, USAGE_MISSING_EVENT } from '@migor/agentia';

/**
 * 从 trace 读成本的**唯一口径**，run / eval / RSI 提案器共用。
 *
 * 事件名从 `@migor/agentia` 取（0.10.14 起进公共导出面）。不再有本地副本 ——
 * 那种副本在改名时不会报错，只会让「这一轮没报计量」判成「报了」。
 */

/** 这一轮有没有回合「根本没报计量」 */
export function usageReported(trace: Trace): boolean {
  for (const span of trace.spans) {
    for (const e of span.events) {
      if (e.name === USAGE_MISSING_EVENT) return false;
    }
  }
  return true;
}

/**
 * 本次运行的美元成本；`undefined` = 无读数。
 *
 * 不能直接拿 `totalUsage.costEstimate`：模型在价格表里而端点没报计量时，上游按
 * 「0 token × 单价」算出 `0`，和「真的免费」是同一个数 —— 预算闸会静默失效。
 */
export function costOf(trace: Trace): number | undefined {
  return usageReported(trace) ? (trace.totalUsage.costEstimate ?? undefined) : undefined;
}
