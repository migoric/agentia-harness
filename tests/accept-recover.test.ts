import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { discoverAssets } from '../src/assets/discover.ts';
import { loadConfig } from '../src/config.ts';
import { commitAccept, recoverAccept } from '../src/rsi/commit.ts';
import { readJournal } from '../src/rsi/journal.ts';
import type { Proposal } from '../src/rsi/types.ts';

/**
 * 采纳的**崩溃恢复**。
 *
 * 覆盖的是那条此前不存在、但真实发生过的窗口：写资产成功、追加 journal 之前被杀。
 * 那时的现象是「资产换了、账本干净」—— `regress` 找不到基准、`ledger` 说没采纳过、
 * `revert` 说没有可回滚的记录，而三件事都不报错。
 *
 * 测试用「手工构造中间态」而不是真杀进程：要断言的是**判据**（磁盘正文等于 before
 * 还是 after），而那个判据与「怎么死的」无关。
 */
const BEFORE = '你是执行者。';
const AFTER = '你是执行者。输出必须以「结论：」开头。';

function project(): { root: string; agentFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'harness-recover-'));
  const agentFile = join(root, 'agents', 'main.md');
  mkdirSync(join(root, 'agents'), { recursive: true });
  mkdirSync(join(root, 'evals'), { recursive: true });
  writeFileSync(agentFile, `---\ndescription: 主\n---\n${BEFORE}\n`);
  writeFileSync(join(root, 'evals', 'e.md'), '---\nname: e\nexpect_ok: true\n---\n跑一下\n');
  writeFileSync(join(root, 'harness.config.json'), '{"model":"claude-opus-5"}');
  return { root, agentFile };
}

function proposal(): Proposal {
  return {
    id: 'p-rec-001',
    modeId: 'wrong_answer:abc',
    kind: 'wrong_answer',
    rationale: '结论缺失',
    layer: 'L1',
    patch: { target: 'agent:main', before: BEFORE, after: AFTER },
  };
}

function intentPath(root: string): string {
  return join(root, '.workspace', 'rsi', 'accept-intent.json');
}

/** 意图记录的形状（与 `commit.ts` 写出的字段一致；手工构造崩溃后的中间态用） */
function writeIntent(root: string, body: { before: string; after: string }): void {
  mkdirSync(join(root, '.workspace', 'rsi'), { recursive: true });
  writeFileSync(
    intentPath(root),
    JSON.stringify({
      schema: 1,
      at: Date.now(),
      proposalId: 'p-rec-001',
      target: 'agent:main',
      before: body.before,
      after: body.after,
      reason: '测试',
      assetsBefore: '',
    }),
  );
}

describe('采纳的事务性', () => {
  it('正常采纳：写盘之后不留中间记录', () => {
    const { root, agentFile } = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const r = commitAccept(config, assets, proposal(), '测试');
    assert.equal(r.entry.status, 'accepted');
    assert.match(readFileSync(agentFile, 'utf8'), /结论/);
    assert.equal(existsSync(intentPath(root)), false);
    assert.equal(readJournal(config).length, 1);
  });

  it('资产已是 after、journal 缺条目 ⇒ 自动补齐', () => {
    const { root, agentFile } = project();
    const config = loadConfig(root);
    writeFileSync(agentFile, `---\ndescription: 主\n---\n${AFTER}\n`);
    writeIntent(root, { before: BEFORE, after: AFTER });
    const note = recoverAccept(config);
    assert.match(String(note), /补齐/);
    const entries = readJournal(config);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.proposalId, 'p-rec-001');
    assert.equal(entries[0]?.after, AFTER);
    assert.equal(existsSync(intentPath(root)), false);
  });

  it('资产仍是 before ⇒ 认为没写成，清掉意图且不动 journal', () => {
    const { root } = project();
    const config = loadConfig(root);
    writeIntent(root, { before: BEFORE, after: AFTER });
    const note = recoverAccept(config);
    assert.match(String(note), /未生效/);
    assert.equal(readJournal(config).length, 0);
    assert.equal(existsSync(intentPath(root)), false);
  });

  it('资产被手改成第三种内容 ⇒ 拒绝猜，保留意图并报错', () => {
    const { root, agentFile } = project();
    const config = loadConfig(root);
    writeFileSync(agentFile, `---\ndescription: 主\n---\n有人手改过这一行\n`);
    writeIntent(root, { before: BEFORE, after: AFTER });
    assert.throws(() => recoverAccept(config), /既不是采纳前、也不是采纳后/);
    assert.equal(
      existsSync(intentPath(root)),
      true,
      '必须保留意图：自动把手改内容记成 RSI 采纳是最坏的自动化',
    );
  });

  it('重复恢复是幂等的（不会补第二条）', () => {
    const { root, agentFile } = project();
    const config = loadConfig(root);
    writeFileSync(agentFile, `---\ndescription: 主\n---\n${AFTER}\n`);
    writeIntent(root, { before: BEFORE, after: AFTER });
    recoverAccept(config);
    assert.equal(recoverAccept(config), undefined, '第二次应当无残留，什么都不做');
    assert.equal(readJournal(config).length, 1);
  });
});
