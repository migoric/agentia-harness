import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { diffTraces } from '@migor/agentia';
import { HarnessError } from '../../errors.js';
import { gate } from '../../evals/gate.js';
import type { EvalReport } from '../../evals/types.js';
import { boolFlag, numFlag } from '../args.js';
import type { CliContext } from '../context.js';
import { json, say } from '../output.js';
import { renderComparison, renderDiff, renderTrace } from '../render.js';
import { findTrace, readTraces } from '../traces.js';

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
  const traces = readTraces(ctx.config, numFlag(ctx.flags, 'tail'));
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

/**
 * `harness diff <A> <B>` —— 两份 trace 差在哪。
 *
 * 为什么值得一条命令：`harness trace` 回答「这次发生了什么」，`harness report` 回答
 * 「整体有没有变好」，而人在修问题时问的是第三个问题 —— **「这两次差在哪一步」**。
 * `gate` 说得出「case 3 从通过变失败」，说不出「第 2 回合少了 search」；后者才是能改的东西。
 *
 * 上游 `diffTraces` 的配对是结构性的（`llm.turn` 只按 kind 配对、模型名降格成字段差），
 * 正好就是「换模型 / 换提示词重跑」这个主用例 —— 所以这里不做任何二次配对。
 */
export function diffCommand(
  ctx: CliContext,
  aId: string | undefined,
  bId: string | undefined,
): number {
  if (aId === undefined || bId === undefined) {
    throw new HarnessError(
      'config.invalid',
      'diff 需要两条 traceId：harness diff <A> <B>（都可用前缀；id 见 eval 报告或 run 的输出）',
    );
  }
  const tail = numFlag(ctx.flags, 'tail');
  const pick = { ...(tail !== undefined ? { tail } : {}) };
  const a = findTrace(ctx.config, aId, pick);
  const b = findTrace(ctx.config, bId, pick);
  const diff = diffTraces(a, b);
  if (boolFlag(ctx.flags, 'json')) json(diff);
  else say(renderDiff(a, b, diff));
  return 0;
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
  const tokenGrowth = numFlag(ctx.flags, 'max-token-growth');
  const costGrowth = numFlag(ctx.flags, 'max-cost-growth');
  const g = gate(baseline, candidate, {
    ...(tokenGrowth !== undefined ? { maxTokenGrowth: tokenGrowth } : {}),
    ...(costGrowth !== undefined ? { maxCostGrowth: costGrowth } : {}),
    // 用例集变了默认拒绝（分母不同，「变好还是变差」没有依据）；显式开这个口子
    // 等于声明「我知道评测集改过，只看同名用例」
    ...(boolFlag(ctx.flags, 'allow-case-set-change') ? { allowCaseSetChange: true } : {}),
  });
  if (boolFlag(ctx.flags, 'json')) json(g);
  else say(renderComparison(baseline, candidate, g));
  return g.ok ? 0 : 1;
}

export function readReport(root: string, path: string): EvalReport {
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
