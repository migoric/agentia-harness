import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { callRemote, type FetchLike, RetriableRemoteError } from '../src/rsi/remote-call.ts';

/**
 * 远程调用层：超时、取消、按幂等性重试。
 *
 * 用假 `fetch` 而不是起服务：这里要验的是**判据**（哪些错误重试、超时怎么算），
 * 而真服务恰好最难稳定地制造「连接挂住不回」和「第一次 503、第二次 200」。
 */
const base = { token: () => 'k', timeoutMs: 50 } as const;

/**
 * 一个永远不回的 fetch，但尊重 signal（与真 fetch 一致）。
 *
 * 那个 `keep` 定时器不是凑数：真 fetch 挂住时 socket 会**保持事件循环**，而
 * `AbortSignal.timeout` 内部是 unref 的 —— 没有它，测试进程会在超时触发之前
 * 就认为「没事可做」并退出（症状是 `Promise resolution is still pending`）。
 */
const hanging: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    const keep = setTimeout(() => undefined, 300);
    init?.signal?.addEventListener('abort', () => {
      clearTimeout(keep);
      reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    });
  });

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('远程调用', () => {
  it('连接挂住 ⇒ 报超时，而不是一直等', async () => {
    await assert.rejects(
      () => callRemote({ ...base, fetch: hanging }, 'http://x', '/p', { method: 'GET' }),
      /超时（50ms）/,
    );
  });

  it('5xx 会退避重试，第二次成功就当成功', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return calls === 1 ? json(503, { error: 'restarting' }) : json(200, { ok: true });
    };
    const out = await callRemote<{ ok: boolean }>({ ...base, fetch: fetchImpl }, 'http://x', '/p', {
      method: 'GET',
      retries: 2,
    });
    assert.equal(out.ok, true);
    assert.equal(calls, 2);
  });

  it('4xx 不重试（重试一个「你发的东西不对」只会更慢地失败）', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return json(403, { error: '角色不是 admin' });
    };
    await assert.rejects(
      () =>
        callRemote({ ...base, fetch: fetchImpl }, 'http://x', '/p', { method: 'GET', retries: 2 }),
      /403：角色不是 admin/,
    );
    assert.equal(calls, 1);
  });

  it('重试用尽后抛最后一次的错误（不是静默返回空）', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return json(500, { error: 'boom' });
    };
    await assert.rejects(
      () =>
        callRemote({ ...base, fetch: fetchImpl }, 'http://x', '/p', { method: 'GET', retries: 2 }),
      (e: unknown) => e instanceof RetriableRemoteError && /500：boom/.test(e.message),
    );
    assert.equal(calls, 3, '1 次 + 2 次重试');
  });

  it('外部取消 ⇒ 明确说「已取消」，不伪装成网络故障', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(
      () =>
        callRemote(
          { ...base, fetch: hanging, signal: controller.signal, timeoutMs: 5_000 },
          'http://x',
          '/p',
          { method: 'POST' },
        ),
      /已取消/,
    );
  });

  it('响应不是 JSON ⇒ 报得出来（而不是让调用方拿到 undefined 继续跑）', async () => {
    const fetchImpl: FetchLike = async () => new Response('<html>oops', { status: 200 });
    await assert.rejects(
      () => callRemote({ ...base, fetch: fetchImpl }, 'http://x', '/p', { method: 'GET' }),
      /响应不是 JSON/,
    );
  });
});
