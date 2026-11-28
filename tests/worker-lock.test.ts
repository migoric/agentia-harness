import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { atomicWrite } from '../src/rsi/journal.ts';
import { acquireWorkerLock, readWorkerLock, workerLockPath } from '../src/rsi/worker-lock.ts';

/**
 * 锁的**互斥**语义。
 *
 * 这块此前有一条只在纸上成立的保证：实现是「读 → 判 → 改名 → 写」，而两个进程同时
 * 启动时都会读到「没有锁」，然后各自写一份 —— 两个都以为自己持有锁。那种错误的
 * 破坏方式很安静：轮次并发、归因失效，而报告仍然正常。所以这里用**真子进程**验，
 * 不用 mock：互斥的正确性来自 `O_EXCL` 这个内核仲裁，mock 掉它等于把要测的东西删了。
 */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-lock-'));
  mkdirSync(join(root, 'agents'), { recursive: true });
  mkdirSync(join(root, 'evals'), { recursive: true });
  writeFileSync(join(root, 'harness.config.json'), JSON.stringify({ model: 'claude-opus-5' }));
  return root;
}

/** 子进程：拿锁 → 打印 GOT → 持有 1.5s → 释放 */
function runChild(root: string): Promise<{ code: number; out: string }> {
  const script = `
import { loadConfig } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'config.ts'))};
import { acquireWorkerLock } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'rsi', 'worker-lock.ts'))};
const cfg = loadConfig(${JSON.stringify(root)});
try {
  const lock = acquireWorkerLock(cfg, { command: 'child' });
  console.log('GOT');
  await new Promise((r) => setTimeout(r, 1500));
  lock.release();
} catch (e) {
  console.log('BLOCKED ' + (e instanceof Error ? e.message : String(e)));
  process.exitCode = 3;
}
`;
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: join(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

describe('工作区锁', () => {
  it('两个进程同时抢：恰好一个拿到', async () => {
    const root = project();
    const [a, b] = await Promise.all([runChild(root), runChild(root)]);
    const got = [a, b].filter((r) => r.out.includes('GOT')).length;
    const blocked = [a, b].filter((r) => r.out.includes('BLOCKED')).length;
    assert.equal(got, 1, `应当恰好一个拿到锁（实际 ${got}）：\n${a.out}\n${b.out}`);
    assert.equal(blocked, 1, `另一个必须被拒绝，而不是并行跑（实际 ${blocked}）`);
  });

  it('陈旧锁自动回收，且旧锁改名留存', () => {
    const root = project();
    const config = loadConfig(root);
    mkdirSync(join(root, '.workspace', 'rsi'), { recursive: true });
    // 心跳是新鲜的，但 pid 不存在 —— 这正是 SIGKILL 留下的形状
    writeFileSync(
      workerLockPath(config),
      JSON.stringify({
        pid: 999_999,
        // 同机 + pid 不存在：判活的第二个条件（异机只信心跳，这里要测 pid 探测那条）
        host: hostname(),
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        rounds: 3,
        command: 'dead-worker',
      }),
      'utf8',
    );
    const lock = acquireWorkerLock(config, { command: 'test' });
    assert.equal(lock.reclaimed?.lock.command, 'dead-worker');
    const stale = readdirSync(join(root, '.workspace', 'rsi')).filter((n) => n.includes('.stale-'));
    assert.equal(stale.length, 1, '旧锁必须改名留存（事后能查是谁卡住的）');
    lock.release();
    assert.equal(existsSync(workerLockPath(config)), false);
  });

  it('release 只删自己的那把：被抢占之后不误删别人的锁', () => {
    const root = project();
    const config = loadConfig(root);
    const lock = acquireWorkerLock(config, { command: 'mine' });
    // 模拟「我的锁被判陈旧、另一个进程接手」：内容换成别人的 token
    atomicWrite(
      workerLockPath(config),
      `${JSON.stringify({
        pid: process.pid,
        host: readWorkerLock(config)?.lock.host,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        rounds: 0,
        token: 'other-process',
        command: 'theirs',
      })}\n`,
    );
    lock.release();
    assert.equal(readWorkerLock(config)?.lock.command, 'theirs', '不该删掉别人的锁');
  });

  it('锁里记着命令名：抢不到的报错能说出对手是谁', () => {
    const root = project();
    const config = loadConfig(root);
    const held = acquireWorkerLock(config, { command: 'rsi --watch' });
    assert.throws(
      () => acquireWorkerLock(config, { command: 'rsi accept' }),
      /rsi --watch/,
      '报错必须带上对手的命令名，否则人不知道该等还是该杀进程',
    );
    held.release();
  });
});
