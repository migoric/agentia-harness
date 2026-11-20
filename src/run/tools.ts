import { type AgentTool, isSuccessStopReason, runCapabilityLoop } from '@migor/agentia';
import type { SkillAsset } from '../assets/types.js';
import { HarnessError } from '../errors.js';

/**
 * 技能资产 → 工具。
 *
 * 桥梁是 `runCapabilityLoop`（agentia 的公共原语，@Skill 内部用的就是它）：它在
 * **当前工具调用**里拉起一条受限子循环，所以技能天然是一个 capability span，
 * 成本、迭代数、失败原因全部落进同一棵 trace —— 这正是 RSI 归因要读的东西。
 *
 * 三个刻意的取舍：
 *
 * 1. **正文即 system**。技能不是「一段可拼接的提示词」，而是一次独立子运行的
 *    完整系统提示。它看不到主 agent 的历史（上下文隔离），只拿到 `task`。
 *    代价是主 agent 必须把上下文写进 task；收益是技能行为可独立评测 ——
 *    而「可独立评测」是 RSI 能验证改动的唯一前提。
 * 2. **非正常收尾就抛**。子循环 `max_tokens` / `aborted` 时若把半截文本当结果返回，
 *    主 agent 会当成结论继续跑，错误被层层放大。抛出去让模型自己决定换路。
 * 3. **入参只有一个 task 字符串**。多字段 schema 会引诱模型编造参数；绝大多数技能
 *    要的就是一段任务描述，多余的结构化留给 agent 资产（system + tools）。
 */
export function buildSkillTools(skills: readonly SkillAsset[]): AgentTool[] {
  assertNoCycles(skills);
  const byName = new Map(skills.map((s) => [s.name, s]));
  const built = new Map<string, AgentTool>();

  const build = (name: string): AgentTool => {
    const cached = built.get(name);
    if (cached !== undefined) return cached;
    const asset = byName.get(name);
    if (asset === undefined) {
      throw new HarnessError(
        'asset.missing',
        `技能引用不存在的能力 "${name}"（可用: ${[...byName.keys()].sort().join(', ') || '无'}）`,
      );
    }
    const tool: AgentTool = {
      name: asset.name,
      description: asset.description,
      capability: 'skill',
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: '交给这项技能的任务描述。技能看不到你的对话历史，上下文请一并写进来。',
          },
        },
        required: ['task'],
        additionalProperties: false,
      },
      run: async (input, ctx) => {
        if (ctx === undefined) {
          throw new HarnessError(
            'run.failed',
            `技能 "${asset.name}" 必须在 agent 工具调用里执行（拿不到 recorder 就没有 trace 归因）`,
          );
        }
        const { task } = input as SkillInput;
        const subTools = asset.tools.map((n) => build(n));
        const r = await runCapabilityLoop(ctx, {
          name: asset.name,
          input: task,
          system: asset.body,
          ...(subTools.length > 0 ? { tools: subTools } : {}),
          ...(asset.model !== undefined ? { model: asset.model } : {}),
          ...(asset.maxIterations !== undefined ? { maxIterations: asset.maxIterations } : {}),
        });
        if (!isSuccessStopReason(r.stopReason)) {
          const why = r.error === undefined ? r.stopReason : `${r.stopReason}: ${r.error.message}`;
          throw new Error(`技能 "${asset.name}" 未正常收尾（${why}），未产出可用结果`);
        }
        return r.text;
      },
    };
    built.set(name, tool);
    return tool;
  };

  return skills.map((s) => build(s.name));
}

interface SkillInput {
  readonly task: string;
}

/**
 * 静态环检测。
 *
 * 运行期才炸是不够的：A→B→A 会一直跑到栈溢出或预算耗尽，而那一刻的 trace 里
 * 只有几十层相同的 capability span，看不出根因。装配期一次 DFS 就能指名道姓。
 */
export function assertNoCycles(skills: readonly SkillAsset[]): void {
  const graph = new Map(skills.map((s) => [s.name, s.tools]));
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (name: string, trail: readonly string[]): void => {
    const mark = state.get(name);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      const start = trail.indexOf(name);
      const cycle = [...trail.slice(start === -1 ? 0 : start), name];
      throw new HarnessError('asset.invalid', `技能引用成环: ${cycle.join(' → ')}`);
    }
    state.set(name, 'visiting');
    for (const next of graph.get(name) ?? []) {
      if (graph.has(next)) visit(next, [...trail, name]);
    }
    state.set(name, 'done');
  };

  for (const s of skills) visit(s.name, []);
}
