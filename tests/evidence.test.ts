import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scriptedClient } from '@migor/agentia';
import { discoverAssets } from '../src/assets/discover.ts';
import { loadConfig } from '../src/config.ts';
import { runSuite } from '../src/evals/run.ts';
import { buildEvidenceCorpus } from '../src/rsi/evidence.ts';

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

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-evidence-'));
  const w = (rel: string, text: string): void => {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text, 'utf8');
  };
  w('agents/main.md', '---\nname: main\nversion: 1\ndescription: 主 agent\n---\n你是执行者。\n');
  w('evals/a.md', '---\nname: a\nexpect_contains: 结论\n---\n任务甲：判断合格\n');
  w('evals/b.md', '---\nname: b\nsplit: holdout\nexpect_contains: 保留\n---\n任务乙：保留摘要\n');
  return root;
}

describe('evidence —— 分层证据语料', () => {
  it('从真实报告导出 overview / detail / raw，并保留任务原文与失败模式', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const report = await runSuite({
      config,
      assets,
      keepTraces: true,
      // 按任务分派，避免脚本游标与用例顺序耦合；两条用例各消耗一步
      client: scriptedClient(
        Array.from(
          { length: 2 },
          () => (params: unknown) =>
            endTurn(JSON.stringify(params).includes('任务甲') ? '无可用信息' : '保留'),
        ),
      ),
    });
    assert.equal(report.passed, 1);
    assert.ok(report.cases.every((c) => c.traceId !== undefined));

    const corpus = buildEvidenceCorpus(config, report, { id: 'ev-test', now: 1_700_000_000_000 });
    assert.equal(corpus.items.length, 2);
    assert.deepEqual(corpus.missingTraces, []);
    assert.equal(corpus.badLines, 0);

    const overview = readFileSync(corpus.overviewPath, 'utf8');
    assert.match(overview, /失败 1/);
    assert.match(overview, /train 1 \/ holdout 1/);
    assert.match(overview, /mode:/);
    assert.match(overview, /\[a\]/);

    const detailA = readFileSync(join(corpus.dir, corpus.items[0]?.detail ?? ''), 'utf8');
    assert.match(detailA, /任务甲：判断合格/);
    assert.match(detailA, /正文缺少 "结论"/);

    const rawA = corpus.items[0]?.raw;
    assert.ok(rawA !== undefined);
    const raw = JSON.parse(readFileSync(join(corpus.dir, rawA), 'utf8')) as {
      traceId: string;
    };
    assert.equal(raw.traceId, corpus.items[0]?.traceId);

    const index = JSON.parse(readFileSync(corpus.indexPath, 'utf8')) as {
      id: string;
      createdAt: number;
      items: readonly { case: string }[];
    };
    assert.equal(index.id, 'ev-test');
    assert.equal(index.createdAt, 1_700_000_000_000);
    assert.deepEqual(
      index.items.map((i) => i.case),
      ['a', 'b'],
    );
  });

  it('报告有 traceId 但文件里没有时如实记入 missingTraces，不静默丢', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const report = await runSuite({
      config,
      assets,
      client: scriptedClient([endTurn('结论')]),
    });
    const altered = {
      ...report,
      cases: [
        report.cases[0] ? { ...report.cases[0], traceId: 't-not-on-disk' } : undefined,
      ].filter((c) => c !== undefined),
    } as typeof report;
    const corpus = buildEvidenceCorpus(config, altered, { id: 'ev-missing' });
    assert.deepEqual(corpus.missingTraces, ['a']);
    assert.equal(corpus.items[0]?.raw, undefined);
    assert.match(readFileSync(corpus.overviewPath, 'utf8'), /找不到原始 trace/);
  });

  it('非法 id 与重复 id 都拒（证据不可覆盖）', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const report = await runSuite({ config, assets, client: scriptedClient([endTurn('结论')]) });
    assert.throws(() => buildEvidenceCorpus(config, report, { id: '../escape' }), /非法字符/);
    buildEvidenceCorpus(config, report, { id: 'ev-once' });
    assert.throws(() => buildEvidenceCorpus(config, report, { id: 'ev-once' }), /不覆盖历史证据/);
    assert.ok(existsSync(join(config.workspaceDir, 'evidence', 'ev-once', 'index.json')));
  });
});

describe('evidence —— 坏行不污染证据', () => {
  it('traces.jsonl 中间夹半截 JSON 时，raw 仍与各自的 traceId 严格对应', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const report = await runSuite({
      config,
      assets,
      keepTraces: true,
      client: scriptedClient(
        Array.from(
          { length: 2 },
          () => (params: unknown) =>
            endTurn(JSON.stringify(params).includes('任务甲') ? '结论' : '保留'),
        ),
      ),
    });
    const lines = readFileSync(config.tracesPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    writeFileSync(config.tracesPath, `${lines[0]}\n{BROKEN\n${lines[1]}\n`, 'utf8');

    const corpus = buildEvidenceCorpus(config, report, { id: 'ev-bad-line' });
    assert.equal(corpus.badLines, 1);
    assert.deepEqual(corpus.missingTraces, []);
    for (const item of corpus.items) {
      assert.ok(item.raw !== undefined);
      const raw = JSON.parse(readFileSync(join(corpus.dir, item.raw), 'utf8')) as {
        traceId: string;
      };
      assert.equal(raw.traceId, item.traceId, `${item.case} 的 raw 必须是自己的 trace`);
    }
  });
});

describe('evidence —— 多轮口径必须标注', () => {
  it('多轮用例在总览与明细里都注明「raw 只是最后一轮」', () => {
    const root = project();
    const config = loadConfig(root);
    mkdirSync(join(root, '.workspace'), { recursive: true });
    writeFileSync(
      config.tracesPath,
      `${JSON.stringify({
        traceId: 't-multi',
        rootSpanId: 's0',
        spans: [],
        status: 'ok',
        totalUsage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      })}\n`,
      'utf8',
    );
    const report = {
      total: 1,
      passed: 0,
      passRate: 0,
      tokens: 2,
      costUsd: 0.01,
      costKnown: true,
      assetFingerprint: 'fp',
      agent: 'main@1',
      skillHits: [],
      cases: [
        {
          name: 'multi',
          task: '先看 foo.c',
          split: 'train' as const,
          passed: false,
          failures: ['正文缺少 "bar.c"'],
          tokens: 2,
          costUsd: 0.01,
          iterations: 2,
          durationMs: 1,
          stopReason: 'end_turn',
          excerpt: '半截',
          traceId: 't-multi',
          turns: 3,
          skills: [],
          subagents: [],
        },
      ],
    };

    const corpus = buildEvidenceCorpus(config, report, { id: 'ev-multi' });
    assert.equal(corpus.items[0]?.turns, 3);
    const overview = readFileSync(corpus.overviewPath, 'utf8');
    assert.match(overview, /3 轮，raw 仅末轮/);
    const detail = readFileSync(join(corpus.dir, corpus.items[0]?.detail ?? ''), 'utf8');
    assert.match(detail, /不是整段/);
  });
});
