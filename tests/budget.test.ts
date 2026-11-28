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
    b.charge(undefined, false);
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
    // 未定价模型的真实形态：端点没报美元读数（不是「报了个不可信的大数」）
    b.charge(undefined, false, 10);
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

  /**
   * 余额对账 —— 未定价模型的出路。
   *
   * 上一组断言把「读不出成本」判成 `blind` 停机，那是**没有别的读数**时的正确行为。
   * 有余额盘时同一件事的答案变了：账单本身就是一个与单价无关的读数。但它是**下界**
   * （结算滞后 + 余额只有两位小数），所以口径是「能判超、不能判准」。
   */
  describe('reconcile（余额对账）', () => {
    it('下界消掉 blind：有账单就不再是「完全没有读数」', () => {
      const b = new Budget({ limitUsd: 10 });
      b.charge(undefined, false);
      assert.equal(b.stopReason(), 'blind');

      b.reconcile(2);
      assert.equal(b.exceeded(), false, '下界没超 ⇒ 继续跑（不再盲目停机）');
      assert.equal(b.usdBlind, false);
      assert.equal(b.billed, true);
      assert.equal(b.costKnown, false, '下界不是精确值，costKnown 必须仍是 false');
    });

    it('下界已超 ⇒ 判 usd（真实花费只会更多，这是充分条件）', () => {
      const b = new Budget({ limitUsd: 1 });
      b.charge(undefined, false);
      b.reconcile(1.5);
      assert.equal(b.stopReason(), 'usd');
    });

    it('小额花费读不出来时不能把已知花费抹成 0（真机踩到过）', () => {
      // 账户余额只显示两位小数：一次约 $0.002 的花费读出的差值是 0
      const b = new Budget({ limitUsd: 10 });
      b.charge(0.02, false);
      b.reconcile(0);
      assert.equal(b.spentUsd, 0.02, '只上推不下压 —— 覆盖会让闸看起来花得更少');
    });

    it('是上推不是累加：第二次读数不会把花费算两遍', () => {
      const b = new Budget({ limitUsd: 10 });
      b.reconcile(0.5);
      b.reconcile(0.8);
      assert.equal(b.spentUsd, 0.8, '累计量重复累加会让闸提前停，症状像「模型涨价了」');
    });

    it('负数 / NaN 一律不采纳（那会把 spent 往下拉，闸从此不超）', () => {
      const b = new Budget({ limitUsd: 1 });
      b.charge(0.5, true);
      b.reconcile(-2);
      b.reconcile(Number.NaN);
      assert.equal(b.spentUsd, 0.5);
    });

    it('对账只动本轮，不动 --rounds 的累计', () => {
      const b = new Budget({ limitUsd: 10, priorUsd: 4 });
      b.reconcile(1);
      assert.equal(b.spentUsd, 1);
      assert.equal(b.totalUsd, 5);
    });
  });
});
