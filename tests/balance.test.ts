import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { Spender } from '../src/rsi/spender.ts';
import {
  type BalanceSnapshot,
  balanceUrlOf,
  billedSince,
  readBalance,
} from '../src/run/balance.ts';

/**
 * 余额盘 —— 「这次真的扣了多少钱」的唯一来源。
 *
 * 守的是几件**不会报错**的事：
 * - 接口给的是**字符串**数字（`"2.94"`），`Number()` 漏掉一步就得到 `NaN`，
 *   而 `NaN` 参与比较永远为 false ⇒ 闸永远不超；
 * - 币种是 CNY 时忘了折算 ⇒ 7 倍误差（或反过来对 USD 账户又除一次）；
 * - 余额上升（充值）被算成负花费 ⇒ `spent` 往下掉，闸从此不超。
 */

interface ProjectOptions {
  readonly baseURL?: string;
  readonly raw?: Record<string, unknown>;
}

/**
 * `balanceUrlOf` 读 `process.env.ANTHROPIC_BASE_URL`（与模型客户端同一优先级），
 * 而 `ensureEndpointEnv` 是**进程级**副作用 —— 别的测试文件可能已经把它设成了
 * 某个假端点。所以这里让 env 与 config 保持同步，并在文件结束时还原。
 */
const ORIGINAL_BASE_URL = process.env.ANTHROPIC_BASE_URL;
const TEST_KEY_ENV = 'HARNESS_BALANCE_TEST_KEY';

after(() => {
  if (ORIGINAL_BASE_URL === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = ORIGINAL_BASE_URL;
  delete process.env[TEST_KEY_ENV];
});

function project(opts: ProjectOptions = {}): ReturnType<typeof loadConfig> {
  const root = mkdtempSync(join(tmpdir(), 'harness-balance-'));
  const w = (rel: string, text: string): void => {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text, 'utf8');
  };
  w('agents/main.md', '---\nname: main\nversion: 1\ndescription: 主 agent\n---\n你是执行者。\n');
  w(
    'harness.config.json',
    JSON.stringify({
      model: 'deepseek-flash',
      endpoint: {
        apiKeyEnv: TEST_KEY_ENV,
        ...(opts.baseURL === undefined ? {} : { baseURL: opts.baseURL }),
      },
      ...opts.raw,
    }),
  );
  process.env[TEST_KEY_ENV] = 'sk-test';
  if (opts.baseURL === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = opts.baseURL;
  return loadConfig(root);
}

/** 固定一份 DeepSeek 形状的余额响应；`body` 为原始字符串时直接当响应体 */
function balanceResponse(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

const OK_BODY = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '2.94', granted_balance: '0.00', topped_up_balance: '2.94' },
  ],
};

function snap(entries: [string, number][], at = 0): BalanceSnapshot {
  return {
    at,
    url: 'https://api.deepseek.com/user/balance',
    available: true,
    entries: entries.map(([currency, total]) => ({ currency, total, granted: 0, toppedUp: total })),
  };
}

describe('balanceUrlOf', () => {
  it('DeepSeek 的 baseURL 自动推导出余额地址（不管 /anthropic 还是结尾斜杠）', () => {
    for (const baseURL of [
      'https://api.deepseek.com',
      'https://api.deepseek.com/',
      'https://api.deepseek.com/anthropic',
      'https://api.deepseek.com/v1',
    ]) {
      assert.equal(
        balanceUrlOf(project({ baseURL })),
        'https://api.deepseek.com/user/balance',
        `${baseURL} 应推导出余额地址`,
      );
    }
  });

  it('别的端点不认识（猜错地址比不猜更糟：会去问一个不存在的接口）', () => {
    assert.equal(balanceUrlOf(project({ baseURL: 'http://127.0.0.1:9999/anthropic' })), undefined);
    assert.equal(balanceUrlOf(project()), undefined, '没写 baseURL 时也没有');
  });

  it('配了 balance.url 就无条件用它（代理、网关后面的 DeepSeek 只能靠这个）', () => {
    const config = project({
      baseURL: 'http://127.0.0.1:9999',
      raw: { balance: { url: 'https://gw.example.com/billing/balance' } },
    });
    assert.equal(balanceUrlOf(config), 'https://gw.example.com/billing/balance');
  });

  it('"balance": false 显式关掉（连推导都不做）', () => {
    const config = project({ baseURL: 'https://api.deepseek.com', raw: { balance: false } });
    assert.equal(balanceUrlOf(config), undefined);
  });
});

describe('readBalance', () => {
  it('解析出总额、赠送、充值（接口给的是字符串数字）', async () => {
    const probe = await readBalance(project({ baseURL: 'https://api.deepseek.com' }), {
      fetchImpl: balanceResponse(OK_BODY),
    });
    assert.equal(probe.ok, true);
    if (!probe.ok) return;
    assert.deepEqual(probe.snapshot.entries, [
      { currency: 'CNY', total: 2.94, granted: 0, toppedUp: 2.94 },
    ]);
    assert.equal(probe.snapshot.available, true);
  });

  it('金额不是数字 ⇒ 明确失败，而不是产出 NaN', async () => {
    const probe = await readBalance(project({ baseURL: 'https://api.deepseek.com' }), {
      fetchImpl: balanceResponse({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: 'n/a' }],
      }),
    });
    assert.equal(probe.ok, false, 'NaN 会让比较永远为 false，必须当场拒掉');
  });

  it('HTTP 非 200 ⇒ 失败并带上状态码', async () => {
    const probe = await readBalance(project({ baseURL: 'https://api.deepseek.com' }), {
      fetchImpl: balanceResponse({ error: 'nope' }, 401),
    });
    assert.equal(probe.ok, false);
    if (probe.ok) return;
    assert.match(probe.reason, /HTTP 401/);
  });

  it('端点不支持时直接说明，不发请求', async () => {
    let called = false;
    const probe = await readBalance(project(), {
      fetchImpl: (async () => {
        called = true;
        return new Response('{}');
      }) as unknown as typeof fetch,
    });
    assert.equal(probe.ok, false);
    assert.equal(called, false, '不知道地址就不该发请求');
  });

  it('请求失败不抛（余额盘是增益不是依赖，挂掉要退回估算）', async () => {
    const probe = await readBalance(project({ baseURL: 'https://api.deepseek.com' }), {
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    assert.equal(probe.ok, false);
    if (probe.ok) return;
    assert.match(probe.reason, /ECONNREFUSED/);
  });
});

describe('billedSince', () => {
  it('CNY 账户按汇率折算（USD 账户不折算 —— 那会差 7 倍）', () => {
    const cny = billedSince(snap([['CNY', 10]]), snap([['CNY', 8.9]]), 7.1);
    assert.ok(cny !== undefined);
    assert.equal(cny.currency, 'CNY');
    assert.ok(Math.abs(cny.amount - 1.1) < 1e-9);
    // 折算结果收到微美元（见 `round6`），所以容差按 1e-6 而不是 1e-9
    assert.ok(Math.abs(cny.usd - 1.1 / 7.1) < 1e-6);

    const usd = billedSince(snap([['USD', 10]]), snap([['USD', 8.9]]), 7.1);
    assert.ok(usd !== undefined);
    assert.equal(usd.usd, 1.1, 'USD 账户的差额就是美元，再除一次汇率是 7 倍误差');
    assert.equal(usd.perUsd, undefined);
  });

  it('余额上升（充值）按 0 算，不给负花费', () => {
    const b = billedSince(snap([['CNY', 5]]), snap([['CNY', 50]]), 7.1);
    assert.ok(b !== undefined);
    assert.equal(b.amount, 0);
  });

  it('币种没有交集 ⇒ 无法对账（返回 undefined，不猜）', () => {
    assert.equal(billedSince(snap([['CNY', 5]]), snap([['USD', 5]]), 7.1), undefined);
  });

  it('两种币都有时优先 USD（同一笔账不该被汇率搅进来）', () => {
    const b = billedSince(
      snap([
        ['CNY', 100],
        ['USD', 10],
      ]),
      snap([
        ['CNY', 99],
        ['USD', 9.5],
      ]),
      7.1,
    );
    assert.ok(b !== undefined);
    assert.equal(b.currency, 'USD');
    assert.equal(b.usd, 0.5);
  });
});

describe('Spender（预算 + 余额对账）', () => {
  it('未定价模型也能按真实扣费判超限 —— 不再一律 blind 停机', async () => {
    const config = project({ baseURL: 'https://api.deepseek.com' });
    let reads = 0;
    // 第一次是开窗前快照，之后每次对账都往下走一点
    const fetchImpl = (async () => {
      reads++;
      const total = String(2.94 - reads * 0.1);
      return new Response(
        JSON.stringify({
          is_available: true,
          balance_infos: [{ currency: 'CNY', total_balance: total }],
        }),
      );
    }) as unknown as typeof fetch;

    const spending = await Spender.open(config, { limitUsd: 1, fetchImpl });
    assert.ok(spending.before !== undefined, '开窗前就有一个真实读数');
    // 一次「读不出成本」的 charge：旧实现这一步之后必然 blind
    await spending.charge(undefined, false, 1000);
    assert.equal(spending.exceeded(), false, '对账后按真实扣费判，没超就不该停');
    assert.ok(spending.spentUsd > 0, '对账后的花费必须来自余额，而不是 0');
    assert.equal(spending.billed()?.currency, 'CNY');
  });

  it('拿不到余额时退回旧行为：charge 后仍是 blind', async () => {
    const config = project({ baseURL: 'https://api.deepseek.com' });
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const spending = await Spender.open(config, { limitUsd: 1, fetchImpl });
    await spending.charge(undefined, false);
    assert.equal(spending.exceeded(), true);
    assert.equal(spending.snapshot(true)?.stoppedBy, 'blind');
  });

  it('meter: null 明确关闭，不发任何请求', async () => {
    const config = project({ baseURL: 'https://api.deepseek.com' });
    const spending = await Spender.open(config, { limitUsd: 1, meter: null });
    await spending.charge(undefined, false);
    assert.equal(spending.billed(), undefined);
    assert.equal(spending.snapshot(true)?.stoppedBy, 'blind');
  });
});
