import type { Trace } from '@migor/agentia';
import { HarnessError } from '../errors.js';
import type { CaseRunner } from './case-runner.js';
import { costOf } from './cost.js';
import type { CostNote, RunOutcome } from './runner.js';
import { mergeTraces } from './trace-merge.js';

/**
 * 把 **远程服务** 当一个 runner 用：`harness eval --remote <url>` 的实现。
 *
 * 为什么值得存在：本地评测证明的是「提示词在本地装配下好不好」，而线上跑的是
 * **服务里的那份装配**（鉴权、租户配额、意图层派单、真模型）。两者共用 `check()` /
 * 报告结构 / 回归门，但跑的是不同的东西 —— 只评本地会出现「本地全绿、线上答非所问」。
 *
 * 四条刻意的口径：
 *
 * 1. **只走 A2A，不走服务的内部 API**。A2A 是对外契约（`message/send` + artifacts +
 *    metadata），评测读它才等于读「客户端能看到的那一面」。
 * 2. **`tokens` / `costUsd` 只从对方报的 `metadata.usage` 拿**。拿不到就如实是 `undefined`
 *    或 0 —— 绝不用本地估算补一个数，那会让「远程这条用例很贵」变成看不见的事。
 * 3. **`iterations` 报 0 而不是猜**。轮次不是 A2A 的字段；服务若在 metadata 里给了
 *    `iterations` 就用它，没给就 0（报告里「0 轮」是一个明确的缺失信号，不是一个读数）。
 * 4. **多轮直接拒绝**（`runTurns` 抛错）。静默按单轮跑会让多轮用例只测了第一轮，
 *    而报告里看不出任何异常 —— 那种"绿"比红更危险。
 */
export interface RemoteRunnerOptions {
  /** 服务根地址，如 `http://192.168.31.112:18080` */
  readonly baseUrl: string;
  /** `authorization: Bearer <token>` */
  readonly token: string;
  /**
   * 打到哪个入口：
   * - 不给 ⇒ `<base>/a2a`（**意图层**，会经过派单，`routedTo` 才有意义）
   * - 给了 ⇒ `<base>/agents/<id>/a2a`（直连那个 agent）
   */
  readonly agentId?: string | undefined;
  /** 单请求超时（毫秒），缺省 5 分钟 */
  readonly timeoutMs?: number | undefined;
  /** 测试注入 */
  readonly fetchImpl?: typeof fetch | undefined;
}

interface A2AMetadata {
  readonly routedTo?: string;
  readonly model?: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheCreationTokens?: number;
    readonly totalTokens?: number;
    readonly costUsd?: number;
  };
  readonly iterations?: number;
  /**
   * 意图层的派单三态。**这是判成败的权威来源**：
   * `done` = 子任务跑完了、`needs_input` = 等人补信息、`accepted` = 还在跑、`failed` = 失败。
   * 没有它时只能靠正文猜（那是模型措辞），或者把「意图层正常收尾」误当成「任务成功」。
   */
  readonly dispatch?: {
    readonly status?: string;
    readonly agentId?: string;
    readonly taskId?: string;
    readonly reason?: string;
  };
}

interface A2AResult {
  readonly kind?: string;
  readonly id?: string;
  readonly status?: { readonly state?: string };
  readonly parts?: ReadonlyArray<{ readonly text?: string }>;
  readonly artifacts?: ReadonlyArray<{
    readonly parts?: ReadonlyArray<{ readonly text?: string }>;
  }>;
  readonly metadata?: A2AMetadata;
}

const EMPTY_TRACE: Trace = {
  traceId: 'remote',
  rootSpanId: 'remote',
  spans: [],
  status: 'ok',
  totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
};

/** 每轮一个派生 id：单轮用它当 contextId，多轮共用一个（见 runTurns 的注释） */
function newContextId(): string {
  return `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function textOf(r: A2AResult): string {
  let text = '';
  for (const p of r.parts ?? []) text += p.text ?? '';
  for (const a of r.artifacts ?? []) for (const p of a.parts ?? []) text += p.text ?? '';
  return text;
}

/**
 * 远程 → 本地 `ok` 口径。
 *
 * 优先级：派单三态 > task 状态 > 「有正文就算跑完」。
 * 最后那一档只给老服务兜底（那时意图层返回的是纯 Message）—— 它把「意图层自己跑完了」
 * 当成「任务成功」，是**已知的乐观**；新服务都会带 dispatch，走不到这里。
 */
function okOf(state: string | undefined, dispatchStatus: string | undefined): boolean {
  if (dispatchStatus !== undefined) return dispatchStatus === 'done';
  if (state !== undefined) return state === 'completed';
  return true;
}

function stopReasonOf(state: string | undefined, dispatchStatus: string | undefined): string {
  if (dispatchStatus !== undefined) {
    switch (dispatchStatus) {
      case 'done':
        return 'end_turn';
      case 'needs_input':
        return 'suspended';
      case 'accepted':
        return 'accepted';
      default:
        return 'error';
    }
  }
  // 与本地 `StopReason` 对齐的近似：本地正常收尾是 end_turn、异常有各自的名字。
  // 远程只有 A2A 的四个状态，这里如实映射（`input-required` 就是挂起，不是失败）
  switch (state) {
    case 'completed':
      return 'end_turn';
    case 'failed':
      return 'error';
    case 'canceled':
      return 'cancelled';
    case 'input-required':
      return 'suspended';
    default:
      return 'unknown';
  }
}

export function createRemoteRunner(opts: RemoteRunnerOptions): CaseRunner {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const path = opts.agentId === undefined ? '/a2a' : `/agents/${opts.agentId}/a2a`;
  const url = `${base}${path}`;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  // 远程模型名在**第一次运行后**才有：`model` 是只读属性，但报告要在跑完之后才读它，
  // 所以用一个可变的持有对象（构造期它只能是 unknown —— 那正是诚实的初始值）
  const seen: { model?: string } = {};

  const runner: CaseRunner = {
    agent: {
      name: opts.agentId === undefined ? 'remote:intent' : `remote:${opts.agentId}`,
      version: 1,
    },
    get model() {
      return seen.model;
    },
    run(task, runOpts) {
      return sendOnce(task, newContextId(), runOpts?.signal);
    },
    /**
     * 多轮：**同一个 contextId** 连续发。
     *
     * 这是 A2A 的会话语义 —— 换 contextId 就是换会话，历史接不上；而多轮用例测的
     * 恰恰是「它记不记得上一轮」。中途某轮非正常收尾就中止：后面几轮会在一个真实
     * 会话里不会出现的上下文上作答，那种结果既不能当失败证据（病根在前面），
     * 也不能当通过（它测的不是用户会遇到的事）。
     */
    async runTurns(turns, runOpts) {
      if (turns.length === 0) {
        throw new HarnessError('config.invalid', 'runTurns 至少需要一轮');
      }
      const blank = turns.findIndex((t) => t.trim() === '');
      if (blank !== -1) {
        throw new HarnessError('config.invalid', `第 ${blank + 1} 轮是空的`);
      }
      const contextId = newContextId();
      const parts: RunOutcome[] = [];
      let threwAt: number | undefined;
      let thrown: RunOutcome['error'];
      for (const [i, task] of turns.entries()) {
        let out: RunOutcome;
        try {
          out = await sendOnce(task, contextId, runOpts?.signal);
        } catch (e) {
          threwAt = i;
          thrown = { type: 'remote', message: e instanceof Error ? e.message : String(e) };
          break;
        }
        parts.push(out);
        if (!out.ok && i < turns.length - 1) break;
      }

      const failedAt = parts.findIndex((p) => !p.ok);
      const failedIndex = failedAt === -1 ? (threwAt ?? -1) : failedAt;
      // 一轮都没跑成时给一条 error 状态的空 trace：下游断言与成本口径照常工作，
      // 而「status: error」让「什么都没跑」与「跑完了但没内容」在报告里能分开
      const merged =
        parts.length === 0
          ? ({ ...EMPTY_TRACE, status: 'error' } as Trace)
          : mergeTraces(parts.map((p) => p.trace));
      // 用每轮自报的 tokens 累加，而不是从合并后的 trace 重算：
      // 对方只给 `totalTokens`（不给四项拆分）时，trace 的四项是 0，重算会把钱算没
      const tokens = parts.reduce((sum, p) => sum + p.tokens, 0);
      const cost = costOf(merged);
      const last = parts[parts.length - 1];
      return {
        text: last?.text ?? '',
        ok: failedIndex === -1,
        stopReason:
          parts[failedIndex]?.stopReason ??
          (failedIndex === -1 ? (last?.stopReason ?? 'end_turn') : 'error'),
        iterations: parts.reduce((sum, p) => sum + p.iterations, 0),
        trace: merged,
        tokens,
        costUsd: cost,
        costNote: parts.length === 0 ? 'unreported' : (last?.costNote ?? undefined),
        durationMs: parts.reduce((sum, p) => sum + p.durationMs, 0),
        error: thrown ?? parts.find((p) => p.error !== undefined)?.error,
        skills: [],
        subagents: [],
        ...(seen.model !== undefined ? { model: seen.model } : {}),
        ...(last?.agent !== undefined ? { agent: last.agent } : {}),
        turns: turns.length,
        ...(failedIndex === -1 ? {} : { failedTurn: failedIndex + 1 }),
      };
    },
  };

  /** 发一轮。多轮靠 `contextId` 串成一段会话，单轮每次新起一个 */
  async function sendOnce(
    task: string,
    contextId: string,
    signal: AbortSignal | undefined,
  ): Promise<RunOutcome> {
    {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = (): void => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      let body: { result?: A2AResult; error?: { code?: number; message?: string } };
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.token}` },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: `harness-${started}`,
            method: 'message/send',
            params: {
              // 评测要结果，不要「已受理」：blocking:true 让服务等任务落终态再回
              configuration: { blocking: true },
              message: {
                role: 'user',
                parts: [{ kind: 'text', text: task }],
                contextId,
              },
            },
          }),
          signal: controller.signal,
        });
        const text = await res.text();
        if (!res.ok) {
          throw new HarnessError(
            'run.failed',
            `远程 ${url} 回 HTTP ${res.status}：${text.slice(0, 200)}`,
          );
        }
        body = JSON.parse(text) as typeof body;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }

      if (body.error !== undefined) {
        throw new HarnessError(
          'run.failed',
          `远程 JSON-RPC 错误 ${String(body.error.code)}：${body.error.message ?? ''}`,
        );
      }
      const r = body.result ?? {};
      const md = r.metadata ?? {};
      if (md.model !== undefined) seen.model = md.model;

      const u = md.usage;
      const total =
        u?.totalTokens ??
        (u?.inputTokens ?? 0) +
          (u?.outputTokens ?? 0) +
          (u?.cacheReadTokens ?? 0) +
          (u?.cacheCreationTokens ?? 0);
      const trace: Trace = {
        ...EMPTY_TRACE,
        traceId: r.id ?? 'remote',
        rootSpanId: r.id ?? 'remote',
        totalUsage: {
          inputTokens: u?.inputTokens ?? 0,
          outputTokens: u?.outputTokens ?? 0,
          cacheReadTokens: u?.cacheReadTokens ?? 0,
          cacheCreationTokens: u?.cacheCreationTokens ?? 0,
          ...(u?.costUsd !== undefined ? { costEstimate: u.costUsd } : {}),
        },
      };
      const costNote: CostNote | undefined =
        u === undefined ? 'unreported' : u.costUsd === undefined ? 'unpriced' : undefined;

      return {
        text: textOf(r),
        ok: okOf(r.status?.state, md.dispatch?.status),
        stopReason: stopReasonOf(r.status?.state, md.dispatch?.status),
        iterations: md.iterations ?? 0,
        trace,
        tokens: total,
        costUsd: u?.costUsd,
        costNote,
        durationMs: Date.now() - started,
        error: okOf(r.status?.state, md.dispatch?.status)
          ? undefined
          : {
              type: `remote:${md.dispatch?.status ?? r.status?.state ?? 'unknown'}`,
              message:
                md.dispatch?.reason ??
                `远程任务结束于 ${md.dispatch?.status ?? r.status?.state ?? '未知状态'}`,
            },
        // 实际承接任务的 agent：这是 `routeAccuracy` 的唯一真值来源。
        // 优先 dispatch（意图层明确说派给了谁），其次 routedTo（老服务的字段名）
        ...(md.dispatch?.agentId !== undefined
          ? { agent: md.dispatch.agentId }
          : md.routedTo !== undefined
            ? { agent: md.routedTo }
            : {}),
        // 远程不报「命中哪个技能 / 委派过谁」：留空而不是编
        skills: [],
        subagents: [],
      };
    }
  }

  return runner;
}
