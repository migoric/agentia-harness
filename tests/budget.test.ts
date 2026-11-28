import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HarnessError } from '../src/errors.ts';
import { Budget } from '../src/rsi/budget.ts';

/**
 * 预算闸的唯一实现。
 *
 * 这些断言守的是「静默失效」的形态，它们都不会报错，只会让闸不生效：
 * - 把「没有读数」当成 0（于是永远不超限）；
 * - 让 `--rounds` 的累计花费被漏掉（于是 N 轮花掉 N 倍预算）；
 * - 把「没设上限」与「没超」记成同一个数；
 * - **设了美元上限、但模型没定价 ⇒ 闸瞎了却继续跑**（本条是 2026-11-28 补的，
 *   旧实现把「不可信」直接判成「没超」，于是 `--max-cost` 一分钱也拦不住）。
 */

describe('Budget', () => {
  it('累加本轮花费；总花费含之前几轮，本轮不含', () => {
    const b = new Budget({ limitUsd: 10, priorUsd: 3 });
    b.charge(2, true);
    b.charge(1.5, true);
    assert.equal(b.spentUsd, 3.5);
    assert.equal(b.totalUsd, 6.5);
  });

  it('没有读数的花费把成本标成不可信（但不是免费）', () => {
    const b = new Budget({ limitUsd: 1 });
    b.charge(0.5, true);
    b.charge(undefined, false);
    assert.equal(b.costKnown, false);
    assert.equal(b.spentUsd, 0.5, '没读数不该被算成 0 或凭空增加');
  });

  it('成本不可信且没有 token 兜底 ⇒ 判 blind 停下（不再静默放行）', () => {
    const b = new Budget({ limitUsd: 0.01 });
    b.charge(100, false);
    assert.equal(b.exceeded(), true, '闸瞎了必须停，而不是判「没超」');
    assert.equal(b.stopReason(), 'blind');
    assert.equal(b.usdBlind, true);
    const snap = b.snapshot(true);
    assert.equal(snap?.stopped, true);
    assert.equal(snap?.stoppedBy, 'blind', '「闸瞎了」与「钱花完了」必须能分开');
    assert.equal(snap?.usdBlind, true);
  });

  it('成本不可信但有 token 兜底 ⇒ 继续跑（用户知道自己换的是什么）', () => {
    const b = new Budget({ limitUsd: 0.01, limitTokens: 1000 });
    b.charge(100, false, 10);
    assert.equal(b.exceeded(), false, 'token 闸还宽裕，不必因为美元读数瞎了就停');
    assert.equal(b.usdBlind, true, '但「美元闸此刻是瞎的」要如实记下来');
  });

  it('token 闸不依赖价格表：超了就停，原因是 tokens', () => {
    const b = new Budget({ limitTokens: 100 });
    b.charge(undefined, false, 60);
    assert.equal(b.exceeded(), false);
    b.charge(undefined, false, 41);
    assert.equal(b.stopReason(), 'tokens');
    assert.equal(b.snapshot(true)?.stoppedBy, 'tokens');
  });

  it('token 也跨轮累加（priorTokens）', () => {
    const b = new Budget({ limitTokens: 100, priorTokens: 90 });
    b.charge(0, true, 20);
    assert.equal(b.totalTokens, 110);
    assert.equal(b.stopReason(), 'tokens');
  });

  it('超过上限（严格大于）才算超', () => {
    const b = new Budget({ limitUsd: 1 });
    b.charge(1, true);
    assert.equal(b.exceeded(), false);
    b.charge(0.01, true);
    assert.equal(b.exceeded(), true);
    assert.equal(b.stopReason(), 'usd');
  });

  it('没设上限 ⇒ snapshot 是 undefined（「没设闸」不是「没超」）', () => {
    const b = new Budget();
    b.charge(5, true);
    assert.equal(b.snapshot(true), undefined);
    assert.equal(b.exceeded(), false);
  });

  it('负上限 / NaN / Infinity ⇒ 当场拒绝（它们都会让比较静默失效）', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => new Budget({ limitUsd: bad }),
        (e: unknown) => e instanceof HarnessError && e.code === 'config.invalid',
        `上限 ${bad} 必须被拒绝`,
      );
    }
  });

  it('token 上限必须是正整数（小数几乎总是单位写错）', () => {
    for (const bad of [0.5, -1, Number.NaN]) {
      assert.throws(
        () => new Budget({ limitTokens: bad }),
        (e: unknown) => e instanceof HarnessError && e.code === 'config.invalid',
        `token 上限 ${bad} 必须被拒绝`,
      );
    }
  });
});
