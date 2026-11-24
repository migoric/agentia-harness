import type { Span, Trace } from '@migor/agentia';
import { CONFIG_FALLBACKS_ATTR, LLM_FALLBACK_EVENT } from './trace-events.js';

/**
 * 从 trace 读「这次跑到底用了哪个模型」—— **报告里模型集合的唯一来源**。
 *
 * 存在理由：`EvalReport.model` 是单值，而 agentia 的 fallback 链（`AppOptions.fallbacks`，
 * 公共面已导出 `ModelFallbackLink` 类型）会让**一次 run 内部**换模型。单值字段在那种
 * 情况下不再说谎得起的地方只有一处 —— 它会把「降级到 B 才跑完」记成「用了 A」，
 * 于是 `gate` 的 `sameModel` 判据静默失效：基线降级过、候选没降级，两份报告的通过率
 * 差异被读成 agent 的进退步。
 *
 * 三处证据，全部现成，不需要上游加接口：
 * - `llm.turn` 的 **span 名就是模型 id**（`engine/turn.ts` 的 `recorder.begin('llm.turn', link.model)`）；
 * - 换环时写 `llm.fallback { from, to, errorType }`（同上，写在新那环的第一个 turn 上）；
 * - 根 span 属性 `config.fallbacks` 是**声明**链（`engine/run-config.ts`，模型名逗号拼接）。
 *
 * 「声明」与「实际」必须分开读：配了三条 fallback 而一次没触发，和没配是同一件事；
 * 反过来，实际集合里出现第二个模型就证明降级发生过。
 */
export interface ModelUsage {
  /**
   * 实际**尝试过**的模型，按首次出现顺序去重。
   *
   * 含尝试后失败的那一环：它真被调用过、也真可能计过费（上游会记 `usage.partial`）。
   * 只统计成功的回合会让「降级到 B 才跑完」在报告里看不见 B。
   */
  readonly models: readonly string[];
  /** 模型 → 往返次数（含失败尝试）。`models` 求和等于 `llm.turn` span 总数 */
  readonly turns: Readonly<Record<string, number>>;
  /** 换环次数（`llm.fallback` 事件数）；0 = 声明过但一次没触发，或压根没配 */
  readonly fallbacks: number;
  /** 声明过的链（根属性）；没配时缺席 —— 「没配」与「配了空链」不是同一件事 */
  readonly declared?: readonly string[] | undefined;
}

export function modelUsage(trace: Trace): ModelUsage {
  // 按开始时间排序：`mergeTraces` 只是把多轮 trace 平铺，顺序靠上游 push 序，
  // 而「首次出现」要的是**真实发生序**，不能赌容器顺序
  const spans: Span[] = [...trace.spans].sort((a, b) => a.startedAt - b.startedAt);
  const turns: Record<string, number> = {};
  const models: string[] = [];
  let fallbacks = 0;
  let declared: string[] | undefined;

  for (const span of spans) {
    if (span.kind === 'llm.turn') {
      if (turns[span.name] === undefined) models.push(span.name);
      turns[span.name] = (turns[span.name] ?? 0) + 1;
    }
    for (const e of span.events) {
      if (e.name === LLM_FALLBACK_EVENT) fallbacks++;
    }
    // 多轮用例合并后会有多个根（每轮一个）；同一条链每次都会写，取最后一个即可
    if (span.parentSpanId === null) {
      const v = span.attributes[CONFIG_FALLBACKS_ATTR];
      if (typeof v === 'string' && v !== '') declared = v.split(',');
    }
  }
  return {
    models,
    turns,
    fallbacks,
    ...(declared === undefined ? {} : { declared }),
  };
}

/** 两个模型集合是否相同 —— 判据单位是「集合」，不是「字符串」 */
export function sameModelSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((m, i) => m === sb[i]);
}
