import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AssetSet } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import { authorized } from './http.js';
import { BOARD_HTML } from './page.js';
import { listReports, loadReport } from './read/reports.js';
import { journalTail, listCycles, loadCycle, workerState } from './read/rsi.js';
import { workspaceOverview } from './read/workspace.js';
import { type MatchResult, matchPath, matchRoute, openApiDocument, ROUTES } from './routes.js';

/**
 * 只读面的**分发**：路由表里 `owner: 'read'` 的条目全部在这里落地。
 *
 * 三条硬规矩：
 *
 * 1. **写方法一律 405，且带 `allow` 头**。判据 15 要求 `POST /evals` 之类拿 404/405；
 *    选 405 是为了让「接口存在，但不许写」和「没有这个接口」可区分 —— 前者是设计，
 *    后者是敲错了地址，运维排查时需要的处置完全不同。
 * 2. **先判鉴权再碰磁盘**。报告与账本里有失败用例原文、提案正文、绝对路径；读它们
 *    和 `/v1/run` 一样要凭据。反过来，看板 HTML 与 openapi 是纯静态壳（不含任何
 *    工作区数据），它们不鉴权 —— 浏览器没有方便的带 header 方式，而静态壳公开换来
 *    的是「打开就知道该敲哪条命令」。
 * 3. **只读**。整条链上除了 `readFileSync`/`readdirSync`/`statSync` 之外没有任何
 *    文件操作（判据 15 用目录 mtime 验这件事）。
 */
export interface LastRun {
  readonly at: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly traceId: string;
  readonly stopReason?: string;
}

export interface ReadRuntime {
  readonly config: HarnessConfig;
  /** 进程启动时的资产快照（和 `/health` 报的是同一份） */
  readonly assets: AssetSet;
  readonly startedAt: number;
  /** 已解析的 key；缺席 = 只服务回环 */
  readonly apiKey: string | undefined;
  readonly maxQueue: number;
  queued(): number;
  running(): boolean;
  lastRun(): LastRun | null;
}

/**
 * 处理一条只读请求。
 *
 * 返回 `false` = 这条路径不归它管（调用方继续走自己的 404）。返回 `true` = 响应
 * 已经写完了 —— 此时调用方**不许**再写任何东西（双写是 `ERR_HTTP_HEADERS_SENT`）。
 */
export async function handleReadRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  rt: ReadRuntime,
): Promise<boolean> {
  const parsed = new URL(url, 'http://127.0.0.1');
  // **不先整体解码**：`%2F` 解码后会变成路径分隔符，于是 `/api/reports/..%2Fsecret.json`
  // 会被切成 5 段、匹配不上路由，最后报 404（「没这个接口」）—— 而真因是这个名字
  // 非法。先按段匹配、再解码参数，才能给出 400 这个准确的理由。
  const pathname = parsed.pathname;
  const method = req.method ?? 'GET';
  const head = method === 'HEAD';

  // 只处理**只读那张表**里的路径。`/v1/run` 这类 owner='core' 的必须放行给 serve.ts，
  // 否则 POST /v1/run 会被这里的 405 挡掉 —— 一个只读面把写入口掐死，是这次改造里
  // 最容易犯且最难在测试里发现的错误（因为「405」看着像正常工作）。
  if (method !== 'GET' && !head) {
    const allowed = readMethodsAt(pathname);
    if (allowed.length === 0) return false;
    res.setHeader('allow', allowed.join(', '));
    send(
      res,
      405,
      { error: `${pathname} 只读：允许 ${allowed.join(' / ')}`, code: 'web.read_only' },
      false,
    );
    return true;
  }

  const hit = matchRoute('GET', pathname);
  if (hit === null || hit.route.owner !== 'read') return false;

  if (hit.route.needsAuth && !authorized(req, rt.apiKey)) {
    res.setHeader('www-authenticate', 'Bearer');
    send(
      res,
      401,
      {
        error:
          rt.apiKey === undefined
            ? '只接受回环地址的请求：对外监听请配 server.apiKeyEnv 并带 Bearer key'
            : '需要 authorization: Bearer <key>',
        code: 'web.unauthorized',
      },
      head,
    );
    return true;
  }

  const body = handlerFor({ route: hit.route, params: decodeParams(hit.params) }, parsed, rt);
  if (body.html !== undefined) {
    sendHtml(res, body.status, body.html, head);
    return true;
  }
  send(res, body.status, body.json, head);
  return true;
}

interface Reply {
  readonly status: number;
  readonly json?: unknown;
  readonly html?: string;
}

/** 这个路径上**只读面**允许的方法（405 的 `allow` 头）。排除 owner='core' 的路径 */
function readMethodsAt(pathname: string): string[] {
  return ROUTES.filter((r) => r.owner === 'read' && matchPath(r.path, pathname) !== null).map(
    (r) => r.method,
  );
}

function handlerFor(hit: MatchResult, url: URL, rt: ReadRuntime): Reply {
  const { route, params } = hit;
  switch (route.path) {
    case '/':
      return { status: 200, html: BOARD_HTML };
    case '/openapi.json':
      return { status: 200, json: openApiDocument() };
    case '/api/workspace':
      return { status: 200, json: workspaceOverview(rt.config, rt.assets) };
    case '/api/reports':
      return { status: 200, json: listReports(rt.config) };
    case '/api/reports/:name':
      return reportReply(rt, params.name ?? '');
    case '/api/rsi/cycles':
      return { status: 200, json: listCycles(rt.config) };
    case '/api/rsi/cycles/:id': {
      const one = loadCycle(rt.config, params.id ?? '');
      return one.ok
        ? { status: 200, json: { cycle: one.cycle } }
        : { status: 404, json: { error: `没有这一轮：${params.id ?? ''}` } };
    }
    case '/api/rsi/journal': {
      const raw = url.searchParams.get('limit');
      const limit = raw === null ? undefined : Number(raw);
      return {
        status: 200,
        json: journalTail(rt.config, Number.isFinite(limit) ? limit : undefined),
      };
    }
    case '/api/rsi/worker':
      return { status: 200, json: workerState(rt.config) };
    case '/api/progress':
      return {
        status: 200,
        json: {
          running: rt.running(),
          queued: rt.queued(),
          maxQueue: rt.maxQueue,
          uptimeMs: Date.now() - rt.startedAt,
          lastRun: rt.lastRun(),
          at: new Date().toISOString(),
        },
      };
    default:
      // 路由表与 handler 不同步时走到这里 —— 宁可 501 也不要静默 200 空对象
      return { status: 501, json: { error: `路由 ${route.path} 还没有处理器` } };
  }
}

function reportReply(rt: ReadRuntime, name: string): Reply {
  const one = loadReport(rt.config, name);
  if (one.ok) {
    return {
      status: 200,
      json: {
        name: one.report.name,
        mtime: one.report.mtime,
        sizeBytes: one.report.sizeBytes,
        raw: one.report.raw,
      },
    };
  }
  switch (one.why) {
    case 'bad_name':
      return { status: 400, json: { error: '报告名只能是 .json 文件名（不接受路径分隔符）' } };
    case 'too_large':
      return {
        status: 413,
        json: { error: '报告超过 8MB，看板不读（用 CLI 的 report/evidence 处理）' },
      };
    case 'bad_json':
      return { status: 500, json: { error: `报告不是合法 JSON：${name}` } };
    case 'not_found':
      return { status: 404, json: { error: `没有这份报告：${name}` } };
  }
}

/** 路径参数逐个解码；解不开就按原样（随后会被各自的白名单挡掉） */
function decodeParams(params: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function send(res: ServerResponse, status: number, body: unknown, head: boolean): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // 只读数据一律不缓存：看板的价值在于「现在是什么样」
    'cache-control': 'no-store',
  });
  if (head) res.end();
  else res.end(text);
}

function sendHtml(res: ServerResponse, status: number, html: string, head: boolean): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
  });
  if (head) res.end();
  else res.end(html);
}
