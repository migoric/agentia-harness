import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Span, Trace } from '@migor/agentia';
import { renderComparison } from '../src/cli/render.js';
import { gate } from '../src/evals/gate.js';
import { summarize } from '../src/evals/report.js';
import type { CaseResult } from '../src/evals/types.js';
import { menuFacts } from '../src/run/menu-read.js';

/**
 * 菜单签名 / 提示词资产版本 —— 可比性判断的另外两半。
 *
 * 这里守的是一条与 `model-read.test.ts` 同族的静默错：模型相同、用例集相同、资产指纹
 * 相同，但**菜单多了一个工具**或**换了 prompt 资产版本**时，通过率的变化会被读成
 * 「提示词改得好不好」。三个读数缺席时不能假装一致，多条用例不一致时也不能压成一个值。
 *
 * ⚠️ 夹具里的属性名**刻意写成字面量**（不 import 上游常量）：夹具是独立证人。
 * 上游改名时这里必须跟着红 —— 若夹具也引常量，改名两边一起变，这条断言就永远绿。
 */
function root(attributes: Record<string, string> = {}, spanId = 's-root'): Span {
  return {
    spanId,
    traceId: 't-1',
    parentSpanId: null,
    kind: 'run',
    name: 'main',
    startedAt: 0,
    endedAt: 100,
    status: 'ok',
    attributes,
    events: [],
  };
}

function traceOf(spans: Span[]): Trace {
  return {
    traceId: 't-1',
    rootSpanId: spans[0]?.spanId ?? 's-root',
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

describe('menuFacts —— 从 trace 读「这次的菜单与资产版本」', () => {
  it('三个根属性都读得到', () => {
    const mf = menuFacts(
      traceOf([
        root({
          'tools.menuHash': 'abc123',
          'tools.names': 'alpha,beta',
          'prompts.versions': 'style@v2',
        }),
      ]),
    );
    assert.deepEqual(mf, {
      menuHash: 'abc123',
      menuNames: 'alpha,beta',
      promptVersions: 'style@v2',
    });
  });

  it('键缺席 ⇒ 字段缺席（不是空串、不是 undefined 值）', () => {
    const mf = menuFacts(traceOf([root()]));
    assert.equal('menuHash' in mf, false);
    assert.equal('promptVersions' in mf, false);
    // 裸用例没挂工具是**合法**的「没有」，不是「不知道」—— 报告层靠字段缺席表达它
    assert.deepEqual(mf, {});
  });

  it('多轮合并后多个根说同一句话 ⇒ 取那个值', () => {
    const mf = menuFacts(
      traceOf([root({ 'tools.menuHash': 'same' }, 'r1'), root({ 'tools.menuHash': 'same' }, 'r2')]),
    );
    assert.equal(mf.menuHash, 'same');
  });

  it('多个根互相矛盾 ⇒ 缺席（这条用例内部就不一致，不能拿来判可比性）', () => {
    const mf = menuFacts(
      traceOf([
        root({ 'tools.menuHash': 'before' }, 'r1'),
        root({ 'tools.menuHash': 'after' }, 'r2'),
      ]),
    );
    assert.equal('menuHash' in mf, false);
  });

  it('子 span 上的同名属性不算 —— 只在 run 根读', () => {
    const child: Span = {
      ...root({ 'tools.menuHash': 'child-menu' }, 's-child'),
      parentSpanId: 's-root',
      kind: 'capability',
    };
    const mf = menuFacts(traceOf([root({}, 's-root'), child]));
    assert.equal('menuHash' in mf, false);
  });
});

describe('报告层的聚合：三档不压平', () => {
  const withMenu = (name: string, hash: string): CaseResult =>
    caseResult(name, { menuHash: hash, promptVersions: 'style@v1' });

  it('每条都有 ⇒ 去重排序的集合', () => {
    const r = summarize([withMenu('a', 'h2'), withMenu('b', 'h1')], 'fp', 'agent@1');
    assert.deepEqual(r.menuHashes, ['h1', 'h2']);
    assert.deepEqual(r.promptVersions, ['style@v1']);
  });

  it('一条都没有 ⇒ 空集合（确认没挂工具，不是不知道）', () => {
    const r = summarize([caseResult('a'), caseResult('b')], 'fp', 'agent@1');
    assert.deepEqual(r.menuHashes, []);
    assert.deepEqual(r.promptVersions, []);
  });

  it('有有有无 ⇒ 字段缺席（这是真缺口，不能当「一样」用）', () => {
    const r = summarize([withMenu('a', 'h1'), caseResult('b')], 'fp', 'agent@1');
    assert.equal('menuHashes' in r, false);
    assert.equal('promptVersions' in r, false);
  });
});

describe('比较视图：菜单/版本不同要出声，但**不否决**', () => {
  function compare(baseline: CaseResult[], candidate: CaseResult[]): { ok: boolean; text: string } {
    const b = summarize(baseline, 'fp', 'agent@1');
    const c = summarize(candidate, 'fp', 'agent@1');
    return { ok: gate(b, c).ok, text: renderComparison(b, c, gate(b, c)) };
  }

  it('菜单签名不同 ⇒ 打印两行读数 + 一条注意', () => {
    const { text } = compare(
      [caseResult('a', { menuHash: 'old' })],
      [caseResult('a', { menuHash: 'new' })],
    );
    assert.match(text, /菜单 {2}old → new/);
    assert.match(text, /工具菜单签名不同/);
  });

  it('提示词资产版本不同 ⇒ 归因指向资产，而不是模型', () => {
    const { text } = compare(
      [caseResult('a', { promptVersions: 'style@v1' })],
      [caseResult('a', { promptVersions: 'style@v2' })],
    );
    assert.match(text, /提示词资产版本不同/);
  });

  it('未记录 ⇒ 说「无法确认」，不说「不同」（老报告没有这两个键）', () => {
    const fresh = summarize([caseResult('a', { menuHash: 'new' })], 'fp', 'agent@1');
    // 老报告：键整个不存在 —— 与 `[]`（确认没挂工具）是两件事
    const { menuHashes: _mh, promptVersions: _pv, ...old } = fresh;
    assert.equal('menuHashes' in old, false);
    assert.equal('promptVersions' in old, false);
    const text = renderComparison(old, fresh, gate(old, fresh));
    assert.match(text, /菜单签名未记录/);
    assert.doesNotMatch(text, /工具菜单签名不同/);
  });

  it('只出声、不否决：菜单变了但通过率没变，门照样放行', () => {
    const { ok } = compare(
      [caseResult('a', { menuHash: 'old' })],
      [caseResult('a', { menuHash: 'new' })],
    );
    assert.equal(ok, true, '菜单变化不是回归 —— 否决它会把「加了个工具」判成退步');
  });
});
