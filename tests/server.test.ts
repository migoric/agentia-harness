import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scriptedClient } from '@migor/agentia';
import { discoverAssets } from '../src/assets/discover.ts';
import { loadConfig } from '../src/config.ts';
import { type ServerOptions, startServer } from '../src/server/serve.ts';

/**
 * HTTP 面的测试 —— 此前这块一行测试都没有。
 *
 * 有测试的前提是能注入模型客户端（`ServerOptions.client`）：没有它，`/run` 的正常
 * 路径只能在有 API 凭据时验证，而「串行闸真的在生效吗」这类问题恰恰只有在并发两个
 * 请求时才看得出来。协议细节（状态码、`allow` 头）是给别的进程看的契约，必须钉住。
 */

const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function endTurn(text: string) {
  return {
    id: 'm',
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    usage: USAGE,
    content: [{ type: 'text', text }],
  };
}

function project(model = 'claude-opus-5'): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-server-'));
  mkdirSync(join(root, 'agents'), { recursive: true });
  mkdirSync(join(root, 'evals'), { recursive: true });
  // 显式写模型：不写就吃 agentia 的缺省模型，成本断言会随上游价格表变动而飘
  writeFileSync(join(root, 'harness.config.json'), JSON.stringify({ model }), 'utf8');
  writeFileSync(
    join(root, 'agents', 'main.md'),
    '---\nname: main\nversion: 1\ndescription: 主 agent\n---\n你是执行者。\n',
    'utf8',
  );
  return root;
}

async function withServer<T>(
  overrides: Partial<ServerOptions>,
  fn: (base: string) => Promise<T>,
  model?: string,
): Promise<T> {
  const root = project(model);
  const config = loadConfig(root);
  const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
  const server = await startServer({ config, assets, port: 0, ...overrides });
  try {
    return await fn(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.close();
  }
}

describe('HTTP 面', () => {
  it('/health 报 agent、资产指纹与排队数', async () => {
    await withServer({}, async (base) => {
      const r = await fetch(`${base}/health`);
      assert.equal(r.status, 200);
      const body = (await r.json()) as Record<string, unknown>;
      assert.equal(body.ok, true);
      assert.equal(body.agent, 'main@1');
      assert.equal(typeof body.assets, 'string');
      assert.equal(body.queued, 0);
    });
  });

  it('GET /run ⇒ 405 且带 allow: POST', async () => {
    await withServer({}, async (base) => {
      const r = await fetch(`${base}/run`);
      assert.equal(r.status, 405);
      assert.equal(r.headers.get('allow'), 'POST');
    });
  });

  it('未知端点 ⇒ 404；空 task ⇒ 400', async () => {
    await withServer({}, async (base) => {
      assert.equal((await fetch(`${base}/nope`)).status, 404);
      const r = await fetch(`${base}/run`, {
        method: 'POST',
        body: JSON.stringify({ task: '   ' }),
      });
      assert.equal(r.status, 400);
    });
  });

  it('请求体超上限 ⇒ 413（不是 422：这是「太大」，不是「不合法」）', async () => {
    await withServer({ maxBodyBytes: 32 }, async (base) => {
      const r = await fetch(`${base}/run`, {
        method: 'POST',
        body: JSON.stringify({ task: 'x'.repeat(200) }),
      });
      assert.equal(r.status, 413);
      const body = (await r.json()) as { code?: string };
      assert.equal(body.code, 'run.payload_too_large');
    });
  });

  it('POST /run 正常路径：文本、token、成本（定价模型 ⇒ 有读数）', async () => {
    const client = scriptedClient([endTurn('结论：已完成')]);
    await withServer({ client }, async (base) => {
      const r = await fetch(`${base}/run`, {
        method: 'POST',
        body: JSON.stringify({ task: '做点事' }),
      });
      assert.equal(r.status, 200);
      const body = (await r.json()) as Record<string, unknown>;
      assert.equal(body.text, '结论：已完成');
      assert.equal(body.ok, true);
      assert.ok((body.tokens as number) > 0);
      // 成本由 agentia 按「应用模型 + 消息 usage」算，与客户端是不是脚本无关
      assert.ok((body.costUsd as number) > 0, `定价模型必须给出成本，实际 ${body.costUsd}`);
      assert.equal(typeof body.traceId, 'string');
    });
  });

  it('未定价模型 ⇒ costUsd 是 null（「不知道」不是「免费」）', async () => {
    const client = scriptedClient([endTurn('结论：已完成')]);
    await withServer(
      { client },
      async (base) => {
        const r = await fetch(`${base}/run`, {
          method: 'POST',
          body: JSON.stringify({ task: '做点事' }),
        });
        const body = (await r.json()) as Record<string, unknown>;
        assert.equal(body.costUsd, null);
      },
      'not-a-priced-model',
    );
  });

  it('串行闸：两个并发请求不会同时进模型（成本归因的前提）', async () => {
    let active = 0;
    let peak = 0;
    const step = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 60));
      active--;
      return endTurn('结论：好');
    };
    const client = scriptedClient([step, step]);

    await withServer({ client }, async (base) => {
      const post = (task: string) =>
        fetch(`${base}/run`, { method: 'POST', body: JSON.stringify({ task }) });
      const [a, b] = await Promise.all([post('一'), post('二')]);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.equal(peak, 1, `并发峰值应为 1，实际 ${peak}`);
    });
  });

  it('关闭时等在飞的请求跑完（trace 不缺收尾 span）', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const client = scriptedClient([
      async () => {
        await new Promise((r) => setTimeout(r, 80));
        return endTurn('结论：慢但完整');
      },
    ]);
    const server = await startServer({ config, assets, port: 0, client });
    const base = `http://127.0.0.1:${server.port}`;

    const inFlight = fetch(`${base}/run`, {
      method: 'POST',
      body: JSON.stringify({ task: '慢任务' }),
    });
    // 让请求先进入 run，再关
    await new Promise((r) => setTimeout(r, 20));
    await server.close();

    const r = await inFlight;
    assert.equal(r.status, 200, 'close 必须等在飞的请求跑完再返回');
    const body = (await r.json()) as Record<string, unknown>;
    assert.equal(body.text, '结论：慢但完整');
  });
});
