import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { HarnessConfig } from '../../config.js';
import { HarnessError } from '../../errors.js';
import { runSuite, type SuiteTuning } from '../../evals/run.js';
import { unpricedHint } from '../../run/endpoint.js';
import { type CostNote, createRunner } from '../../run/runner.js';
import { boolFlag, csvFlag, numFlag, strFlag } from '../args.js';
import { assetsOf, type CliContext } from '../context.js';
import { json, say, warn } from '../output.js';
import { renderReport } from '../render.js';

/** `harness run "<task>"` —— 跑一次，打印结果与 traceId */
export async function runCommand(ctx: CliContext, task: string): Promise<number> {
  if (task.trim() === '') {
    throw new HarnessError('run.failed', 'run 需要任务描述：harness run "..."');
  }
  const runner = createRunner(ctx.config, assetsOf(ctx), ctx.agent);
  const out = await runner.run(task);
  if (boolFlag(ctx.flags, 'json')) {
    json({
      text: out.text,
      ok: out.ok,
      stopReason: out.stopReason,
      tokens: out.tokens,
      model: runner.model,
      costUsd: out.costUsd ?? null,
      costNote: out.costNote ?? null,
      iterations: out.iterations,
      durationMs: out.durationMs,
      skills: out.skills,
      subagents: out.subagents,
      traceId: out.trace.traceId,
      error: out.error ?? null,
    });
  } else {
    say(out.text);
    say(
      `\n[${out.stopReason}] ${out.tokens} token${costSuffix(out.costUsd)} · ${out.iterations} 轮 · ${out.durationMs}ms · trace ${out.trace.traceId}`,
    );
    if (out.skills.length > 0) say(`技能：${out.skills.join(', ')}`);
    if (out.subagents.length > 0) say(`委派：${out.subagents.join(', ')}`);
    // 「没读数」必须说清是哪一种：一个是配置能修的，一个不是
    const why = costNoteHint(out.costNote, ctx.config, runner.model);
    if (why !== undefined) warn(why);
  }
  return out.ok ? 0 : 1;
}

/**
 * `costSuffix` 的反面：**没有**成本读数时解释原因。
 *
 * 静默不打 `$` 是最糟的选择 —— 看上去像「这次很便宜」。两种病因分开报，
 * 因为能做的动作完全不同（改配置 / 换端点）。
 */
function costNoteHint(
  note: CostNote | undefined,
  config: HarnessConfig,
  model: string,
): string | undefined {
  if (note === 'unpriced') return unpricedHint(config, model);
  if (note === 'unreported') {
    return '端点没有回报 token 计量 —— 本轮成本不可用，maxCostUsd 与 RSI 预算闸都不会生效（trace 里有 usage.missing 事件）。';
  }
  return undefined;
}

/** 没有成本读数时打空串，不打印 `$0` —— 那会被读成「免费」 */
function costSuffix(usd: number | undefined): string {
  if (usd === undefined) return '';
  return usd < 0.01 ? ` $${usd.toFixed(5)}` : ` $${usd.toFixed(3)}`;
}

/**
 * `harness eval` —— 跑评测集。
 *
 * `--save <path>` 存报告，`--compare <path>` 与旧报告比并过门：这两条命令合起来
 * 就是「改之前跑一次、改之后跑一次」的完整用法，不需要人工比对数字。
 */
export async function evalCommand(ctx: CliContext): Promise<number> {
  const tuning = tuningOf(ctx);
  const only = csvFlag(ctx.flags, 'only');
  const report = await runSuite({
    config: ctx.config,
    assets: assetsOf(ctx),
    ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
    ...(only !== undefined ? { only } : {}),
    ...(boolFlag(ctx.flags, 'keep-traces') ? { keepTraces: true } : {}),
    ...tuning,
  });

  const savePath = strFlag(ctx.flags, 'save');
  if (savePath !== undefined) {
    writeJson(resolve(ctx.root, savePath), report);
    say(`报告已写入 ${savePath}`);
  }

  if (boolFlag(ctx.flags, 'json')) {
    json(report);
  } else {
    say(renderReport(report));
  }
  return report.passed === report.total ? 0 : 1;
}

export function tuningOf(ctx: CliContext): SuiteTuning {
  const timeoutMs = numFlag(ctx.flags, 'timeout');
  const concurrency = numFlag(ctx.flags, 'concurrency');
  const retries = numFlag(ctx.flags, 'retries');
  return {
    ...(timeoutMs !== undefined ? { timeoutMs: positive(timeoutMs, '--timeout') } : {}),
    ...(concurrency !== undefined ? { concurrency: positive(concurrency, '--concurrency') } : {}),
    ...(retries !== undefined ? { retries: Math.max(0, Math.trunc(retries)) } : {}),
  };
}

function positive(n: number, flag: string): number {
  if (n <= 0) throw new HarnessError('config.invalid', `${flag} 必须是正数（收到 ${n}）`);
  return n;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
