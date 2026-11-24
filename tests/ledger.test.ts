import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import type { GateResult } from '../src/evals/gate.ts';
import type { EvalReport } from '../src/evals/types.ts';
import { lessonsOf, readLedger } from '../src/rsi/ledger.ts';
import { writeCycle as persistCycle } from '../src/rsi/loop.ts';
import type { Proposal } from '../src/rsi/types.ts';
import { runCli } from './support/cli.ts';

/**
 * 决策账本的读取口径。
 *
 * 这个模块是 RSI 里唯一「回头对账」的地方，它的错法都很安静：把 dry-run 说成
 * 「被门拒」、把回滚的解释换成当初的成功理由 —— 报告照样好看，审计结论却是反的。
 */

function report(passed: string[]): EvalReport {
  return {
    total: 2,
    passed: passed.length,
    passRate: passed.length / 2,
    tokens: 20,
    costUsd: 0.01,
    costKnown: true,
    cases: passed.map((name) => ({
      name,
      task: 't',
      split: 'train' as const,
      passed: true,
      failures: [],
      tokens: 10,
      costUsd: 0.005,
      iterations: 1,
      durationMs: 1,
      stopReason: 'end_turn',
      excerpt: '',
      skills: [],
      subagents: [],
    })),
    assetFingerprint: 'fp',
    agent: 'main@1',
    skillHits: [],
  };
}

function gate(fixed: string[]): GateResult {
  return {
    ok: true,
    code: 'pass',
    reason: `修好 ${fixed.length} 条（${fixed.join(',')}）`,
    regressedCases: [],
    fixedCases: fixed,
    passRateDelta: 0.5,
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

function proposal(id: string): Proposal {
  return {
    id,
    modeId: 'm1',
    kind: 'wrong_answer',
    rationale: 'r',
    layer: 'L1',
    manifest: {
      evidence: ['case:a'],
      hypothesis: '没规定输出格式',
      prediction: 'a 应转为通过',
      risk: '可能变长',
    },
    patch: { target: 'agent:main', before: '旧正文', after: '新正文' },
  };
}

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-ledger-'));
  const w = (rel: string, text: string): void => {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text, 'utf8');
  };
  w('agents/main.md', '---\nname: main\nversion: 1\ndescription: 主 agent\n---\n你是执行者。\n');
  w('evals/a.md', '---\nname: a\nexpect_contains: 结论\n---\n任务甲\n');
  return root;
}

/** 一份轮次记录：`verified` 是账本唯一的「当时看到什么」来源 */
function writeCycle(
  root: string,
  cycleId: string,
  p: Proposal,
  opts: { accepted: boolean; dryRun: boolean },
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
        { proposal: p, baseline: report([]), candidate: report(['a']), gate: gate(['a']) },
      ],
      accepted: opts.accepted ? [p] : [],
      rejected: [],
      baseline: report([]),
      dryRun: opts.dryRun,
      costUsd: 0,
      costKnown: true,
    }),
    'utf8',
  );
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

function entry(p: Proposal, at: number, status: 'accepted' | 'rejected', reason: string) {
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

describe('readLedger —— dry-run 不能被读成「被门拒」', () => {
  it('过了门却没落盘的提案标成 accepted/dropped，并且 dryRun 为真', () => {
    const root = project();
    const p = proposal('p-dry');
    writeCycle(root, '2026-02-01T00-00-00-000Z', p, { accepted: true, dryRun: true });

    const entries = readLedger(loadConfig(root));
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.status, 'accepted', 'dry-run 是「本会采纳」，不是被门拒');
    assert.equal(entries[0]?.outcome, 'dropped', '兑现了预测，但刻意没落盘');
    assert.equal(entries[0]?.dryRun, true);
    assert.match(entries[0]?.journalReason ?? '', /dry-run/);
  });

  it('真被门拒的提案仍是 rejected + not_realized', () => {
    const root = project();
    const p = proposal('p-rej');
    const dir = join(root, '.workspace', 'rsi', 'cycles');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '2026-02-02T00-00-00-000Z.json'),
      JSON.stringify({
        cycleId: '2026-02-02T00-00-00-000Z',
        modes: [],
        proposals: [p],
        verified: [
          {
            proposal: p,
            baseline: report([]),
            candidate: report([]),
            gate: {
              ...gate([]),
              ok: false,
              code: 'case_regression',
              passRateDelta: 0,
              reason: '用例 a 退步',
            },
          },
        ],
        accepted: [],
        rejected: [],
        baseline: report([]),
        dryRun: false,
        costUsd: 0,
        costKnown: true,
      }),
      'utf8',
    );
    const entries = readLedger(loadConfig(root));
    assert.equal(entries[0]?.status, 'rejected');
    assert.equal(entries[0]?.outcome, 'not_realized');
    assert.equal(entries[0]?.dryRun, false);
  });

  it('journal 里有记录但没有轮次记录时是 unverified（不猜）', () => {
    const root = project();
    const p = proposal('p-orphan');
    writeJournal(root, [entry(p, 1, 'accepted', '过了门')]);
    const entries = readLedger(loadConfig(root));
    assert.equal(entries[0]?.outcome, 'unverified');
  });
});

describe('账本的时间口径 —— 读字段，不读文件名', () => {
  /** 一份「被门拒」的轮次记录，`at` 与文件名**刻意可以不一致** */
  function writeRejected(root: string, cycleId: string, at: string | undefined, p: Proposal): void {
    const dir = join(root, '.workspace', 'rsi', 'cycles');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${cycleId}.json`),
      JSON.stringify({
        cycleId,
        ...(at === undefined ? {} : { at }),
        modes: [],
        proposals: [p],
        verified: [
          {
            proposal: p,
            baseline: report([]),
            candidate: report([]),
            gate: {
              ...gate([]),
              ok: false,
              code: 'case_regression',
              passRateDelta: 0,
              reason: '用例 a 退步',
            },
          },
        ],
        accepted: [],
        rejected: [],
        baseline: report([]),
        dryRun: false,
        costUsd: 0,
        costKnown: true,
      }),
      'utf8',
    );
  }

  it('取「最近一条」按 at，而不是按文件名 —— 两者相反时不能选错', () => {
    const root = project();
    // 文件名排序与真实时刻**相反**：靠文件名解析会得到相反的结论
    writeRejected(
      root,
      '2026-02-09T00-00-00-000Z',
      '2026-02-01T00:00:00.000Z',
      proposal('p-early'),
    );
    writeRejected(root, '2026-02-01T00-00-00-000Z', '2026-02-09T00:00:00.000Z', proposal('p-late'));

    const lessons = lessonsOf(loadConfig(root), 1);
    assert.equal(lessons.length, 1);
    assert.equal(lessons[0]?.proposalId, 'p-late', '应按记录里的时刻，而不是文件名');
  });

  it('旧记录（没有 at）仍能读：回落到文件名，不许整份账本读不出来', () => {
    const root = project();
    writeRejected(root, '2026-02-09T00-00-00-000Z', undefined, proposal('p-old'));
    const lessons = lessonsOf(loadConfig(root), 1);
    assert.equal(lessons.length, 1);
    assert.equal(lessons[0]?.proposalId, 'p-old');
  });

  it('writeCycle 落盘带 at（新记录不再依赖文件名）', () => {
    const root = project();
    const out = persistCycle(loadConfig(root), {
      modes: [],
      proposals: [],
      verified: [],
      accepted: [],
      rejected: [],
      baseline: undefined,
      dryRun: false,
      costUsd: 0,
      costKnown: true,
      budget: undefined,
    });
    const raw = JSON.parse(readFileSync(out.path, 'utf8')) as { at?: string };
    assert.ok(raw.at !== undefined, '新记录必须带 at');
    assert.ok(!Number.isNaN(Date.parse(raw.at)), 'at 必须可解析');
  });
});

describe('rsi ledger 的回执', () => {
  it('dry-run 与回滚各有自己的标签，不会都说成 rejected', () => {
    const root = project();
    const dry = proposal('p-dry');
    const rev = proposal('p-rev');
    writeCycle(root, '2026-02-01T00-00-00-000Z', dry, { accepted: true, dryRun: true });
    writeCycle(root, '2026-02-02T00-00-00-000Z', rev, { accepted: true, dryRun: false });
    writeJournal(root, [
      entry(rev, 1, 'accepted', '修好 1 条（a）'),
      {
        ...entry(rev, 2, 'rejected', '回滚了 p-rev（原采纳理由：修好 1 条（a））'),
        reverted: true,
      },
    ]);

    const r = runCli(['rsi', 'ledger'], root);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /dry-run\s+p-dry .*\[dropped\]/, r.out);
    assert.match(r.out, /reverted\s+p-rev .*\[reverted\]/, r.out);
    // 回滚那行的「结果」必须说清是采纳当时的，且原因不能写成成功理由
    assert.match(r.out, /采纳时：修好 1 条（a）/, r.out);
    assert.match(r.out, /说明：人工回滚/, r.out);
  });
});
