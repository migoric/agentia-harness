import { HarnessError } from '../errors.js';

/**
 * 远程调用的一层薄封装：**超时、取消、可重试错误的退避重试**。
 *
 * 抽出来的理由与 `budget.ts` 相同：`RemoteStager` 负责「写哪个文件、什么时候还原」，
 * 而「一次 HTTP 该等多久、失败了要不要再来一次」是另一件事。两者混在一个类里，
 * 文件很快就顶到 400 行上限，而那一层恰恰是最难用单测覆盖的（要起服务、要断网）。
 * 现在它可以被一个假 `fetch` 完整测到。
 *
 * 三条判据，都不靠 message（改文案就失效）：
 *
 * 1. **只有幂等的读值得重试**。GET 预检 502 重试是对的；POST 重载重试会让
 *    「其实已经成功、只是响应丢了」变成第二次写操作。重试次数逐调用传。
 * 2. **5xx 可重试，4xx 不可**。前者是「服务端暂时不行」，后者是「你发的东西不对」。
 * 3. **超时必须有**。`fetch` 在没有 signal 时不会自己放弃一个「连上了但永远不回」
 *    的连接；远程 stage 一旦挂住，锁、心跳、用户看到的都只是「卡住了」。
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** 可重试的远程失败 —— 「这次失败有没有可能自己好」 */
export class RetriableRemoteError extends HarnessError {
  constructor(message: string) {
    super('config.invalid', message);
  }
}

export interface RemoteCallOptions {
  readonly fetch: FetchLike;
  /** Bearer token；惰性取（缺凭据要等到真要发请求时才报） */
  readonly token: () => string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

export interface RemoteCallInit {
  readonly method: string;
  readonly retries?: number | undefined;
}

export async function callRemote<T>(
  opts: RemoteCallOptions,
  url: string,
  path: string,
  init: RemoteCallInit,
): Promise<T> {
  const attempts = (init.retries ?? 0) + 1;
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await once<T>(opts, url, path, init.method);
    } catch (err) {
      lastError = err;
      if (!(err instanceof RetriableRemoteError) || i === attempts - 1) throw err;
      // 100/200ms：服务侧重启通常几秒内完成，再长就该让人看见了
      await sleep(100 * 2 ** i, opts.signal);
    }
  }
  throw lastError;
}

async function once<T>(
  opts: RemoteCallOptions,
  url: string,
  path: string,
  method: string,
): Promise<T> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal === undefined ? timeout : AbortSignal.any([timeout, opts.signal]);
  let res: Response;
  try {
    // 带 content-type 却不给 body，Fastify 会直接 400
    // （"Body cannot be empty when content-type is set to 'application/json'"）——
    // 重载端点不需要请求体，所以只有 POST 补一个 `{}`
    res = await opts.fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${opts.token()}`,
        'content-type': 'application/json',
      },
      signal,
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
  } catch (err) {
    if (opts.signal?.aborted === true) {
      throw new HarnessError('config.invalid', `已取消：${method} ${path}`);
    }
    const name = (err as { name?: string }).name;
    throw new RetriableRemoteError(
      name === 'TimeoutError'
        ? `${method} ${url} 超时（${opts.timeoutMs}ms）—— 服务可能挂了或网络不通`
        : `连不上 ${url}：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    const message = `${method} ${path} 返回 ${res.status}：${reasonOf(text)}`;
    // 5xx 是「服务端暂时不行」，值得退避重试；4xx 是「你发的东西不对」，重试无意义
    if (res.status >= 500) throw new RetriableRemoteError(message);
    throw new HarnessError('config.invalid', message);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HarnessError('config.invalid', `${method} ${path} 的响应不是 JSON`);
  }
}

/** 服务侧 4xx 会带 `{error}`（文件坏了 / 角色不对）；非 JSON 就原样截断 */
function reasonOf(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // 非 JSON：原样截断
  }
  return text.slice(0, 300);
}

/** 退避等待（可被取消） */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
