import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Trace } from '@migor/agentia';
import { loadConfig } from '../src/config.ts';
import { harvestCase } from '../src/evals/harvest.ts';
import { loadEvalCases } from '../src/evals/load.ts';
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

/** 一个能被 CLI 直接用的工程：有资产、有一条落盘 trace、有一份 eval 报告 */
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
  w(
    'report.json',
    JSON.stringify({
      total: 1,
      cases: [{ name: 'existing', task: '把这段话压成三条要点', traceId: TRACE_ID }],
    }),
  );
  return root;
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
  it('--from-report 反查任务原文，生成可加载的用例', () => {
    const dir = project();
    const r = runCli(['harvest', 'abc12345', '--from-report', 'report.json'], dir);
    assert.equal(r.code, 0, r.out);
    const config = loadConfig(dir);
    const file = join(config.evalsDir, 'harvest-abc12345-dea.md');
    assert.ok(existsSync(file), r.out);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /把这段话压成三条要点/);
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
    assert.match(second.out, /拒绝覆盖/);
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
    assert.equal(ambiguous.code, 1, ambiguous.out);
    assert.match(ambiguous.out, /请用更长的前缀/);
  });
});
