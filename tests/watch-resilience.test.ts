import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { runWatch } from '../src/rsi/watch.ts';

/**
 * 常驻 worker 的**抗故障**语义。
 *
 * 此前一条真实死法：一次 429 / 网络抖 / 一条读不出来的用例，`runRound` 抛出，
 * `runWatch` 直接冒泡 —— 无人值守的 worker 就这样没了，而「它没了」只有盯着看板
 * 的人才知道。反过来「永远重试」也不行：key 失效会变成永不停止的烧钱循环。
 * 所以是「退避重试，连续 N 次才停」。
 */
function project(): ReturnType<typeof loadConfig> {
  const root = mkdtempSync(join(tmpdir(), 'harness-watch-res-'));
  mkdirSync(join(root, 'agents'), { recursive: true });
  mkdirSync(join(root, 'evals'), { recursive: true });
  writeFileSync(join(root, 'harness.config.json'), JSON.stringify({ model: 'claude-opus-5' }));
  return loadConfig(root);
}

/** 不真等：把请求的毫秒数记下来，立刻返回 */
function recorder(): { waits: number[]; sleep: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

describe('worker 抗故障', () => {
  it('某一轮抛错不退出：退避之后继续下一轮', async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const errors: string[] = [];
    const report = await runWatch({
      config: project(),
      maxRounds: 2,
      everySec: 0,
      sleep,
      onRoundError: (e) => errors.push(e instanceof Error ? e.message : String(e)),
      runRound: async () => {
        calls += 1;
        if (calls === 1) throw new Error('网关 502');
        return { accepted: 1, costUsd: 0.01, costKnown: true };
      },
    });
    assert.equal(report.failures, 1);
    // `--max-rounds` 数的是**跑完的**轮数：失败那次不计入，所以为了 2 轮成功共调了 3 次
    assert.equal(report.rounds, 2);
    assert.equal(calls, 3);
    assert.equal(report.stopReason, 'max_rounds');
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? '', /502/);
    assert.ok((waits[0] ?? 0) >= 1000, `失败后必须退避（实际等 ${waits[0]}ms）`);
  });

  it('连续失败到上限 ⇒ 停下并给出 error（不无限重试烧钱）', async () => {
    const { sleep } = recorder();
    let calls = 0;
    const report = await runWatch({
      config: project(),
      maxRounds: 20,
      everySec: 0,
      maxConsecutiveFailures: 3,
      sleep,
      runRound: async () => {
        calls += 1;
        throw new Error('key 失效');
      },
    });
    assert.equal(report.stopReason, 'error');
    assert.equal(report.failures, 3);
    assert.equal(report.rounds, 0);
    assert.equal(calls, 3, '正好试三次，不多不少');
  });

  it('退避是递增的，且有上限', async () => {
    const { waits, sleep } = recorder();
    await runWatch({
      config: project(),
      maxRounds: 20,
      everySec: 0,
      maxConsecutiveFailures: 5,
      sleep,
      runRound: async () => {
        throw new Error('boom');
      },
    });
    const backoffs = waits.slice(1); // 第一次失败前的等待是 0（第一轮立刻开跑）
    assert.ok(backoffs.length >= 3, `应当记录多次退避（实际 ${backoffs.length}）`);
    assert.ok((backoffs[1] ?? 0) > (backoffs[0] ?? 0), `退避应当递增：${backoffs.join(' → ')}`);
    assert.ok(Math.max(...backoffs) <= 15 * 60_000, '退避不该超过 15 分钟');
  });

  it('信号打断不算失败（被要求停的，不是跑不起来）', async () => {
    const { sleep } = recorder();
    const controller = new AbortController();
    const report = await runWatch({
      config: project(),
      signal: controller.signal,
      maxRounds: 5,
      everySec: 0,
      sleep,
      runRound: async () => {
        controller.abort();
        throw new Error('被取消');
      },
    });
    assert.equal(report.stopReason, 'signal');
    assert.equal(report.failures, 0);
  });
});
