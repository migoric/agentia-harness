import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scriptedClient, type Trace } from '@migor/agentia';
import { discoverAssets } from '../src/assets/discover.ts';
import { loadConfig } from '../src/config.ts';
import { harvestCase } from '../src/evals/harvest.ts';
import { loadEvalCases } from '../src/evals/load.ts';
import { runSuite } from '../src/evals/run.ts';
import { runCli } from './support/cli.ts';

const TRACE_ID = 'abc12345-dead-beef-0000-000000000001';

function trace(): Trace {
  return {
    traceId: TRACE_ID,
    rootSpanId: 's0',
    status: 'error',
    spans: [
      {
        spanId: 's0',
        traceId: TRACE_ID,
        parentSpanId: null,
        kind: 'run',
        name: 'harness',
        startedAt: 1,
        status: 'error',
        attributes: { stop_reason: 'max_tokens' },
        events: [],
      },
      {
        spanId: 's1',
        traceId: TRACE_ID,
        parentSpanId: 's0',
        kind: 'llm.turn',
        name: 'deepseek-flash',
        startedAt: 2,
        status: 'ok',
        attributes: {},
        events: [
          { time: 3, name: 'tool.input', body: { tool: 'search', input: '{"q":"foo.c"}' } },
          { time: 4, name: 'tool.input', body: { tool: 'search', input: '{"q":"bar.c"}' } },
        ],
      },
      {
        spanId: 's2',
        traceId: TRACE_ID,
        parentSpanId: 's0',
        kind: 'capability',
        name: 'summarize',
        startedAt: 5,
        status: 'ok',
        attributes: {},
        events: [],
      },
    ],
    totalUsage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  };
}

/** 一个能被 CLI 直接用的工程：有资产、有一条落盘 trace（报告由 realEval 真实生成） */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'harvest-'));
  const w = (rel: string, text: string): void => {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text, 'utf8');
  };
  w('agents/main.md', '---\ndescription: 主\n---\n你是执行者。\n');
  w('skills/summarize/SKILL.md', '---\nname: summarize\ndescription: 摘要\n---\n压成三条。\n');
  w('evals/existing.md', '---\nname: existing\nexpect_ok: true\n---\n原来的任务\n');
  w('.workspace/traces.jsonl', `${JSON.stringify(trace())}\n`);
  return root;
}

/**
 * 真跑一遍 eval 来产出报告 —— **不能手写 `task` 字段**。
 *
 * 之前的夹具往报告里塞了一个生产代码从不写入的 `task`，于是 `--from-report`
 * 在测试里绿、在真实报告上 100% 失败（review 抓到的）。现在报告来自 runSuite，
 * 顺带保证 `CaseResult.task` 这个契约真的存在。
 */
async function realEval(dir: string): Promise<string> {
  const config = loadConfig(dir);
  const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
  const report = await runSuite({
    config,
    assets,
    keepTraces: true,
    client: scriptedClient([
      {
        id: 'm',
        model: 'm',
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        content: [{ type: 'text', text: '结论：合格' }],
      },
    ]),
  });
  const traceId = report.cases[0]?.traceId;
  assert.ok(traceId !== undefined && traceId !== '');
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return traceId;
}

describe('harvestCase —— 纯函数', () => {
  it('生成的 md 能被 loadEvalCases 直接加载，注释不污染断言', () => {
    const made = harvestCase(trace(), '把这段话压成三条要点\n保留关键数字', {
      skillNames: new Set(['summarize']),
    });
    assert.equal(made.name, 'harvest-abc12345-dea');
    assert.match(made.text, /expect_ok: true/);
    assert.match(made.text, /status=error/);
    assert.match(made.text, /工具=search\(2\)/);
    assert.match(made.text, /技能=summarize/);
    assert.match(made.summary, /stop=max_tokens/);

    const dir = mkdtempSync(join(tmpdir(), 'harvest-md-'));
    writeFileSync(join(dir, `${made.name}.md`), made.text, 'utf8');
    const loaded = loadEvalCases(dir);
    assert.equal(loaded.length, 1);
    assert.deepEqual(loaded[0]?.expect, { ok: true });
    assert.equal(loaded[0]?.task, '把这段话压成三条要点\n保留关键数字');
  });

  it('没有技能名集合时不猜（把子 agent 当技能是最难发现的错）', () => {
    const made = harvestCase(trace(), '某任务');
    assert.doesNotMatch(made.text, /技能=/);
  });

  it('空任务与非法用例名当场拒绝', () => {
    assert.throws(() => harvestCase(trace(), '   '), /非空任务/);
    assert.throws(() => harvestCase(trace(), '任务', { name: '../evil' }), /非法字符/);
  });
});

describe('harness harvest —— 子进程', () => {
  it('--from-report 反查真实报告里的任务原文，生成可加载的用例', async () => {
    const dir = project();
    // 报告由真实 runSuite 产出；traceId 也取自它，才能证明是按 id 反查而不是碰巧
    const traceId = await realEval(dir);
    const r = runCli(['harvest', traceId, '--from-report', 'report.json'], dir);
    assert.equal(r.code, 0, `${r.out}\n报告里的 traceId=${traceId}`);

    const config = loadConfig(dir);
    const made = readdirSync(config.evalsDir).filter((f) => f.startsWith('harvest-'));
    assert.equal(made.length, 1, r.out);
    const text = readFileSync(join(config.evalsDir, made[0] as string), 'utf8');
    // existing.md 的任务原文就是「原来的任务」，生产报告必须把它带回来
    assert.match(text, /原来的任务/);
    assert.equal(loadEvalCases(config.evalsDir).length, 2, '不能覆盖已有用例');
  });

  it('--task 直接给任务也可以（没有评估报告时）', () => {
    const dir = project();
    const r = runCli(['harvest', TRACE_ID, '--task', '直接给的任务'], dir);
    assert.equal(r.code, 0, r.out);
    assert.match(
      readFileSync(join(dir, 'evals', 'harvest-abc12345-dea.md'), 'utf8'),
      /直接给的任务/,
    );
  });

  it('不覆盖已有用例文件', () => {
    const dir = project();
    const first = runCli(['harvest', TRACE_ID, '--task', '任务 A'], dir);
    assert.equal(first.code, 0, first.out);
    const second = runCli(['harvest', TRACE_ID, '--task', '任务 B'], dir);
    assert.equal(second.code, 2, second.out);
    assert.match(second.out, /拒绝生成同名用例/);
    assert.match(readFileSync(join(dir, 'evals', 'harvest-abc12345-dea.md'), 'utf8'), /任务 A/);
  });

  it('没有任务来源 / 两种都给 / 前缀歧义 —— 都拒绝', () => {
    const dir = project();
    const none = runCli(['harvest', TRACE_ID], dir);
    assert.equal(none.code, 2, none.out);
    assert.match(none.out, /--task/);

    const both = runCli(['harvest', TRACE_ID, '--task', 'x', '--from-report', 'report.json'], dir);
    assert.equal(both.code, 2, both.out);
    assert.match(both.out, /只接受一种任务来源/);

    // 同前缀两条 trace：写文件不接受歧义
    const existing = readFileSync(join(dir, '.workspace', 'traces.jsonl'), 'utf8');
    writeFileSync(
      join(dir, '.workspace', 'traces.jsonl'),
      `${existing}${existing.replaceAll(TRACE_ID, `${TRACE_ID}2`)}`,
      'utf8',
    );
    const ambiguous = runCli(['harvest', 'abc12345', '--task', 'x'], dir);
    assert.equal(ambiguous.code, 2, ambiguous.out);
    assert.match(ambiguous.out, /请用更长的前缀/);

    // 前缀写错与歧义都是用法错，不该跟「跑了但没达标」混成退出码 1
    const missing = runCli(['harvest', 'does-not-exist', '--task', 'x'], dir);
    assert.equal(missing.code, 2, missing.out);
    assert.match(missing.out, /没有以 "does-not-exist" 开头的 trace/);
  });

  it('已有同名用例（哪怕在子目录）时拒绝，避免下次 eval 一加载就重名', () => {
    const dir = project();
    const nested = join(dir, 'evals', 'nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(nested, 'CASE.md'),
      '---\nname: harvest-abc12345-dea\nexpect_ok: true\n---\n原来的任务\n',
      'utf8',
    );
    const r = runCli(['harvest', TRACE_ID, '--task', '任务'], dir);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /已被 .* 占用/);
  });
});
