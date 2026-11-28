import { InMemoryMemoryStore, type ModelClient } from '@migor/agentia';
import type { CaseRunner } from '../run/case-runner.js';
import { costOf } from '../run/cost.js';
import { menuFacts } from '../run/menu-read.js';
import { modelUsage } from '../run/model-read.js';
import type { RunOutcome } from '../run/runner.js';
import { mergeTraces } from '../run/trace-merge.js';
import { combineAbort } from '../util/abort.js';
import { check } from './check.js';
import type { CaseResult, EvalCase } from './types.js';

/**
 * 跑**一条**用例 —— 评测的执行单元。
 *
 * 与 `run.ts`（编排整轮）分开的理由是变化原因不同：
 *
 * - `run.ts` 关心「用例集怎么排、并发多少、报告怎么汇总」；
 * - 这里关心「一次运行怎么被超时/重试/多轮/成本折算处理成一个 `CaseResult`」。
 *
 * 这一半是最容易出静默错的地方（超时后已花的 token 要不要记、重试的边界在哪、
 * 多轮中途崩在第几轮），所以它单独一个文件、单独被读。
 *
 * 三条刻意的纪律：
 *
 * 1. **失败即记，不中断**。一条用例挂了不代表后面的没意义 —— RSI 要的是完整的
 *    失败分布，而不是「第一条就停」。
 * 2. **只有「跑崩了」才重试**。断言不通过是**结果**，重试它就等于用采样次数掩盖
 *    问题 —— 那样 RSI 会学到「多试几次就过了」，而不是「这条提示词要改」。
 * 3. **超时/取消时已花的成本要留住**。`Promise.race` 输掉之后整段结果就没了，
 *    但前面几轮真花过 token；把成本记成 0 会让「成本未知」与「免费」混为一谈。
 */
export interface OneShotOptions {
  /** 注入模型客户端（测试与重放用）；不传走真实模型 */
  readonly client?: ModelClient | undefined;
  /** 单条用例超时（毫秒）。超时按失败记，不中断整轮 */
  readonly timeoutMs?: number | undefined;
  /** 只对「run 抛出」或 `stopReason=error` 重试的次数（缺省 0） */
  readonly retries?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** 没有 `runTurns` 的 runner（远程）遇到多轮用例时必须炸，不能只跑第一轮 */
function missingRunTurns(): Promise<never> {
  return Promise.reject(
    new Error('这个 runner 不支持多轮用例（`<!-- turn -->` 分隔的），不能只跑第一轮'),
  );
}

export async function runOne(
  runner: CaseRunner,
  c: EvalCase,
  opts: OneShotOptions,
): Promise<CaseResult> {
  const retries = Math.max(0, opts.retries ?? 0);
  const plannedTurns = turnsOf(c);
  let out: RunOutcome | undefined;
  let lastError: unknown;
  let timedOut = false;
  /** 本次尝试里已经跑完的轮次（只有多轮才非空）—— 超时/异常时靠它保住这笔账 */
  let partial: RunOutcome[] = [];

  for (let attempt = 0; attempt <= retries; attempt++) {
    // 每次尝试一个**新的**数组，并且回调只闭包它：上一轮超时后 `work` 仍可能跑完并
    // 触发回调，若回调捕获的是外层的 `partial`，那几轮会被算进下一次尝试的账单
    const collected: RunOutcome[] = [];
    partial = collected;
    const gate = combineAbort(opts.signal, opts.timeoutMs);
    try {
      // 记忆**每个尝试各造一个**：上一次尝试写到黑板上的键若留下来，重试就不是
      // 「同样条件再来一次」，而是「带着上次的残留再跑」—— 那会让重试看起来像运气，
      // 而重试的语义必须和首跑一致，否则 `--retries` 会静默改变被测对象
      const memory =
        c.memoryKeys === undefined || c.memoryKeys.length === 0
          ? undefined
          : { store: new InMemoryMemoryStore(), keys: c.memoryKeys };
      const runOpts = {
        ...(opts.client !== undefined ? { client: opts.client } : {}),
        ...(gate.signal !== undefined ? { signal: gate.signal } : {}),
        ...(memory !== undefined ? { memory } : {}),
        onTurn: (o: RunOutcome) => collected.push(o),
      };
      // 单轮走 `run`（与线上同一条路），多轮才接会话。分支放在这里而不是 Runner 内部：
      // 「这条用例是几轮」是评测数据本身的性质，不是运行时的开关。
      const work =
        c.followUps === undefined || c.followUps.length === 0
          ? runner.run(c.task, runOpts)
          : // 保留方法调用形态（不把 runTurns 摘出来再调，那样 this 会丢）
            runner.runTurns === undefined
            ? missingRunTurns()
            : runner.runTurns([c.task, ...c.followUps], runOpts);
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
    //
    // 多轮用例在这里最容易失真：`Promise.race` 一输，整段 `runTurns` 的结果就没了。
    // 但已经跑完的那几轮真花过 token —— 所以先合并它们，报告才能说清「崩在第几轮、
    // 前面花了多少」，而不是把成本一律记成 0（成本未知不等于免费）。
    const spent = partial.length === 0 ? undefined : mergeTraces(partial.map((p) => p.trace));
    const tokens =
      spent === undefined
        ? 0
        : spent.totalUsage.inputTokens +
          spent.totalUsage.outputTokens +
          spent.totalUsage.cacheReadTokens +
          spent.totalUsage.cacheCreationTokens;
    const failedTurn =
      plannedTurns === undefined ? undefined : Math.min(partial.length + 1, plannedTurns);
    const done = partial.length === 0 ? '' : `（前 ${partial.length} 轮已完成，${tokens} token）`;
    // 前几轮真跑过，模型事实就得留下：把「降级到 B 才崩」记成「什么都没跑」，
    // 会让这一轮的模型集合与降级次数凭空消失，而报告是可比性判断的唯一依据
    const mu = spent === undefined ? undefined : modelUsage(spent);
    // 前几轮真跑过，菜单与资产版本也得留下：这一条虽然崩了，它的菜单仍是「本轮用过什么」
    // 的证据；漏掉它会让整批变成「至少一条没记 ⇒ 不知道」，而这批本来是可以确认的
    const mf = spent === undefined ? {} : menuFacts(spent);
    return {
      name: c.name,
      task: c.task,
      split: c.split,
      ...(c.phase === undefined ? {} : { phase: c.phase }),
      passed: false,
      failures: [
        `${timedOut ? '用例超时' : 'run 抛出'}${failedTurn === undefined ? '' : `（第 ${failedTurn} 轮）`}${done}: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
      ],
      tokens,
      costUsd: spent === undefined ? undefined : costOf(spent),
      iterations: partial.reduce((sum, p) => sum + p.iterations, 0),
      durationMs: partial.reduce((sum, p) => sum + p.durationMs, 0),
      stopReason: timedOut ? 'timeout' : 'threw',
      excerpt: '',
      skills: [],
      subagents: [],
      ...(mu === undefined ? {} : { models: mu.models, fallbackUsed: mu.fallbacks }),
      ...mf,
      ...(plannedTurns === undefined ? {} : { turns: plannedTurns }),
      ...(failedTurn === undefined ? {} : { failedTurn }),
      // 期望路由随结果落盘（见 `CaseResult.expectRoute`）：基线报告可能是上一版用例写的，
      // 那时 `route` 已不在手里，只有报告自己能把它带回来
      ...(c.route === undefined ? {} : { expectRoute: c.route }),
      // 崩之前跑完的那几轮已经承接过了；拿最后一轮的承接者当这条用例的实际路由。
      // 一轮都没跑完（首轮就抛）时恒缺席 —— 那时确实不知道派给了谁
      ...(spent === undefined ? {} : { routedTo: partial[partial.length - 1]?.agent }),
    };
  }

  const failures = check(c, out);
  if (timedOut) failures.unshift(`用例超时（${opts.timeoutMs}ms）`);
  return {
    name: c.name,
    task: c.task,
    split: c.split,
    ...(c.phase === undefined ? {} : { phase: c.phase }),
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
    ...(c.route === undefined ? {} : { expectRoute: c.route }),
    // 实际路由：只在 runner 明确报出承接者时才写（见 `RunOutcome.agent`）。
    // 崩在半路的那条也写 —— 路由发生在第一轮之前，崩了不等于没派给人；
    // 漏掉它会让「派错了人，然后崩了」在报告里长成「没派」，两种病治法不同。
    ...(out.agent === undefined ? {} : { routedTo: out.agent }),
    // 条件展开：外部构造的 outcome 可能没这两个字段（见 `RunOutcome.models`），
    // 写 `[]` 会让「没记」与「一个回合都没跑」在报告里长成一样
    ...(out.models === undefined ? {} : { models: out.models, fallbackUsed: out.fallbacks ?? 0 }),
    // 菜单签名与资产版本：与模型集合同属「这一条到底被测了什么」的证据
    ...menuFacts(out.trace),
    ...(out.turns === undefined ? {} : { turns: out.turns }),
    ...(out.failedTurn === undefined ? {} : { failedTurn: out.failedTurn }),
  };
}

/** 计划轮数（单轮用例返回 undefined，报告里就不出现这个字段） */
function turnsOf(c: EvalCase): number | undefined {
  const extra = c.followUps?.length ?? 0;
  return extra === 0 ? undefined : extra + 1;
}
