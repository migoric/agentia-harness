import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Span, Trace } from '@migor/agentia';
import { gate } from '../src/evals/gate.js';
import { summarize } from '../src/evals/report.js';
import type { CaseResult } from '../src/evals/types.js';
import { modelUsage, sameModelSet } from '../src/run/model-read.js';

/**
 * 模型事实的读取与可比性判定。
 *
 * 这里守的是**一条具体的静默错**：`EvalReport.model` 是单值，而配了 fallback 链之后
 * 一次 run 内部就可能换模型。单值判据会得出「两边都是 A ⇒ 可比」的假结论，
 * 而实际候选降级过、基线没降级 —— 通过率差异被读成 agent 的进退步。
 */

function turn(
  id: string,
  model: string,
  startedAt: number,
  extra: { status?: 'ok' | 'error'; fallback?: { from: string; errorType: string } } = {},
): Span {
  const events =
    extra.fallback === undefined
      ? []
      : [
          {
            time: startedAt,
            name: 'llm.fallback',
            body: { from: extra.fallback.from, to: model, errorType: extra.fallback.errorType },
          },
        ];
  return {
    spanId: id,
    traceId: 't-1',
    parentSpanId: 's-root',
    kind: 'llm.turn',
    name: model,
    startedAt,
    endedAt: startedAt + 1,
    status: extra.status ?? 'ok',
    attributes: {},
    events,
  };
}

function root(declared?: string): Span {
  return {
    spanId: 's-root',
    traceId: 't-1',
    parentSpanId: null,
    kind: 'run',
    name: 'main',
    startedAt: 0,
    endedAt: 100,
    status: 'ok',
    attributes: declared === undefined ? {} : { 'config.fallbacks': declared },
    events: [],
  };
}

function traceOf(spans: Span[]): Trace {
  return {
    traceId: 't-1',
    rootSpanId: 's-root',
    spans,
    status: 'ok',
    totalUsage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  };
}

function caseResult(name: string, extra: Partial<CaseResult> = {}): CaseResult {
  return {
    name,
    task: name,
    passed: true,
    failures: [],
    tokens: 10,
    costUsd: 0.001,
    iterations: 1,
    durationMs: 1,
    stopReason: 'end_turn',
    excerpt: '',
    skills: [],
    subagents: [],
    ...extra,
  };
}

describe('modelUsage —— 从 trace 读「真用了哪些模型」', () => {
  it('按首次出现顺序去重，同名回合累加次数', () => {
    const mu = modelUsage(
      traceOf([
        root(),
        turn('t1', 'model-a', 1),
        turn('t2', 'model-b', 2),
        turn('t3', 'model-a', 3),
      ]),
    );
    assert.deepEqual(mu.models, ['model-a', 'model-b']);
    assert.deepEqual(mu.turns, { 'model-a': 2, 'model-b': 1 });
  });

  it('顺序按开始时间定，不赌 spans 的容器顺序', () => {
    const mu = modelUsage(traceOf([turn('t2', 'model-b', 2), turn('t1', 'model-a', 1)]));
    assert.deepEqual(mu.models, ['model-a', 'model-b'], '先开始的模型要排在前面');
  });

  it('降级次数 = llm.fallback 事件数；声明链从根属性读', () => {
    const mu = modelUsage(
      traceOf([
        root('model-a,model-b'),
        turn('t1', 'model-a', 1, { status: 'error' }),
        turn('t2', 'model-b', 2, { fallback: { from: 'model-a', errorType: 'overloaded' } }),
      ]),
    );
    assert.equal(mu.fallbacks, 1);
    assert.deepEqual(mu.declared, ['model-a', 'model-b']);
    // 失败的那一环也算「尝试过」：它真被调用过，也可能真计过费
    assert.deepEqual(mu.models, ['model-a', 'model-b']);
  });

  it('没配 fallback 链时 declared 缺席，而不是空数组', () => {
    const mu = modelUsage(traceOf([root(), turn('t1', 'model-a', 1)]));
    assert.equal(mu.declared, undefined);
    assert.equal(mu.fallbacks, 0);
  });

  it('sameModelSet 不看顺序，但看元素', () => {
    assert.equal(sameModelSet(['a', 'b'], ['b', 'a']), true);
    assert.equal(sameModelSet(['a'], ['a', 'b']), false);
    assert.equal(sameModelSet(['a', 'b'], ['a', 'c']), false);
  });
});

describe('报告层的模型事实', () => {
  it('各用例取并集、降级次数求和', () => {
    const report = summarize(
      [
        caseResult('one', { models: ['a', 'b'], fallbackUsed: 1 }),
        caseResult('two', { models: ['b'], fallbackUsed: 0 }),
      ],
      'fp',
      'main@1',
      { model: 'a' },
    );
    assert.deepEqual(report.models, ['a', 'b']);
    assert.equal(report.fallbackUsed, 1);
  });

  it('只要有一条用例没记，报告层就整体缺席（宁可不知道，也不给假结论）', () => {
    const report = summarize(
      [
        caseResult('one', { models: ['a', 'b'], fallbackUsed: 1 }),
        caseResult('two', { stopReason: 'threw' }), // 首轮就抛，没有 trace
      ],
      'fp',
      'main@1',
    );
    assert.equal(report.models, undefined);
    assert.equal(report.fallbackUsed, undefined);
  });
});

describe('门：模型集合不同 / 发生过降级都要说出来', () => {
  const base = summarize([caseResult('c', { models: ['a'], fallbackUsed: 0 })], 'fp', 'main@1');

  it('集合不同 ⇒ sameModel false，且结论里点名两边各是什么', () => {
    const cand = summarize(
      [caseResult('c', { models: ['a', 'b'], fallbackUsed: 1 })],
      'fp',
      'main@1',
    );
    const g = gate(base, cand);
    assert.equal(g.sameModel, false);
    assert.match(g.reason, /模型集合不同（基线 a；候选 a, b）/);
    assert.match(g.reason, /降级/);
  });

  it('集合相同但一侧降级过 ⇒ 不否决，但结论里必须带这句', () => {
    const cand = summarize(
      [caseResult('c', { models: ['a', 'b'], fallbackUsed: 2 })],
      'fp',
      'main@1',
    );
    const baseBoth = summarize(
      [caseResult('c', { models: ['a', 'b'], fallbackUsed: 0 })],
      'fp',
      'main@1',
    );
    const g = gate(baseBoth, cand);
    assert.equal(g.sameModel, true);
    assert.equal(g.ok, true, '降级不是否决理由 —— 否决权只给回归与成本');
    assert.match(g.reason, /发生过模型降级（基线 0 次、候选 2 次）/);
  });

  it('老报告只有单值 model：仍能判，且按单值比', () => {
    const old = summarize([caseResult('c')], 'fp', 'main@1', { model: 'a' });
    const oldOther = summarize([caseResult('c')], 'fp', 'main@1', { model: 'b' });
    assert.equal(old.models, undefined);
    assert.equal(gate(old, oldOther).sameModel, false);
    assert.equal(gate(old, old).sameModel, true);
  });

  it('两边都没记 ⇒ sameModel 是 undefined（不知道），不是 false', () => {
    const unknown = summarize([caseResult('c')], 'fp', 'main@1');
    assert.equal(gate(unknown, unknown).sameModel, undefined);
  });
});
