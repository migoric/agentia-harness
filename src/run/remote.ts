import type { Trace } from '@migor/agentia';
import { HarnessError } from '../errors.js';
import type { CaseRunner } from './case-runner.js';
import type { CostNote } from './runner.js';

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
    async run(task, runOpts) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = (): void => controller.abort();
      runOpts?.signal?.addEventListener('abort', onAbort, { once: true });
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
                contextId: `eval-${started.toString(36)}`,
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
        runOpts?.signal?.removeEventListener('abort', onAbort);
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
    },
    runTurns() {
      return Promise.reject(
        new HarnessError(
          'config.invalid',
          '远程评测暂不支持多轮用例（`<!-- turn -->` 分隔的那些）—— ' +
            '静默按单轮跑会让它只测了第一轮，而报告里看不出来。请先用 --only 排除它们，' +
            '或改用本地评测跑多轮。',
        ),
      );
    },
  };
  return runner;
}
