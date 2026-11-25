import { TOOL_INPUT_EVENT, type Trace } from '@migor/agentia';

/**
 * 从 trace 还原工具调用。
 *
 * 事件名从 `@migor/agentia` 取（0.10.14 起与 `llm.fallback` / `config.fallbacks` 等 7 个
 * trace 词汇一起进了公共导出面）。此前是本地字面量副本，注释里写着「上游没外发」——
 * 那份副本已经删掉了：抄字面量的失败方式不是报错，是上游改名后**静默读到 0 条**。
 */

export interface ToolInvocation {
  readonly tool: string;
  /** 工具入参的原样文本（上游 body.input 通常是 JSON 字符串） */
  readonly input: string;
  readonly at: number;
}

/**
 * 从 trace 还原工具调用 —— 事件挂在 span 上，不是独立 span。
 *
 * 这是 agentia 的既定模型（一个回合 N 个 tool_use 共用一个 turn span），按事件
 * 时间排序还原真实顺序。序列、次数、参数三种断言都从这一个出口读，避免两处
 * 各自扫描而对「什么算一次调用」有不同理解。
 */
export function toolInvocations(trace: Trace): ToolInvocation[] {
  const calls: ToolInvocation[] = [];
  for (const span of trace.spans) {
    for (const e of span.events) {
      if (e.name !== TOOL_INPUT_EVENT) continue;
      const body = e.body as { tool?: unknown; input?: unknown } | null;
      const tool = body?.tool;
      if (typeof tool !== 'string') continue;
      calls.push({
        tool,
        input: inputText(body?.input),
        at: e.time,
      });
    }
  }
  return calls.sort((a, b) => a.at - b.at);
}

function inputText(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

/** 工具名序列（子序列断言用） */
export function toolSequence(trace: Trace): string[] {
  return toolInvocations(trace).map((c) => c.tool);
}
