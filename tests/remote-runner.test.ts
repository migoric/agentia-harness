/**
 * 远程 runner（`harness eval --remote`）。
 *
 * 这里钉的是**口径**而不是「能不能发请求」：远程报什么就记什么，报不出来就如实是
 * 未知 —— 绝不能拿本地配置补一个看起来合理的数。跨服务评测最坏的失效方式不是报错，
 * 而是「报告里的 token 是本地估的、模型是本地配置的」，于是线上那条链路到底花了多少
 * 永远没人知道。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteRunner } from '../src/run/remote.ts';

function fakeFetch(
  body: unknown,
  init: { status?: number; capture?: (url: string, payload: unknown) => void } = {},
): typeof fetch {
  return (async (url: string, opts: RequestInit) => {
    init.capture?.(String(url), JSON.parse(String(opts.body)));
    const status = init.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

test('正常路径：文本、tokens、模型都从对方报的 metadata 读', async () => {
  let seenUrl = '';
  let seenBody: unknown;
  const runner = createRemoteRunner({
    baseUrl: 'http://svc:18080/',
    token: 'k',
    fetchImpl: fakeFetch(
      {
        result: {
          kind: 'task',
          id: 'task-1',
          status: { state: 'completed' },
          artifacts: [{ parts: [{ text: '三条要点…' }] }],
          metadata: {
            model: 'deepseek-v4-flash',
            usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.0012 },
            iterations: 2,
          },
        },
      },
      {
        capture: (u, b) => {
          seenUrl = u;
          seenBody = b;
        },
      },
    ),
    agentId: 'report',
  });

  const out = await runner.run('任务甲');
  assert.equal(out.text, '三条要点…');
  assert.equal(out.ok, true);
  assert.equal(out.tokens, 150, 'token 必须来自对方，不能是本地估的');
  assert.equal(out.costUsd, 0.0012);
  assert.equal(out.costNote, undefined, '有成本读数时不该有 costNote');
  assert.equal(out.iterations, 2, '对方报了轮次就用它');
  assert.equal(runner.model, 'deepseek-v4-flash');
  assert.equal(seenUrl, 'http://svc:18080/agents/report/a2a', '给了 agentId 就直连，不经过意图层');
  // blocking:true 是关键：评测要结果，不要「已受理」
  const params = (seenBody as { params: { configuration: { blocking: boolean } } }).params;
  assert.equal(params.configuration.blocking, true);
});

test('不给 agentId ⇒ 走意图层 /a2a（routedTo 才有意义）', async () => {
  let seenUrl = '';
  const runner = createRemoteRunner({
    baseUrl: 'http://svc:18080',
    token: 'k',
    fetchImpl: fakeFetch(
      {
        result: {
          kind: 'message',
          parts: [{ text: '已派给账单助手' }],
          metadata: { routedTo: 'billing', model: 'm1', usage: { totalTokens: 10 } },
        },
      },
      { capture: (u) => (seenUrl = u) },
    ),
  });
  await runner.run('看发票');
  assert.equal(seenUrl, 'http://svc:18080/a2a');
  assert.equal(runner.model, 'm1');
});

test('对方不报 usage ⇒ tokens 0 且 costNote=unreported（不补猜）', async () => {
  const runner = createRemoteRunner({
    baseUrl: 'http://svc',
    token: 'k',
    fetchImpl: fakeFetch({
      result: { status: { state: 'completed' }, artifacts: [{ parts: [{ text: 'x' }] }] },
    }),
  });
  const out = await runner.run('t');
  assert.equal(out.tokens, 0);
  assert.equal(out.costUsd, undefined);
  assert.equal(out.costNote, 'unreported');
  assert.equal(runner.model, undefined, '没报模型就是不知道，不能填本地配置的');
});

test('报模型但没报成本 ⇒ costNote=unpriced', async () => {
  const runner = createRemoteRunner({
    baseUrl: 'http://svc',
    token: 'k',
    fetchImpl: fakeFetch({
      result: {
        status: { state: 'completed' },
        artifacts: [{ parts: [{ text: 'x' }] }],
        metadata: { model: 'm', usage: { inputTokens: 1, outputTokens: 1 } },
      },
    }),
  });
  const out = await runner.run('t');
  assert.equal(out.costNote, 'unpriced');
});

test('HTTP 非 2xx 与 JSON-RPC error 都要响亮，不能当「跑完了但没输出」', async () => {
  const bad = createRemoteRunner({
    baseUrl: 'http://svc',
    token: 'k',
    fetchImpl: fakeFetch({ error: 'x' }, { status: 500 }),
  });
  await assert.rejects(() => bad.run('t'), /HTTP 500/);

  const rpcErr = createRemoteRunner({
    baseUrl: 'http://svc',
    token: 'k',
    fetchImpl: fakeFetch({ error: { code: -32001, message: '任务不存在' } }),
  });
  await assert.rejects(() => rpcErr.run('t'), /-32001/);
});

test('意图层：派单三态才是成败依据（done 才算通过，needs_input 是挂起）', async () => {
  const mk = (status: string) =>
    createRemoteRunner({
      baseUrl: 'http://svc',
      token: 'k',
      fetchImpl: fakeFetch({
        result: {
          kind: 'message',
          parts: [{ text: '…' }],
          metadata: {
            dispatch: { status, agentId: 'billing', reason: 'r' },
            usage: { totalTokens: 3 },
          },
        },
      }),
    });
  const done = await mk('done').run('t');
  assert.equal(done.ok, true);
  assert.equal(done.stopReason, 'end_turn');
  assert.equal(done.agent, 'billing', '实际承接者在 out.agent 里 —— routeAccuracy 的真值');

  const needs = await mk('needs_input').run('t');
  assert.equal(needs.ok, false, '需要人补信息不是「通过」');
  assert.equal(needs.stopReason, 'suspended');

  const accepted = await mk('accepted').run('t');
  assert.equal(accepted.ok, false, '还在跑不是「通过」');
  assert.equal(accepted.stopReason, 'accepted');

  const failed = await mk('failed').run('t');
  assert.equal(failed.ok, false);
  assert.equal(failed.stopReason, 'error');
  assert.match(failed.error?.message ?? '', /r/, '失败原因要带出来');
});

test('多轮直接拒绝 —— 静默只跑第一轮是最危险的那种「绿」', async () => {
  const runner = createRemoteRunner({
    baseUrl: 'http://svc',
    token: 'k',
    fetchImpl: fakeFetch({ result: { status: { state: 'completed' } } }),
  });
  await assert.rejects(() => runner.runTurns?.(['a', 'b']) ?? Promise.resolve(), /暂不支持多轮/);
});

test('非 completed 一律按非正常收尾（input-required 是挂起，不是通过）', async () => {
  for (const [state, reason] of [
    ['failed', 'error'],
    ['input-required', 'suspended'],
    ['canceled', 'cancelled'],
  ] as const) {
    const runner = createRemoteRunner({
      baseUrl: 'http://svc',
      token: 'k',
      fetchImpl: fakeFetch({
        result: { status: { state }, metadata: { usage: { totalTokens: 5 } } },
      }),
    });
    const out = await runner.run('t');
    assert.equal(out.ok, false, `${state} 不该算正常收尾`);
    assert.equal(out.stopReason, reason);
    assert.ok(out.error !== undefined);
  }
});
