import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gate } from '../src/evals/gate.ts';
import { summarize, wilsonInterval } from '../src/evals/report.ts';
import { aggregateSamples } from '../src/evals/sample.ts';
import { significance } from '../src/evals/significance.ts';
import type { CaseResult, EvalCase, EvalReport } from '../src/evals/types.ts';

const CASE: EvalCase = { name: 'a', task: '做点事', expect: {}, path: 'evals/a.md' };

function sample(passed: boolean, extra: Partial<CaseResult> = {}): CaseResult {
  return {
    name: 'a',
    task: '做点事',
    passed,
    failures: passed ? [] : ['正文缺少 "要点"'],
    tokens: 100,
    costUsd: 0.01,
    iterations: 1,
    durationMs: 50,
    stopReason: 'end_turn',
    excerpt: passed ? '好的' : '不行',
    traceId: passed ? 'tr-ok' : 'tr-bad',
    skills: [],
    subagents: [],
    ...extra,
  };
}

/** 造一份报告：每条用例给定「采了几次 / 过了几次」，与真实路径同一套汇总 */
function sampled(
  rows: readonly { readonly name: string; readonly samples: number; readonly passed: number }[],
  fp = 'A',
): EvalReport {
  const cases: CaseResult[] = rows.map((r) => ({
    ...sample(r.passed * 2 >= r.samples, { failures: [] }),
    name: r.name,
    passed: r.passed * 2 >= r.samples,
    samples: r.samples,
    passedSamples: r.passed,
  }));
  return summarize(cases, fp, 'main@1');
}

describe('aggregateSamples', () => {
  it('全过：passed 为真，样本数与通过数如实记下，token 与成本求和', () => {
    const out = aggregateSamples(CASE, [sample(true), sample(true), sample(true)]);
    assert.equal(out.passed, true);
    assert.equal(out.samples, 3);
    assert.equal(out.passedSamples, 3);
    assert.equal(out.tokens, 300, '三次真花掉的 token 必须求和');
    assert.equal(out.costUsd, 0.03, '求和，不是取平均 —— 报告要能对上账');
    assert.equal(out.durationMs, 150);
  });

  it('过半即通过：2/3 过，且不受「全过才算」的苛求', () => {
    const out = aggregateSamples(CASE, [sample(true), sample(true), sample(false)]);
    assert.equal(out.passed, true, '温度不为 0 时要求次次通过，等于把所有正常改动都拒掉');
    assert.equal(out.passedSamples, 2);
    // 证据字段取第一条失败的：诊断要看坏的那次
    assert.equal(out.excerpt, '不行');
    assert.equal(out.traceId, 'tr-bad');
  });

  it('一半一半算通过（边界），一比二算失败', () => {
    assert.equal(aggregateSamples(CASE, [sample(true), sample(false)]).passed, true);
    const out = aggregateSamples(CASE, [sample(true), sample(false), sample(false)]);
    assert.equal(out.passed, false);
    assert.equal(out.passedSamples, 1);
  });

  it('失败原因带计数，且排序固定（报告要能逐字节比对）', () => {
    const a = aggregateSamples(CASE, [
      sample(false, { failures: ['缺 A'] }),
      sample(false, { failures: ['缺 A'] }),
      sample(false, { failures: ['缺 B'] }),
    ]);
    assert.deepEqual(a.failures, ['缺 A（2/3 次）', '缺 B（1/3 次）']);

    // 同样的计数换一个采样顺序，输出必须一致
    const b = aggregateSamples(CASE, [
      sample(false, { failures: ['缺 B'] }),
      sample(false, { failures: ['缺 A'] }),
      sample(false, { failures: ['缺 A'] }),
    ]);
    assert.deepEqual(b.failures, a.failures);
  });

  it('每次都出现的失败不写计数（省掉噪声，理由本身已经完整）', () => {
    const out = aggregateSamples(CASE, [sample(false), sample(false)]);
    assert.deepEqual(out.failures, ['正文缺少 "要点"']);
  });

  it('一边有成本读数一边没有 ⇒ 整条成本未知，不是把它们加起来', () => {
    const out = aggregateSamples(CASE, [sample(true), sample(true, { costUsd: undefined })]);
    assert.equal(out.costUsd, undefined, '把缺席当 0 会让「便宜了」这种假结论进报告');
  });

  it('环境事实不一致 ⇒ 缺席，而不是取并集', () => {
    const out = aggregateSamples(CASE, [
      sample(true, { models: ['A'], menuHash: 'm1' }),
      sample(true, { models: ['B'], menuHash: 'm1' }),
    ]);
    assert.equal(out.models, undefined, '两个模型 = 这批样本环境不稳，说「用了 A 和 B」是假的可比');
    assert.equal(out.menuHash, 'm1', '一致的字段照常写出来');
  });

  it('重复次数为 1 时原样返回，一个字段都不加', () => {
    const only = sample(true);
    assert.equal(aggregateSamples(CASE, [only]), only);
  });
});

describe('wilsonInterval', () => {
  it('没有样本 ⇒ 整个区间（什么都不知道），不是 0', () => {
    assert.deepEqual(wilsonInterval(0, 0), { low: 0, high: 1 });
  });

  it('全过时下界小于 1：样本不足就不该声称「确定 100%」', () => {
    const ci = wilsonInterval(3, 3);
    assert.ok(ci.high === 1);
    assert.ok(ci.low > 0 && ci.low < 1, `下界应在 (0,1) 内，实际 ${ci.low}`);
  });

  it('全挂时上界大于 0', () => {
    const ci = wilsonInterval(0, 3);
    assert.equal(ci.low, 0);
    assert.ok(ci.high > 0 && ci.high < 1);
  });

  it('永远不越界（正态近似在这里会算出负数）', () => {
    for (const [k, n] of [
      [0, 1],
      [1, 1],
      [0, 50],
      [50, 50],
      [1, 1000],
    ] as const) {
      const ci = wilsonInterval(k, n);
      assert.ok(ci.low >= 0 && ci.high <= 1, `k=${k} n=${n} 越界: ${ci.low}~${ci.high}`);
      assert.ok(ci.low <= ci.high);
    }
  });

  it('样本越多区间越窄', () => {
    const wide = wilsonInterval(18, 20);
    const narrow = wilsonInterval(180, 200);
    assert.ok(narrow.high - narrow.low < wide.high - wide.low);
  });
});

describe('significance（单侧 z 检验）', () => {
  it('没有重复采样 ⇒ 不知道显著性，退回点估计', () => {
    const a = sampled([{ name: 'a', samples: 1, passed: 1 }]);
    const b = sampled([{ name: 'a', samples: 1, passed: 0 }]);
    assert.equal(significance(a, b, null), undefined);
  });

  it('两边采样数不同 ⇒ 拒绝计算（那是实验设计问题，不是统计问题）', () => {
    const a = sampled([{ name: 'a', samples: 2, passed: 2 }]);
    const b = sampled([{ name: 'a', samples: 3, passed: 1 }]);
    assert.equal(significance(a, b, null), undefined);
  });

  it('只比交集时不算（分母口径已经是另一件事）', () => {
    const a = sampled([{ name: 'a', samples: 3, passed: 3 }]);
    const b = sampled([{ name: 'a', samples: 3, passed: 1 }]);
    assert.equal(significance(a, b, ['a']), undefined);
  });

  it('大样本的大幅下降 ⇒ 显著', () => {
    const rows = (passed: number) =>
      Array.from({ length: 20 }, (_, i) => ({ name: `c${i}`, samples: 3, passed }));
    const a = sampled(rows(3)); // 60/60
    const b = sampled(rows(2)); // 40/60
    const sig = significance(a, b, null);
    assert.ok(sig !== undefined);
    assert.equal(sig.significant, true, `z=${sig.z} 应显著`);
  });

  it('小样本的同样比例下降 ⇒ 不显著（这正是 --repeat 要解决的问题）', () => {
    const a = sampled([{ name: 'a', samples: 3, passed: 3 }]);
    const b = sampled([{ name: 'a', samples: 3, passed: 2 }]);
    const sig = significance(a, b, null);
    assert.ok(sig !== undefined);
    assert.equal(sig.significant, false, '3 个样本分不出 100% 与 67%');
  });

  it('两边都没变 ⇒ z 为 0，不显著', () => {
    const a = sampled([{ name: 'a', samples: 3, passed: 3 }]);
    assert.equal(significance(a, a, null)?.significant, false);
  });
});

describe('gate × 重复采样', () => {
  it('不显著的下降 ⇒ 放行，但结论单独标出来（不是「没看出问题」）', () => {
    const base = sampled([
      { name: 'a', samples: 3, passed: 3 },
      { name: 'b', samples: 3, passed: 3 },
    ]);
    const cand = sampled([
      { name: 'a', samples: 3, passed: 2 },
      { name: 'b', samples: 3, passed: 3 },
    ]);
    const g = gate(base, cand);
    assert.equal(g.ok, true, '样本不足时不该否决');
    assert.equal(g.code, 'pass_rate_dropped_not_significant');
    assert.match(g.reason, /z=-?\d/);
    assert.match(g.reason, /--repeat/, '要告诉人下一条路是加大采样');
  });

  it('显著的下降 ⇒ 照旧否决，理由里带次数', () => {
    const rows = (passed: number) =>
      Array.from({ length: 20 }, (_, i) => ({ name: `c${i}`, samples: 3, passed }));
    const g = gate(sampled(rows(3)), sampled(rows(2)));
    assert.equal(g.ok, false);
    assert.equal(g.code, 'pass_rate_dropped');
  });

  it('用例由过变挂仍然硬否决（过半判定已经平滑过抖动，不再看区间）', () => {
    const base = sampled([{ name: 'a', samples: 3, passed: 3 }]);
    const cand = sampled([{ name: 'a', samples: 3, passed: 1 }]);
    const g = gate(base, cand);
    assert.equal(g.ok, false);
    assert.equal(g.code, 'case_regression');
  });

  it('没有采样信息的老报告 ⇒ 旧判据原样生效（过→挂照旧硬否决）', () => {
    const report = (passed: boolean): EvalReport =>
      summarize([{ ...sample(passed), failures: passed ? [] : ['x'] }], 'A', 'main@1');
    const g = gate(report(true), report(false));
    // 顺带记一个逻辑事实：`samples === 1` 时「通过率下降」必然先命中 `case_regression`
    // （净减一条就说明有某条从过变挂），所以 `pass_rate_dropped` 在单次采样下不可达。
    // 显著性判定要求 samples ≥ 2，正是因为它只在重复采样才可能被用到
    assert.equal(g.code, 'case_regression', '没有样本量就不该假装知道噪声');
  });

  it('采样数不同 ⇒ 不做检验，退回点估计（两边调优不一致不是统计问题）', () => {
    const base = sampled([{ name: 'a', samples: 1, passed: 1 }]);
    // 加了 --repeat 之后，同一条用例 3 次里过 2 次仍算通过（过半），但通过率从 100% 掉到 67%
    const cand = sampled([{ name: 'a', samples: 3, passed: 2 }]);
    const g = gate(base, cand);
    assert.equal(g.code, 'pass_rate_dropped', '采样数不同时给不出可比区间，只能按点估计');
  });
});

describe('summarize 的采样口径', () => {
  it('全部用例采样数一致才写 samples 与区间', () => {
    const r = sampled([
      { name: 'a', samples: 3, passed: 3 },
      { name: 'b', samples: 3, passed: 0 },
    ]);
    assert.equal(r.samples, 3);
    assert.equal(r.passRate, 0.5, '样本级微平均：3/6');
    assert.ok(r.passRateLow !== undefined && r.passRateHigh !== undefined);
  });

  it('各条采样数不一致 ⇒ 整体缺席（没有共同分母）', () => {
    const r = sampled([
      { name: 'a', samples: 3, passed: 2 },
      { name: 'b', samples: 1, passed: 1 },
    ]);
    assert.equal(r.samples, undefined);
    assert.equal(r.passRateLow, undefined);
  });

  it('采样数为 1 时通过率与用例级比值逐位相同（老口径不变）', () => {
    const r = sampled([
      { name: 'a', samples: 1, passed: 1 },
      { name: 'b', samples: 1, passed: 0 },
    ]);
    assert.equal(r.passRate, r.passed / r.total);
  });
});
