import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import {
  beginPending,
  finishPending,
  pendingPaths,
  readPending,
  sweepOrphanBackups,
} from '../src/rsi/pending.ts';

/**
 * 远程 staging 的崩溃安全带。
 *
 * 重点不是「能备份」，而是**清理顺序**：旧实现先删备份再删记录，一旦崩在中间，
 * 下次启动会读到「记录指向一个不存在的备份」并永久失败 —— 一个纯由清理顺序造成的、
 * 要求人工介入的死锁，而文件其实早就还原过了。
 */
function project(): { root: string; target: string } {
  const root = mkdtempSync(join(tmpdir(), 'harness-pending-'));
  mkdirSync(join(root, 'agents'), { recursive: true });
  const target = join(root, 'agents', 'main.md');
  writeFileSync(target, '---\ndescription: 主\n---\n原始正文\n');
  writeFileSync(join(root, 'harness.config.json'), '{}');
  return { root, target };
}

describe('pending 记录', () => {
  it('备份原内容 + 写记录；finish 之后两者都不留', () => {
    const { root, target } = project();
    const config = loadConfig(root);
    const stage = beginPending(config, { proposalId: 'p1', target: 'agent:main', file: target });
    assert.match(readFileSync(stage.backup, 'utf8'), /原始正文/);
    assert.equal(readPending(config)?.proposalId, 'p1');

    finishPending(config, stage);
    assert.equal(readPending(config), undefined);
    assert.equal(readdirSync(pendingPaths(config).dir).length, 0, '备份也要一起删掉');
  });

  it('已有未回收的记录时拒绝再开一个（覆盖会丢掉上一份备份的引用）', () => {
    const { root, target } = project();
    const config = loadConfig(root);
    beginPending(config, { proposalId: 'p1', target: 'agent:main', file: target });
    assert.throws(
      () => beginPending(config, { proposalId: 'p2', target: 'agent:main', file: target }),
      /上一次远程验证没有收尾/,
    );
    // 第一份仍然可读、可还原 —— 拒绝覆盖的意义就在这里
    assert.equal(readPending(config)?.proposalId, 'p1');
  });

  it('孤儿备份可清理（先删记录的安全代价不累积）', () => {
    const { root, target } = project();
    const config = loadConfig(root);
    const stage = beginPending(config, { proposalId: 'p1', target: 'agent:main', file: target });
    // 只删记录，留下备份：模拟「先删记录、还没删备份」时被 kill
    finishPending(config, stage);
    writeFileSync(stage.backup, 'orphan');

    const removed = sweepOrphanBackups(config, -1);
    assert.equal(removed, 1);
    assert.equal(readdirSync(pendingPaths(config).dir).length, 0);
  });

  it('没到期的备份不清（可能有正在用的）', () => {
    const { root, target } = project();
    const config = loadConfig(root);
    const stage = beginPending(config, { proposalId: 'p1', target: 'agent:main', file: target });
    finishPending(config, stage);
    writeFileSync(stage.backup, 'still-fresh');
    assert.equal(sweepOrphanBackups(config, 60_000), 0);
    assert.ok(statSync(stage.backup).isFile());
  });
});
