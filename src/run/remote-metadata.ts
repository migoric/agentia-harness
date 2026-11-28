/**
 * A2A 响应的**读取形状**（服务端契约的客户端侧）。
 *
 * 单独一个文件是文件长度守卫逼出来的，但边界本身也说得通：`remote.ts` 管「怎么发
 * 一次请求」，这个文件管「对方回的那坨 JSON 里哪些字段我们认、怎么解读」。
 * 加一个新读数（比如这次的 `toolCalls`）只该动这里。
 */

export interface A2AMetadata {
  readonly routedTo?: string;
  readonly model?: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheCreationTokens?: number;
    readonly totalTokens?: number;
    readonly costUsd?: number;
  };
  readonly iterations?: number;
  /**
   * 意图层的派单三态。**这是判成败的权威来源**：
   * `done` = 子任务跑完了、`needs_input` = 等人补信息、`accepted` = 还在跑、`failed` = 失败。
   * 没有它时只能靠正文猜（那是模型措辞），或者把「意图层正常收尾」误当成「任务成功」。
   */
  readonly dispatch?: {
    readonly status?: string;
    readonly agentId?: string;
    readonly taskId?: string;
    readonly reason?: string;
  };
  /**
   * 服务端从 trace 里摘出来的能力调用（技能 / 子 agent / MCP 工具）。
   *
   * **缺席不等于空数组**：缺席是「对方没报（老服务 / 没 trace）」，空数组是
   * 「跑了但一个能力都没调」—— 后者对「该派单却自己答」这类失败正是证据。
   */
  readonly toolCalls?: ReadonlyArray<{
    readonly name?: string;
    readonly calls?: number;
    readonly errors?: number;
    readonly subagent?: boolean;
  }>;
}

export interface A2AResult {
  readonly kind?: string;
  readonly id?: string;
  readonly status?: { readonly state?: string };
  readonly parts?: ReadonlyArray<{ readonly text?: string }>;
  readonly artifacts?: ReadonlyArray<{
    readonly parts?: ReadonlyArray<{ readonly text?: string }>;
  }>;
  readonly metadata?: A2AMetadata;
}

/**
 * 服务报的能力调用 → 「技能」「子 agent」两栏。
 *
 * 为什么要本地再分一次：引擎的 capability span 只标 `attributes.subagent`，
 * 技能与 MCP 工具在 span 上同形。名字归属只有持有资产清单的这一侧说得清，
 * 所以给了 `skillNames` 就精确过滤；没给（`eval --remote` 不带资产）时全按技能记 ——
 * 归因只会拿它去自己的资产名单里匹配，多一个不认识的名字无害，而**少报**会让
 * 归因退回到「无资产命中」，提案器于是去改主 agent 的 system。
 */
export function capabilitiesOf(
  md: A2AMetadata | undefined,
  skillNames: ReadonlySet<string> | undefined,
): { skills: string[]; subagents: string[] } {
  const skills: string[] = [];
  const subagents: string[] = [];
  for (const c of md?.toolCalls ?? []) {
    const name = c.name;
    if (name === undefined || name === '') continue;
    if (c.subagent === true) {
      subagents.push(name);
      continue;
    }
    if (skillNames === undefined || skillNames.has(name)) skills.push(name);
  }
  // 去重、保持首次出现序：报告里要的是「用过哪些」，不是「用了几次」
  return { skills: [...new Set(skills)], subagents: [...new Set(subagents)] };
}
