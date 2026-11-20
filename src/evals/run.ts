import type { ModelClient } from '@migor/agentia';
import type { AssetSet } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import { createRunner, type RunOutcome } from '../run/runner.js';
import { combineAbort } from '../util/abort.js';
import { loadEvalCases } from './load.js';
import { toolInvocations } from './tool-events.js';
import { type CaseResult, type EvalCase, type EvalReport, summarize } from './types.js';

// 工具事件提取的唯一实现搬到了 tool-events.ts（序列 / 次数 / 参数共用一份扫描）。
// 保留从本模块再导出：index.ts 与既有测试一直从这里取 toolSequence。
export { toolInvocations, toolSequence } from './tool-events.js';

/**
 * 跑评测集。
 *
 * 三个刻意的纪律：
 *
 * 1. **不落 trace**（`persistTraces: false`）。评测会跑几十上百次，落盘会把
 *    `traces.jsonl` 变成垃圾场；要留证据就跑 `--keep-traces`，由调用方显式要。
 * 2. **失败即记，不中断**。一条用例挂了不代表后面的没意义 —— RSI 要的是完整的
 *    失败分布，而不是「第一条就停」。
 * 3. **只有「跑崩了」才重试**。断言不通过是**结果**，重试它就等于用采样次数掩盖
 *    问题 —— 那样 RSI 会学到「多试几次就过了」，而不是「这条提示词要改」。
 */
/**
 * 评测的调优旋钮 —— `runSuite` 与 `verifyProposal` 共用同一份形状。
 *
 * 抽出来是为了**不要两条口径**：RSI 的验证若比基线跑得更宽松（比如超时更长、
 * 重试更多），门比较的就不是同一个东西，采纳记录会变成噪声。
 */
export interface SuiteTuning {
  /** 单条用例超时（毫秒）。超时按失败记，不中断整轮 */
  readonly timeoutMs?: number | undefined;
  /**
   * 同时在飞的用例数（缺省 1）。
   *
   * 缺省串行的理由不是保守：并发会让「一轮花了多少钱」与「哪个用例贵」这两件事
   * 互相污染 —— 而 RSI 的成本归因全靠这个。要快就显式开，并接受归因变粗。
   */
  readonly concurrency?: number | undefined;
  /** 只对「run 抛出」重试的次数（缺省 0） */
  readonly retries?: number | undefined;
}

export interface RunSuiteOptions extends SuiteTuning {
  readonly config: HarnessConfig;
  readonly assets: AssetSet;
  readonly agent?: string | undefined;
  /** 注入模型客户端（测试与重放用）；不传走真实模型 */
  readonly client?: ModelClient | undefined;
  /**
   * 是否把每次评测运行的 trace 落盘（缺省不落）。
   *
   * 缺省不落是纪律：评测会跑几十上百次，落盘会把 `traces.jsonl` 变成垃圾场。
   * 需要回查某条失败用例的链路时显式开，报告里的 `traceId` 才有用。
   */
  readonly keepTraces?: boolean | undefined;
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

  const runner = createRunner(opts.config, opts.assets, opts.agent, opts.keepTraces === true);
  const limit = Math.max(1, opts.concurrency ?? 1);
  const results = await mapLimit(cases, limit, (c) => runOne(runner, c, opts));
  return summarize(
    results,
    opts.assets.fingerprint,
    `${runner.agent.name}@${runner.agent.version}`,
  );
}

/**
 * 有界并发，**保持输入顺序**。
 *
 * 顺序很重要：报告里用例的排列不该取决于谁先跑完，否则两次跑分的 diff 全是噪声。
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) return;
      out[i] = await fn(item);
    }
  });
  await Promise.all(workers);
  return out;
}

async function runOne(
  runner: ReturnType<typeof createRunner>,
  c: EvalCase,
  opts: RunSuiteOptions,
): Promise<CaseResult> {
  const retries = Math.max(0, opts.retries ?? 0);
  let out: RunOutcome | undefined;
  let lastError: unknown;
  let timedOut = false;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const gate = combineAbort(opts.signal, opts.timeoutMs);
    try {
      const work = runner.run(c.task, {
        ...(opts.client !== undefined ? { client: opts.client } : {}),
        ...(gate.signal !== undefined ? { signal: gate.signal } : {}),
      });
      // race 输掉之后 work 仍可能 reject（abort 常常正好让下游抛）—— 挂个空 catch，
      // 否则会变成 unhandled rejection 把进程带崩
      work.catch(() => undefined);
      out = await Promise.race([work, gate.expired]);
      timedOut = gate.timedOut();
      // 「跑崩了」在 agentia 里不一定表现为抛异常 —— 模型/客户端层的错会被收成
      // `stopReason: 'error'`（带结构化 error）。那才是最该重试的一类。
      //
      // 刻意**不看** `error.retryable`：那是引擎内部自动重试的语义，它已经用过了
      // （引擎自己重试过才把 run 收成 error）。这里的 `--retries` 是「外面再给一次
      // 机会」，语义不同，混用会让「用户要求的重试」被上游一个字段静默取消。
      if (out.stopReason === 'error' && attempt < retries) {
        lastError = out.error;
        out = undefined;
        continue;
      }
      break;
    } catch (e) {
      lastError = e;
      timedOut = gate.timedOut();
      // 超时或被取消时重试没有意义（只会再等一轮同样长的时间），直接收工
      if (timedOut || gate.signal?.aborted === true) break;
    } finally {
      gate.dispose();
    }
  }

  if (out === undefined) {
    // 装配/客户端层的异常也要变成「这条用例失败」，而不是让整轮崩掉
    return {
      name: c.name,
      passed: false,
      failures: [
        `${timedOut ? '用例超时' : 'run 抛出'}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      ],
      tokens: 0,
      costUsd: undefined,
      iterations: 0,
      durationMs: 0,
      stopReason: timedOut ? 'timeout' : 'threw',
      excerpt: '',
      skills: [],
      subagents: [],
    };
  }

  const failures = check(c, out);
  if (timedOut) failures.unshift(`用例超时（${opts.timeoutMs}ms）`);
  return {
    name: c.name,
    passed: failures.length === 0,
    failures,
    tokens: out.tokens,
    costUsd: out.costUsd,
    iterations: out.iterations,
    durationMs: out.durationMs,
    stopReason: out.stopReason,
    excerpt: out.text.slice(0, 400),
    traceId: out.trace.traceId,
    skills: out.skills,
    subagents: out.subagents,
  };
}

/** 断言。返回空数组 = 通过 */
export function check(c: EvalCase, out: RunOutcome): string[] {
  const f: string[] = [];
  // 只在这一轮真的需要过程类断言时才扫 trace —— 多数用例只看文本
  const needsTools =
    c.expect.tools !== undefined ||
    c.expect.toolCounts !== undefined ||
    (c.expect.toolArgs?.length ?? 0) > 0;
  const invocations = needsTools ? toolInvocations(out.trace) : [];
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
  for (const s of c.expect.notContains ?? []) {
    if (out.text.includes(s)) f.push(`正文不该出现 "${s}"`);
  }
  if (c.expect.matches !== undefined) {
    const re = new RegExp(c.expect.matches);
    if (!re.test(out.text)) f.push(`正文不匹配 /${c.expect.matches}/`);
  }
  if (c.expect.tools !== undefined && c.expect.tools.length > 0) {
    const seq = invocations.map((i) => i.tool);
    if (!isSubsequence(c.expect.tools, seq)) {
      f.push(
        `工具序列不符：期望 ${c.expect.tools.join(' → ')}，实际 ${seq.join(' → ') || '（无调用）'}`,
      );
    }
  }
  if (c.expect.toolCounts !== undefined) {
    const actual = countTools(invocations);
    for (const [tool, want] of Object.entries(c.expect.toolCounts)) {
      const got = actual.get(tool) ?? 0;
      if (got !== want) f.push(`工具 "${tool}" 调用 ${got} 次，期望恰好 ${want} 次`);
    }
  }
  for (const a of c.expect.toolArgs ?? []) {
    const hit = invocations.some((i) => i.tool === a.tool && i.input.includes(a.substring));
    if (!hit) {
      f.push(`工具 "${a.tool}" 的入参里没有 "${a.substring}"`);
    }
  }
  for (const s of c.expect.skills ?? []) {
    if (!out.skills.includes(s)) {
      f.push(`没有命中技能 "${s}"（实际：${out.skills.join(', ') || '无'}）`);
    }
  }
  if (c.expect.maxTokens !== undefined && out.tokens > c.expect.maxTokens) {
    f.push(`token 超预算：${out.tokens} > ${c.expect.maxTokens}`);
  }
  if (c.expect.maxIterations !== undefined && out.iterations > c.expect.maxIterations) {
    f.push(`轮数超预算：${out.iterations} > ${c.expect.maxIterations}`);
  }
  return f;
}

function countTools(invocations: readonly { tool: string }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const i of invocations) out.set(i.tool, (out.get(i.tool) ?? 0) + 1);
  return out;
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
