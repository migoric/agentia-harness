import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { HarnessError } from '../src/errors.js';
import {
  type Fail,
  isPlainObject,
  objectAt,
  onlyKeys,
  readJsonObject,
  requiredText,
} from '../src/util/shape.js';

/**
 * `util/shape.ts` 的**直接**单测（2026-11-22 抽出时补）。
 *
 * 为什么值得单独一份：这四条判定此前在四个不可信输入口（harness.json / lock / 手写提案 /
 * 清单）各自实现，测试也只能从各自的入口**间接**打 —— 于是「锁的顶层是数组」这种分支
 * 可能从来没人走过，而它会以「读到一半才炸」或「静默当空锁」的形式出现。抽成一件之后
 * 判据与文案都能直接钉住，四个入口继续各自测它们的**语义**（错误码、定位串）。
 *
 * 错误码刻意不在本件定（`util/` 不许 import `errors.js`，见 architecture.test.ts），
 * 所以测试用同一个 `HarnessError` 走 `config.invalid` 作代表 —— 码由调用方给这件事本身
 * 由 `tests/config.test.ts` / `assets.test.ts` 的 `lock.mismatch` 断言覆盖。
 */

const fail: Fail = (message, cause) => {
  throw new HarnessError('config.invalid', message, cause);
};

/** 断言抛的是 HarnessError 且 message 命中（用 message 而不是 code：码由调用方选） */
function throwsMessage(fn: () => unknown, re: RegExp): void {
  assert.throws(fn, (e: unknown) => e instanceof HarnessError && re.test(e.message));
}

describe('isPlainObject —— 「普通对象」这一条在四个入口只有一个读法', () => {
  it('对象与类实例算，null / 数组 / 原始值不算', () => {
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject({ a: 1 }), true);
    class C {
      readonly a = 1;
    }
    assert.equal(
      isPlainObject(new C()),
      true,
      '类实例不该被误伤（JSON.parse 不会产出它，但测试夹具会用）',
    );
    assert.equal(isPlainObject(null), false);
    assert.equal(isPlainObject([]), false, '数组必须拒 —— 它 typeof 也是 object，最容易漏判');
    assert.equal(isPlainObject('x'), false);
    assert.equal(isPlainObject(1), false);
    assert.equal(isPlainObject(undefined), false);
  });
});

describe('objectAt / requiredText —— 形状与空值', () => {
  it('objectAt 给的是「定位 + 应是对象」', () => {
    assert.deepEqual(objectAt({ a: 1 }, 'x', fail), { a: 1 });
    throwsMessage(() => objectAt([], '配置字段 "pricing"', fail), /配置字段 "pricing" 应是对象/);
  });

  it('requiredText 拒非串与空白串（空白串常被当成「没填」静默放过）', () => {
    assert.equal(requiredText('ok', 'x.id', fail), 'ok');
    throwsMessage(() => requiredText('   ', 'x.id', fail), /x\.id 应是非空字符串/);
    throwsMessage(() => requiredText(1, 'x.id', fail), /x\.id 应是非空字符串/);
  });
});

describe('onlyKeys —— 未知键一律拒（拼错静默丢字段是最难查的一类）', () => {
  it('认识的键放行、空的也放行', () => {
    onlyKeys({ a: 1, b: 2 }, 'w', ['a', 'b'], fail);
    onlyKeys({}, 'w', [], fail);
  });

  it('不认识的键报「定位 + 字段名 + 白名单」——**只有一种说法**（config 与 rsi 曾各说一套）', () => {
    throwsMessage(
      () => onlyKeys({ a: 1, base_url: 'x' }, '配置字段 "endpoint"', ['a'], fail),
      /配置字段 "endpoint": 不认识的字段 "base_url"（只认 a）/,
    );
  });
});

describe('readJsonObject —— 读 / 解析 / 顶层是对象三步', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shape-'));

  it('正常对象读得回来', () => {
    const p = join(dir, 'ok.json');
    writeFileSync(p, JSON.stringify({ version: 1 }));
    assert.deepEqual(readJsonObject(p, fail), { version: 1 });
  });

  it('读不到 ⇒ 带路径（不是把 ENOENT 原样漏出去）', () => {
    throwsMessage(() => readJsonObject(join(dir, 'nope.json'), fail), /读不到 .*nope\.json/);
  });

  it('不是合法 JSON ⇒ 带路径', () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{ nope');
    throwsMessage(() => readJsonObject(p, fail), /bad\.json 不是合法 JSON/);
  });

  it('顶层是数组 / 字面量 / null ⇒ 拒（此前只有 harness.json 那条路被间接测过）', () => {
    for (const [name, text] of [
      ['arr.json', '[1,2]'],
      ['num.json', '1'],
      ['null.json', 'null'],
    ] as const) {
      const p = join(dir, name);
      writeFileSync(p, text);
      throwsMessage(() => readJsonObject(p, fail), /顶层必须是对象/);
    }
  });
});
