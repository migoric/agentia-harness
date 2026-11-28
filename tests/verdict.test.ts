import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gate } from '../src/evals/gate.ts';
import { summarize } from '../src/evals/report.ts';
import type { CaseResult, EvalReport } from '../src/evals/types.ts';

function sample(name: string, passed: boolean): CaseResult {
  return {
    name,
    task: '做点事',
    passed,
    failures: passed ? [] : ['正文缺少 "要点"'],
    tokens: 100,
    costUsd: 0.01,
    iterations: 1,
    durationMs: 50,
    stopReason: 'end_turn',
    excerpt: 'x',
    traceId: 'tr',
    skills: [],
    subagents: [],
  };
}

/** 同一份资产、同一份用例集的两份报告：只有结局不同 */
function report(passed: readonly boolean[], names = ['a', 'b']): EvalReport {
  const cases = names.map((n, i) => sample(n, passed[i] ?? true));
  return { ...summarize(cases, 'A', 'main@1'), caseFingerprint: 'C' };
}

describe('gate × 历史抖动', () => {
  it('不带历史 ⇒ 行为与以前逐字相同（默认路径不许被这个特性改变）', () => {
    const g = gate(report([true, true]), report([false, true]));
    assert.equal(g.code, 'case_regression');
    assert.equal(g.ok, false);
    assert.equal(g.reason, '1 条原本通过的用例变失败：a');
  });

  it('变失败的全是抖动用例 ⇒ 不否决，但给独立结论', () => {
    const g = gate(report([true, true]), report([false, true]), { flaky: new Set(['a']) });
    assert.equal(g.ok, true, '一条天生不稳的用例挂了，不能据此判退步');
    assert.equal(g.code, 'case_regression_flaky', '单独一个 code：下一步该做的是让它稳定');
    assert.deepEqual(g.regressedCases, ['a'], '事实仍然保留 —— 结论不同不等于事实没了');
    assert.match(g.reason, /历史上都不稳定/);
  });

  it('只要混着一条稳的用例变失败 ⇒ 照旧否决', () => {
    const g = gate(report([true, true]), report([false, false]), { flaky: new Set(['a']) });
    assert.equal(g.ok, false);
    assert.equal(g.code, 'case_regression');
    assert.match(g.reason, /^1 条原本通过的用例变失败：b/);
    // 被排除的那条必须写进理由：读的人要能自己复核「排除得对不对」
    assert.match(g.reason, /另有 1 条历史上不稳定，未计入：a/);
  });

  it('名单里有点别的名字不影响判定（不按名字前缀之类的模糊匹配）', () => {
    const g = gate(report([true, true]), report([false, false]), { flaky: new Set(['c']) });
    assert.equal(g.code, 'case_regression');
  });

  it('空名单 = 没有抖动知识，不是「全部抖动」', () => {
    const g = gate(report([true, true]), report([false, true]), { flaky: new Set() });
    assert.equal(g.code, 'case_regression');
    assert.equal(g.reason, '1 条原本通过的用例变失败：a');
  });

  it('抖动不影响其余判据：成本涨了照样拒', () => {
    const base = report([true, true]);
    // 逐条翻倍：门的成本判据读的是**用例级**读数，报告级的汇总数不参与比较
    const cases = base.cases.map((c) => ({ ...c, costUsd: (c.costUsd ?? 0) * 2 }));
    const cand = { ...base, ...summarize(cases, 'A', 'main@1'), caseFingerprint: 'C' };
    const g = gate(base, cand, { flaky: new Set(['a', 'b']) });
    assert.equal(g.code, 'cost_regression', '阈值判据与「用例是否可信」是两件事');
  });
});
