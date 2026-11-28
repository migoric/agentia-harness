import { readFileSync } from 'node:fs';
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

/**
 * 读 `traces.jsonl`。唯一的 trace 文件解析实现 —— CLI 展示、harvest、evidence 语料共用。
 *
 * 半行只跳过并计数：进程被杀时可能留下半截 JSON，让整条命令失败只会妨碍取证。
 */
export interface TraceLine {
  readonly trace: Trace;
  /** 与 trace 严格配对的原始行（evidence 的 raw/ 就存它） */
  readonly line: string;
}

export function readTraceLines(
  path: string,
  tail?: number,
): { traces: Trace[]; entries: TraceLine[]; bad: number; lines: readonly string[] } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // 「文件不存在」有两种常见成因，而默认的那种**不是**「没跑过」：trace 默认不落盘
    // （每次留一份会让 .workspace 涨得很快），所以跑过十次 eval 的工程照样可以没有这个
    // 文件，而报告里的 `traceId` 一直填着。说成「还没跑过任何任务」会把人引向
    // 「是不是评测没跑成功」—— 真正要做的是加 `--keep-traces` 重跑一次。
    throw new Error(
      `读不到 ${path} —— 这个工程还没落过 trace。trace 默认不留：跑 eval 时加 --keep-traces 才有（路径不对也会走到这里）`,
    );
  }
  const all = text.split('\n').filter((l) => l.trim() !== '');
  const lines = tail !== undefined && tail > 0 ? all.slice(-tail) : all;
  const traces: Trace[] = [];
  const entries: TraceLine[] = [];
  let bad = 0;
  for (const line of lines) {
    try {
      const trace = JSON.parse(line) as Trace;
      traces.push(trace);
      // 必须在同一次循环里配对：两条数组分别 push 会让坏行之后的所有 raw 存错内容
      entries.push({ trace, line });
    } catch {
      bad++;
    }
  }
  return { traces, entries, bad, lines };
}
