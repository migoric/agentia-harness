import type { Span, Trace } from '@migor/agentia';

/**
 * 从 trace 读「这次跑实际用了哪些能力」。
 *
 * 技能与子 agent 的判定方式**不对称**，这是如实反映上游模型而不是我们的选择：
 *
 * - 子 agent 的 capability span 带 `attributes.subagent`（`subagentToTool` 写的）；
 * - 技能的 capability span **不带** `attributes.skill` —— `runCapabilityLoop` 只
 *   `begin('capability', name)`，那个属性是 `@Skill` 装饰器路径写的，harness 走的是
 *   子循环原语。所以技能只能靠**名字集合**判定。
 *
 * 靠名字判定要求「工具名跨 kind 唯一」，而那条约束已经在 `discoverAssets` 里强制
 * （技能与 agent 会进同一张模型工具表，撞名本来就该报错）。所以这里不做二次校验。
 */
export interface CapabilityHits {
  /** 按发生顺序，可能有重复（同一技能被调两次就是两条） */
  readonly skills: readonly string[];
  readonly subagents: readonly string[];
}

export function capabilityHits(trace: Trace, skillNames: ReadonlySet<string>): CapabilityHits {
  const spans: Span[] = [...trace.spans].sort((a, b) => a.startedAt - b.startedAt);
  const skills: string[] = [];
  const subagents: string[] = [];
  for (const s of spans) {
    if (s.kind !== 'capability') continue;
    if (s.attributes.subagent !== undefined) {
      subagents.push(s.name);
      continue;
    }
    if (skillNames.has(s.name)) skills.push(s.name);
  }
  return { skills, subagents };
}

/** 去重且保持首次出现顺序 —— 报告里要的是「用过哪些」，不是「用了几次」 */
export function distinct(names: readonly string[]): string[] {
  return [...new Set(names)];
}
