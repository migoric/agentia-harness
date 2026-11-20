import type { Trace } from '@migor/agentia';
import { HarnessError } from '../errors.js';
import { capabilityHits } from '../run/trace-read.js';
import { toolInvocations } from './tool-events.js';

/**
 * 从一条 trace 回流出一个 eval case（纯函数，不碰磁盘）。
 *
 * 一个必须说清的边界：**trace 里没有任务原文**。root span 只记模型/配置/收尾状态，
 * 所以 `task` 必须来自调用方（`--task`，或从 eval 报告按 traceId 反查）。凭空猜一个
 * 任务会让回流用例测的是另一件事 —— 那比没有用例更糟。
 *
 * 同理，自动生成的断言只有 `expect_ok: true`：trace 记录的是**实际行为**，不是
 * **正确行为**。把实际调过的工具/技能固化成断言，等于把当时的错误一起固化。
 * 所以这里只在 frontmatter 注释里列出观察到的事实，提示人补结果类断言。
 */
export interface HarvestedCase {
  readonly name: string;
  /** 可直接写成 `<evals>/<name>.md` 的 Markdown */
  readonly text: string;
  /** 给人看的摘要：回流时从 trace 里读到了什么 */
  readonly summary: string;
}

export function harvestCase(
  trace: Trace,
  task: string,
  opts: { name?: string; skillNames?: ReadonlySet<string> } = {},
): HarvestedCase {
  const trimmed = task.trim();
  if (trimmed === '') {
    throw new HarnessError('eval.invalid', 'harvest 需要一个非空任务描述（trace 里没有任务原文）');
  }
  const name = opts.name ?? `harvest-${safeName(trace.traceId)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new HarnessError(
      'eval.invalid',
      `harvest 用例名 "${name}" 含非法字符（只认字母数字 _ -）`,
    );
  }

  const root = trace.spans.find((s) => s.spanId === trace.rootSpanId);
  const stop = root?.attributes.stop_reason;
  const invocations = toolInvocations(trace);
  const counts = new Map<string, number>();
  for (const i of invocations) counts.set(i.tool, (counts.get(i.tool) ?? 0) + 1);
  const tools = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([t, n]) => `${t}(${n})`)
    .join(' ');
  // 技能与子 agent 靠名字区分，没有资产名集合时宁可不写，也不要把子 agent 当技能
  const skills =
    opts.skillNames === undefined ? '' : capabilityHits(trace, opts.skillNames).skills.join(' ');
  const summary = [
    `status=${trace.status}`,
    stop === undefined ? undefined : `stop=${String(stop)}`,
    tools === '' ? '工具=无' : `工具=${tools}`,
    opts.skillNames === undefined ? undefined : skills === '' ? '技能=无' : `技能=${skills}`,
  ]
    .filter((s) => s !== undefined)
    .join(' · ');

  const text = [
    '---',
    `name: ${name}`,
    'expect_ok: true',
    `# 来源 trace: ${trace.traceId}`,
    `# 观察: ${summary}`,
    '# 自动断言只覆盖「过程类」回归；答案正确性请补 expect_contains / expect_matches',
    '---',
    '',
    trimmed,
    '',
  ].join('\n');

  return { name, text, summary };
}

function safeName(traceId: string): string {
  return traceId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 12);
}
