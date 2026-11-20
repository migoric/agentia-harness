import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AssetSet } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import { createRunner, type Runner } from '../run/runner.js';

/**
 * 最小 HTTP 面。
 *
 * 只有两个端点，是刻意的：harness 的 server 不是产品，是**让别的进程能调这个
 * agent** 的缝。真要会话管理、审批、SSE 那一套，用 agentia 的 `transport/`
 * （它已经做完了），别在这里长第二套。
 *
 * ```
 * POST /run    { "task": "..." }  →  { text, ok, stopReason, tokens, durationMs, traceId }
 * GET  /health                    →  { ok: true, agent, assets }
 * ```
 *
 * 串行执行：一个 harness 进程同时跑多个任务会让评测与 RSI 的成本归因互相污染。
 * 要并发就起多个进程（每个有独立 workspace）。
 */
export interface ServerOptions {
  readonly config: HarnessConfig;
  readonly assets: AssetSet;
  readonly agent?: string | undefined;
  readonly port: number;
  readonly host?: string | undefined;
}

export interface RunningServer {
  readonly port: number;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const runner = createRunner(opts.config, opts.assets, opts.agent, true);
  const server = createServer((req, res) => {
    void handle(req, res, runner, opts.assets);
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e === undefined || e === null ? resolve() : reject(e)));
      }),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  runner: Runner,
  assets: AssetSet,
): Promise<void> {
  const url = req.url ?? '/';
  try {
    if (req.method === 'GET' && url === '/health') {
      return json(res, 200, {
        ok: true,
        agent: `${runner.agent.name}@${runner.agent.version}`,
        assets: assets.fingerprint,
      });
    }
    if (req.method === 'POST' && url === '/run') {
      const body = await readJson(req);
      const task = typeof body.task === 'string' ? body.task : '';
      if (task.trim() === '') {
        return json(res, 400, { error: 'body 需要非空的 "task" 字段' });
      }
      const out = await runner.run(task);
      return json(res, 200, {
        text: out.text,
        ok: out.ok,
        stopReason: out.stopReason,
        tokens: out.tokens,
        durationMs: out.durationMs,
        traceId: out.trace.traceId,
      });
    }
    return json(res, 404, { error: `没有这个端点: ${req.method} ${url}` });
  } catch (e) {
    const status = e instanceof HarnessError ? 422 : 500;
    return json(res, status, {
      error: e instanceof Error ? e.message : String(e),
      ...(e instanceof HarnessError ? { code: e.code } : {}),
    });
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
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
