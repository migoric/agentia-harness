import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scriptedClient } from '@migor/agentia';
import { discoverAssets } from '../src/assets/discover.ts';
import { loadConfig } from '../src/config.ts';
import type { GateResult } from '../src/evals/gate.ts';
import type { EvalReport } from '../src/evals/types.ts';
import { lessonsOf } from '../src/rsi/ledger.ts';
import { runCycle } from '../src/rsi/loop.ts';
import { LlmProposer } from '../src/rsi/propose.ts';
import type { FailureMode, Proposal } from '../src/rsi/types.ts';

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

function report(passRate: number): EvalReport {
  const total = 2;
  const passed = Math.round(total * passRate);
  return {
    total,
    passed,
    passRate,
    tokens: 20,
    costUsd: 0.01,
    costKnown: true,
    cases: [],
    assetFingerprint: 'fp',
    agent: 'main@1',
    skillHits: [],
  };
}

function gate(fixed: string[], ok: boolean): GateResult {
  return {
    ok,
    code: ok ? 'pass' : 'case_regression',
    reason: ok ? '没有用例变差' : '用例 a 退步',
    regressedCases: ok ? [] : ['a'],
    fixedCases: fixed,
    passRateDelta: ok ? 0 : -0.5,
    tokenDelta: 0,
    costDelta: undefined,
    costBasis: 'tokens',
    sameAssets: true,
    sameCaseSet: true,
    onlyInBaseline: [],
    onlyInCandidate: [],
    sameModel: undefined,
    sameAgent: true,
  };
}

function proposal(id: string, target = 'agent:main'): Proposal {
  return {
    id,
    modeId: 'm1',
    kind: 'wrong_answer',
    rationale: 'r',
    layer: 'L1',
    manifest: {
      evidence: ['case:a'],
      hypothesis: '失败是因为没规定输出格式',
      prediction: 'a 应转为通过',
      risk: '可能让别的用例变长',
    },
    patch: { target, before: '旧正文', after: '新正文' },
  };
}

/** 一个固定的失败模式夹具（提案器只需要一个能喂进去的模式） */
const mode: FailureMode = {
  id: 'm1',
  kind: 'wrong_answer',
  signature: '正文缺少结论',
  count: 1,
  cases: ['a'],
  samples: [
    {
      case: 'a',
      failures: ['正文缺少 "结论"'],
      stopReason: 'end_turn',
      tokens: 20,
      iterations: 1,
      excerpt: '没有结论',
      skills: [],
      subagents: [],
    },
  ],
  targets: [],
};

/** 一条 journal 记录 —— 账本里「预测 vs 结果」的另一半证据 */
function journalEntry(p: Proposal, at: number, status: 'accepted' | 'rejected', reason: string) {
  return {
    at,
    proposalId: p.id,
    status,
    target: p.patch.target,
    before: p.patch.before,
    after: p.patch.after,
    reason,
    manifest: p.manifest,
    assetsBefore: 'fp-before',
    assetsAfter: 'fp-after',
    kind: 'asset' as const,
  };
}

function writeJournal(root: string, entries: readonly object[]): void {
  const dir = join(root, '.workspace', 'rsi');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'journal.jsonl'),
    `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`,
    'utf8',
  );
}

/** 造一份 cycle JSON：这是账本唯一的证据来源 */
function writeCycle(
  root: string,
  cycleId: string,
  p: Proposal,
  g: GateResult,
  passedBefore: number,
  passedAfter: number,
): void {
  const dir = join(root, '.workspace', 'rsi', 'cycles');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${cycleId}.json`),
    JSON.stringify({
      cycleId,
      modes: [],
      proposals: [p],
      verified: [
        { proposal: p, baseline: report(passedBefore), candidate: report(passedAfter), gate: g },
      ],
      accepted: [],
      rejected: [],
      baseline: report(passedBefore),
      dryRun: false,
      costUsd: 0,
      costKnown: true,
    }),
    'utf8',
  );
}

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-lessons-'));
  const w = (rel: string, text: string): void => {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text, 'utf8');
  };
  w('agents/main.md', '---\nname: main\nversion: 1\ndescription: 主 agent\n---\n你是执行者。\n');
  w('evals/a.md', '---\nname: a\nexpect_contains: 结论\n---\n任务甲\n');
  return root;
}

describe('lessonsOf —— 什么才算教训', () => {
  it('只收「验过没兑现」与「回滚」，兑现过的方向不进教训', () => {
    const root = project();
    writeCycle(root, '2026-01-01T00-00-00-000Z', proposal('p-fail'), gate([], false), 0.5, 0.5);
    writeCycle(root, '2026-01-02T00-00-00-000Z', proposal('p-ok'), gate(['a'], true), 0.5, 1);
    const config = loadConfig(root);

    const lessons = lessonsOf(config);
    assert.equal(lessons.length, 1, '只有失败那条算教训');
    assert.equal(lessons[0]?.proposalId, 'p-fail');
    assert.equal(lessons[0]?.target, 'agent:main');
    assert.equal(lessons[0]?.prediction, 'a 应转为通过');
    assert.equal(lessons[0]?.reason, '用例 a 退步');
    assert.equal(lessons[0]?.outcome, 'not_realized');
  });

  it('被门拒的提案按轮次时间排序，不会被老记录挤掉', () => {
    const root = project();
    // 三条都是「被门拒」（只在 cycle JSON 里，不在 journal），时间与写入顺序不一致
    writeCycle(root, '2026-01-01T00-00-00-000Z', proposal('p-oldest'), gate([], false), 0.5, 0.5);
    writeCycle(root, '2026-03-01T00-00-00-000Z', proposal('p-newest'), gate([], false), 0.5, 0.5);
    writeCycle(root, '2026-02-01T00-00-00-000Z', proposal('p-middle'), gate([], false), 0.5, 0.5);

    const lessons = lessonsOf(loadConfig(root), 2);
    assert.deepEqual(
      lessons.map((l) => l.proposalId),
      ['p-newest', 'p-middle'],
      '截断必须按真实时间倒序，而不是按文件写入顺序',
    );
  });

  it('limit 截断，且取最近的（at 大）优先', () => {
    const root = project();
    for (let i = 0; i < 3; i++) {
      const p = proposal(`p-${i}`);
      writeCycle(root, `2026-01-0${i + 1}T00-00-00-000Z`, p, gate([], false), 0.5, 0.5);
    }
    const lessons = lessonsOf(loadConfig(root), 2);
    assert.equal(lessons.length, 2);
  });

  it('回滚的教训不能拿「当初采纳的理由」当失败原因', () => {
    const root = project();
    const p = proposal('p-rev');
    // cycle 记录里这条是**通过**的（fixed 有 a），只有 journal 记得它后来被回滚了
    writeCycle(root, '2026-01-05T00-00-00-000Z', p, gate(['a'], true), 0.5, 1);
    writeJournal(root, [
      journalEntry(p, 1, 'accepted', '修好 1 条（a）'),
      {
        ...journalEntry(p, 2, 'rejected', '回滚了 p-rev（原采纳理由：修好 1 条（a））'),
        reverted: true,
      },
    ]);

    const lessons = lessonsOf(loadConfig(root));
    assert.equal(lessons.length, 1, '回滚条目只算一条教训（采纳那条是 realized）');
    const reason = lessons[0]?.reason ?? '';
    assert.equal(lessons[0]?.outcome, 'reverted');
    assert.notEqual(reason, '修好 1 条（a）', '成功理由不能当成失败原因');
    assert.ok(reason.includes('人工回滚'), `应说明是人工回滚，实际："${reason}"`);
    assert.ok(
      reason.includes('没写原因'),
      `回滚记录里本来就没有原因，不要编一个，实际："${reason}"`,
    );
  });

  it('回滚教训渲染进提示词时不自相矛盾', async () => {
    const root = project();
    const p = proposal('p-rev');
    writeCycle(root, '2026-01-05T00-00-00-000Z', p, gate(['a'], true), 0.5, 1);
    writeJournal(root, [
      journalEntry(p, 1, 'accepted', '修好 1 条（a）'),
      {
        ...journalEntry(p, 2, 'rejected', '回滚了 p-rev（原采纳理由：修好 1 条（a））'),
        reverted: true,
      },
    ]);
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const prompts: string[] = [];
    const client = scriptedClient([
      (params: unknown) => {
        prompts.push(JSON.stringify(params));
        return endTurn('你是执行者。结论：开头。');
      },
    ]);
    await new LlmProposer(config).propose({
      modes: [mode],
      assets,
      config,
      client,
      history: lessonsOf(config),
    });
    const prompt = prompts[0] ?? '';
    assert.ok(prompt.includes('采纳后又被回滚'), '要点明是回滚这条教训');
    assert.ok(
      !prompt.includes('又被回滚：修好 1 条'),
      `不能把成功理由直接接在「又被回滚」后面，实际提示词：${prompt.slice(0, 400)}`,
    );
  });
});

describe('提案器真的看到了历史', () => {
  it('被拒方向写进提示词，并明确要求换一种改法', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const prompts: string[] = [];
    const patch = '你是执行者。结论：开头。';
    const client = scriptedClient([
      (params: unknown) => {
        prompts.push(JSON.stringify(params));
        return endTurn(patch);
      },
    ]);

    const proposer = new LlmProposer(config);
    const made = await proposer.propose({
      modes: [mode],
      assets,
      config,
      client,
      history: [
        {
          proposalId: 'p-old',
          target: 'agent:main',
          prediction: 'a 应转为通过',
          reason: '用例 a 退步',
          outcome: 'not_realized',
        },
      ],
    });

    assert.equal(made.length, 1);
    const prompt = prompts[0] ?? '';
    assert.ok(prompt.includes('已经试过、但没成立的方向'), '必须出现历史段落');
    assert.ok(prompt.includes('p-old') === false, '提示词里不该暴露内部提案 id');
    assert.ok(prompt.includes('agent:main'), '必须指出上次改的是哪儿');
    assert.ok(prompt.includes('a 应转为通过'), '必须带上当时的预测');
    assert.ok(prompt.includes('用例 a 退步'), '必须带上被否的原因');
  });

  it('没有历史时不出现该段落（避免空话占篇幅）', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const prompts: string[] = [];
    const client = scriptedClient([
      (params: unknown) => {
        prompts.push(JSON.stringify(params));
        return endTurn('你是执行者。\n回答必须以「结论：」开头。');
      },
    ]);
    await new LlmProposer(config).propose({ modes: [mode], assets, config, client });
    assert.ok(!(prompts[0] ?? '').includes('已经试过、但没成立的方向'));
  });
});

describe('runCycle 把教训接进闭环', () => {
  it('账本里有一条失败教训时，本轮提案提示词带上它并记进轮次记录', async () => {
    const root = project();
    // 先造一条历史：上一轮改过 agent:main 但没用
    writeCycle(root, '2026-01-01T00-00-00-000Z', proposal('p-old'), gate([], false), 0.5, 0.5);
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const prompts: string[] = [];
    const script = [
      // 基线：不满足 expect_contains: 结论
      () => endTurn('不合格'),
      // 提案器
      (params: unknown) => {
        prompts.push(JSON.stringify(params));
        return endTurn('你是执行者。结论：开头。');
      },
      // 候选：通过
      () => endTurn('结论：合格'),
    ];
    const client = scriptedClient(script.map((fn) => fn));

    const result = await runCycle({
      config,
      assets,
      client,
      proposer: new LlmProposer(config),
    });

    assert.equal(result.historyConsulted, 1);
    assert.equal(result.accepted.length, 1);
    assert.ok((prompts[0] ?? '').includes('已经试过、但没成立的方向'));
    assert.ok((prompts[0] ?? '').includes('p-old') === false);
  });
});
