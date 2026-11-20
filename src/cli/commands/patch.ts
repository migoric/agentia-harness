import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HarnessError } from '../../errors.js';
import { applyCodePatch, revertLastCode } from '../../rsi/code/apply.js';
import { parsePatch } from '../../rsi/code/diff.js';
import { verifyInSandbox } from '../../rsi/code/sandbox.js';
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
 * - `harness patch x.diff --yes`   验证通过后落盘（人工审批的那一步）
 * - `harness patch --revert`       回滚最近一次代码补丁
 *
 * L2 的「提案」刻意不由 LLM 生成：让人或外部 agent 交一个 diff 进来，本层负责
 * **验证、审批、留痕、回滚**这四件真正需要机器纪律的事。让模型直接写 TS 的失败率
 * 远高于它写提示词，而一次坏补丁的代价大得多 —— 这个不对称决定了分工。
 */
export async function patchCommand(ctx: CliContext, file: string | undefined): Promise<number> {
  if (boolFlag(ctx.flags, 'revert')) return revert(ctx);

  const patch = parsePatch(readPatch(file));
  const command = verifyCommand(ctx);
  const timeoutMs = numFlag(ctx.flags, 'timeout') ?? ctx.config.codeVerifyTimeoutMs;
  const sandbox = await verifyInSandbox({
    repoRoot: ctx.root,
    patch,
    command,
    timeoutMs,
  });
  const { verify } = sandbox;

  if (boolFlag(ctx.flags, 'json') && !boolFlag(ctx.flags, 'yes')) {
    json({ patch, sandbox });
    return verify.ok ? 0 : 1;
  }

  say(`补丁：${patch.files.join(', ')}`);
  say(
    `验证：${verify.ok ? 'PASS' : 'BLOCK'}（${command.join(' ')}，${(verify.durationMs / 1000).toFixed(1)}s，退出码 ${verify.exitCode ?? '无'}）`,
  );
  if (!verify.ok) {
    say(verify.timedOut ? '      超时 —— 超时按失败记，不放宽' : '      输出尾部：');
    for (const line of verify.outputTail.split('\n')) say(`      ${line}`);
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
