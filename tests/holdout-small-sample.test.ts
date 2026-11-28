import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GateResult } from '../src/evals/gate.ts';
import { noteSmallSample } from '../src/rsi/holdout.ts';

/**
 * 小样本留出集的置信度说明。
 *
 * 实测到的形状：远程留出集只有 1 条用例时，候选几乎必被 `token_regression` 拒掉 ——
 * 不是改动真的更贵，而是**单条用例的 token 逐次波动常常就超过 10% 的阈值**。
 * 判据是对的（没变好还更贵就该拒），错的是把这条当成「改动更差」的结论。
 *
 * 所以这里只加一句说明、**不放宽阈值**：放宽会在真有大样本时放过本该拦的改动，
 * 而说清「这条置信度低」之后，人能自己去补用例。
 */

function g(code: GateResult['code'], reason = '原因'): GateResult {
  return { ok: code === 'pass', code, reason } as GateResult;
}

describe('noteSmallSample', () => {
  it('样本够（≥3 条）⇒ 一个字都不改', () => {
    const base = g('token_regression');
    assert.equal(noteSmallSample(base, 3), base);
    assert.equal(noteSmallSample(base, 10), base);
  });

  it('1 条且是 token/成本超限 ⇒ 追加置信度说明', () => {
    for (const code of ['token_regression', 'cost_regression'] as const) {
      const out = noteSmallSample(g(code), 1);
      assert.equal(out.code, code, '结论不变');
      assert.equal(out.ok, false, '也不许因为样本少就放过');
      assert.match(out.reason, /只有 1 条/);
      assert.match(out.reason, /置信度低/);
      assert.match(out.reason, /≥3 条/);
    }
  });

  it('小样本但结论不是成本类（比如用例回退）⇒ 不追加（那与样本量无关）', () => {
    for (const code of ['case_regression', 'pass_rate_dropped', 'pass'] as const) {
      const base = g(code);
      assert.equal(noteSmallSample(base, 1), base);
    }
  });
});
