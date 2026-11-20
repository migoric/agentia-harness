import {
  type AgentTool,
  isSuccessStopReason,
  type JsonSchema,
  runCapabilityLoop,
  subagentToTool,
} from '@migor/agentia';
import type { AgentAsset, AssetSet, SkillAsset } from '../assets/types.js';
import { HarnessError } from '../errors.js';

/** 技能与子 agent 共用的入参形状：只收一段任务描述 */
const TASK_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    task: {
      type: 'string',
      description: '交给它的任务描述。它看不到你的对话历史，上下文请一并写进来。',
    },
  },
  required: ['task'],
  additionalProperties: false,
};

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
      inputSchema: TASK_SCHEMA,
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
 * 装配一个 agent 能看到的工具表。
 *
 * 能力清单的语义（技能与 agent 同一套）：
 * - `tools` **未声明** → 挂全部技能（缺省必须安全：安静地少挂能力是最难查的故障）；
 * - `tools: [a, b]` → 只挂这些，这是精确清单，也是多 agent 工程「这个 agent 不该能干
 *   那件事」的表达方式；
 * - `tools: []` → 一个都不挂（纯文本 agent）；
 * - `subagents: [x]` → 把 agent x 变成可委派的工具（未声明即不委派）。
 *
 * 委派走 `subagentToTool`（agentia 的既有原语）而不是自己拉 `runCapabilityLoop`：
 * 它会在 trace 上写 `subagent` 属性与 `agentia.handoff.from/to`，于是「谁把活交给了谁」
 * 是 trace 里的一等事实，而不是靠命名约定反推。
 *
 * `spec.tools` 只被 `subagentToTool` 用来判断「要不要取工具」，真正的过滤由传进去的
 * `resolveTools` 完成 —— 所以这里把能力名原样写进去，而不是拼 provider token 路径。
 */
export function buildTools(agent: AgentAsset, set: AssetSet): AgentTool[] {
  const skillByName = new Map(buildSkillTools(set.skills).map((t) => [t.name, t]));
  const agentByName = new Map(set.agents.map((a) => [a.name, a]));
  const built = new Map<string, AgentTool>();
  const allSkills = set.skills.map((s) => s.name);

  /** 未声明 = 全部（见上）；声明了就严格按清单 */
  const skillsOf = (a: AgentAsset): readonly string[] => (a.toolsDeclared ? a.tools : allSkills);

  const requireSkill = (name: string): AgentTool => {
    const t = skillByName.get(name);
    if (t === undefined) {
      throw new HarnessError(
        'asset.missing',
        `引用不存在的技能 "${name}"（可用: ${[...skillByName.keys()].sort().join(', ') || '无'}）`,
      );
    }
    return t;
  };

  const requireAgent = (name: string, from: string): AgentAsset => {
    const a = agentByName.get(name);
    if (a === undefined) {
      throw new HarnessError(
        'asset.missing',
        `${from} 委派了不存在的 agent "${name}"（可用: ${[...agentByName.keys()].sort().join(', ') || '无'}）`,
      );
    }
    return a;
  };

  const buildAgent = (a: AgentAsset, trail: readonly string[]): AgentTool => {
    const cached = built.get(a.name);
    if (cached !== undefined) return cached;
    if (trail.includes(a.name)) {
      throw new HarnessError('asset.invalid', `agent 委派成环: ${[...trail, a.name].join(' → ')}`);
    }
    // 子工具在**装配期**全部建好：环检测才有意义。若留到运行期再解析，A→B→A 会一直
    // 跑到预算耗尽，而那一刻的 trace 里只有几十层同名 capability span。
    const children = [
      ...skillsOf(a).map(requireSkill),
      ...a.subagents.map((n) =>
        buildAgent(requireAgent(n, `agent "${a.name}"`), [...trail, a.name]),
      ),
    ];
    const tool = subagentToTool(
      {
        name: a.name,
        description: a.description,
        inputSchema: TASK_SCHEMA,
        spec: {
          name: a.name,
          description: a.description,
          schema: TASK_SCHEMA,
          system: a.body,
          ...(children.length > 0 ? { tools: [...skillsOf(a), ...a.subagents] } : {}),
          ...(a.model !== undefined ? { model: a.model } : {}),
          ...(a.maxIterations !== undefined ? { maxIterations: a.maxIterations } : {}),
        },
      },
      () => children,
    );
    built.set(a.name, tool);
    return tool;
  };

  return [
    ...skillsOf(agent).map(requireSkill),
    ...agent.subagents.map((n) =>
      buildAgent(requireAgent(n, `agent "${agent.name}"`), [agent.name]),
    ),
  ];
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
