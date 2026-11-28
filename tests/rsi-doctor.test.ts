import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runCli } from './support/cli.ts';

/**
 * `rsi doctor` —— 一条命令回答「现在能不能开跑」。
 *
 * 它存在的理由是那次排查：启动即 `rsi.gate_blocked`，人依次怀疑进程、网络、
 * 磁盘，最后才发现是「三天前的 SIGKILL 留下的锁 + 一个没回收的远程候选」——
 * 两样东西在两个文件里，而没有任何一处把它们放在一起。
 *
 * 这里的断言刻意落在**退出码**上：cron 只看得懂它。有阻塞项时非零，才有机会
 * 用「先 doctor 再开跑」写一条守门脚本。
 */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-doctor-'));
  mkdirSync(join(root, 'agents'), { recursive: true });
  mkdirSync(join(root, 'evals'), { recursive: true });
  writeFileSync(join(root, 'harness.config.json'), JSON.stringify({ model: 'claude-opus-5' }));
  writeFileSync(
    join(root, 'agents', 'main.md'),
    '---\ndescription: 主\n---\n你是执行者。\n',
    'utf8',
  );
  return root;
}

describe('rsi doctor', () => {
  it('干净工程：退出码 0，且说清可以开跑', () => {
    const r = runCli(['rsi', 'doctor'], project());
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /没有发现问题/);
    assert.match(r.out, /锁/);
    assert.match(r.out, /账本/);
  });

  it('journal 末行半截 ⇒ 退出码 1 并指向 --repair', () => {
    const root = project();
    mkdirSync(join(root, '.workspace', 'rsi'), { recursive: true });
    writeFileSync(
      join(root, '.workspace', 'rsi', 'journal.jsonl'),
      '{"proposalId":"p1","status":"accepted"}\n{"proposalId":"p2","stat',
      'utf8',
    );
    const r = runCli(['rsi', 'doctor'], root);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /journal --repair/);
  });

  it('远程候选没回收 ⇒ 退出码 1（远端可能还在用未验证的提示词）', () => {
    const root = project();
    mkdirSync(join(root, '.workspace', 'rsi'), { recursive: true });
    writeFileSync(
      join(root, '.workspace', 'rsi', 'pending.json'),
      JSON.stringify({
        schema: 1,
        proposalId: 'p9',
        target: 'agent:main',
        file: join(root, 'agents', 'main.md'),
        backup: join(root, '.workspace', 'rsi', 'pending', 'p9.bak'),
        startedAt: new Date().toISOString(),
      }),
      'utf8',
    );
    const r = runCli(['rsi', 'doctor'], root);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /p9/);
  });

  it('没配模型凭据也能跑（它回答的正是「为什么起不来」）', () => {
    const root = project();
    const r = runCli(['rsi', 'doctor'], root, { ANTHROPIC_API_KEY: undefined });
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /缺少模型凭据/);
  });
});
