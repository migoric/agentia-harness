import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { isHarnessError } from '../src/errors.js';
import { applyCodePatch, revertLastCode } from '../src/rsi/code/apply.ts';
import { parsePatch } from '../src/rsi/code/diff.ts';
import { verifyInSandbox } from '../src/rsi/code/sandbox.ts';
import { readJournal } from '../src/rsi/journal.ts';

/**
 * L2 的四条承诺，每条都在这里被钉住：
 * 1. **验证零副作用** —— 沙箱里跑完，主树逐字未变（这是 RSI 敢试错的前提）；
 * 2. **不验证不落盘** —— verify 失败时 apply 必须拒绝；
 * 3. **不审批不落盘** —— 代码补丁不接受自动采纳；
 * 4. **回滚先验指纹** —— 落盘后有人动过，就拒绝自动回退。
 */

const FILE = 'calc.ts';
const ORIGINAL = 'export const sum = (a: number, b: number) => a + b;\n';

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

/** 最小 git 工程：一次提交 + 一个可改的源文件 */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-code-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'harness@test']);
  git(dir, ['config', 'user.name', 'harness']);
  writeFileSync(join(dir, FILE), ORIGINAL, 'utf8');
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n.workspace\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);
  return dir;
}

/** 把 ORIGINAL 的那一行换成 `next` 的 diff */
function diffOf(next: string): string {
  return [
    `--- a/${FILE}`,
    `+++ b/${FILE}`,
    '@@ -1 +1 @@',
    `-${ORIGINAL.trimEnd()}`,
    `+${next.trimEnd()}`,
    '',
  ].join('\n');
}

const OK = ['node', '-e', 'process.exit(0)'];
const BAD = ['node', '-e', 'process.exit(3)'];
const HANG = ['node', '-e', 'setTimeout(() => {}, 5000)'];

describe('parsePatch —— 补丁通道的唯一边界检查', () => {
  it('剥掉 a/ b/ 前缀，记录文件清单', () => {
    const p = parsePatch(diffOf('export const sum = (a: number, b: number) => a + b + 1;'));
    assert.deepEqual(p.files, [FILE]);
    assert.ok(p.diff.endsWith('\n'), 'diff 必须以换行结尾，否则 git apply 会吃掉最后一行');
  });

  it('新增文件：/dev/null 那一侧不产生路径', () => {
    const p = parsePatch(
      ['--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1 @@', '+export const x = 1;', ''].join('\n'),
    );
    assert.deepEqual(p.files, ['new.ts']);
  });

  it('空补丁 / 二进制 / 无 hunk / 路径逃逸 全部拒绝', () => {
    const bad: [string, RegExp][] = [
      ['   ', /空/],
      ['GIT binary patch\nliteral 3\nkcmZ?', /二进制/],
      ['--- a/x\n+++ b/x\n', /@@ hunk/],
      ['--- a/../../etc/passwd\n+++ b/../../etc/passwd\n@@ -1 +1 @@\n-a\n+b\n', /\.\./],
      ['--- /etc/passwd\n+++ /etc/passwd\n@@ -1 +1 @@\n-a\n+b\n', /绝对路径/],
    ];
    for (const [text, pattern] of bad) {
      assert.throws(
        () => parsePatch(text),
        (e) => isHarnessError(e) && e.code === 'code.invalid' && pattern.test(e.message),
        `应拒绝：${JSON.stringify(text.slice(0, 40))}`,
      );
    }
  });

  it('--- 之后没有 +++（diff 被截断）要报错，而不是当空操作', () => {
    assert.throws(
      () => parsePatch('--- a/x.ts\n@@ -1 +1 @@\n-a\n+b\n'),
      (e) => isHarnessError(e) && /不完整/.test(e.message),
    );
  });
});

describe('沙箱验证 —— 主树逐字不变', () => {
  it('验证通过时 ok=true，且主树文件没被碰过', async () => {
    const dir = repo();
    const patch = parsePatch(diffOf('export const sum = (a: number, b: number) => a + b + 1;'));
    const r = await verifyInSandbox({ repoRoot: dir, patch, command: OK, timeoutMs: 20_000 });

    assert.equal(r.verify.ok, true);
    assert.equal(r.verify.exitCode, 0);
    assert.equal(readFileSync(join(dir, FILE), 'utf8'), ORIGINAL, '验证阶段绝不能改主树');
    assert.equal(git(dir, ['status', '--porcelain', '--', FILE]).trim(), '');
  });

  it('验证失败时 ok=false 并带上退出码', async () => {
    const dir = repo();
    const patch = parsePatch(diffOf('export const sum = (a: number, b: number) => a + b + 1;'));
    const r = await verifyInSandbox({ repoRoot: dir, patch, command: BAD, timeoutMs: 20_000 });

    assert.equal(r.verify.ok, false);
    assert.equal(r.verify.exitCode, 3);
    assert.equal(readFileSync(join(dir, FILE), 'utf8'), ORIGINAL);
  });

  it('超时按失败记（timedOut，且没有退出码可以被误读成 0）', async () => {
    const dir = repo();
    const patch = parsePatch(diffOf('export const sum = (a: number, b: number) => a + b + 1;'));
    const r = await verifyInSandbox({ repoRoot: dir, patch, command: HANG, timeoutMs: 400 });

    assert.equal(r.verify.ok, false);
    assert.equal(r.verify.timedOut, true);
    assert.notEqual(r.verify.exitCode, 0);
  });

  it('补丁本身应用不上时立刻失败（不去跑验证命令）', async () => {
    const dir = repo();
    const stale = [
      `--- a/${FILE}`,
      `+++ b/${FILE}`,
      '@@ -1 +1 @@',
      '-export const sum = (a, b) => a + b;',
      '+export const sum = (a, b) => a + b + 1;',
      '',
    ].join('\n');
    const r = await verifyInSandbox({
      repoRoot: dir,
      patch: parsePatch(stale),
      command: OK,
      timeoutMs: 20_000,
    });

    assert.equal(r.verify.ok, false);
    assert.match(r.verify.outputTail, /补丁应用失败/);
  });

  it('沙箱能解析主仓的依赖（否则 npm test 必然假阴性）', async () => {
    const dir = repo();
    // 造一个「装了依赖」的仓库。这条测试守的是**沙箱位置**：放在仓库外面，
    // 依赖就解析不到，`npm test` 会在沙箱里以「模块找不到」失败 ——
    // 而那与补丁对错无关，假阴性比假阳性更浪费时间
    execFileSync('mkdir', ['-p', join(dir, 'node_modules', 'tiny-lib')]);
    writeFileSync(
      join(dir, 'node_modules', 'tiny-lib', 'index.js'),
      'module.exports = 42;\n',
      'utf8',
    );
    const patch = parsePatch(diffOf('export const sum = (a: number, b: number) => a + b + 1;'));
    const r = await verifyInSandbox({
      repoRoot: dir,
      patch,
      command: ['node', '-e', "require('tiny-lib')"],
      timeoutMs: 20_000,
    });

    assert.equal(r.verify.ok, true, `沙箱里解析不到主仓依赖：${r.verify.outputTail}`);
  });

  it('沙箱用完就删（不留 worktree 记录）', async () => {
    const dir = repo();
    const patch = parsePatch(diffOf('export const sum = (a: number, b: number) => a + b + 1;'));
    const r = await verifyInSandbox({ repoRoot: dir, patch, command: OK, timeoutMs: 20_000 });

    const list = git(dir, ['worktree', 'list', '--porcelain']);
    assert.ok(!list.includes(r.sandbox), `worktree 未清理：\n${list}`);
  });
});

describe('落盘与回滚', () => {
  it('没审批 ⇒ 拒绝；验证没过 ⇒ 拒绝（两种拒绝分得开）', async () => {
    const dir = repo();
    const config = loadConfig(dir);
    const patch = parsePatch(diffOf('export const sum = (a: number, b: number) => a + b + 1;'));
    const pass = await verifyInSandbox({ repoRoot: dir, patch, command: OK, timeoutMs: 20_000 });
    const fail = await verifyInSandbox({ repoRoot: dir, patch, command: BAD, timeoutMs: 20_000 });

    assert.throws(
      () =>
        applyCodePatch({
          config,
          patch,
          verify: pass.verify,
          sandbox: pass.sandbox,
          approved: false,
        }),
      (e) => isHarnessError(e) && e.code === 'code.unapproved',
    );
    assert.throws(
      () =>
        applyCodePatch({
          config,
          patch,
          verify: fail.verify,
          sandbox: fail.sandbox,
          approved: true,
        }),
      (e) => isHarnessError(e) && e.code === 'code.verify_failed',
    );
    assert.equal(readFileSync(join(dir, FILE), 'utf8'), ORIGINAL, '两条拒绝路径都不能改文件');
  });

  it('审批后落盘：文件变了、journal 有逐文件指纹、回滚能逐字恢复', async () => {
    const dir = repo();
    const config = loadConfig(dir);
    const next = 'export const sum = (a: number, b: number) => a + b + 1;';
    const patch = parsePatch(diffOf(next));
    const r = await verifyInSandbox({ repoRoot: dir, patch, command: OK, timeoutMs: 20_000 });
    const entry = applyCodePatch({
      config,
      patch,
      verify: r.verify,
      sandbox: r.sandbox,
      approved: true,
    });

    assert.equal(readFileSync(join(dir, FILE), 'utf8'), `${next}\n`);
    assert.equal(entry.kind, 'code');
    assert.equal(entry.code?.files[0]?.path, FILE);
    assert.notEqual(entry.code?.files[0]?.before, entry.code?.files[0]?.after);

    const back = revertLastCode(config);
    assert.deepEqual(back.files, [FILE]);
    assert.equal(readFileSync(join(dir, FILE), 'utf8'), ORIGINAL, '回滚必须逐字恢复');
    assert.equal(readJournal(config).filter((e) => e.kind === 'code').length, 2);
  });

  it('目标文件有未提交改动 ⇒ 拒绝落盘（不把别人的修改混进去）', async () => {
    const dir = repo();
    const config = loadConfig(dir);
    const patch = parsePatch(diffOf('export const sum = (a: number, b: number) => a + b + 1;'));
    const r = await verifyInSandbox({ repoRoot: dir, patch, command: OK, timeoutMs: 20_000 });
    // 改动写在文件末尾：不碰 hunk 的上下文，`git apply` 自己不会失败 ——
    // 只有「目标文件必须干净」这道检查能拦住它
    const dirty = `${ORIGINAL}// 本地未提交的改动\n`;
    writeFileSync(join(dir, FILE), dirty, 'utf8');

    assert.throws(
      () => applyCodePatch({ config, patch, verify: r.verify, sandbox: r.sandbox, approved: true }),
      (e) => isHarnessError(e) && e.code === 'code.conflict' && /未提交的改动/.test(e.message),
      '有本地改动时必须在落盘前拒绝，而不是让 git apply 撞上去',
    );
    assert.equal(readFileSync(join(dir, FILE), 'utf8'), dirty);
  });

  it('落盘之后有人手改 ⇒ 回滚拒绝（先验指纹）', async () => {
    const dir = repo();
    const config = loadConfig(dir);
    const next = 'export const sum = (a: number, b: number) => a + b + 1;';
    const patch = parsePatch(diffOf(next));
    const r = await verifyInSandbox({ repoRoot: dir, patch, command: OK, timeoutMs: 20_000 });
    applyCodePatch({ config, patch, verify: r.verify, sandbox: r.sandbox, approved: true });

    const edited = `${next}\n// 顺手加的一行\n`;
    writeFileSync(join(dir, FILE), edited, 'utf8');
    assert.throws(
      () => revertLastCode(config),
      (e) => isHarnessError(e) && e.code === 'code.conflict' && /被改动过/.test(e.message),
      '必须先验指纹再动手；靠 git apply -R 失败兜底等于让文件已经被改过一半',
    );
    assert.equal(
      readFileSync(join(dir, FILE), 'utf8'),
      edited,
      '拒绝时文件必须原样不动 —— 反向应用跑了一半是最坏的结果',
    );
  });

  it('回滚条目带作废标记；二次回滚报「没有可回滚」而不是撞指纹', async () => {
    const dir = repo();
    const config = loadConfig(dir);
    const patch = parsePatch(diffOf('export const sum = (a: number, b: number) => a + b + 1;'));
    const r = await verifyInSandbox({ repoRoot: dir, patch, command: OK, timeoutMs: 20_000 });
    applyCodePatch({ config, patch, verify: r.verify, sandbox: r.sandbox, approved: true });

    const back = revertLastCode(config);
    assert.equal(
      back.entry.reverted,
      true,
      '回滚条目必须带作废标记 —— 它是 liveAccepted 的判据之一',
    );

    assert.throws(
      () => revertLastCode(config),
      (e) => isHarnessError(e) && e.code === 'rsi.no_signal' && /没有可回滚/.test(e.message),
      '已回滚的补丁不能再退 —— 修复前这里会撞指纹校验报「落盘后被改动过」',
    );
    assert.equal(readFileSync(join(dir, FILE), 'utf8'), ORIGINAL, '拒绝二次回滚时文件必须原样不动');
  });

  it('新增文件的补丁：落盘后文件在，回滚后文件消失（before = null 的路径）', async () => {
    const dir = repo();
    const config = loadConfig(dir);
    const added = [
      '--- /dev/null',
      '+++ b/extra.ts',
      '@@ -0,0 +1 @@',
      '+export const x = 1;',
      '',
    ].join('\n');
    const patch = parsePatch(added);
    const r = await verifyInSandbox({ repoRoot: dir, patch, command: OK, timeoutMs: 20_000 });
    const entry = applyCodePatch({
      config,
      patch,
      verify: r.verify,
      sandbox: r.sandbox,
      approved: true,
    });

    assert.equal(entry.code?.files[0]?.before, null, '新增文件的 before 必须是 null，不是空串');
    assert.equal(readFileSync(join(dir, 'extra.ts'), 'utf8'), 'export const x = 1;\n');

    revertLastCode(config);
    assert.throws(() => readFileSync(join(dir, 'extra.ts'), 'utf8'), /ENOENT/);
  });
});
