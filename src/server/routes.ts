/**
 * 只读面的**路由表**——实现、OpenAPI、鉴权口径共用这一份。
 *
 * 为什么要有这张表而不是继续 `if (url === '/x')`：判据 20 要求「`GET /openapi.json`
 * 与路由表双向一致」，而两份手写的清单必然漂移 —— 漂移的方式还是静默的（文档里多
 * 一条不存在的路径，调用方按文档写代码，拿到 404 之后开始怀疑人生）。表在这里，
 * 实现按表注册，openapi 由表生成，于是「一致」不再是纪律而是结构。
 *
 * 表里也登记了 `/v1/run` 这类**非只读**路径：openapi 若只描述只读面，读的人会以为
 * 整个服务只有 GET。登记它们不改变「web 不持有写权限」这条边界 —— D9 说的是
 * harness 自己的工作区不许被网络写，而 `/v1/run` 写的是 agent 的输出，不是工作区。
 */
export type RouteGroup = 'board' | 'ops' | 'api';

export interface RouteParamDef {
  readonly name: string;
  /** 给人看的说明；同时也是 openapi 的 description */
  readonly description: string;
}

export interface RouteDef {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly summary: string;
  readonly group: RouteGroup;
  /**
   * 要不要凭据。
   *
   * 只读也不等于可以公开：报告里有失败用例的原文、账本里有提案正文，这些和
   * `/v1/run` 一样属于「工作区数据」。反过来说，看板 HTML 与 openapi 是**纯静态壳**
   * （不含任何工作区内容），它们不鉴权 —— 浏览器没有方便的带 header 方式，让静态壳
   * 免费换来的是「打开页面就能看到该敲哪条命令」。
   */
  readonly needsAuth: boolean;
  /** 由谁提供处理器：`core` = serve.ts（run/health），`read` = web.ts */
  readonly owner: 'core' | 'read';
  /** 早期发布的路径别名：仍可用，openapi 里标 `deprecated` */
  readonly legacy?: boolean;
  readonly params?: readonly RouteParamDef[];
}

/**
 * 单独一条路由对应一个处理器，处理器名就是 `path + method` 的稳定标识。
 *
 * 不用下标当 key（改顺序就全错位），也不用心算字符串（拼错就是运行期 404）。
 */
export function routeKey(route: Pick<RouteDef, 'method' | 'path'>): string {
  return `${route.method} ${route.path}`;
}

export const ROUTES: readonly RouteDef[] = [
  {
    method: 'GET',
    path: '/',
    summary: '只读看板（静态壳，数据靠 /api/* 另取）',
    group: 'board',
    needsAuth: false,
    owner: 'read',
  },
  {
    method: 'GET',
    path: '/openapi.json',
    summary: '本服务对外路径的自描述（与路由表同源）',
    group: 'ops',
    needsAuth: false,
    owner: 'read',
  },
  {
    method: 'GET',
    path: '/api/workspace',
    summary: '工作区概览：资产指纹与漂移、各目录条目数',
    group: 'api',
    needsAuth: true,
    owner: 'read',
  },
  {
    method: 'GET',
    path: '/api/reports',
    summary: '评测报告列表（.workspace/reports/*.json）',
    group: 'api',
    needsAuth: true,
    owner: 'read',
  },
  {
    method: 'GET',
    path: '/api/reports/:name',
    summary: '单份评测报告（原样返回，含 cases）',
    group: 'api',
    needsAuth: true,
    owner: 'read',
    params: [{ name: 'name', description: '报告文件名（只收 .json，不接受路径分隔符）' }],
  },
  {
    method: 'GET',
    path: '/api/rsi/cycles',
    summary: 'RSI 轮次列表（按时间序，含采纳数与成本）',
    group: 'api',
    needsAuth: true,
    owner: 'read',
  },
  {
    method: 'GET',
    path: '/api/rsi/cycles/:id',
    summary: '单轮明细（含 verified / accepted 原文）',
    group: 'api',
    needsAuth: true,
    owner: 'read',
    params: [{ name: 'id', description: 'cycleId，例如 2026-11-28T07-00-00-000Z' }],
  },
  {
    method: 'GET',
    path: '/api/rsi/journal',
    summary: '账本尾部（?limit=50，append-only 的审计线索）',
    group: 'api',
    needsAuth: true,
    owner: 'read',
  },
  {
    method: 'GET',
    path: '/api/rsi/worker',
    summary: '常驻 worker 的锁与心跳（谁在跑、还活着吗）',
    group: 'api',
    needsAuth: true,
    owner: 'read',
  },
  {
    method: 'GET',
    path: '/api/progress',
    summary: '执行进度：在飞/排队/最近一次 run 的结果',
    group: 'api',
    needsAuth: true,
    owner: 'read',
  },
  {
    method: 'GET',
    path: '/health',
    summary: '健康检查：资产指纹漂移、队列深度、鉴权模式',
    group: 'ops',
    needsAuth: false,
    owner: 'core',
  },
  {
    method: 'GET',
    path: '/v1/health',
    summary: '/health 的旧别名',
    group: 'ops',
    needsAuth: false,
    owner: 'core',
    legacy: true,
  },
  {
    method: 'POST',
    path: '/v1/run',
    summary: '跑一次任务（进程内串行；写的是 agent 输出，不是工作区）',
    group: 'ops',
    needsAuth: true,
    owner: 'core',
  },
  {
    method: 'POST',
    path: '/run',
    summary: '/v1/run 的旧别名',
    group: 'ops',
    needsAuth: true,
    owner: 'core',
    legacy: true,
  },
];

/** `/api/reports/:name` 这样的模板 → 实际路径。参数值已解码 */
export function matchPath(template: string, pathname: string): Record<string, string> | null {
  if (template === pathname) return {};
  const t = template.split('/');
  const p = pathname.split('/');
  if (t.length !== p.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < t.length; i++) {
    const seg = t[i] ?? '';
    const got = p[i] ?? '';
    if (seg.startsWith(':')) {
      // 空段不算匹配：`/api/reports/` 不该被当成 name=''
      if (got === '') return null;
      params[seg.slice(1)] = got;
      continue;
    }
    if (seg !== got) return null;
  }
  return params;
}

export interface MatchResult {
  readonly route: RouteDef;
  readonly params: Record<string, string>;
}

/** 按「路径 + 方法」精确匹配；表里没有就是没有，不做前缀猜测 */
export function matchRoute(method: string, pathname: string): MatchResult | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const params = matchPath(route.path, pathname);
    if (params !== null) return { route, params };
  }
  return null;
}

/**
 * 这个路径上是否存在**任意方法**的路由。
 *
 * 用途只有一个：把「方法不对」和「路径不存在」分开报。两者都回 404 的话，
 * `POST /api/reports` 会被读成「没有这个接口」——而接口存在，只是不让写。
 */
export function knownPath(pathname: string): boolean {
  return ROUTES.some((r) => matchPath(r.path, pathname) !== null);
}

/** 该路径上允许的方法（405 的 `allow` 头用） */
export function allowedMethods(pathname: string): string[] {
  return ROUTES.filter((r) => matchPath(r.path, pathname) !== null).map((r) => r.method);
}

/**
 * 由路由表生成 OpenAPI 文档。
 *
 * 刻意只写到「读了这一份就知道有哪些路径、要不要凭据」的程度：把响应 schema 也
 * 编出来，就等于在第二个地方维护「返回值长什么样」，而它比路由更容易漂移（字段随
 * 需求增删）。`/api/reports` 的返回形状在 `docs/operations.md` 里有一段真例子。
 */
export function openApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of ROUTES) {
    const item = paths[route.path] ?? {};
    const params = (route.params ?? []).map((p) => ({
      name: p.name,
      in: 'path',
      required: true,
      description: p.description,
      schema: { type: 'string' },
    }));
    item[route.method.toLowerCase()] = {
      summary: route.summary,
      tags: [route.group],
      ...(params.length > 0 ? { parameters: params } : {}),
      security: route.needsAuth ? [{ bearerAuth: [] }] : [],
      ...(route.legacy === true ? { deprecated: true } : {}),
      responses: { 200: { description: '成功' } },
    };
    paths[route.path] = item;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'harness',
      version: '1',
      description:
        '只读看板与执行入口。写工作区（evals/assets/journal）的能力只在 CLI 与常驻 worker 里，' +
        '不在这里——这是 D9 的红线，不是遗漏。',
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
    },
    paths,
  };
}
