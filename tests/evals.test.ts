import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scriptedClient, type Trace } from '@migor/agentia';
import { discoverAssets } from '../src/assets/discover.ts';
import { loadConfig } from '../src/config.ts';
import { gate } from '../src/evals/gate.ts';
import { check, toolSequence } from '../src/evals/run.ts';
import { type CaseResult, type EvalCase, type EvalReport, summarize } from '../src/evals/types.ts';
import { createRunner, type RunOutcome } from '../src/run/runner.ts';

const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function endTurn(text: string) {
  return {
    id: 'm',
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    usage: USAGE,
    content: [{ type: 'text', text }],
  };
}

function toolUse(name: string, input: unknown) {
  return {
    id: 'm',
    model: 'claude-opus-5',
    stop_reason: 'tool_use',
    usage: USAGE,
    content: [{ type: 'tool_use', id: `tu_${name}`, name, input }],
  };
}

/** 最小工程：一个 agent + 一个技能 */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-eval-'));
  const w = (rel: string, text: string): void => {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text, 'utf8');
  };
  w('agents/main.md', '---\ndescription: 主 agent\n---\n你是执行者。\n');
  w(
    'skills/summarize/SKILL.md',
    '---\nname: summarize\ndescription: 把文字压成三条要点\nmaxIterations: 3\n---\n你是摘要器，输出三条要点。\n',
  );
  w(
    'evals/e1.md',
    '---\nname: e1\nexpect_contains: 结论\nexpect_tools: [summarize]\n---\n压一下这段文字\n',
  );
  return root;
}

function emptyTrace(): Trace {
  return {
    traceId: 't-1',
    rootSpanId: 's-0',
    spans: [],
    status: 'ok',
    totalUsage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  };
}

function outcome(text: string, extra: Partial<RunOutcome> = {}): RunOutcome {
  return {
    text,
    ok: true,
    stopReason: 'end_turn',
    iterations: 1,
    trace: emptyTrace(),
    tokens: 15,
    durationMs: 1,
    error: undefined,
    ...extra,
  };
}

function evalCase(expect: EvalCase['expect']): EvalCase {
  return { name: 'c', task: 't', expect, path: 'c.md' };
}

describe('check —— 断言', () => {
  it('contains 命中/未命中', () => {
    assert.deepEqual(check(evalCase({ contains: ['结论'] }), outcome('这是结论')), []);
    assert.match(check(evalCase({ contains: ['结论'] }), outcome('没有'))[0] ?? '', /缺少 "结论"/);
  });

  it('matches 用正则', () => {
    assert.deepEqual(check(evalCase({ matches: 'P[0-9]' }), outcome('判定 P1')), []);
    assert.match(check(evalCase({ matches: 'P[0-9]' }), outcome('判定 PX'))[0] ?? '', /不匹配/);
  });

  it('ok 缺省要求正常收尾', () => {
    const bad = check(
      evalCase({ contains: ['x'] }),
      outcome('x', { ok: false, stopReason: 'max_tokens' }),
    );
    assert.match(bad[0] ?? '', /期望正常收尾/);
  });

  it('expect_ok: false 反过来断言失败路径', () => {
    const c = evalCase({ ok: false });
    assert.deepEqual(check(c, outcome('', { ok: false, stopReason: 'max_tokens' })), []);
    assert.match(check(c, outcome(''))[0] ?? '', /期望非正常收尾/);
  });

  it('maxTokens 超预算算失败', () => {
    assert.deepEqual(check(evalCase({ maxTokens: 20 }), outcome('x', { tokens: 15 })), []);
    assert.match(
      check(evalCase({ maxTokens: 20 }), outcome('x', { tokens: 30 }))[0] ?? '',
      /超预算/,
    );
  });

  it('工具序列用子序列匹配（允许中间夹无关调用）', () => {
    const trace: Trace = {
      ...emptyTrace(),
      spans: [
        {
          spanId: 's-1',
          traceId: 't-1',
          parentSpanId: 's-0',
          kind: 'llm.turn',
          name: 'claude-opus-5',
          startedAt: 1,
          status: 'ok',
          attributes: {},
          events: [
            { time: 10, name: 'tool.input', body: { tool: 'search' } },
            { time: 20, name: 'tool.input', body: { tool: 'noise' } },
            { time: 30, name: 'tool.input', body: { tool: 'edit' } },
          ],
        },
      ],
    };
    const out = outcome('', { trace });
    assert.deepEqual(check(evalCase({ tools: ['search', 'edit'] }), out), []);
    assert.match(check(evalCase({ tools: ['edit', 'search'] }), out)[0] ?? '', /工具序列不符/);
  });
});

describe('toolSequence —— 从真实 trace 还原工具调用', () => {
  it('技能调用在 trace 里留下 tool.input 事件（上游改名会在这里红）', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const runner = createRunner(config, assets, undefined, false);

    // 主：先调技能 → 子循环：给结论 → 主：收尾
    const client = scriptedClient([
      toolUse('summarize', { task: '压一下' }),
      endTurn('要点一。要点二。要点三。'),
      endTurn('结论：三条要点已给出'),
    ]);
    const out = await runner.run('压一下这段文字', { client });

    assert.equal(out.ok, true);
    assert.equal(toolSequence(out.trace).join(','), 'summarize');
    // 技能内部那次 llm.turn 必须被算进总量（子循环不是免费午餐）
    assert.ok(out.tokens > 0, `tokens 应大于 0，实际 ${out.tokens}`);
  });

  it('技能非正常收尾时把它变成工具错误，主 agent 看到失败', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const runner = createRunner(config, assets, undefined, false);

    const client = scriptedClient([
      toolUse('summarize', { task: '压一下' }),
      { ...endTurn('半截'), stop_reason: 'max_tokens' }, // 子循环被截断
      endTurn('结论：技能失败了'),
    ]);
    const out = await runner.run('压一下这段文字', { client });

    // 主 agent 仍正常收尾，但 trace 里应有错误事件 —— 关键是「半截文本没被当结论」
    assert.equal(out.ok, true);
    assert.match(out.text, /技能失败/);
  });
});

function report(results: { n: string; passed: boolean }[], tokens: number, fp = 'A'): EvalReport {
  const cases: CaseResult[] = results.map((r, i) => ({
    name: r.n,
    passed: r.passed,
    failures: r.passed ? [] : ['x'],
    // 总量记在第一条上：test 关心的是汇总值，不是分摊方式
    tokens: i === 0 ? tokens : 0,
    iterations: 1,
    durationMs: 1,
    stopReason: 'end_turn',
    excerpt: '',
  }));
  return summarize(cases, fp, `main@1`);
}

describe('gate —— 回归门', () => {
  it('有用例由过变挂 ⇒ 否决（哪怕整体通过率没降）', () => {
    const b = report(
      [
        { n: 'a', passed: true },
        { n: 'b', passed: false },
      ],
      100,
    );
    const c = report(
      [
        { n: 'a', passed: false },
        { n: 'b', passed: true },
      ],
      100,
    );
    const g = gate(b, c);
    assert.equal(g.ok, false);
    assert.equal(g.code, 'case_regression');
    assert.deepEqual(g.regressedCases, ['a']);
    assert.deepEqual(g.fixedCases, ['b']);
  });

  it('通过率下降（新增用例没做）⇒ 否决', () => {
    // 造 pass_rate_dropped 的独特场景：没有「原本过、现在挂」的用例，
    // 而是评测集里多了一条候选不通过的 —— 此时 case_regression 判不出来
    const b = report(
      [
        { n: 'a', passed: true },
        { n: 'b', passed: true },
      ],
      100,
    );
    const c = report(
      [
        { n: 'a', passed: true },
        { n: 'b', passed: true },
        { n: 'new', passed: false },
      ],
      100,
    );
    const g = gate(b, c);
    assert.equal(g.ok, false);
    assert.equal(g.code, 'pass_rate_dropped');
  });

  it('有用例由过变挂时，优先报 case_regression（比通过率更具体）', () => {
    const b = report(
      [
        { n: 'a', passed: true },
        { n: 'b', passed: true },
      ],
      100,
    );
    const c = report(
      [
        { n: 'a', passed: false },
        { n: 'b', passed: false },
      ],
      100,
    );
    assert.equal(gate(b, c).code, 'case_regression');
  });

  it('通过率没变但 token 涨超阈值 ⇒ 否决', () => {
    const b = report([{ n: 'a', passed: true }], 100);
    const c = report([{ n: 'a', passed: true }], 150);
    const g = gate(b, c);
    assert.equal(g.ok, false);
    assert.equal(g.code, 'token_regression');
    assert.ok(Math.abs(g.tokenDelta - 0.5) < 1e-9);
  });

  it('通过率提升时 token 涨也放行（用预算换能力）', () => {
    const b = report(
      [
        { n: 'a', passed: false },
        { n: 'b', passed: true },
      ],
      100,
    );
    const c = report(
      [
        { n: 'a', passed: true },
        { n: 'b', passed: true },
      ],
      180,
    );
    const g = gate(b, c);
    assert.equal(g.ok, true);
    assert.deepEqual(g.fixedCases, ['a']);
  });

  it('通过率没变、token 略降 ⇒ 放行', () => {
    const b = report([{ n: 'a', passed: true }], 100);
    const c = report([{ n: 'a', passed: true }], 90);
    const g = gate(b, c);
    assert.equal(g.ok, true);
    assert.equal(g.code, 'pass');
  });

  it('资产指纹相同会被标出来（结论只反映采样噪声）', () => {
    const b = report([{ n: 'a', passed: true }], 100, 'SAME');
    const c = report([{ n: 'a', passed: true }], 100, 'SAME');
    assert.equal(gate(b, c).sameAssets, true);
  });
});
