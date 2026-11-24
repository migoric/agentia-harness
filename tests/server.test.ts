import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type ModelClient, scriptedClient } from '@migor/agentia';
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
  it('/health 报 agent、资产指纹、排队数与鉴权模式', async () => {
    await withServer({}, async (base) => {
      const r = await fetch(`${base}/health`);
      assert.equal(r.status, 200);
      const body = (await r.json()) as Record<string, unknown>;
      assert.equal(body.ok, true);
      assert.equal(body.agent, 'main@1');
      assert.equal(typeof body.assets, 'string');
      assert.equal(body.queued, 0);
      assert.equal(body.maxQueue, 8);
      assert.equal(body.auth, 'loopback');
    });
  });

  it('/v1/health 与 /health 是同一个端点（版本前缀不影响探针）', async () => {
    await withServer({}, async (base) => {
      const r = await fetch(`${base}/v1/health`);
      assert.equal(r.status, 200);
      const body = (await r.json()) as Record<string, unknown>;
      assert.equal(body.ok, true);
    });
  });

  it('GET /v1/run ⇒ 405 且带 allow: POST', async () => {
    await withServer({}, async (base) => {
      const r = await fetch(`${base}/v1/run`);
      assert.equal(r.status, 405);
      assert.equal(r.headers.get('allow'), 'POST');
    });
  });

  it('旧路径 /run 仍可用（历史别名，行为与 /v1/run 完全一样）', async () => {
    const client = scriptedClient([endTurn('结论：别名可用')]);
    await withServer({ client }, async (base) => {
      const r = await fetch(`${base}/run`, {
        method: 'POST',
        body: JSON.stringify({ task: '做点事' }),
      });
      assert.equal(r.status, 200);
      const body = (await r.json()) as Record<string, unknown>;
      assert.equal(body.text, '结论：别名可用');
    });
  });

  it('未知端点 ⇒ 404；空 task ⇒ 400', async () => {
    await withServer({}, async (base) => {
      assert.equal((await fetch(`${base}/nope`)).status, 404);
      const r = await fetch(`${base}/v1/run`, {
        method: 'POST',
        body: JSON.stringify({ task: '   ' }),
      });
      assert.equal(r.status, 400);
    });
  });

  it('坏 JSON ⇒ 400 + run.bad_request（客户端错误，不是执行失败）', async () => {
    await withServer({}, async (base) => {
      const r = await fetch(`${base}/v1/run`, { method: 'POST', body: '{"task":' });
      assert.equal(r.status, 400);
      const body = (await r.json()) as { code?: string };
      assert.equal(body.code, 'run.bad_request');
    });
  });

  it('JSON 合法但不是对象 ⇒ 400（不再静默收成 {}）', async () => {
    // 此前 `JSON.parse` 成功就往下走，字符串/数组/null 一律被收成 `{}`，调用方只
    // 看到「body 需要非空的 task」—— 而真正的原因是他发的根本不是对象。
    await withServer({}, async (base) => {
      for (const body of ['"a string"', '[1,2]', 'null', '42']) {
        const r = await fetch(`${base}/v1/run`, { method: 'POST', body });
        assert.equal(r.status, 400, `${body} 应 400（收到 ${r.status}）`);
        const parsed = (await r.json()) as { code?: string };
        assert.equal(parsed.code, 'run.bad_request', `${body} 应报 run.bad_request`);
      }
    });
  });

  it('超时从真正开始执行起算（排队时间不算）', async () => {
    // 串行闸 + 超时 150ms：A 跑 300ms（自己超时，504），B 排在它后面。
    // B 真正开始执行是在 A 让出串行链之后，自己只需 5ms —— 旧实现（gate 在入队前
    // 创建）会让 B 在 150ms 时就以 504 收场，而它根本没开始跑。
    //
    // 这里不能用 `scriptedClient`：它的游标只在 `finalMessage` 成功返回后前进，
    // A 的调用还挂着时 B 会重放第一步（本测试就变成「B 也睡 300ms」）。手写一个
    // 按调用序号决定耗时的客户端，两次调用的行为才是独立的。
    let n = 0;
    const client: ModelClient = {
      messages: {
        stream: () => ({
          on: () => undefined,
          finalMessage: async () => {
            n++;
            await new Promise((r) => setTimeout(r, n === 1 ? 300 : 5));
            return endTurn('完成');
          },
        }),
      },
    } as unknown as ModelClient;
    await withServer({ client, timeoutMs: 150, maxQueue: 4 }, async (base) => {
      const post = (task: string) =>
        fetch(`${base}/v1/run`, { method: 'POST', body: JSON.stringify({ task }) });
      const [a, b] = await Promise.all([post('慢'), post('快')]);
      assert.equal(a.status, 504, 'A 自己跑超了，应 504');
      assert.equal(b.status, 200, `排队中的请求不该被判超时（收到 ${b.status}）`);
    });
  });

  it('请求体超上限 ⇒ 413（不是 422：这是「太大」，不是「不合法」）', async () => {
    await withServer({ maxBodyBytes: 32 }, async (base) => {
      const r = await fetch(`${base}/v1/run`, {
        method: 'POST',
        body: JSON.stringify({ task: 'x'.repeat(200) }),
      });
      assert.equal(r.status, 413);
      const body = (await r.json()) as { code?: string };
      assert.equal(body.code, 'run.payload_too_large');
    });
  });

  it('POST /v1/run 正常路径：文本、token、成本（定价模型 ⇒ 有读数）', async () => {
    const client = scriptedClient([endTurn('结论：已完成')]);
    await withServer({ client }, async (base) => {
      const r = await fetch(`${base}/v1/run`, {
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
        const r = await fetch(`${base}/v1/run`, {
          method: 'POST',
          body: JSON.stringify({ task: '做点事' }),
        });
        const body = (await r.json()) as Record<string, unknown>;
        assert.equal(body.costUsd, null);
      },
      'not-a-priced-model',
    );
  });

  it('客户端层异常 ⇒ 200 + ok:false（HTTP 200 只表示「请求被处理了」）', async () => {
    // 这一条钉的是**协议语义**：模型/客户端层的失败在 agentia 里被收成
    // `stopReason: 'error'`，不是 HTTP 错误 —— 调用方要看 `ok`，不能只看状态码。
    // （500 分支只留给未分类异常，且不回显内部 message，见 `logInternal`。）
    const client = {
      messages: {
        stream: () => ({
          on: () => undefined,
          finalMessage: async () => {
            throw new Error('内部路径 /Users/secret/key.txt 读不到');
          },
        }),
      },
    } as unknown as ModelClient;
    await withServer({ client }, async (base) => {
      const r = await fetch(`${base}/v1/run`, {
        method: 'POST',
        body: JSON.stringify({ task: '做事' }),
      });
      assert.equal(r.status, 200);
      const body = (await r.json()) as { ok?: boolean; stopReason?: string; error?: unknown };
      assert.equal(body.ok, false);
      assert.equal(body.stopReason, 'error');
      assert.doesNotMatch(JSON.stringify(body), /secret|\/Users/, '响应里不该出现内部路径');
    });
  });

  it('/health 报出资产漂移（RSI 采纳后进程仍在用旧快照）', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const server = await startServer({ config, assets, port: 0 });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const before = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
      assert.equal(before.assetDrift, false);

      // 磁盘上新增一个资产（等价于 RSI 采纳后进程没重启）
      writeFileSync(
        join(root, 'agents', 'extra.md'),
        '---\nname: extra\nversion: 1\ndescription: 新加的\n---\n你是补充。\n',
        'utf8',
      );

      const after = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
      assert.equal(after.assets, before.assets, '服务仍用启动时的快照');
      assert.notEqual(after.assetsOnDisk, before.assets);
      assert.equal(after.assetDrift, true, '漂移必须能看见，否则运维以为进程已是新资产');
    } finally {
      await server.close();
    }
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
        fetch(`${base}/v1/run`, { method: 'POST', body: JSON.stringify({ task }) });
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

    const inFlight = fetch(`${base}/v1/run`, {
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

describe('HTTP 面的闸', () => {
  const KEY_ENV = 'HARNESS_TEST_API_KEY';

  /** 在 withServer 期间设置一个环境变量，结束后恢复原值（不污染同进程的其它测试） */
  async function withEnv<T>(name: string, value: string | undefined, fn: () => Promise<T>) {
    const prev = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env[name];
      else process.env[name] = prev;
    }
  }

  it('配了 key ⇒ 不带凭据 401，带对的 200，带错的 401', async () => {
    await withEnv(KEY_ENV, 's3cret', async () => {
      const client = scriptedClient([endTurn('结论：过了闸')]);
      await withServer({ client, apiKeyEnv: KEY_ENV }, async (base) => {
        const post = (headers: Record<string, string>) =>
          fetch(`${base}/v1/run`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify({ task: '做点事' }),
          });

        const none = await post({});
        assert.equal(none.status, 401);
        assert.equal(none.headers.get('www-authenticate'), 'Bearer');
        const nbody = (await none.json()) as { code?: string };
        assert.equal(nbody.code, 'run.unauthorized');

        const wrong = await post({ authorization: 'Bearer nope' });
        assert.equal(wrong.status, 401);

        // 方案名大小写不敏感（RFC 7235），别让客户端因为 `bearer` 被拒
        const ok = await post({ authorization: 'bearer s3cret' });
        assert.equal(ok.status, 200);
        const body = (await ok.json()) as Record<string, unknown>;
        assert.equal(body.text, '结论：过了闸');
      });
    });
  });

  it('配了 key 但环境变量是空的 ⇒ 拒绝启动（空 key 不能退化成「不用鉴权」）', async () => {
    await withEnv(KEY_ENV, '', async () => {
      const root = project();
      const config = loadConfig(root);
      const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
      await assert.rejects(
        () => startServer({ config, assets, port: 0, apiKeyEnv: KEY_ENV }),
        (e: unknown) => e instanceof Error && /空 key/.test(e.message),
      );
    });
  });

  it('/health 不需要 key（探针要能打），但会报出当前是 key 模式', async () => {
    await withEnv(KEY_ENV, 's3cret', async () => {
      await withServer({ apiKeyEnv: KEY_ENV }, async (base) => {
        const r = await fetch(`${base}/health`);
        assert.equal(r.status, 200);
        const body = (await r.json()) as Record<string, unknown>;
        assert.equal(body.auth, 'key');
      });
    });
  });

  it('队列满 ⇒ 429 + retry-after（不排无限长的队），跑完就恢复', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const client = scriptedClient([
      async () => {
        await gate;
        return endTurn('结论：慢一点');
      },
    ]);

    await withServer({ client, maxQueue: 1 }, async (base) => {
      const post = () =>
        fetch(`${base}/v1/run`, {
          method: 'POST',
          body: JSON.stringify({ task: '占住队列' }),
        });

      const first = post();
      // 等到它真的进了 run（/health 的 queued 是本进程唯一的观测点）
      for (let i = 0; i < 50; i++) {
        const h = (await (await fetch(`${base}/health`)).json()) as { queued?: number };
        if (h.queued === 1) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const h = (await (await fetch(`${base}/health`)).json()) as { queued?: number };
      assert.equal(h.queued, 1, '第一个请求应已在队列里');

      const rejected = await post();
      assert.equal(rejected.status, 429);
      assert.equal(rejected.headers.get('retry-after'), '1');
      const rbody = (await rejected.json()) as { code?: string };
      assert.equal(rbody.code, 'run.queue_full');

      release();
      const ok = await first;
      assert.equal(ok.status, 200, '释放后第一个请求应正常完成');
    });
  });

  it('鉴权先于读请求体：超大 body 也得先过闸（否则 401 变成内存放大器）', async () => {
    await withEnv(KEY_ENV, 's3cret', async () => {
      await withServer({ apiKeyEnv: KEY_ENV, maxBodyBytes: 16 }, async (base) => {
        const r = await fetch(`${base}/v1/run`, {
          method: 'POST',
          body: JSON.stringify({ task: 'x'.repeat(200) }),
        });
        assert.equal(r.status, 401, '没凭据时不该因为 body 大小先拿到 413');
      });
    });
  });
});
