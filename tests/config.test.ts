import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type HarnessConfig, loadConfig } from '../src/config.ts';
import {
  applyEndpointEnv,
  assertEndpointKey,
  endpointSummary,
  unpricedHint,
} from '../src/run/endpoint.ts';

/**
 * 配置层与端点桥接。
 *
 * 这一层的错两种都很难查：**拼错字段名**（静默忽略 ⇒ 行为像「配了没用」）与
 * **价格表用错口径**（`cacheRead` 是乘数不是绝对价 ⇒ 成本算出来差几十倍，而没人会
 * 往「乘数」上想）。所以这里的断言大多是「写错会炸」而不是「写对能读」。
 */

function cfg(json: unknown): HarnessConfig {
  const root = mkdtempSync(join(tmpdir(), 'harness-config-'));
  if (json !== undefined) {
    writeFileSync(join(root, 'harness.config.json'), JSON.stringify(json), 'utf8');
  }
  return loadConfig(root);
}

/** 断言抛的是 config.invalid，且文案里出现某段关键词（避免「炸了但对不上号」） */
function assertConfigError(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (e: unknown) => {
    const err = e as { code?: string; message?: string };
    assert.equal(err.code, 'config.invalid', `错误码应是 config.invalid，实际 ${String(err.code)}`);
    assert.match(err.message ?? '', pattern);
    return true;
  });
}

describe('配置 —— endpoint 段', () => {
  it('缺省：没有 baseURL，key 从 ANTHROPIC_API_KEY 读', () => {
    const c = cfg(undefined);
    assert.equal(c.baseURL, undefined);
    assert.equal(c.apiKeyEnv, 'ANTHROPIC_API_KEY');
    assert.deepEqual(c.pricing, {});
  });

  it('解析 baseURL 与 apiKeyEnv', () => {
    const c = cfg({
      endpoint: { baseURL: 'https://api.deepseek.com/anthropic', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    });
    assert.equal(c.baseURL, 'https://api.deepseek.com/anthropic');
    assert.equal(c.apiKeyEnv, 'DEEPSEEK_API_KEY');
  });

  it('baseURL 不是 http(s) 就炸（错在这里比错在 fetch 里早一轮 token）', () => {
    assertConfigError(() => cfg({ endpoint: { baseURL: 'api.deepseek.com' } }), /http\(s\)/);
    assertConfigError(() => cfg({ endpoint: { baseURL: 'ftp://x/y' } }), /http\(s\)/);
  });

  it('apiKeyEnv 写成了 key 本身也炸 —— 配置文件会被提交', () => {
    assertConfigError(() => cfg({ endpoint: { apiKeyEnv: 'sk-abc123' } }), /环境变量名/);
  });

  it('endpoint 里的未知字段不静默忽略', () => {
    assertConfigError(() => cfg({ endpoint: { base_url: 'https://x' } }), /不认识 "base_url"/);
  });
});

describe('配置 —— pricing 段', () => {
  it('in/out 是绝对价，cacheRead 是乘数', () => {
    const c = cfg({ pricing: { 'deepseek-flash': { in: 0.15, out: 0.6, cacheRead: 0.02 } } });
    assert.deepEqual(c.pricing['deepseek-flash'], { in: 0.15, out: 0.6, cacheRead: 0.02 });
  });

  it('缺 out / 负数 / 非数 / 未知字段都不接受', () => {
    assertConfigError(() => cfg({ pricing: { m: { in: 1 } } }), /"m"\]\.out 应为非负有限数/);
    assertConfigError(() => cfg({ pricing: { m: { in: -1, out: 1 } } }), /"m"\]\.in/);
    assertConfigError(() => cfg({ pricing: { m: { in: '1', out: 1 } } }), /"m"\]\.in/);
    assertConfigError(
      () => cfg({ pricing: { m: { in: 1, out: 1, cache_read: 0.1 } } }),
      /不认识 "cache_read"/,
    );
  });

  it('价格表本身不是对象、模型名为空也炸', () => {
    assertConfigError(() => cfg({ pricing: [] }), /"pricing" 应为/);
    assertConfigError(() => cfg({ pricing: { '  ': { in: 1, out: 1 } } }), /空模型名/);
  });
});

describe('配置 —— 拼错字段与非法预算必须响亮', () => {
  it('顶层未知键不静默忽略（modle 拼错不能变成「配了没用」）', () => {
    assertConfigError(() => cfg({ modle: 'deepseek-flash' }), /不认识 "modle"/);
    assertConfigError(() => cfg({ maxCost: 1 }), /不认识 "maxCost"/);
  });

  it('code 段未知键也不静默忽略（注释承诺过，实现此前漏了）', () => {
    assertConfigError(() => cfg({ code: { verfiy: ['npm', 'test'] } }), /不认识 "verfiy"/);
  });

  it('maxCostUsd / maxIterations 必须为正数：0 在 agentia 里是「不设上限」', () => {
    assertConfigError(() => cfg({ maxCostUsd: 0 }), /"maxCostUsd" 必须为正数/);
    assertConfigError(() => cfg({ maxCostUsd: -1 }), /"maxCostUsd" 必须为正数/);
    assertConfigError(() => cfg({ maxIterations: 0 }), /"maxIterations" 必须为正数/);
  });

  it('合法的预算照常读入（别把严格化做成一刀切拒绝）', () => {
    const c = cfg({ maxCostUsd: 0.5, maxIterations: 8 });
    assert.equal(c.maxCostUsd, 0.5);
    assert.equal(c.maxIterations, 8);
  });
});

describe('端点桥接 —— 配置 → 进程环境变量', () => {
  const touched = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY'];
  function withCleanEnv(fn: () => void): void {
    const saved = new Map(touched.map((k) => [k, process.env[k]]));
    for (const k of touched) delete process.env[k];
    try {
      fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it('把 baseURL 与 apiKeyEnv 搬到客户端实际读的变量上', () => {
    withCleanEnv(() => {
      const c = cfg({
        endpoint: { baseURL: 'https://api.deepseek.com/anthropic', apiKeyEnv: 'DEEPSEEK_API_KEY' },
      });
      process.env.DEEPSEEK_API_KEY = 'sk-test';
      applyEndpointEnv(c);

      assert.equal(process.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
      assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-test', '客户端只认这一个变量名');
      // 摘要只说「从哪个变量来」，不回显 key
      assert.deepEqual(endpointSummary(c), {
        baseURL: 'https://api.deepseek.com/anthropic',
        keyFrom: 'ANTHROPIC_API_KEY',
      });
    });
  });

  it('真实环境变量优先：已有值不被配置覆盖', () => {
    withCleanEnv(() => {
      const c = cfg({
        endpoint: { baseURL: 'https://from-config', apiKeyEnv: 'DEEPSEEK_API_KEY' },
      });
      process.env.ANTHROPIC_BASE_URL = 'https://from-env';
      process.env.DEEPSEEK_API_KEY = 'sk-file';
      process.env.ANTHROPIC_API_KEY = 'sk-env';

      applyEndpointEnv(c);
      assert.equal(process.env.ANTHROPIC_BASE_URL, 'https://from-env');
      assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-env');
    });
  });

  it('显式声明了 apiKeyEnv 却没有 key ⇒ 开跑前就报错（不等到 401）', () => {
    withCleanEnv(() => {
      const c = cfg({ endpoint: { apiKeyEnv: 'DEEPSEEK_API_KEY' } });
      applyEndpointEnv(c);
      assertConfigError(() => assertEndpointKey(c), /缺少模型凭据：DEEPSEEK_API_KEY/);
    });
  });

  it('没声明 apiKeyEnv 的老工程不受影响（e2e 的假端点不需要 key）', () => {
    withCleanEnv(() => {
      const c = cfg({ endpoint: { baseURL: 'http://127.0.0.1:9/fake' } });
      applyEndpointEnv(c);
      assert.doesNotThrow(() => assertEndpointKey(c));
      assert.equal(endpointSummary(c).keyFrom, null);
    });
  });

  it('声明了 apiKeyEnv、但 ANTHROPIC_API_KEY 已经设了 ⇒ 也算有凭据', () => {
    withCleanEnv(() => {
      const c = cfg({ endpoint: { apiKeyEnv: 'DEEPSEEK_API_KEY' } });
      process.env.ANTHROPIC_API_KEY = 'sk-env';
      applyEndpointEnv(c);
      assert.doesNotThrow(() => assertEndpointKey(c));
    });
  });
});

describe('未定价提示', () => {
  it('内置价格表里的模型不提示', () => {
    assert.equal(unpricedHint(cfg({ model: 'claude-opus-5' }), 'claude-opus-5'), undefined);
  });

  it('pricing 段覆盖过的模型不提示', () => {
    const c = cfg({ pricing: { 'deepseek-flash': { in: 0.15, out: 0.6 } } });
    assert.equal(unpricedHint(c, 'deepseek-flash'), undefined);
  });

  it('两处都没有 ⇒ 提示里必须出现「怎么修」（pricing 段那段 JSON）', () => {
    const hint = unpricedHint(cfg({}), 'deepseek-flash') ?? '';
    assert.match(hint, /不在价格表里/);
    assert.match(hint, /"deepseek-flash": \{ "in": 0\.15, "out": 0\.6 \}/);
    // 三个静默失效的后果都要点到：报告里的 $、成本门、RSI 预算闸
    assert.match(hint, /--max-cost/);
  });
});
