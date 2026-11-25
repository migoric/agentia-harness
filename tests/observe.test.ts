import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Span, Trace } from '@migor/agentia';
import { scriptedClient } from '@migor/agentia';
import { discoverAssets } from '../src/assets/discover.ts';
import { renderComparison, renderTrace } from '../src/cli/render.ts';
import { loadConfig } from '../src/config.ts';
import { gate } from '../src/evals/gate.ts';
import { runSuite } from '../src/evals/run.ts';
import type { CaseResult, EvalReport } from '../src/evals/types.ts';
import { runCli, tmpProject } from './support/cli.ts';

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

function project(cases: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-observe-'));
  const files: Record<string, string> = {
    'agents/main.md': '---\nname: main\ndescription: 主\nmaxIterations: 4\n---\n你是执行者。\n',
    ...cases,
  };
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text, 'utf8');
  }
  return root;
}

function assetsOf(root: string) {
  const config = loadConfig(root);
  return { config, assets: discoverAssets({ skills: config.skillsDir, agents: config.agentsDir }) };
}

describe('runSuite —— 并发、超时、重试', () => {
  it('并发时结果顺序仍与用例名顺序一致（报告不该随谁先跑完而变）', async () => {
    const root = project({
      'evals/b.md': '---\nname: b\nexpect_contains: 结论\n---\n任务B\n',
      'evals/a.md': '---\nname: a\nexpect_contains: 结论\n---\n任务A\n',
    });
    const { config, assets } = assetsOf(root);
    const report = await runSuite({
      config,
      assets,
      concurrency: 2,
      client: scriptedClient([endTurn('结论：好'), endTurn('结论：好')]),
    });
    assert.deepEqual(
      report.cases.map((c) => c.name),
      ['a', 'b'],
      '顺序必须按名字排，而不是完成顺序',
    );
    assert.equal(report.passed, 2);
  });

  it('并发度给 NaN 不丢用例（非有限值按「不限制」处理，不是 0 个 worker）', async () => {
    // 这条钉的是「为什么用上游 mapWithConcurrency 而不是本地再写一份」：本地那份按
    // `Array.from({ length: Math.min(limit, n) })` 起 worker，NaN 会让 worker 数为 0 ——
    // fn 一次都不调，results 全是 undefined，整轮用例**静默消失**。上游把非正/非有限值
    // 一律当「不限制」。CLI 有 positive() 校验，所以这只影响库调用方。
    const root = project({
      'evals/a.md': '---\nname: a\nexpect_contains: 结论\n---\n任务A\n',
    });
    const { config, assets } = assetsOf(root);
    const report = await runSuite({
      config,
      assets,
      concurrency: Number.NaN,
      client: scriptedClient([endTurn('结论：好')]),
    });
    assert.equal(report.cases.length, 1, 'NaN 并发度不能让用例消失');
    assert.equal(report.passed, 1);
  });

  it('报告自带环境事实：模型、harness 版本、完成时刻、用例集指纹', async () => {
    // 没有这四项，「两份报告可比」只是个假设：换了模型 / 改了断言 / 升级了 harness
    // 都会被读成 agent 的进退步（gate 的 case_set_changed 与 sameModel 都依赖它们）
    const root = project({ 'evals/a.md': '---\nname: a\nexpect_contains: 结论\n---\n任务A\n' });
    const { config, assets } = assetsOf(root);
    const report = await runSuite({
      config,
      assets,
      client: scriptedClient([endTurn('结论：好')]),
    });
    assert.equal(typeof report.model, 'string');
    assert.ok((report.model ?? '').length > 0, '模型名不能是空串');
    // 这个字面量**故意**和 package.json 独立：被测代码若哪天改成硬编码常量、或从别处读
    // 版本，只有这里会红。代价是每次发版要一起改 —— 别为了省这一步改成读 package.json，
    // 那会让断言退化成「两处都从同一处读」的空断言。
    assert.equal(report.harnessVersion, '0.3.1', '版本号来自 package.json，不是手写常量');
    assert.ok(
      Number.isFinite(Date.parse(report.finishedAt ?? '')),
      'finishedAt 必须是可解析的时刻',
    );
    assert.match(report.caseFingerprint ?? '', /^[0-9a-f]{12}$/, '用例集指纹沿用 12 位前缀');
  });

  it('单条用例超时 ⇒ 记为该用例失败，整轮不崩', async () => {
    // 用例按名字排序执行：a-slow 先跑（拿第一步＝延迟的那步），b-fast 后跑
    const root = project({
      'evals/slow.md': '---\nname: a-slow\nexpect_contains: 结论\n---\n慢慢想\n',
      'evals/fast.md': '---\nname: b-fast\nexpect_contains: 结论\n---\n快点\n',
    });
    const { config, assets } = assetsOf(root);
    // 按请求内容决定快慢：scriptedClient 的游标跟着「成功消费」走，而超时那条的
    // 后台调用还在飞 —— 固定顺序的脚本会把两步错配给两个用例
    const respond = (
      params: unknown,
    ): Record<string, unknown> | Promise<Record<string, unknown>> =>
      JSON.stringify(params).includes('慢慢想')
        ? new Promise((r) => setTimeout(() => r(endTurn('结论：慢的')), 300))
        : endTurn('结论：快的');
    const client = scriptedClient([respond, respond, respond, respond]);
    const report = await runSuite({ config, assets, timeoutMs: 30, client });

    const slow = report.cases.find((c) => c.name === 'a-slow');
    assert.ok(slow !== undefined);
    assert.equal(slow.passed, false);
    assert.ok(
      slow.failures.some((f) => f.includes('超时')),
      `失败原因应显式说明超时，实际：${slow.failures.join(' | ')}`,
    );
    // 另一条不受牵连：超时是「这条用例失败」，不是「整轮崩掉」
    const fast = report.cases.find((c) => c.name === 'b-fast');
    assert.equal(fast?.passed, true);
  });

  it('重试只对「跑崩了」生效：第一次抛错、第二次成功 ⇒ 通过', async () => {
    const root = project({
      'evals/e1.md': '---\nname: e1\nexpect_contains: 结论\n---\n任务\n',
    });
    const { config, assets } = assetsOf(root);
    let calls = 0;
    const client = scriptedClient([
      () => {
        calls++;
        if (calls === 1) throw new Error('429 限流');
        return endTurn('结论：好了');
      },
    ]);
    const report = await runSuite({ config, assets, retries: 1, client });
    assert.equal(report.passed, 1);
    assert.equal(calls, 2, '重试过恰好一次');
  });

  it('断言失败不重试（那是结果，不是抖动）', async () => {
    const root = project({
      'evals/e1.md': '---\nname: e1\nexpect_contains: 绝对不出现\n---\n任务\n',
    });
    const { config, assets } = assetsOf(root);
    let calls = 0;
    const client = scriptedClient([
      () => {
        calls++;
        return endTurn('结论：合格');
      },
    ]);
    const report = await runSuite({ config, assets, retries: 3, client });
    assert.equal(report.passed, 0);
    assert.equal(calls, 1, '断言不通过只能跑一次，否则等于用采样掩盖问题');
  });
});

function span(p: Partial<Span> & Pick<Span, 'spanId' | 'kind' | 'name'>): Span {
  return {
    traceId: 't-1',
    parentSpanId: null,
    startedAt: 0,
    status: 'ok',
    attributes: {},
    events: [],
    ...p,
  };
}

function sampleTrace(): Trace {
  return {
    traceId: 't-abc',
    rootSpanId: 's-run',
    status: 'ok',
    totalUsage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    spans: [
      span({ spanId: 's-run', kind: 'run', name: 'main', startedAt: 0, endedAt: 120 }),
      span({
        spanId: 's-llm',
        parentSpanId: 's-run',
        kind: 'llm.turn',
        name: 'claude-opus-5',
        startedAt: 1,
        endedAt: 60,
        events: [{ time: 2, name: 'tool.input', body: { tool: 'review' } }],
      }),
      span({
        spanId: 's-cap',
        parentSpanId: 's-llm',
        kind: 'capability',
        name: 'review',
        startedAt: 3,
        endedAt: 50,
      }),
      span({
        spanId: 's-sub',
        parentSpanId: 's-run',
        kind: 'capability',
        name: 'writer',
        startedAt: 70,
        endedAt: 110,
        status: 'error',
        error: { type: 'timeout', message: '超时被放弃', retryable: true },
        attributes: {
          subagent: 'writer',
          'agentia.handoff.from': 'main',
          'agentia.handoff.to': 'writer',
        },
      }),
    ],
  };
}

describe('终端渲染', () => {
  it('trace 树按父子关系缩进，并标出事件、委派与错误', () => {
    const text = renderTrace(sampleTrace());
    assert.match(text, /trace t-abc {2}ok {2}4 span/);
    assert.match(text, /run {2}main/);
    assert.match(text, /· tool\.input/, '事件行要出现，否则看不到工具调用');
    assert.match(text, /capability {2}writer {2}ERROR/);
    assert.match(text, /main→writer/, 'handoff 两端要能一眼看到');
    assert.match(text, /— 超时被放弃/);
  });

  it('maxDepth 截断时整层折叠，不逐层刷屏', () => {
    const text = renderTrace(sampleTrace(), { maxDepth: 0 });
    assert.match(text, /还有 2 个 span/);
    assert.doesNotMatch(text, /writer/);
  });

  it('报告对比列出逐条变化与门结论', () => {
    const mk = (name: string, passed: boolean): CaseResult => ({
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
      skills: [],
      subagents: [],
    });
    const b: EvalReport = {
      total: 2,
      passed: 1,
      passRate: 0.5,
      tokens: 20,
      costUsd: 0,
      costKnown: false,
      cases: [mk('a', true), mk('b', false)],
      assetFingerprint: 'F1',
      agent: 'main@1',
      skillHits: [],
    };
    const c: EvalReport = {
      ...b,
      passed: 2,
      passRate: 1,
      cases: [mk('a', true), mk('b', true)],
      assetFingerprint: 'F2',
    };
    const text = renderComparison(b, c, gate(b, c));
    assert.match(text, /门：PASS/);
    assert.match(text, /\+ b {2}FAIL → PASS/);
    assert.match(text, /= a {2}PASS/);
  });
});

describe('harness trace / report', () => {
  it('trace <id> 读 traces.jsonl 并打印树；找不到时退出码 2', () => {
    const dir = tmpProject();
    mkdirSync(join(dir, '.workspace'), { recursive: true });
    writeFileSync(
      join(dir, '.workspace', 'traces.jsonl'),
      `${JSON.stringify(sampleTrace())}\n`,
      'utf8',
    );

    const ok = runCli(['trace', 't-a'], dir);
    assert.equal(ok.code, 0);
    assert.match(ok.out, /main→writer/);

    const miss = runCli(['trace', 'nope'], dir);
    assert.equal(miss.code, 1);
    assert.match(miss.out, /没有以 "nope" 开头/);
  });

  it('report 两份 JSON 比一次：变好退出 0，变差退出 1', () => {
    const dir = tmpProject();
    const one = (name: string, passed: boolean, fp: string): EvalReport => ({
      total: 1,
      passed: passed ? 1 : 0,
      passRate: passed ? 1 : 0,
      tokens: 100,
      costUsd: 0,
      costKnown: false,
      cases: [
        {
          name,
          task: '任务原文',
          passed,
          failures: passed ? [] : ['断言不通过'],
          tokens: 100,
          costUsd: undefined,
          iterations: 1,
          durationMs: 1,
          stopReason: 'end_turn',
          excerpt: '',
          skills: [],
          subagents: [],
        },
      ],
      assetFingerprint: fp,
      agent: 'main@1',
      skillHits: [],
    });
    writeFileSync(join(dir, 'base.json'), JSON.stringify(one('e1', false, 'A')), 'utf8');
    writeFileSync(join(dir, 'good.json'), JSON.stringify(one('e1', true, 'B')), 'utf8');
    writeFileSync(join(dir, 'bad.json'), JSON.stringify(one('e1', false, 'C')), 'utf8');

    const better = runCli(['report', 'base.json', 'good.json'], dir);
    assert.equal(better.code, 0);
    assert.match(better.out, /FAIL → PASS/);

    const worse = runCli(['report', 'good.json', 'bad.json'], dir);
    assert.equal(worse.code, 1);
    assert.match(worse.out, /门：BLOCK/);
  });

  it('report 缺参数时给用法而不是崩栈', () => {
    const dir = tmpProject();
    const r = runCli(['report', 'a.json'], dir);
    assert.equal(r.code, 2);
    assert.match(r.out, /需要两份报告/);
  });
});
