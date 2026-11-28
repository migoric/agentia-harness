import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scriptedClient, type Trace } from '@migor/agentia';
import { discoverAssets } from '../src/assets/discover.ts';
import { loadConfig } from '../src/config.ts';
import { gate } from '../src/evals/gate.ts';
import { loadEvalCases } from '../src/evals/load.ts';
import { summarize } from '../src/evals/report.ts';
import { check, runSuite, toolSequence } from '../src/evals/run.ts';
import {
  type CaseResult,
  caseSetFingerprint,
  type EvalCase,
  type EvalReport,
  type ReportEnv,
} from '../src/evals/types.ts';
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

function report(
  results: { n: string; passed: boolean }[],
  tokens: number,
  fp = 'A',
  env: ReportEnv = {},
): EvalReport {
  const cases: CaseResult[] = results.map((r, i) => ({
    name: r.n,
    task: '任务原文',
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
  return summarize(cases, fp, `main@1`, env);
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
    task: '任务原文',
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

describe('用例集指纹', () => {
  const c = (name: string, contains: string, path = `evals/${name}.md`): EvalCase => ({
    name,
    task: '任务原文',
    expect: { contains: [contains] },
    path,
  });

  it('名字相同、断言不同 ⇒ 指纹不同（资产指纹看不出来这个）', () => {
    assert.notEqual(caseSetFingerprint([c('a', '三条')]), caseSetFingerprint([c('a', '三条要点')]));
  });

  it('只改文件名 ⇒ 指纹不变（判定标准没动，只是文件换了位置）', () => {
    assert.equal(
      caseSetFingerprint([c('a', 'x', 'evals/a.md')]),
      caseSetFingerprint([c('a', 'x', 'evals/01-a.md')]),
    );
  });

  it('与磁盘顺序无关（按名字排序后再算）', () => {
    assert.equal(
      caseSetFingerprint([c('a', 'x'), c('b', 'y')]),
      caseSetFingerprint([c('b', 'y'), c('a', 'x')]),
    );
  });
});

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

  it('用例集变了 ⇒ 拒绝，但理由必须是「分母变了」而不是「整体退步」', () => {
    // 造 case_set_changed 的独特场景：没有「原本过、现在挂」的用例，
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
    assert.equal(
      g.code,
      'case_set_changed',
      '结论对（拒绝）但归因要对：这是基线过期，不是提案让整体退步',
    );
    assert.deepEqual(g.onlyInCandidate, ['new']);
    assert.deepEqual(g.onlyInBaseline, []);
    // 交集内没有任何用例退步，通过率也没变 —— 这两个数必须如实反映
    assert.deepEqual(g.regressedCases, []);
    assert.equal(g.passRateDelta, 0);
    assert.match(g.reason, /用例集不一致/);
    assert.match(g.reason, /重跑基线/);
  });

  it('显式允许只比交集 ⇒ 不拒绝，结论里写明只算了同名用例', () => {
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
    const g = gate(b, c, { allowCaseSetChange: true });
    assert.equal(g.ok, true);
    assert.equal(g.code, 'pass');
    assert.equal(g.sameCaseSet, false);
    assert.match(g.reason, /只比对 2 条同名用例/);
    assert.match(g.reason, /仅候选有：new/);
  });

  it('只比交集时 token 也只在交集上算（新用例的开销不能算成「变贵」）', () => {
    // 基线：a(100) b(100)；候选：a(100) b(100) new(1000)
    // 拿总和比会得出 +500%，而同名用例一分钱没多花
    const baseCases: CaseResult[] = [
      caseWith(undefined, true, 'a', 100),
      caseWith(undefined, true, 'b', 100),
    ];
    const candCases: CaseResult[] = [
      caseWith(undefined, true, 'a', 100),
      caseWith(undefined, true, 'b', 100),
      caseWith(undefined, false, 'new', 1000),
    ];
    const b = summarize(baseCases, 'A', 'main@1');
    const c = summarize(candCases, 'A', 'main@1');
    const g = gate(b, c, { allowCaseSetChange: true });
    assert.equal(g.tokenDelta, 0, `交集 token 没变，实际算出 ${g.tokenDelta}`);
    assert.equal(c.tokens, 1200, '候选报告自己的总和仍是 1200（只是不比这一项）');
  });

  it('两份报告没有同名用例 ⇒ not_comparable（无从比较，不是「通过」）', () => {
    const b = report([{ n: 'a', passed: true }], 100);
    const c = report([{ n: 'z', passed: true }], 100);
    const g = gate(b, c, { allowCaseSetChange: true });
    assert.equal(g.ok, false);
    assert.equal(g.code, 'not_comparable');
  });

  it('用例名相同但断言被改过 ⇒ 算作用例集变了（资产指纹看不出来这个）', () => {
    const b = report([{ n: 'a', passed: true }], 100, 'A', { caseFingerprint: 'fp-old' });
    const c = report([{ n: 'a', passed: true }], 100, 'A', { caseFingerprint: 'fp-new' });
    const g = gate(b, c);
    assert.equal(g.sameCaseSet, false);
    assert.equal(g.code, 'case_set_changed');
    assert.match(g.reason, /任务或断言被改过/, '名字全同时必须说清是哪一种不一致');
    // 老报告没有指纹时只能说「不知道」，不能假装确认过
    const legacy = gate(
      report([{ n: 'a', passed: true }], 100),
      report([{ n: 'a', passed: true }], 100),
    );
    assert.equal(legacy.sameCaseSet, undefined);
    assert.equal(legacy.ok, true);
  });

  it('换模型不否决（跨模型是合法实验），但要如实标出 sameModel=false', () => {
    const b = report([{ n: 'a', passed: true }], 100, 'A', { model: 'model-x' });
    const c = report([{ n: 'a', passed: true }], 100, 'A', { model: 'model-y' });
    const g = gate(b, c);
    assert.equal(g.sameModel, false);
    assert.equal(g.ok, true, '跨模型对比本身不该被门拒绝');
    assert.equal(gate(b, c).sameAgent, true);
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
      task: '任务原文',
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
          task: '任务原文',
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

describe('用例加载 —— 断言字段拼错必须响亮', () => {
  function evalProject(header: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'harness-eval-load-'));
    mkdirSync(join(dir, 'evals'), { recursive: true });
    writeFileSync(
      join(dir, 'evals', 'c.md'),
      `---\nname: c\n${header}\n---\n\n压一下这段文字\n`,
      'utf8',
    );
    return dir;
  }

  function assertEvalError(fn: () => unknown, pattern: RegExp): void {
    assert.throws(fn, (e: unknown) => {
      const err = e as { code?: string; message?: string };
      assert.equal(err.code, 'eval.invalid', `错误码应是 eval.invalid，实际 ${String(err.code)}`);
      assert.match(err.message ?? '', pattern);
      return true;
    });
  }

  it('expect_max_token 少个 s ⇒ 拒绝，而不是静默少一道门', () => {
    const dir = evalProject('expect_contains: 结论\nexpect_max_token: 200');
    assertEvalError(() => loadEvalCases(join(dir, 'evals')), /不认识的用例字段 "expect_max_token"/);
  });

  it('expect_matches 非法正则在加载期就炸（不能等用例跑到一半才崩）', () => {
    const dir = evalProject("expect_matches: '['");
    assertEvalError(() => loadEvalCases(join(dir, 'evals')), /不是合法正则/);
  });

  it('合法断言照常读入（严格化不误伤）', () => {
    const dir = evalProject(
      'expect_contains: 结论\nexpect_tools: [a, b]\nexpect_matches: 结论.*\nexpect_ok: true\nexpect_max_tokens: 200',
    );
    const cases = loadEvalCases(join(dir, 'evals'));
    assert.equal(cases.length, 1);
    assert.deepEqual(cases[0]?.expect.contains, ['结论']);
    assert.deepEqual(cases[0]?.expect.tools, ['a', 'b']);
    assert.equal(cases[0]?.expect.maxTokens, 200);
  });
});

describe('trace 留证 —— 评测默认不落盘，--keep-traces 才落', () => {
  it('缺省不写 traces.jsonl；keepTraces 后写并把 traceId 记进报告', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });

    const plain = await runSuite({
      config,
      assets,
      client: scriptedClient([endTurn('结论：合格')]),
    });
    assert.equal(existsSync(config.tracesPath), false, '评测跑几十次不该把 trace 撑爆');
    assert.equal(plain.cases.length, 1);

    const kept = await runSuite({
      config,
      assets,
      keepTraces: true,
      client: scriptedClient([endTurn('结论：合格')]),
    });
    assert.equal(existsSync(config.tracesPath), true);
    const id = kept.cases[0]?.traceId;
    assert.ok(id !== undefined && id.length > 0, '报告要给出可回查的 traceId');
    const traces = readFileSync(config.tracesPath, 'utf8');
    assert.match(traces, new RegExp(id as string));
  });
});

describe('新断言 —— 结果与过程两侧都要咬得住', () => {
  function tracedOutcome(): ReturnType<typeof outcome> {
    const trace: Trace = {
      ...emptyTrace(),
      spans: [
        {
          spanId: 's-1',
          traceId: 't-1',
          parentSpanId: 's-0',
          kind: 'llm.turn',
          name: 'm',
          startedAt: 1,
          status: 'ok',
          attributes: {},
          events: [
            {
              time: 10,
              name: 'tool.input',
              body: { tool: 'search', input: '{"query":"foo.c"}' },
            },
            { time: 20, name: 'tool.input', body: { tool: 'search', input: '{"query":"bar.c"}' } },
            { time: 30, name: 'tool.input', body: { tool: 'edit', input: '{"path":"foo.c"}' } },
          ],
        },
      ],
    };
    return outcome('结论：没问题', { trace, skills: ['summarize'], iterations: 3 });
  }

  it('notContains：命中/未命中', () => {
    assert.deepEqual(check(evalCase({ notContains: ['TODO'] }), tracedOutcome()), []);
    assert.match(
      check(evalCase({ notContains: ['结论'] }), tracedOutcome())[0] ?? '',
      /不该出现 "结论"/,
    );
  });

  it('skills：命中/未命中', () => {
    assert.deepEqual(check(evalCase({ skills: ['summarize'] }), tracedOutcome()), []);
    assert.match(check(evalCase({ skills: ['review'] }), tracedOutcome())[0] ?? '', /命中技能/);
  });

  it('maxIterations：命中/未命中', () => {
    assert.deepEqual(check(evalCase({ maxIterations: 3 }), tracedOutcome()), []);
    assert.match(check(evalCase({ maxIterations: 2 }), tracedOutcome())[0] ?? '', /轮数超预算/);
  });

  it('toolCounts 是**精确**次数，与 tools 的子序列语义刻意不同', () => {
    assert.deepEqual(
      check(evalCase({ toolCounts: { search: 2, edit: 1, review: 0 } }), tracedOutcome()),
      [],
    );
    const bad = check(evalCase({ toolCounts: { search: 1, edit: 1 } }), tracedOutcome());
    assert.equal(bad.length, 1);
    assert.match(bad[0] ?? '', /"search" 调用 2 次，期望恰好 1 次/);
  });

  it('toolArgs 从真实入参文本里找子串', () => {
    assert.deepEqual(
      check(evalCase({ toolArgs: [{ tool: 'search', substring: 'foo.c' }] }), tracedOutcome()),
      [],
    );
    const bad = check(
      evalCase({ toolArgs: [{ tool: 'search', substring: 'missing.c' }] }),
      tracedOutcome(),
    );
    assert.match(bad[0] ?? '', /入参里没有 "missing.c"/);
    // 工具名对不上也不算命中 —— 防止「任何工具的入参里有这个串」的假阳性
    assert.equal(
      check(evalCase({ toolArgs: [{ tool: 'nope', substring: 'foo.c' }] }), tracedOutcome()).length,
      1,
    );
  });

  it('真实 trace 上次数与参数都能读到（上游改事件名会在这里红）', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const runner = createRunner(config, assets, undefined, false);
    const out = await runner.run('压一下这段文字', {
      client: scriptedClient([
        toolUse('summarize', { task: '压一下' }),
        endTurn('三条要点'),
        endTurn('结论：三条'),
      ]),
    });
    assert.deepEqual(
      check(
        evalCase({
          toolCounts: { summarize: 1 },
          toolArgs: [{ tool: 'summarize', substring: '压一下' }],
        }),
        out,
      ),
      [],
    );
  });
});

describe('新断言的加载期校验', () => {
  function withHeader(header: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'harness-eval-new-'));
    mkdirSync(join(dir, 'evals'), { recursive: true });
    writeFileSync(
      join(dir, 'evals', 'c.md'),
      `---\nname: c\n${header}\n---\n\n压一下这段文字\n`,
      'utf8',
    );
    return dir;
  }

  const cases: readonly [string, RegExp][] = [
    ['expect_tool_counts: [read:0]', /正整数/],
    ['expect_tool_counts: [read:x]', /正整数/],
    ['expect_tool_counts: [read:1, read:2]', /重复声明/],
    ['expect_tool_counts: [read]', /格式不对/],
    ['expect_tool_args: [read:]', /格式不对/],
    ['expect_max_iterations: -1', /应为正数/],
    ['expect_contains: x\nexpect_not_contains: x', /同时出现/],
  ];

  for (const [header, pattern] of cases) {
    it(`拒绝非法输入: ${header}`, () => {
      const dir = withHeader(header);
      assert.throws(
        () => loadEvalCases(join(dir, 'evals')),
        (e: unknown) => {
          const err = e as { code?: string; message?: string };
          assert.equal(err.code, 'eval.invalid');
          assert.match(err.message ?? '', pattern);
          return true;
        },
      );
    });
  }

  it('全部合法写法可以一起加载', () => {
    const dir = withHeader(
      [
        'expect_contains: 结论',
        'expect_not_contains: TODO',
        'expect_skills: [summarize]',
        'expect_tool_counts: [search:2, edit:1]',
        'expect_tool_args: [search:foo.c]',
        'expect_max_iterations: 5',
      ].join('\n'),
    );
    const loaded = loadEvalCases(join(dir, 'evals'));
    assert.equal(loaded.length, 1);
    assert.deepEqual(loaded[0]?.expect.toolCounts, { search: 2, edit: 1 });
    assert.deepEqual(loaded[0]?.expect.toolArgs, [{ tool: 'search', substring: 'foo.c' }]);
  });
});

describe('route —— 期望派遣写进用例，实际承接写进报告', () => {
  it('frontmatter 的 route 读进用例；不写就是真的没有', () => {
    const root = project();
    writeFileSync(
      join(root, 'evals/e2.md'),
      '---\nname: e2\nroute: reviewer\nexpect_contains: 结论\n---\n看看这段\n',
      'utf8',
    );
    const cases = loadEvalCases(join(root, 'evals'));
    assert.equal(
      cases.find((c) => c.name === 'e2')?.route,
      'reviewer',
      'route 在类型里存在却读不进来，是「数据面缺席」而不是「没测」',
    );
    // 缺席与「派给默认 agent」是两件事：前者让这条用例不进 routeAccuracy 的分母
    assert.equal(cases.find((c) => c.name === 'e1')?.route, undefined);
  });

  it('route 写多值直接拒绝 —— 「算半分」和「算失败」都能自圆其说，所以都不选', () => {
    const root = project();
    writeFileSync(
      join(root, 'evals/bad.md'),
      '---\nname: bad\nroute: a, b\nexpect_contains: x\n---\nhi\n',
      'utf8',
    );
    assert.throws(() => loadEvalCases(join(root, 'evals')), /route 只能是一个 agent 名/);
  });

  it('runSuite 把实际承接者写进 routedTo，并算出 routeAccuracy', async () => {
    const root = project();
    writeFileSync(
      join(root, 'evals/e1.md'),
      '---\nname: e1\nroute: main\nexpect_contains: 结论\n---\n压一下这段文字\n',
      'utf8',
    );
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const r = await runSuite({
      config,
      assets,
      client: scriptedClient([endTurn('结论：合格')]),
    });
    assert.equal(r.cases[0]?.routedTo, 'main');
    assert.equal(r.routeAccuracy, 1);
    assert.equal(r.routeCases, 1);
  });

  it('派错人时通过率照样 100%，但 routeAccuracy 掉到 0 —— 这正是分开两个读数的理由', async () => {
    const root = project();
    writeFileSync(
      join(root, 'evals/e1.md'),
      '---\nname: e1\nroute: reviewer\nexpect_contains: 结论\n---\n压一下这段文字\n',
      'utf8',
    );
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const r = await runSuite({
      config,
      assets,
      client: scriptedClient([endTurn('结论：合格')]),
    });
    assert.equal(r.passRate, 1, '回答是对的');
    assert.equal(r.cases[0]?.routedTo, 'main', '但接活的是 main');
    assert.equal(r.routeAccuracy, 0, '路由塌缩只有这个读数看得见');
    assert.equal(r.routeCases, 1);
  });
});
