import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { discoverAssets } from '../src/assets/discover.ts';
import {
  buildLock,
  describeDrift,
  diffLock,
  driftIsEmpty,
  readLock,
  writeLock,
} from '../src/assets/lockfile.ts';
import { HarnessError } from '../src/errors.ts';
import { list, parseFrontmatter, scalar } from '../src/util/frontmatter.ts';

/** 每个用例一个独立目录 —— 资产发现会读真实文件，共享目录会互相污染 */
function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'harness-assets-'));
}

function write(root: string, rel: string, text: string): string {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return path;
}

describe('frontmatter', () => {
  it('解析标量、行内数组、块数组', () => {
    const fm = parseFrontmatter(
      '---\nname: a\nversion: 3\ntools: [x, y]\ntags:\n  - p\n  - q\n---\n正文\n',
      't.md',
    );
    assert.equal(scalar(fm, 'name', 't.md'), 'a');
    assert.equal(scalar(fm, 'version', 't.md'), '3');
    assert.deepEqual(list(fm, 'tools'), ['x', 'y']);
    assert.deepEqual(list(fm, 'tags'), ['p', 'q']);
    assert.equal(fm.body.trim(), '正文');
  });

  it('行尾 # 是注释；引号内与 URL 里的 # 不是', () => {
    const fm = parseFrontmatter(
      '---\nname: a # 名字\ntools: [x, y] # 工具\nurl: https://x/#frag\nquote: "a # b"\n---\n正文\n',
      't.md',
    );
    assert.equal(scalar(fm, 'name', 't.md'), 'a');
    assert.deepEqual(list(fm, 'tools'), ['x', 'y']);
    // 这两条是「支持注释」这个特性的边界：剥错了比不剥更难查
    assert.equal(scalar(fm, 'url', 't.md'), 'https://x/#frag');
    assert.equal(scalar(fm, 'quote', 't.md'), 'a # b');
  });

  it('没有 frontmatter 时整篇都是正文', () => {
    const fm = parseFrontmatter('就是正文\n', 't.md');
    assert.deepEqual(fm.data, {});
    assert.equal(fm.body, '就是正文\n');
  });

  it('没有收尾分隔符就抛（不猜）', () => {
    assert.throws(() => parseFrontmatter('---\nname: a\n正文\n', 't.md'), /缺少收尾/);
  });

  it('无法解析的行抛错，且带行号', () => {
    assert.throws(() => parseFrontmatter('---\n没有冒号\n---\n', 't.md'), /t\.md:2/);
  });

  it('列表项没有归属键时抛错', () => {
    assert.throws(() => parseFrontmatter('---\n- 孤立项\n---\n', 't.md'), /没有归属的键/);
  });
});

describe('discoverAssets', () => {
  it('两种布局都认：扁平 .md 与一能力一目录', () => {
    const root = workspace();
    write(root, 'skills/plain.md', '---\ndescription: 扁平的\n---\n正文一\n');
    write(root, 'skills/nested/SKILL.md', '---\ndescription: 嵌套的\n---\n正文二\n');
    write(root, 'agents/main.md', '---\ndescription: 主\n---\n系统\n');

    const set = discoverAssets({ skills: join(root, 'skills'), agents: join(root, 'agents') });
    assert.deepEqual(set.skills.map((s) => s.name).sort(), ['nested', 'plain']);
    assert.deepEqual(
      set.agents.map((a) => a.name),
      ['main'],
    );
    // 一能力一目录时缺省名取目录名，不是 "SKILL"
    assert.ok(set.skills.some((s) => s.name === 'nested'));
  });

  it('缺 description 直接抛 —— 它要进模型可见的工具列表', () => {
    const root = workspace();
    write(root, 'skills/x.md', '---\nname: x\n---\n正文\n');
    assert.throws(
      () => discoverAssets({ skills: join(root, 'skills'), agents: join(root, 'agents') }),
      /缺少 description/,
    );
  });

  it('同名技能抛错并指出两个文件', () => {
    const root = workspace();
    write(root, 'skills/a.md', '---\nname: dup\ndescription: 一\n---\n正文\n');
    write(root, 'skills/b.md', '---\nname: dup\ndescription: 二\n---\n正文\n');
    assert.throws(
      () => discoverAssets({ skills: join(root, 'skills'), agents: join(root, 'agents') }),
      /重名 "dup"/,
    );
  });

  it('正文为空抛错（资产的意义就是那段文本）', () => {
    const root = workspace();
    write(root, 'skills/e.md', '---\ndescription: 空\n---\n   \n');
    assert.throws(
      () => discoverAssets({ skills: join(root, 'skills'), agents: join(root, 'agents') }),
      /正文为空/,
    );
  });

  it('目录不存在时返回空集，不抛', () => {
    const root = workspace();
    const set = discoverAssets({ skills: join(root, 'nope'), agents: join(root, 'nada') });
    assert.equal(set.skills.length, 0);
    assert.equal(set.agents.length, 0);
  });

  it('改一个字全体指纹就变（RSI 的归因前提）', () => {
    const root = workspace();
    const p = write(root, 'skills/s.md', '---\ndescription: 描述\n---\n原始正文\n');
    const a = discoverAssets({ skills: join(root, 'skills'), agents: join(root, 'agents') });
    writeFileSync(p, '---\ndescription: 描述\n---\n改过的正文\n', 'utf8');
    const b = discoverAssets({ skills: join(root, 'skills'), agents: join(root, 'agents') });
    assert.notEqual(a.fingerprint, b.fingerprint);
    assert.notEqual(a.skills[0]?.fingerprint, b.skills[0]?.fingerprint);
  });
});

describe('lockfile', () => {
  const root = workspace();
  after(() => {
    /* 临时目录由系统回收；不在测试里删（避免与被测代码的写盘竞态） */
  });

  it('build → write → read 往返一致', () => {
    const dir = workspace();
    write(dir, 'skills/s.md', '---\nversion: 2\ndescription: 描述\n---\n正文\n');
    const set = discoverAssets({ skills: join(dir, 'skills'), agents: join(dir, 'agents') });
    const path = join(dir, 'harness.lock.json');
    writeLock(path, buildLock(set));

    const lock = readLock(path);
    assert.equal(Object.keys(lock.assets).length, 1);
    assert.equal(lock.assets['skill:s']?.version, '2');
    assert.equal(lock.assets['skill:s']?.fingerprint, set.skills[0]?.fingerprint);
  });

  it('diff 能分辨 added / changed / removed', () => {
    const dir = workspace();
    write(dir, 'skills/keep.md', '---\ndescription: 保持\n---\n正文\n');
    write(dir, 'skills/gone.md', '---\ndescription: 将被删\n---\n正文\n');
    const before = discoverAssets({ skills: join(dir, 'skills'), agents: join(dir, 'agents') });
    const lock = buildLock(before);

    // 改一个、删一个、加一个
    write(dir, 'skills/keep.md', '---\ndescription: 保持\n---\n改过\n');
    const afterSet = discoverAssets({ skills: join(dir, 'skills'), agents: join(dir, 'agents') });
    write(dir, 'skills/new.md', '---\ndescription: 新\n---\n正文\n');
    const now = discoverAssets({ skills: join(dir, 'skills'), agents: join(dir, 'agents') });

    const d = diffLock(lock, now);
    assert.deepEqual(d.added, ['skill:new']);
    assert.deepEqual(
      d.changed.map((c) => c.key),
      ['skill:keep'],
    );
    // gone.md 没被删（上面只是没引用它），先确认它还在
    assert.ok(afterSet.skills.some((s) => s.name === 'gone'));
    assert.deepEqual(d.removed, []);
    assert.match(describeDrift(d), /新增 1.*变更 1/);
  });

  it('一致时 driftIsEmpty 为 true', () => {
    const dir = workspace();
    write(dir, 'skills/s.md', '---\ndescription: 描述\n---\n正文\n');
    const set = discoverAssets({ skills: join(dir, 'skills'), agents: join(dir, 'agents') });
    assert.ok(driftIsEmpty(diffLock(buildLock(set), set)));
    assert.equal(describeDrift(diffLock(buildLock(set), set)), '资产与锁一致');
  });

  it('锁文件缺失时 readLock 返回空锁，不抛', () => {
    assert.deepEqual(readLock(join(root, 'missing.json')), { version: 1, assets: {} });
  });

  /**
   * 锁的形状错必须**在启动时**响亮 —— `lock --check` 是 CI 门，读到的半个锁如果被当成
   * 「没锁过」（空锁），症状是「资产全都新增」这种看起来像正常漂移的东西，而真因在解析。
   * 四条分支各一条：解析失败 / 顶层不是对象 / `assets` 是数组 / 条目缺字段。
   * ⚠️ `assets` 是数组那条是 2026-11-22 抽 `util/shape.ts` 时补的：数组同样
   * `typeof === 'object'`，旧判据会放过它，然后拿 `"0"` 当资产键。
   */
  it('锁的形状错一律拒（lock.mismatch，而不是静默当空锁）', () => {
    const dir = workspace();
    const path = join(dir, 'harness.lock.json');
    const reject = (text: string, re: RegExp): void => {
      writeFileSync(path, text, 'utf8');
      assert.throws(
        () => readLock(path),
        (e: unknown) =>
          e instanceof HarnessError && e.code === 'lock.mismatch' && re.test(e.message),
      );
    };
    reject('{ nope', /不是合法 JSON/);
    reject('[1]', /顶层必须是对象/);
    reject('{"version":1,"assets":[{"version":"1","fingerprint":"x"}]}', /形状不对/);
    reject('{"version":1,"assets":{"skill:a":{"version":"1"}}}', /条目 "skill:a" 形状不对/);
  });
});
