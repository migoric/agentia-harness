/**
 * 报告结构版本 + 路由准确率（ADR §7 的判据 10 / 27）。
 *
 * 两条都在防同一类失败：**读数在，含义丢了**。
 *
 * - 判据 10：老报告没有 `schemaVersion`。如果读侧把它当成「坏报告」拒读，历史上
 *   所有基线一次性作废；如果当成「v0 且字段齐全」，下次加字段就会静默读成空值。
 *   正确做法是**按 v1 读、不炸**，遇到比本进程新的版本只出声不拒读。
 * - 判据 27：路由塌缩的典型形状是「通过率不变甚至微涨，但所有请求都派给同一个 agent」。
 *   只看 passRate 的门看不出来，而意图层与成本模型会同时失效。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GateResult } from '../src/evals/gate.ts';
import { EVAL_REPORT_SCHEMA_VERSION, reportSchemaVersion, summarize } from '../src/evals/report.ts';
import type { CaseResult, EvalReport } from '../src/evals/types.ts';
import type { VerifyOutcome } from '../src/rsi/types.ts';
import { isWorthAccepting } from '../src/rsi/verify.ts';

function caseResult(over: Partial<CaseResult> & { name: string }): CaseResult {
  return {
    task: 't',
    passed: true,
    failures: [],
    tokens: 10,
    costUsd: 0.01,
    iterations: 1,
    durationMs: 5,
    stopReason: 'end_turn',
    excerpt: '',
    skills: [],
    subagents: [],
    ...over,
  };
}

function report(cases: readonly CaseResult[], over: Partial<EvalReport> = {}): EvalReport {
  return { ...summarize(cases, 'fp', 'main'), ...over };
}

function gateResult(over: Partial<GateResult> = {}): GateResult {
  return {
    ok: true,
    code: 'pass',
    reason: '无变化',
    regressedCases: [],
    fixedCases: [],
    passRateDelta: 0,
    tokenDelta: 0,
    costDelta: 0,
    costBasis: 'cost',
    sameAssets: false,
    sameCaseSet: true,
    onlyInBaseline: [],
    onlyInCandidate: [],
    sameModel: true,
    sameAgent: true,
    ...over,
  };
}

function outcome(baseline: EvalReport, candidate: EvalReport, gate: Partial<GateResult> = {}) {
  return {
    proposal: { id: 'p', target: 'skill:a', patch: { target: 'skill:a', before: 'x', after: 'y' } },
    baseline,
    candidate,
    gate: gateResult(gate),
  } as unknown as VerifyOutcome;
}

describe('报告结构版本', () => {
  it('新写的报告带当前版本号', () => {
    const r = report([caseResult({ name: 'a' })]);
    assert.equal(r.schemaVersion, EVAL_REPORT_SCHEMA_VERSION);
  });

  it('老报告（无该字段）按 v1 读，不炸', () => {
    const oldReport: { total: number; cases: never[]; schemaVersion?: unknown } = {
      total: 1,
      cases: [],
    };
    assert.equal(reportSchemaVersion(oldReport), 1);
  });

  it('坏值（0 / 负数 / 字符串 / 非整数）一律按 v1 —— 不把「坏报告」伪装成新版本', () => {
    for (const bad of [0, -1, '2', 1.5, null, undefined]) {
      assert.equal(reportSchemaVersion({ schemaVersion: bad }), 1, `对 ${String(bad)}`);
    }
    assert.equal(reportSchemaVersion({ schemaVersion: 3 }), 3);
  });
});

describe('路由准确率', () => {
  it('只在「期望与实际都有值」的用例上计分', () => {
    const r = report([
      caseResult({ name: 'a', expectRoute: 'billing', routedTo: 'billing' }),
      caseResult({ name: 'b', expectRoute: 'billing', routedTo: 'report' }),
      // 没声明期望：不进分母（否则「没测」会被算成「测错」）
      caseResult({ name: 'c', routedTo: 'report' }),
      // 声明了但执行器没采到实际值：同样不进分母
      caseResult({ name: 'd', expectRoute: 'report' }),
    ]);
    assert.equal(r.routeCases, 2);
    assert.equal(r.routeAccuracy, 0.5);
  });

  it('一条都没声明 route 时，读数缺席而不是 0', () => {
    const r = report([caseResult({ name: 'a' })]);
    assert.equal(r.routeAccuracy, undefined);
    assert.equal(r.routeCases, undefined);
  });
});

describe('采纳判据：路由不塌缩', () => {
  it('通过率涨了、但路由准确率掉了 ⇒ 不采纳', () => {
    const baseline = report([], { routeAccuracy: 0.9, routeCases: 10 });
    const candidate = report([], { routeAccuracy: 0.5, routeCases: 10 });
    assert.equal(
      isWorthAccepting(outcome(baseline, candidate, { passRateDelta: 0.1, fixedCases: ['x'] })),
      false,
    );
  });

  it('路由持平或更好时，原判据照常生效', () => {
    const baseline = report([], { routeAccuracy: 0.9, routeCases: 10 });
    const same = report([], { routeAccuracy: 0.9, routeCases: 10 });
    assert.equal(
      isWorthAccepting(outcome(baseline, same, { passRateDelta: 0.1, fixedCases: ['x'] })),
      true,
    );
    const better = report([], { routeAccuracy: 1, routeCases: 10 });
    assert.equal(
      isWorthAccepting(outcome(baseline, better, { passRateDelta: 0.1, fixedCases: ['x'] })),
      true,
    );
  });

  it('读数缺席时不做判断（不知道 ≠ 没退化）', () => {
    const baseline = report([]);
    const candidate = report([], { routeAccuracy: 0.1, routeCases: 10 });
    assert.equal(
      isWorthAccepting(outcome(baseline, candidate, { passRateDelta: 0.1, fixedCases: ['x'] })),
      true,
    );
  });
});
