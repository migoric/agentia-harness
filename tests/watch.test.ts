import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { type RoundTick, runWatch } from '../src/rsi/watch.ts';
import { readWorkerLock, workerLockPath } from '../src/rsi/worker-lock.ts';

/**
 * 常驻 worker 的**调度语义**（判据 16 与 17 的机制部分）。
 *
 * 这里一个模型都不调：`runWatch` 的「跑一轮」是注入的。这不是为了测试好写，而是
 * 这条边界的正确定义 —— worker 只决定**什么时候开始下一轮**，轮内怎么采集、提案、
 * 验证全在 `runCycle` 里。把两者混在一起测，会得到一个「要跑完两遍评测才能验证
 * 锁生效了没有」的测试套件，那种测试没人会在改锁的时候跑。
 *
 * 覆盖不到的（诚实记在这里）：真进程被 SIGKILL 在写资产中途时的恢复。那需要真跑
 * 一轮 RSI，成本与耗时都不适合放进单测；机制上它由三件事保证，各自有独立的测试：
 * 资产写入原子（`journal.test`）、journal 末行可修（`journal-repair.test`）、
 * 陈旧锁可回收（本文件）。
 */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-watch-'));
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
  return root;
}

const ok = (accepted = 1): RoundTick => ({ accepted, costUsd: 0.01, costKnown: true });
const noSleep = async (): Promise<void> => undefined;

describe('rsi --watch', () => {
  it('判据 16：连跑多轮是串行的（时间窗不重叠，且按顺序）', async () => {
    const root = project();
    const windows: Array<{ start: number; end: number; round: number }> = [];
    const report = await runWatch({
      config: loadConfig(root),
      maxRounds: 3,
      everySec: 1,
      sleep: noSleep,
      runRound: async (_signal, round) => {
        const start = Date.now();
        await new Promise((r) => setTimeout(r, 20));
        windows.push({ start, end: Date.now(), round });
        return ok();
      },
    });
    assert.equal(report.rounds, 3);
    assert.equal(report.accepted, 3);
    assert.equal(report.stopReason, 'max_rounds');
    assert.deepEqual(
      windows.map((w) => w.round),
      [1, 2, 3],
      '轮次必须按顺序，且每次只跑一轮',
    );
    for (let i = 1; i < windows.length; i++) {
      const prev = windows[i - 1];
      const cur = windows[i];
      assert.ok(prev && cur && cur.start >= prev.end, `第 ${i + 1} 轮与上一轮重叠了 —— 串行闸失效`);
    }
  });

  it('没有推进就停（不再开下一轮，避免「更贵但更不聪明」）', async () => {
    const root = project();
    const seen: number[] = [];
    const report = await runWatch({
      config: loadConfig(root),
      maxRounds: 5,
      everySec: 1,
      sleep: noSleep,
      runRound: async (_s, round) => {
        seen.push(round);
        return round === 1 ? ok() : ok(0);
      },
    });
    assert.deepEqual(seen, [1, 2]);
    assert.equal(report.stopReason, 'no_progress');
    assert.equal(report.accepted, 1);
  });

  it('这一轮自己声明该停（预算）时立刻停', async () => {
    const root = project();
    const report = await runWatch({
      config: loadConfig(root),
      maxRounds: 5,
      everySec: 1,
      sleep: noSleep,
      runRound: async () => ({ accepted: 1, costUsd: 0.5, costKnown: true, stop: 'budget' }),
    });
    assert.equal(report.rounds, 1);
    assert.equal(report.stopReason, 'budget');
    assert.equal(report.costUsd, 0.5);
  });

  it('到点即停：`--until` 到期后不再开新一轮', async () => {
    const root = project();
    const report = await runWatch({
      config: loadConfig(root),
      maxRounds: 10,
      everySec: 1,
      until: Date.now() + 40,
      sleep: async () => {
        await new Promise((r) => setTimeout(r, 60));
      },
      runRound: async () => ok(),
    });
    assert.equal(report.rounds, 1);
    assert.equal(report.stopReason, 'until');
  });

  it('信号：不再开下一轮，当前轮跑完再退（不是就地砍断）', async () => {
    const root = project();
    const controller = new AbortController();
    let finished = 0;
    const report = await runWatch({
      config: loadConfig(root),
      signal: controller.signal,
      maxRounds: 5,
      everySec: 1,
      sleep: noSleep,
      runRound: async () => {
        finished += 1;
        // 模拟「跑到一半收到 SIGTERM」：这一轮仍要收尾
        controller.abort();
        return ok();
      },
    });
    assert.equal(finished, 1, '当前这一轮必须跑完');
    assert.equal(report.rounds, 1);
    assert.equal(report.stopReason, 'signal');
  });

  it('判据 17 的机制部分：第二个实例被锁挡下，且不会静默并行', async () => {
    const root = project();
    const config = loadConfig(root);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = runWatch({
      config,
      maxRounds: 1,
      sleep: noSleep,
      runRound: async () => {
        await gate;
        return ok();
      },
    });
    // 等第一个实例拿到锁
    for (let i = 0; i < 50 && readWorkerLock(config) === null; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.notEqual(readWorkerLock(config), null, '第一个实例应当已经写下锁');

    await assert.rejects(
      () => runWatch({ config, maxRounds: 1, sleep: noSleep, runRound: async () => ok() }),
      /已经有一个 worker 在推进轮次/,
      '第二个实例必须被拒绝，而不是排队或并行',
    );

    release?.();
    const report = await first;
    assert.equal(report.rounds, 1);
    assert.equal(existsSync(workerLockPath(config)), false, '正常收尾必须删掉自己的锁');
  });

  it('陈旧锁自动回收（被 SIGKILL 留下的锁不该要求人手动删文件）', async () => {
    const root = project();
    const config = loadConfig(root);
    mkdirSync(join(root, '.workspace', 'rsi'), { recursive: true });
    writeFileSync(
      workerLockPath(config),
      JSON.stringify({
        pid: 999_999, // 几乎不可能是活着的进程
        host: hostname(),
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        rounds: 2,
      }),
      'utf8',
    );
    let reclaimed: string | undefined;
    const report = await runWatch({
      config,
      maxRounds: 1,
      sleep: noSleep,
      onReclaim: (why) => {
        reclaimed = why;
      },
      runRound: async () => ok(),
    });
    assert.equal(report.rounds, 1);
    assert.match(reclaimed ?? '', /pid 999999 已不存在/);
    assert.equal(existsSync(workerLockPath(config)), false);
  });

  it('参数校验：负间隔与非法轮数在开跑前就拒绝（不写锁）', async () => {
    const root = project();
    const config = loadConfig(root);
    await assert.rejects(
      () => runWatch({ config, everySec: -1, runRound: async () => ok() }),
      /--every 必须是非负数/,
    );
    await assert.rejects(
      () => runWatch({ config, maxRounds: 0, runRound: async () => ok() }),
      /--max-rounds 必须是正整数/,
    );
    assert.equal(existsSync(workerLockPath(config)), false, '参数不合法时不该留下锁');
  });
});
