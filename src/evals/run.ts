import type { ModelClient, Trace } from '@migor/agentia';
import type { AssetSet } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import { createRunner, type RunOutcome } from '../run/runner.js';
import { loadEvalCases } from './load.js';
import { type CaseResult, type EvalCase, type EvalReport, summarize } from './types.js';

/**
 * 跑评测集。
 *
 * 两个刻意的纪律：
 *
 * 1. **不落 trace**（`persistTraces: false`）。评测会跑几十上百次，落盘会把
 *    `traces.jsonl` 变成垃圾场；要留证据就跑 `--keep-traces`，由调用方显式要。
 * 2. **失败即记，不中断**。一条用例挂了不代表后面的没意义 —— RSI 要的是完整的
 *    失败分布，而不是「第一条就停」。
 */
export interface RunSuiteOptions {
  readonly config: HarnessConfig;
  readonly assets: AssetSet;
  readonly agent?: string | undefined;
  /** 注入模型客户端（测试与重放用）；不传走真实模型 */
  readonly client?: ModelClient | undefined;
  readonly signal?: AbortSignal | undefined;
  /** 只跑这些用例（按名） */
  readonly only?: readonly string[] | undefined;
}

export async function runSuite(opts: RunSuiteOptions): Promise<EvalReport> {
  const all = loadEvalCases(opts.config.evalsDir);
  if (all.length === 0) {
    throw new HarnessError(
      'eval.invalid',
      `${opts.config.evalsDir} 下没有用例 —— 没有评测集，RSI 的任何改动都无法被验证`,
    );
  }
  const cases =
    opts.only === undefined ? all : all.filter((c) => opts.only?.includes(c.name) ?? false);
  if (cases.length === 0) {
    throw new HarnessError('eval.invalid', `--only 没有匹配到任何用例: ${opts.only?.join(', ')}`);
  }

  const runner = createRunner(opts.config, opts.assets, opts.agent, false);
  const results: CaseResult[] = [];
  for (const c of cases) {
    results.push(await runOne(runner, c, opts));
  }
  return summarize(
    results,
    opts.assets.fingerprint,
    `${runner.agent.name}@${runner.agent.version}`,
  );
}

async function runOne(
  runner: ReturnType<typeof createRunner>,
  c: EvalCase,
  opts: RunSuiteOptions,
): Promise<CaseResult> {
  let out: RunOutcome;
  try {
    out = await runner.run(c.task, {
      ...(opts.client !== undefined ? { client: opts.client } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } catch (e) {
    // 装配/客户端层的异常也要变成"这条用例失败"，而不是让整轮崩掉
    return {
      name: c.name,
      passed: false,
      failures: [`run 抛出: ${e instanceof Error ? e.message : String(e)}`],
      tokens: 0,
      iterations: 0,
      durationMs: 0,
      stopReason: 'threw',
      excerpt: '',
    };
  }
  const failures = check(c, out);
  return {
    name: c.name,
    passed: failures.length === 0,
    failures,
    tokens: out.tokens,
    iterations: out.iterations,
    durationMs: out.durationMs,
    stopReason: out.stopReason,
    excerpt: out.text.slice(0, 400),
  };
}

/** 断言。返回空数组 = 通过 */
export function check(c: EvalCase, out: RunOutcome): string[] {
  const f: string[] = [];
  const wantOk = c.expect.ok ?? true;
  if (wantOk && !out.ok) {
    f.push(`期望正常收尾，实际 stopReason=${out.stopReason}`);
  }
  if (!wantOk && out.ok) {
    f.push('期望非正常收尾，实际正常收尾');
  }
  for (const s of c.expect.contains ?? []) {
    if (!out.text.includes(s)) f.push(`正文缺少 "${s}"`);
  }
  if (c.expect.matches !== undefined) {
    const re = new RegExp(c.expect.matches);
    if (!re.test(out.text)) f.push(`正文不匹配 /${c.expect.matches}/`);
  }
  if (c.expect.tools !== undefined && c.expect.tools.length > 0) {
    const seq = toolSequence(out.trace);
    if (!isSubsequence(c.expect.tools, seq)) {
      f.push(
        `工具序列不符：期望 ${c.expect.tools.join(' → ')}，实际 ${seq.join(' → ') || '（无调用）'}`,
      );
    }
  }
  if (c.expect.maxTokens !== undefined && out.tokens > c.expect.maxTokens) {
    f.push(`token 超预算：${out.tokens} > ${c.expect.maxTokens}`);
  }
  return f;
}

/**
 * agentia 的工具入参事件名（`core/trace.ts` 的 `TOOL_INPUT_EVENT`）。
 *
 * 为什么写字面量而不是 import：agentia 的公共导出面里没有它（它属于
 * 「core 词汇表」，只对内部三层可见）。这里复制一份字面量是有风险的 ——
 * 上游改名会让我们静默读到 0 条工具调用。防线是测试：`tests/evals.test.ts`
 * 用真实调用产生的 trace 断言这个序列非空，改名会立刻红。
 */
const TOOL_INPUT_EVENT = 'tool.input';

/**
 * 从 trace 提取工具调用序列。
 *
 * 工具调用不是独立 span —— 它以 `tool.input` 事件挂在 `llm.turn` span 上。这是
 * agentia 的既定模型（一个回合 N 个 tool_use 共用一个 turn span），不是我们能选的，
 * 所以这里按事件时间排序还原真实顺序。
 */
export function toolSequence(trace: Trace): string[] {
  const calls: { at: number; tool: string }[] = [];
  for (const span of trace.spans) {
    for (const e of span.events) {
      if (e.name !== TOOL_INPUT_EVENT) continue;
      const body = e.body as { tool?: unknown } | null;
      const tool = body?.tool;
      if (typeof tool === 'string') calls.push({ at: e.time, tool });
    }
  }
  return calls.sort((a, b) => a.at - b.at).map((c) => c.tool);
}

/** 子序列匹配：允许中间夹别的调用（「先查再改」不该被无关调用判失败） */
function isSubsequence(need: readonly string[], seq: readonly string[]): boolean {
  let i = 0;
  for (const s of seq) {
    if (need[i] === s) i++;
    if (i === need.length) return true;
  }
  return i === need.length;
}
