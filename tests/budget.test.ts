import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HarnessError } from '../src/errors.ts';
import { Budget } from '../src/rsi/budget.ts';

/**
 * 预算闸的唯一实现。
 *
 * 这些断言守的是「静默失效」的三种形态，它们都不会报错，只会让闸不生效：
 * - 把「没有读数」当成 0（于是永远不超限）；
 * - 让 `--rounds` 的累计花费被漏掉（于是 N 轮花掉 N 倍预算）；
 * - 把「没设上限」与「没超」记成同一个数。
 */

describe('Budget', () => {
  it('累加本轮花费；总花费含之前几轮，本轮不含', () => {
    const b = new Budget(10, 3);
    b.charge(2, true);
    b.charge(1.5, true);
    assert.equal(b.spentUsd, 3.5);
    assert.equal(b.totalUsd, 6.5);
  });

  it('没有读数的花费把成本标成不可信（但不是免费）', () => {
    const b = new Budget(1);
    b.charge(0.5, true);
    b.charge(undefined, false);
    assert.equal(b.costKnown, false);
    assert.equal(b.spentUsd, 0.5, '没读数不该被算成 0 或凭空增加');
  });

  it('成本不可信时闸不生效（拿偏低数字判超限只会误伤）', () => {
    const b = new Budget(0.01);
    b.charge(100, false);
    assert.equal(b.exceeded(), false);
    assert.equal(b.snapshot(true)?.stopped, true, '结论仍可如实记录');
  });

  it('超过上限（严格大于）才算超', () => {
    const b = new Budget(1);
    b.charge(1, true);
    assert.equal(b.exceeded(), false);
    b.charge(0.01, true);
    assert.equal(b.exceeded(), true);
  });

  it('没设上限 ⇒ snapshot 是 undefined（「没设闸」不是「没超」）', () => {
    const b = new Budget(undefined);
    b.charge(5, true);
    assert.equal(b.snapshot(true), undefined);
    assert.equal(b.exceeded(), false);
  });

  it('负上限 / NaN / Infinity ⇒ 当场拒绝（它们都会让比较静默失效）', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => new Budget(bad),
        (e: unknown) => e instanceof HarnessError && e.code === 'config.invalid',
        `上限 ${bad} 必须被拒绝`,
      );
    }
  });
});
