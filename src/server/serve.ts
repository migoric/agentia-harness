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
 * POST /run    { "task": "..." }  →  { text, ok, stopReason, tokens, costUsd, durationMs, traceId, skills }
 * GET  /health                    →  { ok, agent, assets, uptimeMs, queued }
 * ```
 *
 * 四条硬规矩（都不是「以后再说」的事）：
 *
 * 1. **串行执行**。一个进程同时跑多个任务会让成本归因互相污染，而成本归因是 RSI
 *    的输入。要并发就起多个进程（每个有独立 workspace）。
 * 2. **请求体有上限**。没有上限的 JSON 解析 = 一个 curl 就能把进程打死。
 * 3. **单请求有超时**。超时按失败返回，但 trace 会留下完整记录 —— 那正是事后查
 *    「为什么这个请求超时」的唯一证据。
 * 4. **关闭是优雅的**：先停止接新请求（503），再等在飞的那一个跑完。直接 exit
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

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const runner = createRunner(opts.config, opts.assets, opts.agent, true);
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;

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
    if (req.method === 'GET' && url === '/health') {
      return json(res, 200, {
        ok: true,
        agent: `${c.runner.agent.name}@${c.runner.agent.version}`,
        assets: c.assets.fingerprint,
        uptimeMs: Date.now() - c.startedAt,
        queued: c.queued(),
      });
    }
    if (url === '/run' && req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return json(res, 405, { error: `/run 只接受 POST（收到 ${req.method ?? '未知'}）` });
    }
    if (req.method === 'POST' && url === '/run') {
      const body = await readJson(req, c.maxBody);
      const task = typeof body.task === 'string' ? body.task : '';
      if (task.trim() === '') {
        return json(res, 400, { error: 'body 需要非空的 "task" 字段' });
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
