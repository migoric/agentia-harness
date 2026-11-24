import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type HarnessConfig, loadConfig } from '../src/config.ts';
import { HarnessError } from '../src/errors.ts';
import { journalPath, readJournal, repairJournal } from '../src/rsi/journal.ts';
import { runCli, tmpProject } from './support/cli.ts';

/**
 * 账本的两种坏法，必须给出**不同的结论**。
 *
 * append-only 文件被杀在写系统调用中间只会有末行半截 —— 那是「中断的追加」，前面的
 * 历史完好，截掉就能继续用。而「中间某行不是 JSON」是真损坏（手改、磁盘错误），
 * 自动截它等于把「数据坏了」变成「数据少了一条」，比报错更危险。
 *
 * 修复之前这两种都表现为原生 `SyntaxError: Unterminated string in JSON`，没有 code、
 * 没有建议，而它会让 `accept` / `regress` / `ledger` / `cycle` 全部失效。
 */

function project(): HarnessConfig {
  const root = mkdtempSync(join(tmpdir(), 'journal-'));
  writeFileSync(join(root, 'harness.config.json'), '{}');
  return loadConfig(root);
}

function line(id: string): string {
  return JSON.stringify({
    at: 1,
    proposalId: id,
    status: 'accepted',
    target: 'skill:demo',
    before: 'a',
    after: 'b',
    reason: 'r',
    assetsBefore: 'x',
    assetsAfter: 'y',
  });
}

function write(config: HarnessConfig, text: string): string {
  const path = journalPath(config);
  mkdirSync(join(config.workspaceDir, 'rsi'), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return path;
}

describe('journal 读取：半截行 vs 真损坏', () => {
  it('末行半截 ⇒ HarnessError，且报错里点名修复命令', () => {
    const config = project();
    write(config, `${line('p1')}\n{"proposalId":"p2","sta`);

    assert.throws(
      () => readJournal(config),
      (e: unknown) =>
        e instanceof HarnessError &&
        e.code === 'rsi.no_signal' &&
        /半截/.test(e.message) &&
        /journal --repair/.test(e.message),
      '半截行必须给出「可修复」的信号，而不是裸 SyntaxError',
    );
  });

  it('中间行坏了 ⇒ 拒绝跳过（不是截尾能修的）', () => {
    const config = project();
    write(config, `${line('p1')}\n{不是 JSON}\n${line('p3')}\n`);

    assert.throws(
      () => readJournal(config),
      (e: unknown) =>
        e instanceof HarnessError && e.code === 'rsi.no_signal' && /第 2 行/.test(e.message),
    );
  });

  it('行能解析但缺 proposalId ⇒ 当场报，而不是留给下游解引用', () => {
    const config = project();
    write(config, `${JSON.stringify({ at: 1, status: 'accepted' })}\n`);

    assert.throws(
      () => readJournal(config),
      (e: unknown) => e instanceof HarnessError && /缺少 proposalId/.test(e.message),
    );
  });

  it('status 不在词汇表里 ⇒ 报错（否则「这条算不算采纳」会静默变成 false）', () => {
    const config = project();
    write(config, `${JSON.stringify({ at: 1, proposalId: 'p', status: 'ok' })}\n`);

    assert.throws(
      () => readJournal(config),
      (e: unknown) => e instanceof HarnessError && /accepted\/rejected/.test(e.message),
    );
  });
});

describe('journal --repair：只截尾，且先备份', () => {
  it('截掉末行半截，历史行原样保留，备份含原文', () => {
    const config = project();
    const original = `${line('p1')}\n${line('p2')}\n{"proposalId":"p3","sta`;
    const path = write(config, original);

    const r = repairJournal(config);
    assert.equal(r.truncated, true);
    assert.equal(r.linesAfter, 2);
    assert.ok(r.backupPath !== undefined);
    assert.equal(readFileSync(r.backupPath, 'utf8'), original, '备份必须是修复前的原文');
    assert.equal(readFileSync(path, 'utf8'), `${line('p1')}\n${line('p2')}\n`);

    const entries = readJournal(config);
    assert.deepEqual(
      entries.map((e) => e.proposalId),
      ['p1', 'p2'],
    );
  });

  it('健康的文件 ⇒ 什么都不做（不改内容、不留备份）', () => {
    const config = project();
    const original = `${line('p1')}\n`;
    const path = write(config, original);

    const r = repairJournal(config);
    assert.equal(r.truncated, false);
    assert.equal(r.backupPath, undefined);
    assert.equal(readFileSync(path, 'utf8'), original);
  });

  it('坏的不止末行 ⇒ 拒绝修，且文件一个字节都不动', () => {
    const config = project();
    const original = `${line('p1')}\n{坏}\n{"proposalId":"p3","sta`;
    const path = write(config, original);

    assert.throws(
      () => repairJournal(config),
      (e: unknown) => e instanceof HarnessError && /坏的不止最后半行/.test(e.message),
    );
    assert.equal(readFileSync(path, 'utf8'), original);
  });

  it('文件不存在 ⇒ 空账本，不是错误（第一次跑 RSI 的正常状态）', () => {
    const config = project();
    assert.deepEqual(readJournal(config), []);
    const r = repairJournal(config);
    assert.equal(r.truncated, false);
    assert.equal(r.linesBefore, 0);
  });
});

describe('rsi journal（CLI 契约：退出码与可执行建议）', () => {
  it('半截行 ⇒ 退出码 1 且提示修复命令；--repair 之后恢复可读', () => {
    const root = tmpProject();
    writeFileSync(join(root, 'harness.config.json'), '{}');
    const path = join(root, '.workspace', 'rsi', 'journal.jsonl');
    mkdirSync(join(root, '.workspace', 'rsi'), { recursive: true });
    writeFileSync(path, `${line('p1')}\n{"proposalId":"p2","sta`, 'utf8');

    const bad = runCli(['rsi', 'journal'], root);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /journal --repair/);

    const fixed = runCli(['rsi', 'journal', '--repair'], root);
    assert.equal(fixed.code, 0);
    assert.match(fixed.out, /已截掉半行/);

    const ok = runCli(['rsi', 'journal'], root);
    assert.equal(ok.code, 0);
    assert.match(ok.out, /共 1 条/);
  });
});
