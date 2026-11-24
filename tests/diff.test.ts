import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { diffTraces, type Span, type Trace } from '@migor/agentia';
import { renderDiff } from '../src/cli/render.js';
import { runCli } from './support/cli.js';

/**
 * `harness diff` —— 两份 trace 差在哪。
 *
 * 守的是「归因腿」：`gate` 说得出「case 3 从通过变失败」，说不出「第 2 回合少了
 * search」。后者才是能改的东西，而它只能从两条 trace 的结构差异里读。
 */

function span(
  id: string,
  kind: Span['kind'],
  name: string,
  startedAt: number,
  extra: Partial<Span> = {},
): Span {
  return {
    spanId: id,
    traceId: 't',
    parentSpanId: 's-root',
    kind,
    name,
    startedAt,
    endedAt: startedAt + 10,
    status: 'ok',
    attributes: {},
    events: [],
    ...extra,
  };
}

function traceOf(id: string, model: string, spans: Span[], input: number): Trace {
  return {
    traceId: id,
    rootSpanId: 's-root',
    status: 'ok',
    totalUsage: {
      inputTokens: input,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    spans: [
      span('s-root', 'run', 'main', 0, {
        parentSpanId: null,
        endedAt: 100,
        attributes: { model },
      }),
      ...spans,
    ],
  };
}

const WITH_SEARCH = [
  span('s-llm', 'llm.turn', 'model-a', 1),
  span('s-cap', 'capability', 'search', 2, { parentSpanId: 's-llm' }),
];

describe('renderDiff —— 差异要能被人读成一条线索', () => {
  it('同一份 trace 比出来是「无差异」', () => {
    const a = traceOf('t-a', 'model-a', WITH_SEARCH, 10);
    const text = renderDiff(a, a, diffTraces(a, a));
    assert.match(text, /无差异/);
  });

  it('模型换了 ⇒ run 级看得见；少了一步 ⇒ span 级指名道姓', () => {
    const a = traceOf('t-a', 'model-a', WITH_SEARCH, 10);
    const b = traceOf('t-b', 'model-b', [span('s-llm', 'llm.turn', 'model-b', 1)], 30);
    const text = renderDiff(a, b, diffTraces(a, b));
    assert.match(text, /run 级/);
    assert.match(text, /attributes\.model/);
    assert.match(text, /仅 A 有：capability search/, '缺侧必须说清是哪一侧没有');
    assert.match(text, /totalUsage\.inputTokens/);
  });

  it('缺侧的 span 不写成「两侧都没值」', () => {
    const a = traceOf('t-a', 'model-a', WITH_SEARCH, 10);
    const b = traceOf('t-b', 'model-a', [], 10);
    const text = renderDiff(a, b, diffTraces(a, b));
    assert.doesNotMatch(text, /（无） → （无）/);
  });
});

function cliProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-diff-'));
  const dir = join(root, '.workspace');
  mkdirSync(dir, { recursive: true });
  const a = traceOf('t-aaa', 'model-a', WITH_SEARCH, 10);
  const b = traceOf('t-bbb', 'model-b', [span('s-llm', 'llm.turn', 'model-b', 1)], 30);
  writeFileSync(join(dir, 'traces.jsonl'), `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`, 'utf8');
  return root;
}

describe('harness diff 的 CLI 契约', () => {
  it('两条 id ⇒ 打出差异，退出码 0', () => {
    const root = cliProject();
    const r = runCli(['diff', 't-aaa', 't-bbb'], root);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^A t-aaa/m);
    assert.match(r.out, /^B t-bbb/m);
    assert.match(r.out, /仅 A 有/);
  });

  it('--json 给结构化差异（TraceDiff）', () => {
    const root = cliProject();
    const r = runCli(['diff', 't-aaa', 't-bbb', '--json'], root);
    assert.equal(r.code, 0, r.out);
    const parsed = JSON.parse(r.out) as { equal: boolean; spans: unknown[] };
    assert.equal(parsed.equal, false);
    assert.ok(parsed.spans.length > 0);
  });

  it('只给一个 id 是用法错（2），不是「结果不达标」（1）', () => {
    const root = cliProject();
    assert.equal(runCli(['diff', 't-aaa'], root).code, 2);
  });

  it('id 不存在也是用法错（2）', () => {
    const root = cliProject();
    assert.equal(runCli(['diff', 'nope-1', 'nope-2'], root).code, 2);
  });
});
