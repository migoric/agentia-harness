import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ModelClient } from '@migor/agentia';
import type { AssetSet } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import { createRunner, type Runner, type RunOutcome } from '../run/runner.js';
import { combineAbort } from '../util/abort.js';

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
      return json(res, 200, {
        ok: true,
        agent: `${c.runner.agent.name}@${c.runner.agent.version}`,
        assets: c.assets.fingerprint,
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
      const gate = combineAbort(undefined, c.timeoutMs);
      try {
        // 超时必须由这里兑现（race），不能只靠把 signal 传下去 —— 见 util/abort.ts
        const work = c.queue(async () =>
          c.runner.run(task, {
            signal: gate.signal,
            ...(c.client !== undefined ? { client: c.client } : {}),
          }),
        );
        work.catch(() => undefined); // 超时后它仍可能 reject，别让它变成 unhandled
        let out: RunOutcome;
        try {
          out = await Promise.race([work, gate.expired]);
        } catch (e) {
          if (gate.timedOut()) {
            return json(res, 504, { error: `请求超时（${c.timeoutMs}ms）` });
          }
          throw e;
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
      } finally {
        gate.dispose();
      }
    }
    return json(res, 404, { error: `没有这个端点: ${req.method} ${url}` });
  } catch (e) {
    const status = statusOf(e);
    return json(res, status, {
      error: e instanceof Error ? e.message : String(e),
      ...(e instanceof HarnessError ? { code: e.code } : {}),
    });
  }
}

function statusOf(e: unknown): number {
  if (e instanceof HarnessError) {
    if (e.code === 'run.payload_too_large') return 413;
    if (e.code === 'asset.missing' || e.code === 'asset.invalid') return 500;
    return 422;
  }
  return 500;
}

/**
 * 从环境变量名解析出 key。
 *
 * 三条都是刻意的：
 * - 没配 `apiKeyEnv` ⇒ `undefined`（只服务回环），这是本地开发的常态；
 * - 配了但变量不存在/是空白 ⇒ **抛错**，因为「配了闸却没有闸」比不配更危险；
 * - 值只进闭包，不进日志、不进 `ServerOptions` 的可打印字段。
 */
function resolveKey(envName: string | undefined): string | undefined {
  if (envName === undefined) return undefined;
  const key = process.env[envName]?.trim() ?? '';
  if (key === '') {
    throw new HarnessError(
      'config.invalid',
      `配置了 server.apiKeyEnv="${envName}" 但该环境变量是空的 —— ` +
        '空 key 会被当成「不用鉴权」，所以这里直接拒绝启动',
    );
  }
  return key;
}

/**
 * 请求有没有资格进来。
 *
 * 两种模式互斥：配了 key 就只认 Bearer；没配就只认回环来源。**不存在**「两个条件
 * 任一满足」。混合判定会在「配了 key 却忘了转发头」时静默放行本机代理，而代理后面
 * 往往就是整个内网。
 */
function authorized(req: IncomingMessage, key: string | undefined): boolean {
  if (key === undefined) return isLoopback(req.socket.remoteAddress);
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match !== null && sameKey(match[1]?.trim() ?? '', key);
}

function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false;
  // IPv4-mapped IPv6（::ffff:127.0.0.1）是 Node 在双栈监听时的常见形态
  const a = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return a === '::1' || /^127\./.test(a);
}

/** 定长比较：逐字节 `===` 会按「第一个不同字节」提前返回，把 key 的长度与前缀泄给计时 */
function sameKey(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const buf = Buffer.from(c);
    size += buf.length;
    if (size > limit) {
      // 413 而不是 422：这是「请求太大」，不是「请求内容不合法」——
      // 客户端据此决定是截断重发还是改格式
      throw new HarnessError('run.payload_too_large', `请求体超过 ${limit} 字节上限`);
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new HarnessError('run.failed', '请求体不是合法 JSON');
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}
