import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessError } from '../../errors.js';
import { applyCodePatch, revertLastCode } from '../../rsi/code/apply.js';
import { parsePatch } from '../../rsi/code/diff.js';
import { verifyInSandbox } from '../../rsi/code/sandbox.js';
import type { EvalSummary } from '../../rsi/code/types.js';
import { boolFlag, numFlag, strFlag } from '../args.js';
import type { CliContext } from '../context.js';
import { json, say } from '../output.js';

/**
 * `harness patch <diff>` —— L2 的唯一入口。
 *
 * 为什么 L2 不挂在 `rsi` 子命令下：RSI 一轮的产物是「提案」，而补丁的产物是
 * 「一次验证 + 一条采纳记录」。把两者塞进同一命令会让 `rsi --dry-run` 的语义变得
 * 可疑（dry-run 到底碰不碰代码？）。分开之后每个命令只做一件事：
 *
 * - `harness patch x.diff`         只验证，不落盘（缺省，可在 CI 里当门用）
 * - `harness patch x.diff --eval`  用**评测集**当验证门（而不是单测），摘要进 journal
 * - `harness patch x.diff --yes`   验证通过后落盘（人工审批的那一步）
 * - `harness patch --revert`       回滚最近一次代码补丁
 *
 * L2 的「提案」刻意不由 LLM 生成：让人或外部 agent 交一个 diff 进来，本层负责
 * **验证、审批、留痕、回滚**这四件真正需要机器纪律的事。让模型直接写 TS 的失败率
 * 远高于它写提示词，而一次坏补丁的代价大得多 —— 这个不对称决定了分工。
 */
export async function patchCommand(ctx: CliContext, file: string | undefined): Promise<number> {
  if (boolFlag(ctx.flags, 'revert')) return revert(ctx);

  const useEval = boolFlag(ctx.flags, 'eval');
  if (useEval && strFlag(ctx.flags, 'verify') !== undefined) {
    throw new HarnessError(
      'config.invalid',
      '--eval 与 --verify 是同一个旋钮的两种取值，只能给一个',
    );
  }
  const patch = parsePatch(readPatch(file));
  // `--eval` 的评测报告写到沙箱**外面**：沙箱会在验证结束后整体删除，写里面就等于没写
  const evalReport = useEval
    ? join(mkdtempSync(join(tmpdir(), 'harness-l2-')), 'report.json')
    : undefined;
  const command = evalReport !== undefined ? evalCommand(evalReport) : verifyCommand(ctx);
  const timeoutMs = numFlag(ctx.flags, 'timeout') ?? ctx.config.codeVerifyTimeoutMs;
  const sandbox = await verifyInSandbox({
    repoRoot: ctx.root,
    patch,
    command,
    timeoutMs,
  });
  // 评测摘要从报告文件读回来：沙箱只回输出尾部（40 行），靠解析 stdout 会拿到半截 JSON
  const summary = evalReport !== undefined ? readEvalSummary(evalReport) : undefined;
  const verify = summary !== undefined ? { ...sandbox.verify, eval: summary } : sandbox.verify;

  if (boolFlag(ctx.flags, 'json') && !boolFlag(ctx.flags, 'yes')) {
    json({ patch, sandbox: { ...sandbox, verify } });
    return verify.ok ? 0 : 1;
  }

  say(`补丁：${patch.files.join(', ')}`);
  say(
    `验证：${verify.ok ? 'PASS' : 'BLOCK'}（${command.join(' ')}，${(verify.durationMs / 1000).toFixed(1)}s，退出码 ${verify.exitCode ?? '无'}）`,
  );
  if (summary !== undefined) {
    say(
      `评测：${summary.passed}/${summary.total}（${(summary.passRate * 100).toFixed(1)}%），` +
        `${summary.tokens} token` +
        (summary.costUsd !== undefined ? `，${summary.costUsd.toFixed(4)} USD` : '，成本未知'),
    );
  }
  if (!verify.ok) {
    say(verify.timedOut ? '      超时 —— 超时按失败记，不放宽' : '      输出尾部：');
    for (const line of verify.outputTail.split('\n')) say(`      ${line}`);
    // 评测门没过时也要说清「差在哪」：退出码只告诉你「有用例没通过」
    if (summary !== undefined && summary.passed < summary.total) {
      say(`      有 ${summary.total - summary.passed} 条用例没过 —— 代码补丁不许降低通过率`);
    }
    return 1;
  }

  if (!boolFlag(ctx.flags, 'yes')) {
    say('未落盘（缺省只验证）。确认无误后加 --yes 落盘 —— 代码补丁不接受自动采纳。');
    return 0;
  }

  const entry = applyCodePatch({
    config: ctx.config,
    patch,
    verify,
    sandbox: sandbox.sandbox,
    approved: true,
  });
  if (boolFlag(ctx.flags, 'json')) {
    json(entry);
    return 0;
  }
  say(`已落盘 ${entry.proposalId}（journal 记了逐文件指纹，回滚用 harness patch --revert）`);
  return 0;
}

function revert(ctx: CliContext): number {
  const r = revertLastCode(ctx.config);
  if (boolFlag(ctx.flags, 'json')) {
    json(r);
    return 0;
  }
  say(`已回滚代码补丁 ${r.entry.proposalId}：`);
  for (const f of r.files) say(`  ${f}`);
  return 0;
}

/** `<文件>` 或 `-`（stdin）；两者都没有是用法错 */
function readPatch(file: string | undefined): string {
  if (file === undefined) {
    throw new HarnessError('config.invalid', 'patch 需要一个 diff 文件（或用 - 从 stdin 读）');
  }
  if (file === '-') return readFileSync(0, 'utf8');
  try {
    return readFileSync(resolve(file), 'utf8');
  } catch (e) {
    throw new HarnessError('config.invalid', `读不到补丁文件 ${file}`, e);
  }
}

/** `--verify "npm test"` 按空白切 —— 刻意不支持引号：沙箱里跑的东西越简单越可信 */
function verifyCommand(ctx: CliContext): readonly string[] {
  const raw = strFlag(ctx.flags, 'verify');
  if (raw === undefined) return ctx.config.codeVerify;
  const parts = raw.split(/\s+/).filter((s) => s !== '');
  if (parts.length === 0) {
    throw new HarnessError('config.invalid', '--verify 需要一个命令，例如 --verify "npm test"');
  }
  return parts;
}

/**
 * `--eval` 的验证命令：在沙箱里跑**这棵树的** `harness eval`。
 *
 * 四个细节都是踩过才写下来的：
 * 1. 用 `process.execPath` 而不是 `'node'`：PATH 上可能是另一个 node 版本，
 *    而「验证用的 node 与开发用的不是同一个」会让失败无法归因。
 * 2. 用**本文件的绝对路径**（`SELF`）而不是相对的 `src/cli.ts`：沙箱是被打补丁的那个
 *    仓库，它不一定有 `src/cli.ts`（业务工程就没有）。跑评测的应该始终是**当前这份**
 *    harness —— 否则「用被打补丁的代码去验证被打补丁的代码」，结论没有意义。
 * 3. 不给 `--root`：沙箱执行时的 cwd 就是沙箱根，`loadConfig` 会读沙箱里的
 *    `harness.config.json` 与资产 —— 那正是「打了补丁之后」的那一份。
 * 4. `--save <沙箱外的路径>`：报告要活过沙箱删除；`--json` 照样打给 stdout（进 outputTail）。
 *
 * 一条诚实的限制：沙箱的 root 是沙箱目录，`loadEnvFile` 找不到主仓的 `.env` ——
 * 凭据必须在**真实环境变量**里（或者用 `--verify` 自己拼命令）。
 */
/**
 * 本 CLI 的启动命令（绝对路径）：沙箱里跑评测必须用**当前这份** harness。
 *
 * **源码优先，dist 兜底** —— 顺序是刻意的。反过来的话，改完源码再验证会跑一份过期
 * 的构建产物，于是「评测过了」证明的是旧代码（这个坑真的踩过：dist 旧了三次，
 * 三次真机结论全是错的）。
 *
 * 两个分支都是必须的：
 * - 有 `src/`（开发态 / 仓库内）⇒ tsx + 源码。`--import` 必须给**解析出来的绝对 URL**：
 *   裸名 `tsx` 会按 cwd（= 沙箱）解析，而沙箱在别的目录树上，那里没有 node_modules
 *   （实测报 `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'`）；
 * - 只有 dist（npm 装出来的包，没有 tsx）⇒ 直接跑 `dist/cli.js`。
 */
function selfEntry(): readonly string[] {
  const src = fileURLToPath(new URL('../../cli.ts', import.meta.url));
  if (existsSync(src)) {
    try {
      return [process.execPath, '--import', import.meta.resolve('tsx'), src];
    } catch {
      // 没装 tsx（运行时安装）：落回 dist，而不是报一个和补丁无关的模块错
    }
  }
  return [process.execPath, fileURLToPath(new URL('../../../dist/cli.js', import.meta.url))];
}

export function evalCommand(reportPath: string): readonly string[] {
  // 不打 `--json`：验证失败时人要看的是那几行报告摘要，不是一整段 JSON。
  // 机器可读的那份已经在 `--save` 的文件里（摘要从那儿读回来）
  return [...selfEntry(), 'eval', '--save', reportPath];
}

/**
 * 读回评测报告，只留判据要的四个数。
 *
 * 文件读不到 / 不是合法 JSON 时**返回 undefined 而不是抛**：那时真正的失败已经写进
 * `verify.ok`（退出码非 0）与输出尾部了，这里再炸一次只会把有用的错误盖掉。
 */
function readEvalSummary(path: string): EvalSummary | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  const r = raw as {
    total?: unknown;
    passed?: unknown;
    passRate?: unknown;
    tokens?: unknown;
    costUsd?: unknown;
  };
  if (
    typeof r.total !== 'number' ||
    typeof r.passed !== 'number' ||
    typeof r.passRate !== 'number'
  ) {
    return undefined;
  }
  return {
    total: r.total,
    passed: r.passed,
    passRate: r.passRate,
    tokens: typeof r.tokens === 'number' ? r.tokens : 0,
    ...(typeof r.costUsd === 'number' ? { costUsd: r.costUsd } : {}),
  };
}
