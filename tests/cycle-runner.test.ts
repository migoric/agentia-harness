/**
 * 基线必须跑在**同一个 runner** 上。
 *
 * 这条测试是为一个真实 bug 写的：`runCycle` 里候选跑用注入的 runner，基线却漏了 ——
 * 于是远程模式下「基线跑在本地、候选跑在服务上」，两边的成绩被放进同一个回归门比较，
 * 而报告里一切正常（`model` 字段各自报各自的）。归因也一起失真：本地那次没有派单，
 * 于是「该改哪个资产」永远是空的。
 *
 * 断言刻意落在「runner 被调用过」而不是某个数字上：这个 bug 的症状不是算错，是
 * **测了另一个东西**。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Trace } from '@migor/agentia';
import { discoverAssets } from '../src/assets/discover.js';
import { loadConfig } from '../src/config.js';
import { runCycle } from '../src/rsi/loop.js';
import type { Proposer } from '../src/rsi/propose.js';
import type { CaseRunner } from '../src/run/case-runner.js';
import type { RunOutcome } from '../src/run/runner.js';

const TRACE = {
  traceId: 't1',
  rootSpanId: 's1',
  status: 'ok',
  startedAt: 0,
  endedAt: 1,
  spans: [],
  totalUsage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
} as unknown as Trace;

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cycle-runner-'));
  mkdirSync(join(dir, 'agents'), { recursive: true });
  mkdirSync(join(dir, 'evals'), { recursive: true });
  writeFileSync(
    join(dir, 'agents', 'main.md'),
    '---\nname: main\ndescription: 摘要器\n---\n你是摘要器。压成三条要点。\n',
  );
  writeFileSync(
    join(dir, 'evals', 'one.md'),
    '---\nname: one\nexpect_ok: true\nexpect_max_tokens: 20000\n---\n\n压成三条要点。\n',
  );
  return dir;
}

describe('runCycle 的基线', () => {
  it('用注入的 runner（否则远程模式下基线会偷偷跑在本地）', async () => {
    const dir = project();
    const config = loadConfig(dir);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });

    const calls: string[] = [];
    const runner: CaseRunner = {
      model: 'stub',
      // 报告里要拼 `agent@version`（`runSuite` 唯一一处无条件读 runner.agent）
      agent: { name: 'stub', version: '1' },
      async run(task: string): Promise<RunOutcome> {
        calls.push(task);
        return {
          text: '三条要点：一、二、三',
          ok: true,
          stopReason: 'end_turn',
          iterations: 1,
          trace: TRACE,
          tokens: 5,
          costUsd: undefined,
          costNote: 'unreported',
          durationMs: 1,
          skills: [],
          subagents: [],
        } as unknown as RunOutcome;
      },
    } as unknown as CaseRunner;

    // 一个什么都不提的提案器：这轮只跑基线，正好隔离「基线用了谁」这一件事
    const proposer: Proposer = {
      propose: async () => ({ proposals: [], cost: { usd: 0, known: true } }),
    };

    const report = await runCycle({ config, assets, runner, proposer });

    assert.deepEqual(calls, ['压成三条要点。'], '基线必须通过注入的 runner 跑');
    assert.ok(report.baseline !== undefined, '基线报告必须存在（否则这轮没测东西）');
    assert.equal(report.baseline.total, 1);
    assert.equal(report.baseline.passed, 1);
  });
});
