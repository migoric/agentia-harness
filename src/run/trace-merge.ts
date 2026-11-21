import type { Trace, Usage } from '@migor/agentia';

/**
 * 把多轮 run 的多条 trace 合并成一条**可被现有断言消费**的视图。
 *
 * 多轮评测每轮是一次独立 run（agentia 的 session 只负责接历史，不负责合并观测）。
 * 但 `check()`、`toolInvocations()`、`capabilityHits()` 全部吃单条 `Trace` —— 与其
 * 让这些地方各学一遍多轮，不如在边界上合并一次：**下游永远只看见一条 trace**。
 *
 * 三个刻意定下的口径：
 *
 * 1. **traceId 取最后一轮**。它不是「所有轮的 id」，而是一个可回查的锚点；
 *    拿第一轮的会让 `harness trace` 打开最初那条、看不到最终失败的那一轮。
 * 2. **status 全 ok 才 ok**。中间轮出错而最后一轮正常，整体仍然是坏的一次会话 ——
 *    用户经历的是整段对话，不是最后一句。
 * 3. **totalUsage 逐段累加**。`costEstimate` 的累加**可能偏低**（某段没报计量时
 *    上游按 0 算），但这不会变成错误读数：`costOf()` 先问 `usageReported()`，
 *    只要任一段带 `usage.missing` 就整体返回 `undefined`。低位假设只影响
 *    「不知道」的判定，不影响「更贵了」的判定。
 */
export function mergeTraces(traces: readonly Trace[]): Trace {
  const first = traces[0];
  const last = traces[traces.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error('mergeTraces 至少需要一条 trace');
  }
  return {
    traceId: last.traceId,
    rootSpanId: first.rootSpanId,
    spans: traces.flatMap((t) => t.spans),
    status: traces.every((t) => t.status === 'ok') ? 'ok' : 'error',
    totalUsage: mergeUsage(traces.map((t) => t.totalUsage)),
  };
}

/** 账单累加 —— 与上游 `trace.ts` 的 `addUsage` 同口径（它不在公共导出面） */
export function mergeUsage(all: readonly Usage[]): Usage {
  const out: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  let cost: number | undefined;
  for (const u of all) {
    out.inputTokens += u.inputTokens;
    out.outputTokens += u.outputTokens;
    out.cacheReadTokens += u.cacheReadTokens;
    out.cacheCreationTokens += u.cacheCreationTokens;
    if (u.costEstimate !== undefined) cost = (cost ?? 0) + u.costEstimate;
  }
  if (cost !== undefined) out.costEstimate = Math.round(cost * 1e6) / 1e6;
  return out;
}
