import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join as joinPath, relative as relativePath, resolve } from 'node:path';
import { type HarnessConfig, reportsDir } from '../../config.js';
import { describeError, HarnessError } from '../../errors.js';
import { appendRun } from '../../evals/history.js';
import { assertCasesExist, runSuite, type SuiteTuning } from '../../evals/run.js';
import type { EvalReport } from '../../evals/types.js';
import type { CaseRunner } from '../../run/case-runner.js';
import { unpricedHint } from '../../run/endpoint.js';
import { createRemoteRunner } from '../../run/remote.js';
import { type CostNote, createRunner } from '../../run/runner.js';
import { boolFlag, csvFlag, numFlag, strFlag } from '../args.js';
import { assetsOf, type CliContext } from '../context.js';
import { json, say, warn } from '../output.js';
import { renderReport } from '../render.js';
import { requireModel } from '../require-model.js';
import { authHint, formatError } from '../run-diagnose.js';

/** `harness run "<task>"` —— 跑一次，打印结果与 traceId */
export async function runCommand(ctx: CliContext, task: string): Promise<number> {
  if (task.trim() === '') {
    throw new HarnessError('run.failed', 'run 需要任务描述：harness run "..."');
  }
  requireModel(ctx);
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
    // 失败原因必须打出来。`text` 在失败时通常是空的，状态行又只有一个 `stopReason`
    // 词 —— 两者合起来就是「一行没有任何信息的红字」。而 `error` 里其实有完整的
    // 上游报文（HTTP 状态、端点原话），它此前只走 `--json`，等于**只有写脚本的人看得见**。
    if (!out.ok && out.error !== undefined) {
      warn(`\n错误：${formatError(out.error)}`);
      const hint = authHint(out.error, ctx.config);
      if (hint !== undefined) warn(hint);
    }
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
  // 用例集为空是**工程的病**，先于「缺凭据」报：两者都要退出码 2，但一个人先看到
  // 「没有评测集」才知道该去建用例，而不是去配 key。
  assertCasesExist(ctx.config, only);
  if (remote === undefined) requireModel(ctx);
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
  let saved: string | undefined;
  if (saveArg !== undefined) {
    const target =
      saveArg === true
        ? joinPath(reportsDir(ctx.config), reportFileName())
        : resolve(ctx.root, saveArg);
    writeJson(target, report);
    saved = relativePath(ctx.root, target);
    say(`报告已写入 ${saved}`);
  }
  // 记账与 `--save` 无关：报告是**某一次**的快照，历史是**所有次**的走向。
  // 只在 `--save` 时记，等于「不存报告就没有历史」—— 而判断抖动恰恰只需要结果，
  // 不需要那份 JSON。`--no-history` 留给「试一下，别污染趋势」的场合。
  if (!boolFlag(ctx.flags, 'no-history')) recordHistory(ctx, report, saved);

  if (boolFlag(ctx.flags, 'json')) {
    json(report);
  } else {
    say(renderReport(report));
  }
  return report.passed === report.total ? 0 : 1;
}

/**
 * 把这次运行记进历史账本。失败只出声、不改变退出码。
 *
 * 理由是这条路径的**主产品是评测结论**，历史是它的旁证。磁盘只读、空间满、工程根在
 * 只读挂载上——这些都不该让「评测跑完了、结论正确」变成一次失败。但也不能一声不响：
 * 静默丢账的症状是几天后发现「抖动判定一直没生效」，而那时已经很难回溯是哪次开始丢的。
 */
function recordHistory(ctx: CliContext, report: EvalReport, saved: string | undefined): void {
  try {
    appendRun(ctx.config, report, { ...(saved !== undefined ? { report: saved } : {}) });
  } catch (e) {
    warn(`历史没记上（${describeError(e)}）—— 评测结果本身不受影响`);
  }
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
  // 本地资产名单用来把服务报的 capability 分成技能与子 agent（`eval --remote` 也带资产，
  // 没有理由让它比 rsi 少一栏读数）
  const skillNames = new Set(assetsOf(ctx).skills.map((s) => s.name));
  return createRemoteRunner({
    baseUrl,
    token: token.trim(),
    ...(ctx.agent !== undefined ? { agentId: ctx.agent } : {}),
    skillNames,
  });
}

export function tuningOf(ctx: CliContext): SuiteTuning {
  const timeoutMs = numFlag(ctx.flags, 'timeout');
  const concurrency = numFlag(ctx.flags, 'concurrency');
  const retries = numFlag(ctx.flags, 'retries');
  const repeat = numFlag(ctx.flags, 'repeat');
  return {
    ...(timeoutMs !== undefined ? { timeoutMs: positive(timeoutMs, '--timeout') } : {}),
    ...(concurrency !== undefined ? { concurrency: positive(concurrency, '--concurrency') } : {}),
    ...(retries !== undefined ? { retries: Math.max(0, Math.trunc(retries)) } : {}),
    ...(repeat !== undefined ? { repeat: positiveInt(repeat, '--repeat') } : {}),
  };
}

function positive(n: number, flag: string): number {
  if (n <= 0) throw new HarnessError('config.invalid', `${flag} 必须是正数（收到 ${n}）`);
  return n;
}

/**
 * 正整数 —— `--repeat` 专用。
 *
 * 不用 `Math.trunc` 抹平原值：`--repeat 2.5` 的意图不明（2 次还是 3 次？），静默取整会
 * 让「我以为采样了 3 次」与报告里的事实差一次，而采样次数正是判断区间的唯一依据。
 */
function positiveInt(n: number, flag: string): number {
  if (!Number.isInteger(n) || n <= 0) {
    throw new HarnessError('config.invalid', `${flag} 必须是正整数（收到 ${n}）`);
  }
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
