import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scriptedClient } from '@migor/agentia';
import { discoverAssets } from '../src/assets/discover.ts';
import { loadConfig } from '../src/config.ts';
import { loadEvalCases } from '../src/evals/load.ts';
import { summarize } from '../src/evals/report.ts';
import type { CaseResult } from '../src/evals/types.ts';
import {
  appendHoldoutUse,
  describeProgress,
  holdoutProgress,
  holdoutUsePath,
  pickHoldoutBatch,
  readHoldoutUses,
} from '../src/rsi/holdout-batch.ts';
import { runCycle } from '../src/rsi/loop.ts';
import type { Proposal } from '../src/rsi/types.ts';

/**
 * 分期留出 —— 把「留出集只验一次」从**一轮之内**扩到**跨轮**。
 *
 * 三条被守住的规矩，每条都对应一种具体的坏结局：
 * - 批次用完就拒（否则同一批被反复验，累积假阳性 → 越转越自信、能力越转越差）；
 * - 消耗与结果无关（只在通过时记账，等于让没通过的尝试免费重抽）；
 * - 未分期不硬拦但出声（加一个字段之前，老工程的行为不该被悄悄改掉）。
 */

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

function caseOf(name: string, passed = true, phase?: number): CaseResult {
  return {
    name,
    task: name,
    passed,
    failures: passed ? [] : ['断言失败'],
    tokens: 100,
    costUsd: 0.01,
    iterations: 1,
    durationMs: 1,
    stopReason: 'end_turn',
    excerpt: '',
    split: 'holdout',
    ...(phase === undefined ? {} : { phase }),
    skills: [],
    subagents: [],
  };
}

function report(cases: readonly CaseResult[]) {
  return summarize(cases, 'fp', 'main@1');
}

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-batch-'));
  const w = (rel: string, text: string): void => {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text, 'utf8');
  };
  w('agents/main.md', '---\nname: main\nversion: 1\ndescription: 主 agent\n---\n你是执行者。\n');
  w('evals/a-train.md', '---\nname: a-train\nexpect_contains: 结论\n---\n任务甲：判断合格\n');
  w(
    'evals/h1.md',
    '---\nname: h1\nsplit: holdout\nphase: 1\nexpect_contains: 保留\n---\n任务乙：保留摘要\n',
  );
  w(
    'evals/h2.md',
    '---\nname: h2\nsplit: holdout\nphase: 2\nexpect_contains: 保留\n---\n任务丙：保留摘要\n',
  );
  return root;
}

describe('留出批次 —— 纯选择逻辑', () => {
  it('未分期：算作同一批，可复用但把次数数出来', () => {
    const root = project();
    const config = loadConfig(root);
    const unphased = report([caseOf('h1'), caseOf('h2')]);
    const progress = holdoutProgress(config, unphased.cases);
    assert.equal(progress.enforced, false);
    assert.equal(progress.batches.length, 1);
    assert.equal(progress.batches[0]?.phase, 1);

    const first = pickHoldoutBatch(progress);
    assert.equal(first.ok, true);
    assert.equal(first.ok && first.batch.used, 0);

    // 用过一次之后仍然可以挑（不硬拦），但 used 变成 1 —— 复用是**可见**的
    appendHoldoutUse(config, {
      at: Date.now(),
      cycleId: 'c1',
      proposalId: 'p1',
      phase: 1,
      cases: ['h1', 'h2'],
      passed: true,
      reason: '通过',
    });
    const again = pickHoldoutBatch(holdoutProgress(config, unphased.cases));
    assert.equal(again.ok, true);
    assert.equal(again.ok && again.batch.used, 1);
  });

  it('分期：挑序号最小且没用过的那批', () => {
    const root = project();
    const config = loadConfig(root);
    const phased = report([caseOf('h1', true, 1), caseOf('h2', true, 2)]);
    const p = holdoutProgress(config, phased.cases);
    assert.equal(p.enforced, true);
    assert.deepEqual(
      p.batches.map((b) => b.phase),
      [1, 2],
    );
    const first = pickHoldoutBatch(p);
    assert.equal(first.ok && first.batch.phase, 1);
    assert.deepEqual(first.ok && first.batch.cases, ['h1']);
  });

  it('批次用尽：拒绝，并说清下一步（补新用例 / 收工）', () => {
    const root = project();
    const config = loadConfig(root);
    const phased = report([caseOf('h1', true, 1), caseOf('h2', true, 2)]);
    mkdirSync(join(root, '.workspace', 'rsi'), { recursive: true });
    writeFileSync(
      holdoutUsePath(config),
      `${[1, 2]
        .map((phase) =>
          JSON.stringify({
            at: Date.now(),
            cycleId: `c${phase}`,
            proposalId: `p${phase}`,
            phase,
            cases: [phase === 1 ? 'h1' : 'h2'],
            passed: false,
            reason: '未通过',
          }),
        )
        .join('\n')}\n`,
      'utf8',
    );
    const pick = pickHoldoutBatch(holdoutProgress(config, phased.cases));
    assert.equal(pick.ok, false);
    assert.match(pick.ok === false ? pick.reason : '', /全部用过/);
    assert.match(pick.ok === false ? pick.reason : '', /补一批新用例/);
    // 未通过的尝试也算消耗 —— 2 批都被"验过一眼"，哪怕两次都没通过
    assert.equal(readHoldoutUses(config).length, 2);
  });

  it('消耗账坏一行就炸，不静默跳过（跳过等于白送一批已用过的留出集）', () => {
    const root = project();
    const config = loadConfig(root);
    mkdirSync(join(root, '.workspace', 'rsi'), { recursive: true });
    writeFileSync(holdoutUsePath(config), '{"phase":1}\n{半截\n', 'utf8');
    assert.throws(() => readHoldoutUses(config), /留出集消耗账第 2 行/);
  });

  it('人话读数：分期报 已用/共几批，未分期报复用次数（复用即假阳性在累积）', () => {
    const root = project();
    const config = loadConfig(root);
    const unphased = report([caseOf('h1')]);
    assert.match(describeProgress(holdoutProgress(config, unphased.cases)), /未分期/);

    mkdirSync(join(root, '.workspace', 'rsi'), { recursive: true });
    writeFileSync(
      holdoutUsePath(config),
      `${JSON.stringify({
        at: Date.now(),
        cycleId: 'c1',
        proposalId: 'p1',
        phase: 1,
        cases: ['h1'],
        passed: true,
        reason: '通过',
      })}\n`,
      'utf8',
    );
    assert.match(describeProgress(holdoutProgress(config, unphased.cases)), /已复用 1 次/);

    const phased = report([caseOf('h1', true, 1), caseOf('h2', true, 2)]);
    assert.match(describeProgress(holdoutProgress(config, phased.cases)), /已用 1\/2 批/);
  });
});

/**
 * 端到端：一轮真的采纳之后，**消耗账与轮次记录**同时留下痕迹。
 *
 * 这两处缺一处就会让下一个人踩坑：只有账没有记录 ⇒ 看不出"哪批被哪一轮用掉了"；
 * 只有记录没有账 ⇒ 下一轮会把同一批再用一次，而它看起来完全正常。
 */
describe('留出批次 —— 加载期校验', () => {
  it('phase 写在 train 上、或不是正整数：加载就炸（两种都会静默失效）', () => {
    const root = project();
    const bad = (name: string, text: string): void =>
      writeFileSync(join(root, 'evals', `${name}.md`), text, 'utf8');
    bad('t1', '---\nname: t1\nphase: 2\nexpect_contains: x\n---\n任务\n');
    assert.throws(
      () => loadEvalCases(join(root, 'evals')),
      /phase 只对 split: holdout 的用例有意义/,
    );

    writeFileSync(
      join(root, 'evals', 't1.md'),
      '---\nname: t1\nexpect_contains: x\n---\n任务\n',
      'utf8',
    );
    bad('h3', '---\nname: h3\nsplit: holdout\nphase: 0\nexpect_contains: x\n---\n任务\n');
    assert.throws(() => loadEvalCases(join(root, 'evals')), /phase 必须是正整数/);
  });
});

describe('留出批次 —— 与 runCycle 的接线', () => {
  it('采纳后记下批次，并在下一轮换成第 2 批', async () => {
    const root = project();
    const { report: cycleReport } = await oneCycle(root, 'MARK-ONE');
    assert.equal(cycleReport.accepted.length, 1);
    assert.equal(cycleReport.holdoutBatch?.phase, 1);
    assert.equal(cycleReport.holdoutBatch?.priorUses, 0);
    assert.equal(cycleReport.holdoutBatch?.enforced, true);

    const uses = readHoldoutUses(loadConfig(root));
    assert.equal(uses.length, 1, '验过一次就必须记一次消耗');
    assert.equal(uses[0]?.phase, 1);
    assert.equal(uses[0]?.cycleId, cycleReport.cycleId, '消耗账与轮次记录必须对得上');

    const next = pickHoldoutBatch(
      holdoutProgress(
        loadConfig(root),
        summarize([caseOf('h1', true, 1), caseOf('h2', true, 2)], 'fp', 'main@1').cases,
      ),
    );
    assert.equal(next.ok && next.batch.phase, 2, '下一轮自动换批');
  });

  it('两批都用过之后：候选连留出集都进不去，整轮不采纳', async () => {
    const root = project();
    const config = loadConfig(root);
    mkdirSync(join(root, '.workspace', 'rsi'), { recursive: true });
    writeFileSync(
      holdoutUsePath(config),
      `${[1, 2]
        .map((phase) =>
          JSON.stringify({
            at: Date.now(),
            cycleId: `old-${phase}`,
            proposalId: `old-p${phase}`,
            phase,
            cases: [phase === 1 ? 'h1' : 'h2'],
            passed: true,
            reason: '通过',
          }),
        )
        .join('\n')}\n`,
      'utf8',
    );
    const { report: cycleReport } = await oneCycle(root, 'MARK-TWO');
    assert.equal(cycleReport.accepted.length, 0);
    assert.equal(cycleReport.holdoutBatch, undefined, '没验成功就不该记批次');
    assert.match(cycleReport.rejected.map((r) => r.reason).join('\n'), /留出集不可用：.*全部用过/);
    assert.equal(readHoldoutUses(config).length, 2, '被拒的那次没有再消耗一批');
  });
});

/** 一轮：基线（train + 2 条 holdout）+ 候选 train + 候选 holdout */
async function oneCycle(root: string, tag: string) {
  const config = loadConfig(root);
  const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
  const agent = assets.agents[0];
  assert.ok(agent !== undefined);

  const step = (params: unknown) => {
    const p = params as { system?: string | Array<{ text?: string }>; messages?: unknown };
    const system =
      typeof p.system === 'string'
        ? p.system
        : (p.system ?? []).map((b) => b.text ?? '').join('\n');
    const message = JSON.stringify(p.messages ?? []);
    const fixed = system.includes(tag);
    if (message.includes('任务甲')) return endTurn(fixed ? '结论：合格' : '不合格');
    return endTurn('保留摘要');
  };

  const report = await runCycle({
    config,
    assets,
    client: scriptedClient(Array.from({ length: 12 }, () => step)),
    proposer: {
      propose: async (ctx) => {
        const proposals: Proposal[] = [
          {
            id: `p-${tag}`,
            modeId: ctx.modes[0]?.id ?? 'm',
            kind: 'wrong_answer',
            rationale: 'train 失败，收紧输出格式',
            layer: 'L1',
            patch: {
              target: 'agent:main',
              before: agent.body,
              after: `你是执行者。回答必须以「${tag}」开头。`,
            },
          },
        ];
        return { proposals, cost: { usd: 0.001, known: true } };
      },
    },
  });
  return { report, config };
}
