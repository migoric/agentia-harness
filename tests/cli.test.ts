import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runCli as run } from './support/cli.ts';

/**
 * CLI 端到端：用真实子进程跑，断言**退出码**。
 *
 * 退出码是这个工具对 CI 的契约（`lock --check` 靠它拦「偷偷改提示词」），
 * 用函数内调用测不出「process.exitCode 有没有设对」。
 */

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'harness-cli-'));
}

describe('harness init', () => {
  it('生成可用的最小工程，且不覆盖已有文件', () => {
    const dir = tmp();
    const first = run(['init'], dir);
    assert.equal(first.code, 0, first.out);
    for (const f of [
      'harness.config.json',
      'agents/main.md',
      'skills/example/SKILL.md',
      'evals/example.md',
    ]) {
      assert.ok(existsSync(join(dir, f)), `应生成 ${f}`);
    }

    // 再跑一次：跳过而不是覆盖
    writeFileSync(join(dir, 'agents/main.md'), '---\ndescription: 改过\n---\n正文\n', 'utf8');
    const second = run(['init'], dir);
    assert.equal(second.code, 0);
    assert.match(second.out, /跳过已存在: agents\/main\.md/);
    assert.match(readFileSync(join(dir, 'agents/main.md'), 'utf8'), /改过/);
  });
});

describe('harness lock', () => {
  it('写锁后用 --check 通过；改资产后 --check 失败', () => {
    const dir = tmp();
    run(['init'], dir);

    const write = run(['lock'], dir);
    assert.equal(write.code, 0, write.out);
    assert.ok(existsSync(join(dir, 'harness.lock.json')));

    const clean = run(['lock', '--check'], dir);
    assert.equal(clean.code, 0, clean.out);
    assert.match(clean.out, /资产与锁一致/);

    // 偷偷改一个字（模拟「手改提示词没重新锁」）
    const skill = join(dir, 'skills/example/SKILL.md');
    writeFileSync(skill, `${readFileSync(skill, 'utf8')}\n多出来的一行\n`, 'utf8');

    const dirty = run(['lock', '--check'], dir);
    assert.equal(dirty.code, 1, '资产变了，--check 必须非 0');
    assert.match(dirty.out, /变更 1/);
  });
});

describe('harness eval', () => {
  it('没有用例时报错得体（退出码 1，不是栈崩）', () => {
    const dir = tmp();
    run(['init'], dir);
    // 拿掉唯一用例
    rmSync(join(dir, 'evals/example.md'));

    const r = run(['eval'], dir);
    // 2 = 配置/用法错（没评测集是工程没配好），与「跑了但没达标」的 1 分开
    assert.equal(r.code, 2);
    assert.match(r.out, /没有用例/);
    assert.doesNotMatch(r.out, /at Object\.<anonymous>/);
  });
});

describe('用法错误', () => {
  it('未知命令退出码 2 并打帮助', () => {
    const r = run(['nope'], tmp());
    assert.equal(r.code, 2);
    assert.match(r.out, /未知命令/);
  });

  it('run 缺任务描述时给出用法', () => {
    const dir = tmp();
    run(['init'], dir);
    const r = run(['run'], dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /run 需要任务描述/);
  });
});
