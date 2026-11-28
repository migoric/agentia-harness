import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join as joinPath, relative as relativePath, resolve } from 'node:path';
import { type HarnessConfig, reportsDir } from '../../config.js';
import { HarnessError } from '../../errors.js';
import { runSuite, type SuiteTuning } from '../../evals/run.js';
import type { CaseRunner } from '../../run/case-runner.js';
import { unpricedHint } from '../../run/endpoint.js';
import { createRemoteRunner } from '../../run/remote.js';
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
 * `--save <path>` 存报告，之后用 `harness report <基线> <候选>` 过回归门：
 * 两条命令合起来就是「改之前跑一次、改之后跑一次」的完整用法，不需要人工比对数字。
 */
export async function evalCommand(ctx: CliContext): Promise<number> {
  const tuning = tuningOf(ctx);
  const only = csvFlag(ctx.flags, 'only');
  const remote = remoteRunnerOf(ctx);
  const report = await runSuite({
    config: ctx.config,
    assets: assetsOf(ctx),
    ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
    ...(only !== undefined ? { only } : {}),
    ...(boolFlag(ctx.flags, 'keep-traces') ? { keepTraces: true } : {}),
    ...(remote !== undefined ? { runner: remote } : {}),
    ...tuning,
  });

  // `--save` 不带值 ⇒ 写约定目录（看板读的那一个）；带值 ⇒ 用户说了算。
  //
  // 这是这段话存在的理由：约定目录若只写在看板里、而 CLI 要求人肉给出完整路径，
  // 「刚跑完评测，看板里 0 份报告」就是默认体验，且两侧都不报错。
  const saveArg = ctx.flags.save;
  if (saveArg !== undefined) {
    const target =
      saveArg === true
        ? joinPath(reportsDir(ctx.config), reportFileName())
        : resolve(ctx.root, saveArg);
    writeJson(target, report);
    say(`报告已写入 ${relativePath(ctx.root, target)}`);
  }

  if (boolFlag(ctx.flags, 'json')) {
    json(report);
  } else {
    say(renderReport(report));
  }
  return report.passed === report.total ? 0 : 1;
}

/**
 * `--remote <url>`：把评测打到**服务**上（A2A），断言与报告完全复用本地那套。
 *
 * token 只从环境变量取（`--token-env`，缺省 `HARNESS_REMOTE_TOKEN`）：
 * 令牌出现在命令行里会进 shell history 与进程列表，那是最常见的泄漏方式。
 */
function remoteRunnerOf(ctx: CliContext): CaseRunner | undefined {
  const baseUrl = strFlag(ctx.flags, 'remote');
  if (baseUrl === undefined) {
    // 给了 token-env 却没给 remote 是「以为自己在测远程」的典型形态，必须响亮
    if (strFlag(ctx.flags, 'token-env') !== undefined) {
      throw new HarnessError('config.invalid', '--token-env 只与 --remote 一起用');
    }
    return undefined;
  }
  // 优先级：命令行 > 配置里的 `remote.tokenEnv` > 约定名。
  // 配置里有 remote 段却不认它的 tokenEnv，等于同一个服务要配两个变量名 —— 迟早有人配错
  const envName =
    strFlag(ctx.flags, 'token-env') ?? ctx.config.remote?.tokenEnv ?? 'HARNESS_REMOTE_TOKEN';
  const token = process.env[envName];
  if (token === undefined || token.trim() === '') {
    throw new HarnessError(
      'config.invalid',
      `远程评测需要凭据：设置环境变量 ${envName}（服务端的 api key），或用 --token-env 指定别的变量名`,
    );
  }
  return createRemoteRunner({
    baseUrl,
    token: token.trim(),
    ...(ctx.agent !== undefined ? { agentId: ctx.agent } : {}),
  });
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

/**
 * 默认报告文件名：UTC 时间戳，冒号与点换成 `-`。
 *
 * 不用 `:` 是因为它在 Windows 上非法、在 URL 里要转义；不用 `T` 分隔日期与时间
 * 是因为看板把那串当文件名显示，人第一眼要能读出「这是哪天」。
 * 带毫秒：同一秒里连跑两次（脚本里很常见）不该互相覆盖。
 */
function reportFileName(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
