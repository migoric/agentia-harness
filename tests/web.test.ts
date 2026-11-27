import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { discoverAssets } from '../src/assets/discover.ts';
import { loadConfig } from '../src/config.ts';
import { ROUTES } from '../src/server/routes.ts';
import { startServer } from '../src/server/serve.ts';

/**
 * 只读面（S8）—— 判据 15 与 20，外加「数据真的读出来了」。
 *
 * 两个判据的性质完全不同，所以分成两组测：
 *
 * - **判据 15（web 无写口）**是**安全属性**：它要证明的不是「返回了 405」，而是
 *   「工作区一个字节都没被改」。所以断言落在目录 mtime 上 —— 只断状态码的话，
 *   一个「先写文件、后回 405」的实现照样能过。
 * - **判据 20（路由表与文档一致）**是**结构属性**：openapi 与路由表双向相等之外，
 *   还要求每条 GET 路由**真的能应答**。少了后半句，两份清单可以一起漏掉一条真路由，
 *   双向比较仍然「一致」。
 */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-web-'));
  mkdirSync(join(root, 'agents'), { recursive: true });
  mkdirSync(join(root, 'evals'), { recursive: true });
  writeFileSync(
    join(root, 'harness.config.json'),
    JSON.stringify({ model: 'claude-opus-5' }),
    'utf8',
  );
  writeFileSync(
    join(root, 'agents', 'main.md'),
    '---\nname: main\nversion: 1\ndescription: 主 agent\n---\n你是执行者。\n',
    'utf8',
  );
  // 评测用例计数用（内容不重要，看板只数 .md）
  writeFileSync(join(root, 'evals', 'a.md'), '# a\n', 'utf8');

  const ws = join(root, '.workspace');
  mkdirSync(join(ws, 'reports'), { recursive: true });
  mkdirSync(join(ws, 'rsi', 'cycles'), { recursive: true });
  writeFileSync(
    join(ws, 'reports', 'run-1.json'),
    JSON.stringify({
      schemaVersion: 2,
      total: 4,
      passed: 3,
      passRate: 0.75,
      tokens: 1000,
      costUsd: 0.12,
      costKnown: true,
      cases: [{ name: 'a', passed: true }],
      assetFingerprint: 'abc',
      agent: 'main',
      finishedAt: '2026-11-28T00:00:00.000Z',
      routeAccuracy: 0.5,
      routeCases: 2,
    }),
    'utf8',
  );
  // 一份坏报告：它必须进 invalid，而不是让整个列表 500
  writeFileSync(join(ws, 'reports', 'broken.json'), '{not json', 'utf8');
  writeFileSync(
    join(ws, 'rsi', 'cycles', '2026-11-28T00-00-00-000Z.json'),
    JSON.stringify({
      schema: 3,
      cycleId: '2026-11-28T00-00-00-000Z',
      at: '2026-11-28T00:00:00.000Z',
      dryRun: false,
      verified: [
        {
          proposal: { id: 'p-1', patch: { target: 'skill:alpha', before: '', after: 'x' } },
          candidate: { cases: [] },
        },
      ],
      accepted: [{ id: 'p-1' }],
    }),
    'utf8',
  );
  writeFileSync(
    join(ws, 'rsi', 'journal.jsonl'),
    `${JSON.stringify({ at: 1, proposalId: 'p-1', status: 'accepted', target: 'skill:alpha' })}\n`,
    'utf8',
  );
  return root;
}

async function withServer<T>(
  fn: (base: string, root: string) => Promise<T>,
  apiKey?: string,
): Promise<T> {
  const root = project();
  const config = loadConfig(root);
  const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
  if (apiKey !== undefined) process.env.HARNESS_TEST_KEY = apiKey;
  const server = await startServer({
    config,
    assets,
    port: 0,
    ...(apiKey !== undefined ? { apiKeyEnv: 'HARNESS_TEST_KEY' } : {}),
  });
  try {
    return await fn(`http://127.0.0.1:${server.port}`, root);
  } finally {
    await server.close();
    if (apiKey !== undefined) delete process.env.HARNESS_TEST_KEY;
  }
}

/** 目录 mtime（纳秒级：秒级精度在「写一下就 405」的实现上看不出差别） */
function mtimes(root: string): Record<string, bigint> {
  const ws = join(root, '.workspace');
  return {
    workspace: statSync(ws, { bigint: true }).mtimeNs,
    reports: statSync(join(ws, 'reports'), { bigint: true }).mtimeNs,
    rsi: statSync(join(ws, 'rsi'), { bigint: true }).mtimeNs,
  };
}

describe('只读面', () => {
  it('判据 15：写口全拒（404/405），且工作区 mtime 一个都没变', async () => {
    await withServer(async (base, root) => {
      const before = mtimes(root);
      const attempts: Array<[string, string]> = [
        ['POST', '/rsi/rounds'],
        ['POST', '/evals'],
        ['PUT', '/assets'],
        ['POST', '/api/reports'],
        ['DELETE', '/api/reports/run-1.json'],
        ['POST', '/api/rsi/cycles'],
      ];
      for (const [method, path] of attempts) {
        const res = await fetch(base + path, { method });
        assert.ok(
          res.status === 404 || res.status === 405,
          `${method} ${path} 期望 404/405，收到 ${res.status}`,
        );
        if (res.status === 405) {
          assert.equal(res.headers.get('allow'), 'GET', `${method} ${path} 的 allow 头`);
        }
      }
      assert.deepEqual(mtimes(root), before, '只读面不许改工作区（连目录 mtime 都不该动）');
    });
  });

  it('判据 20：openapi 与路由表双向一致，且每条 GET 路由都真的应答', async () => {
    await withServer(async (base) => {
      const doc = (await (await fetch(`${base}/openapi.json`)).json()) as {
        paths: Record<string, Record<string, unknown>>;
      };
      const fromDoc = new Set<string>();
      for (const [path, item] of Object.entries(doc.paths)) {
        for (const method of Object.keys(item)) fromDoc.add(`${method.toUpperCase()} ${path}`);
      }
      const fromTable = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
      assert.deepEqual(
        [...fromDoc].sort(),
        [...fromTable].sort(),
        'openapi 与路由表必须逐条相同（少一条 = 文档漂了；多一条 = 文档在骗人）',
      );

      // 用样例参数把模板路由实例化：`/api/reports/:name` 打一份真的报告
      const concrete = (path: string): string =>
        path.replace(':name', 'run-1.json').replace(':id', '2026-11-28T00-00-00-000Z');
      for (const route of ROUTES) {
        if (route.method !== 'GET') continue;
        if (route.owner === 'core') continue; // /health 由 serve.test 覆盖
        const res = await fetch(base + concrete(route.path));
        assert.equal(res.status, 200, `GET ${route.path} 期望 200，收到 ${res.status}`);
      }
    });
  });

  it('报告：列表含摘要与坏文件原因，单份原样返回', async () => {
    await withServer(async (base) => {
      const list = (await (await fetch(`${base}/api/reports`)).json()) as {
        reports: Array<Record<string, unknown>>;
        invalid: Array<{ name: string; reason: string }>;
      };
      assert.equal(list.reports.length, 1);
      const r = list.reports[0] ?? {};
      assert.equal(r.name, 'run-1.json');
      assert.equal(r.passRate, 0.75);
      assert.equal(r.schemaVersion, 2);
      assert.equal(r.routeAccuracy, 0.5);
      assert.equal(r.routeCases, 2);
      assert.equal(list.invalid.length, 1);
      assert.equal(list.invalid[0]?.name, 'broken.json');

      const one = (await (await fetch(`${base}/api/reports/run-1.json`)).json()) as {
        raw: { total: number };
      };
      // 原样返回：看板不许替报告补字段或「美化」数字
      assert.equal(one.raw.total, 4);
    });
  });

  it('报告名不接受路径分隔符（穿越尝试 → 400，不是 404 也不是 500）', async () => {
    await withServer(async (base) => {
      for (const name of ['..%2Fsecret.json', '..%2F..%2Fetc%2Fpasswd', 'a%2Fb.json']) {
        const res = await fetch(`${base}/api/reports/${name}`);
        assert.equal(res.status, 400, `${name} 期望 400，收到 ${res.status}`);
      }
    });
  });

  it('轮次与账本：摘要有采纳与目标；明细不带宿主绝对路径', async () => {
    await withServer(async (base) => {
      const cycles = (await (await fetch(`${base}/api/rsi/cycles`)).json()) as {
        cycles: Array<Record<string, unknown>>;
      };
      assert.equal(cycles.cycles.length, 1);
      const c = cycles.cycles[0] ?? {};
      assert.equal(c.cycleId, '2026-11-28T00-00-00-000Z');
      assert.equal(c.accepted, 1);
      assert.deepEqual(c.targets, ['skill:alpha']);

      const one = (await (
        await fetch(`${base}/api/rsi/cycles/2026-11-28T00-00-00-000Z`)
      ).json()) as { cycle: Record<string, unknown> };
      assert.equal(one.cycle.path, undefined, '明细不该带宿主机绝对路径');

      const j = (await (await fetch(`${base}/api/rsi/journal?limit=10`)).json()) as {
        total: number;
        entries: unknown[];
      };
      assert.equal(j.total, 1);
      assert.equal(j.entries.length, 1);
    });
  });

  it('worker：没锁时说空闲，有锁时能读出 pid 与心跳', async () => {
    await withServer(async (base, root) => {
      const idle = (await (await fetch(`${base}/api/rsi/worker`)).json()) as {
        running: boolean;
        reason: string;
      };
      assert.equal(idle.running, false);
      assert.match(idle.reason, /没有 worker/);

      writeFileSync(
        join(root, '.workspace', 'rsi', 'worker.lock'),
        JSON.stringify({
          pid: process.pid,
          host: 'test-host',
          startedAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          rounds: 2,
          currentRound: 3,
        }),
        'utf8',
      );
      const live = (await (await fetch(`${base}/api/rsi/worker`)).json()) as {
        running: boolean;
        lock: { pid: number; rounds: number };
      };
      assert.equal(live.running, true);
      assert.equal(live.lock.pid, process.pid);
      assert.equal(live.lock.rounds, 2);
    });
  });

  it('鉴权：静态壳与 openapi 免费，数据面 401，带 key 通过', async () => {
    await withServer(async (base) => {
      for (const p of ['/', '/openapi.json']) {
        const res = await fetch(base + p);
        assert.equal(res.status, 200, `${p} 是纯静态壳，不该要凭据`);
      }
      const denied = await fetch(`${base}/api/reports`);
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get('www-authenticate'), 'Bearer');

      const ok = await fetch(`${base}/api/reports`, {
        headers: { authorization: 'Bearer web-test-key' },
      });
      assert.equal(ok.status, 200);
    }, 'web-test-key');
  });

  it('看板首页是 HTML 且不引用任何外链', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
      const html = await res.text();
      assert.match(html, /只读看板/);
      // 零外链：内网部署时 CDN 要么拖慢首屏，要么断网整页空白
      assert.ok(!/(src|href)="https?:/.test(html), '看板不许引用外部资源');
    });
  });

  it('回归：GET /v1/run 仍是 405（只读面没把写入口吞掉）', async () => {
    await withServer(async (base) => {
      // 只验 GET：POST 会真的去调模型（这个测试没有注入 client）。
      // 「GET 拿 405 且 allow=POST」已经足以证明只读面没有把 `/v1/run` 当成自己的路由。
      const get = await fetch(`${base}/v1/run`);
      assert.equal(get.status, 405);
      assert.equal(get.headers.get('allow'), 'POST');
    });
  });
});
