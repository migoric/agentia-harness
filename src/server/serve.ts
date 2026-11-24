import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ModelClient } from '@migor/agentia';
import { discoverAssets } from '../assets/discover.js';
import type { AssetSet } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import { createRunner, type Runner, type RunOutcome } from '../run/runner.js';
import { combineAbort } from '../util/abort.js';
import {
  authorized,
  json,
  logInternal,
  readJson,
  resolveKey,
  statusOf,
  TIMED_OUT,
} from './http.js';

/**
 * 最小 HTTP 面。
 *
 * 只有两个端点，是刻意的：harness 的 server 不是产品，是**让别的进程能调这个
 * agent** 的缝。真要会话管理、审批、SSE 那一套，用 agentia 的 `transport/`
 * （它已经做完了），别在这里长第二套。
 *
 * ```
 * POST /v1/run    { "task": "..." }  →  { text, ok, stopReason, tokens, costUsd, durationMs, traceId, skills }
 * GET  /health                       →  { ok, agent, assets, uptimeMs, queued, maxQueue, auth }
 * ```
 *
 * `/run` 与 `/v1/health` 是**旧路径别名**（版本前缀加进来之前只有这两个字符串，
 * 已有人在用）。新调用方写 `/v1/run` —— 有一天要破坏性改协议时，那是唯一能靠
 * 前缀分辨「老调用方」的地方。
 *
 * 六条硬规矩（都不是「以后再说」的事）：
 *
 * 1. **串行执行**。一个进程同时跑多个任务会让成本归因互相污染，而成本归因是 RSI
 *    的输入。要并发就起多个进程（每个有独立 workspace）。
 * 2. **队列有上限**。串行 + 无限队列 = 请求照收、延迟无限增长，调用方拿到的是
 *    「等了十分钟然后超时」而不是「现在别来」。超限返回 429 + `retry-after`。
 * 3. **请求体有上限**。没有上限的 JSON 解析 = 一个 curl 就能把进程打死。
 * 4. **单请求有超时**。超时按失败返回，但 trace 会留下完整记录 —— 那正是事后查
 *    「为什么这个请求超时」的唯一证据。
 * 5. **默认不对外**。没配 `server.apiKeyEnv` 时只服务回环地址；配了就必须带
 *    `authorization: Bearer <key>`。配了环境变量却是空的，启动直接失败 —— 把
 *    「空 key」当成「不用鉴权」是这类闸最典型的静默失效。
 * 6. **关闭是优雅的**：先停止接新请求（503），再等在飞的那一个跑完。直接 exit
 *    会让正在写的 trace 缺收尾 span。
 */
export interface ServerOptions {
  readonly config: HarnessConfig;
  readonly assets: AssetSet;
  readonly agent?: string | undefined;
  readonly port: number;
  readonly host?: string | undefined;
  /** 单请求超时（毫秒），缺省 10 分钟 */
  readonly timeoutMs?: number | undefined;
  /** 请求体上限（字节），缺省 1 MiB */
  readonly maxBodyBytes?: number | undefined;
  /**
   * 鉴权 key 的**环境变量名**（来自 `server.apiKeyEnv`）。不给 = 只服务回环地址。
   *
   * 用环境变量名而不是值：`ServerOptions` 会被日志、测试夹具、调试器打印，
   * 而 key 出现在任何一处都算泄漏。
   */
  readonly apiKeyEnv?: string | undefined;
  /** 队列上限（含正在跑的那一个），缺省 8 */
  readonly maxQueue?: number | undefined;
  /**
   * 注入模型客户端（测试与重放用）；不传走真实模型。
   *
   * 有这个口子不是为了「让部署更灵活」，是为了**HTTP 面能被测**：没有它，
   * `/run` 的正常路径只能在有 API 凭据时验证，而「串行闸真的在生效吗」这类问题
   * 恰恰只能在并发两个请求时看出来。
   */
  readonly client?: ModelClient | undefined;
}

export interface RunningServer {
  readonly port: number;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_BODY = 1024 * 1024;
const DEFAULT_MAX_QUEUE = 8;

/** 一个端点两个名字：带版本前缀的是对外契约，不带的是历史别名 */
const RUN_PATHS: ReadonlySet<string> = new Set(['/run', '/v1/run']);
const HEALTH_PATHS: ReadonlySet<string> = new Set(['/health', '/v1/health']);

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const runner = createRunner(opts.config, opts.assets, opts.agent, true);
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
  // 配了鉴权却没有值 ⇒ 启动失败。空 key 若被当成「不用鉴权」，那台机器会以
  // 「配置了安全措施」的样子对外提供服务 —— 比没配更危险。
  const apiKey = resolveKey(opts.apiKeyEnv);

  let closing = false;
  let pending = 0;
  /** 串行链：一次只有一个 run 在跑（见文件头第 1 条） */
  let chain: Promise<unknown> = Promise.resolve();

  const server = createServer((req, res) => {
    void handle(req, res, {
      runner,
      config: opts.config,
      assets: opts.assets,
      ...(opts.client !== undefined ? { client: opts.client } : {}),
      startedAt,
      timeoutMs,
      maxBody,
      maxQueue,
      ...(apiKey !== undefined ? { apiKey } : {}),
      isClosing: () => closing,
      queued: () => pending,
      queue: (fn) => {
        pending++;
        const next = chain.then(fn, fn);
        chain = next.then(
          () => undefined,
          () => undefined,
        );
        return next.finally(() => {
          pending--;
        });
      },
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : opts.port;
  return {
    port,
    close: async () => {
      closing = true;
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e === undefined || e === null ? resolve() : reject(e)));
        // Node 20 起 close() 会顺带关掉空闲 keep-alive 连接；显式调一次是为了
        // 在旧版本上也不会卡住（那时 close 只等新连接不再建立）。
        server.closeIdleConnections();
      });
      await chain; // 等在飞的那个请求收尾，trace 才不缺尾
    },
  };
}

interface HandlerCtx {
  readonly runner: Runner;
  /** 健康检查要现读磁盘指纹（见 `/health` 的 `assetDrift`） */
  readonly config: HarnessConfig;
  readonly assets: AssetSet;
  readonly client?: ModelClient | undefined;
  readonly startedAt: number;
  readonly timeoutMs: number;
  readonly maxBody: number;
  readonly maxQueue: number;
  /** 已解析的鉴权 key；缺席 = 只服务回环地址 */
  readonly apiKey?: string | undefined;
  isClosing(): boolean;
  /** 当前排队 + 在飞的请求数（健康检查里给运维看，也用来确认串行闸真的在生效） */
  queued(): number;
  queue<T>(fn: () => Promise<T>): Promise<T>;
}

async function handle(req: IncomingMessage, res: ServerResponse, c: HandlerCtx): Promise<void> {
  const url = req.url ?? '/';
  try {
    if (c.isClosing()) {
      return json(res, 503, { error: '服务正在关闭，不再接受新请求' });
    }
    if (req.method === 'GET' && HEALTH_PATHS.has(url)) {
      // 服务的 runner 用的是**启动时**的资产快照。RSI 采纳之后磁盘变了而进程没变，
      // 探针若只报快照指纹，运维看到的是一台「资产是新的」的旧进程。现读一次磁盘，
      // 把漂移说出来（`null` = 读不动，例如资产文件坏了 —— 那也要能看见）。
      const onDisk = fingerprintOnDisk(c.config);
      return json(res, 200, {
        ok: true,
        agent: `${c.runner.agent.name}@${c.runner.agent.version}`,
        assets: c.assets.fingerprint,
        assetsOnDisk: onDisk,
        assetDrift: onDisk === null ? null : onDisk !== c.assets.fingerprint,
        uptimeMs: Date.now() - c.startedAt,
        queued: c.queued(),
        maxQueue: c.maxQueue,
        // 运维要能一眼看出这台机器是「谁都能调」还是「必须带 key」
        auth: c.apiKey === undefined ? 'loopback' : 'key',
      });
    }
    if (RUN_PATHS.has(url) && req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return json(res, 405, { error: `${url} 只接受 POST（收到 ${req.method ?? '未知'}）` });
    }
    if (req.method === 'POST' && RUN_PATHS.has(url)) {
      // 鉴权在**读请求体之前**：没凭据的连接不该有机会占内存
      if (!authorized(req, c.apiKey)) {
        res.setHeader('www-authenticate', 'Bearer');
        return json(res, 401, {
          error:
            c.apiKey === undefined
              ? '只接受回环地址的请求：对外监听请在配置里写 server.apiKeyEnv 并带 Bearer key'
              : '需要 authorization: Bearer <key>',
          code: 'run.unauthorized',
        });
      }
      const body = await readJson(req, c.maxBody);
      const task = typeof body.task === 'string' ? body.task : '';
      if (task.trim() === '') {
        return json(res, 400, { error: 'body 需要非空的 "task" 字段' });
      }
      // 容量检查与入队在同一个 tick 里完成（中间没有 await），并发下不会超卖
      if (c.queued() >= c.maxQueue) {
        res.setHeader('retry-after', '1');
        return json(res, 429, {
          error: `队列已满（上限 ${c.maxQueue} 个，含正在执行的）`,
          code: 'run.queue_full',
        });
      }
      // 超时**从真正开始执行的那一 tick 起算**，不含排队时间。此前 gate 在入队前
      // 创建：队列深度 8 × 单任务最长 10 分钟时，一个请求完全可能「还没开始跑就超时」，
      // 而调用方看到的 504 会被读成「模型太慢」。
      //
      // 超时仍必须由这里兑现（race），不能只靠把 signal 传下去 —— 见 util/abort.ts。
      const work = c.queue(async (): Promise<RunOutcome | typeof TIMED_OUT> => {
        const gate = combineAbort(undefined, c.timeoutMs);
        try {
          const run = c.runner.run(task, {
            signal: gate.signal,
            ...(c.client !== undefined ? { client: c.client } : {}),
          });
          run.catch(() => undefined); // 超时后它仍可能 reject，别让它变成 unhandled
          return await Promise.race([run, gate.expired]);
        } catch (e) {
          if (gate.timedOut()) return TIMED_OUT;
          throw e;
        } finally {
          gate.dispose();
        }
      });
      {
        const out = await work;
        if (out === TIMED_OUT) {
          return json(res, 504, { error: `请求超时（${c.timeoutMs}ms）`, code: 'run.timeout' });
        }
        return json(res, 200, {
          text: out.text,
          ok: out.ok,
          stopReason: out.stopReason,
          tokens: out.tokens,
          // 与 CLI 同一个口径：没有读数时是 null（「不知道」不是「免费」）
          costUsd: out.costUsd ?? null,
          durationMs: out.durationMs,
          skills: out.skills,
          subagents: out.subagents,
          traceId: out.trace.traceId,
        });
      }
    }
    return json(res, 404, { error: `没有这个端点: ${req.method} ${url}` });
  } catch (e) {
    const status = statusOf(e);
    const known = e instanceof HarnessError;
    // 未分类异常不回显 message：它可能带绝对路径、上游响应片段甚至凭据片段，
    // 而「内部为什么坏」应该进服务端日志，不是进调用方的 JSON。已知错误码的
    // 文案是**为调用方写的**，照旧透出。
    if (!known) logInternal(url, req.method ?? '?', e);
    return json(res, status, {
      error: known ? e.message : 'internal error（详细原因见服务端日志）',
      ...(known ? { code: e.code } : {}),
    });
  }
}

/**
 * 现读磁盘上的资产指纹（`/health` 的 `assetDrift` 用）。
 *
 * 服务的 runner 用的是**启动时**的快照，而 RSI 采纳会在进程活着的时候改盘。探针
 * 只报快照指纹时，运维看到的是「资产是新的」——实际跑的是旧的。
 *
 * `null` = 读不动（目录被删、frontmatter 坏了）。这里吞掉异常而不是让 `/health`
 * 跟着 500：进程还活着、还能接请求，只是资产和启动时不一样了 —— 那正是要靠
 * 探针说出来、然后重启的事，而不是把探针本身打挂。
 */
function fingerprintOnDisk(config: HarnessConfig): string | null {
  try {
    return discoverAssets({ skills: config.skillsDir, agents: config.agentsDir }).fingerprint;
  } catch {
    return null;
  }
}
