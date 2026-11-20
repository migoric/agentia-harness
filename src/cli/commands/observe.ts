import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Trace } from '@migor/agentia';
import { HarnessError } from '../../errors.js';
import { gate } from '../../evals/gate.js';
import type { EvalReport } from '../../evals/types.js';
import { boolFlag, numFlag } from '../args.js';
import type { CliContext } from '../context.js';
import { json, say, warn } from '../output.js';
import { renderComparison, renderTrace } from '../render.js';

/**
 * `harness trace <id>` —— 把一次运行的 span 树打出来。
 *
 * 为什么这个命令值得存在：RSI 归因读的是**汇总**（失败模式、命中统计），而人查问题
 * 读的是**链路**（谁调了谁、在哪一步炸的）。没有这条命令，`.workspace/traces.jsonl`
 * 就只是一堆没人会去 grep 的日志。
 */
export function traceCommand(ctx: CliContext, id: string | undefined): number {
  if (id === undefined) {
    throw new HarnessError('config.invalid', 'trace 需要一个 traceId（可用前缀匹配）');
  }
  const traces = readTraces(ctx.config.tracesPath, numFlag(ctx.flags, 'tail'));
  const hit = traces.filter((t) => t.traceId.startsWith(id)).at(-1);
  if (hit === undefined) {
    throw new HarnessError(
      'run.failed',
      `${ctx.config.tracesPath} 里没有以 "${id}" 开头的 trace（共 ${traces.length} 条）`,
    );
  }
  if (boolFlag(ctx.flags, 'json')) json(hit);
  else say(renderTrace(hit));
  return 0;
}

function readTraces(path: string, tail: number | undefined): Trace[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new HarnessError('run.failed', `读不到 ${path} —— 还没跑过任何任务（或路径不对）`);
  }
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const slice = tail !== undefined && tail > 0 ? lines.slice(-tail) : lines;
  const out: Trace[] = [];
  let bad = 0;
  for (const line of slice) {
    try {
      out.push(JSON.parse(line) as Trace);
    } catch {
      // 半行（进程被杀）不该让整条命令失败 —— 但也不能装作没看见
      bad++;
    }
  }
  if (bad > 0) warn(`跳过 ${bad} 行无法解析的记录（可能是进程中途被杀写下的半行）`);
  return out;
}

/**
 * `harness report <基线.json> <候选.json>` —— 两份报告比一次，过门。
 *
 * 这是把「改了提示词，到底变好没有」变成**退出码**的那条命令：CI 里不用人读数字。
 */
export function reportCommand(
  ctx: CliContext,
  baselinePath: string | undefined,
  candidatePath: string | undefined,
): number {
  if (baselinePath === undefined || candidatePath === undefined) {
    throw new HarnessError(
      'config.invalid',
      'report 需要两份报告：harness report <基线.json> <候选.json>（用 eval --save 生成）',
    );
  }
  const baseline = readReport(ctx.root, baselinePath);
  const candidate = readReport(ctx.root, candidatePath);
  const growth = numFlag(ctx.flags, 'max-token-growth');
  const g = gate(baseline, candidate, growth !== undefined ? { maxTokenGrowth: growth } : {});
  if (boolFlag(ctx.flags, 'json')) json(g);
  else say(renderComparison(baseline, candidate, g));
  return g.ok ? 0 : 1;
}

function readReport(root: string, path: string): EvalReport {
  const full = resolve(root, path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(full, 'utf8'));
  } catch (e) {
    throw new HarnessError('eval.invalid', `读不到或不是合法 JSON：${full}`, e);
  }
  const r = parsed as Partial<EvalReport>;
  if (!Array.isArray(r.cases) || typeof r.total !== 'number') {
    throw new HarnessError(
      'eval.invalid',
      `${full} 不像一份评测报告（缺 cases/total）—— 请用 harness eval --save 生成`,
    );
  }
  return r as EvalReport;
}
