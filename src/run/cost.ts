import type { Trace } from '@migor/agentia';

/**
 * 从 trace 读成本的**唯一口径**，run / eval / RSI 提案器共用。
 *
 * 上游的 `usage.missing` 不在公共导出面（与 `tool.input` 同款），所以这里复制字面量。
 * 风险是上游改名后静默读不到 —— 防线是 `tests/evals.test.ts` 里那条真实 trace 断言。
 */
const USAGE_MISSING_EVENT = 'usage.missing';

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
