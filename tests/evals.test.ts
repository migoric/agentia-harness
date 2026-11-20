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
    costUsd: undefined,
    costNote: 'unpriced',
    durationMs: 1,
    error: undefined,
    skills: [],
    subagents: [],
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

describe('成本 —— 从 trace 读真实 USD', () => {
  it('模型有定价时 RunOutcome.costUsd 等于各 llm.turn 的 costEstimate 之和', async () => {
    const root = project();
    // 定价表里有 claude-opus-5 —— 没配对模型时 costEstimate 恒为 undefined，
    // 那样这个测试会「因为没读数而通过」，等于什么都没测
    writeFileSync(
      join(root, 'harness.config.json'),
      JSON.stringify({ model: 'claude-opus-5' }),
      'utf8',
    );
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const runner = createRunner(config, assets, undefined, false);
    const client = scriptedClient([
      toolUse('summarize', { task: '压一下' }),
      endTurn('要点一。'),
      endTurn('结论：已给出'),
    ]);

    const out = await runner.run('压一下这段文字', { client });
    const expected =
      Math.round(
        out.trace.spans
          .filter((s) => s.kind === 'llm.turn')
          .reduce((sum, s) => sum + (s.usage?.costEstimate ?? 0), 0) * 1e6,
      ) / 1e6;

    assert.ok(expected > 0, '定价模型 + 有 usage ⇒ 必须有成本读数，否则测试前提不成立');
    assert.equal(out.costUsd, expected);
  });

  it('端点不报 usage ⇒ costUsd 是 undefined（此时上游算出来的是 0，最容易被当成免费）', async () => {
    const root = project();
    writeFileSync(
      join(root, 'harness.config.json'),
      JSON.stringify({ model: 'claude-opus-5' }),
      'utf8',
    );
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const runner = createRunner(config, assets, undefined, false);

    // 定价模型 + 「没报计量」：上游拿 0 token × 单价算出 costEstimate = 0 ——
    // 与「真的免费」同数，所以必须是 0 之外的另一个值
    const client = scriptedClient([
      {
        ...endTurn('结论：好'),
        usage: { input_tokens: 0, output_tokens: 0, unreported: true as const },
      },
    ]);
    const out = await runner.run('压一下', { client });

    assert.equal(
      out.costUsd,
      undefined,
      '「没报读数」不能落成 0 —— 那会让预算闸与成本门一起静默失效',
    );
    assert.equal(out.tokens, 0, 'token 总量此时确实是 0，与成本未知是两件事');
    assert.equal(
      out.costNote,
      'unreported',
      '病因必须记成「端点没报计量」而不是「没定价」—— 两者的补救动作完全不同',
    );

    // harness 读的是复制的字面量 `usage.missing`（该常量不在 agentia 公共导出面），
    // 上游改名后会静默「读到 0 条」⇒ 成本又变回 0。这条断言就是那个变化的探针
    const names = out.trace.spans.flatMap((s) => s.events.map((e) => e.name));
    assert.ok(
      names.includes('usage.missing'),
      `上游可能改了事件名；实际事件: ${[...new Set(names)].join(', ') || '无'}`,
    );
  });

  it('未定价模型 ⇒ costUsd 是 undefined（不是 0）', async () => {
    const root = project();
    writeFileSync(
      join(root, 'harness.config.json'),
      JSON.stringify({ model: 'not-a-priced-model' }),
      'utf8',
    );
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const runner = createRunner(config, assets, undefined, false);
    const out = await runner.run('压一下', { client: scriptedClient([endTurn('结论：好')]) });

    assert.equal(
      out.costUsd,
      undefined,
      '「不知道花了多少」与「花了 0」必须可区分，否则成本门静默失效',
    );
    assert.equal(out.costNote, 'unpriced', '这一种是配置能修的：pricing 段缺一条单价');
  });

  it('pricing 段配了单价之后，非 Anthropic 模型也有成本读数', async () => {
    const root = project();
    // 这条守的是「配置里的 pricing 真的接到了 agentia 的 priceOverrides」——
    // 只测 loadConfig 解析，接不上等于写了个没人读的字段
    writeFileSync(
      join(root, 'harness.config.json'),
      JSON.stringify({
        model: 'deepseek-flash',
        pricing: { 'deepseek-flash': { in: 0.15, out: 0.6 } },
      }),
      'utf8',
    );
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const runner = createRunner(config, assets, undefined, false);
    const out = await runner.run('压一下', { client: scriptedClient([endTurn('结论：好')]) });

    assert.equal(out.costNote, undefined, '配了单价就不该再报「没读数」');
    assert.ok(
      (out.costUsd ?? 0) > 0,
      `10 in + 5 out × ($0.15/$0.6 每 1M) 应大于 0，实际 ${String(out.costUsd)}`,
    );
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
    costUsd: undefined,
    iterations: 1,
    durationMs: 1,
    stopReason: 'end_turn',
    excerpt: '',
    skills: [],
    subagents: [],
  }));
  return summarize(cases, fp, `main@1`);
}

/** 与 report 同形，但买单记在第一条上；`costUsd` 传 undefined = 没有读数 */
function reportCost(
  results: { n: string; passed: boolean }[],
  tokens: number,
  costUsd: number | undefined,
  fp = 'A',
): EvalReport {
  const cases = results.map((r, i) => caseWith(i === 0 ? costUsd : 0, r.passed, r.n, tokens));
  return summarize(cases, fp, `main@1`);
}

function caseWith(
  costUsd: number | undefined,
  passed: boolean,
  name = 'a',
  tokens = 10,
): CaseResult {
  return {
    name,
    passed,
    failures: passed ? [] : ['x'],
    tokens,
    costUsd,
    iterations: 1,
    durationMs: 1,
    stopReason: 'end_turn',
    excerpt: '',
    skills: [],
    subagents: [],
  };
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

  it('通过率没变、成本涨超阈值 ⇒ 否决（优先级高于 token）', () => {
    const b = reportCost([{ n: 'a', passed: true }], 100, 0.02);
    const c = reportCost([{ n: 'a', passed: true }], 100, 0.03);
    const g = gate(b, c);
    assert.equal(g.ok, false);
    assert.equal(g.code, 'cost_regression');
    assert.equal(g.costBasis, 'cost');
    assert.ok(Math.abs((g.costDelta ?? 0) - 0.5) < 1e-9);
  });

  it('成本不可比时退回 token 判据（不是「没涨」）', () => {
    const b = reportCost([{ n: 'a', passed: true }], 100, undefined);
    const c = reportCost([{ n: 'a', passed: true }], 150, undefined);
    const g = gate(b, c);
    assert.equal(g.code, 'token_regression');
    assert.equal(g.costBasis, 'tokens');
    assert.equal(g.costDelta, undefined);
  });

  it('成本可比时 token 涨不否决 —— 换模型是合法提案', () => {
    const b = reportCost([{ n: 'a', passed: true }], 100, 0.02);
    const c = reportCost([{ n: 'a', passed: true }], 300, 0.02);
    const g = gate(b, c);
    assert.equal(g.ok, true, `token 涨了 200% 但成本没变，该放行（实际：${g.reason}）`);
    assert.equal(g.costBasis, 'cost');
  });

  it('只有一条用例没成本读数，整轮就不可比（总和偏低会漏判）', () => {
    const b = summarize([caseWith(0.02, true), caseWith(0.02, false)], 'A', 'main@1');
    const c = summarize([caseWith(0.03, true), caseWith(undefined, false)], 'B', 'main@1');
    assert.equal(b.costKnown, true);
    assert.equal(c.costKnown, false, '有一条没读数就不能拿总和当结论');
    assert.equal(gate(b, c).costBasis, 'tokens');
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

describe('命中统计 —— 提案选目标的数据来源', () => {
  it('summarize 按资产聚合用例，重复调用不重复计数', () => {
    const mk = (
      name: string,
      passed: boolean,
      skills: string[],
      subagents: string[],
    ): CaseResult => ({
      name,
      passed,
      failures: passed ? [] : ['x'],
      tokens: 10,
      costUsd: undefined,
      iterations: 1,
      durationMs: 1,
      stopReason: 'end_turn',
      excerpt: '',
      skills,
      subagents,
    });
    const report = summarize(
      [
        // review 在一轮里被调两次 —— 只该记成「a 走过它」
        mk('a', true, ['review', 'review'], []),
        mk('b', false, ['review', 'summary'], ['writer']),
      ],
      'F',
      'main@1',
    );
    assert.deepEqual(report.skillHits, [
      { target: 'skill:review', cases: ['a', 'b'] },
      { target: 'agent:writer', cases: ['b'] },
      { target: 'skill:summary', cases: ['b'] },
    ]);
  });

  it('没有任何命中时是空数组（不是 undefined）', () => {
    const report = summarize(
      [
        {
          name: 'a',
          passed: true,
          failures: [],
          tokens: 1,
          costUsd: undefined,
          iterations: 1,
          durationMs: 1,
          stopReason: 'end_turn',
          excerpt: '',
          skills: [],
          subagents: [],
        },
      ],
      'F',
      'main@1',
    );
    assert.deepEqual(report.skillHits, []);
  });
});
