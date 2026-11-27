import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { GateResult } from '../src/evals/gate.ts';
import { loadEvalCases } from '../src/evals/load.ts';
import { summarize } from '../src/evals/report.ts';
import { splitReport } from '../src/evals/split.ts';
import type { CaseResult } from '../src/evals/types.ts';
import { attribute, collectFailures } from '../src/rsi/attribute.ts';
import { manifestFor, validateManifest } from '../src/rsi/manifest.ts';
import type { FailureMode, HoldoutResult, VerifyOutcome } from '../src/rsi/types.ts';
import { isWorthAccepting } from '../src/rsi/verify.ts';
import { fingerprint } from '../src/util/hash.ts';

function evalsDir(files: Record<string, string>): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'harness-split-')), 'evals');
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

function result(name: string, passed: boolean, split?: 'train' | 'holdout'): CaseResult {
  return {
    name,
    task: name,
    split,
    passed,
    failures: passed ? [] : ['正文缺少 "x"'],
    tokens: 10,
    costUsd: 0.01,
    iterations: 1,
    durationMs: 1,
    stopReason: 'end_turn',
    excerpt: '',
    skills: [],
    subagents: [],
  };
}

describe('train / holdout 分组', () => {
  it('加载期识别 split，拼错和「全是 holdout」都当场拒', () => {
    const dir = evalsDir({
      'a.md': '---\nname: a\nsplit: train\nexpect_contains: x\n---\n任务 A\n',
      'b.md': '---\nname: b\nsplit: holdout\nexpect_contains: x\n---\n任务 B\n',
    });
    const cases = loadEvalCases(dir);
    assert.equal(cases[0]?.split, 'train');
    assert.equal(cases[1]?.split, 'holdout');

    const bad = evalsDir({
      'c.md': '---\nname: c\nsplit: holout\nexpect_contains: x\n---\n任务\n',
    });
    assert.throws(() => loadEvalCases(bad), /split 只能是 train \/ holdout/);

    const onlyHoldout = evalsDir({
      'd.md': '---\nname: d\nsplit: holdout\nexpect_contains: x\n---\n任务\n',
    });
    assert.throws(() => loadEvalCases(onlyHoldout), /至少要留一条 train/);
  });

  it('splitReport 拆视图：缺席的 split 归 train，指纹不变', () => {
    const report = summarize(
      [result('a', false), result('b', true, 'holdout'), result('c', true, 'train')],
      'fp-1',
      'main@1',
    );
    const views = splitReport(report);
    assert.deepEqual(views.trainCases, ['a', 'c']);
    assert.deepEqual(views.holdoutCases, ['b']);
    assert.equal(views.train.total, 2);
    assert.equal(views.holdout?.total, 1);
    assert.equal(views.train.assetFingerprint, 'fp-1');
    assert.equal(views.holdout?.assetFingerprint, 'fp-1');
  });
});

describe('变更清单', () => {
  const mode: FailureMode = {
    id: 'wrong_answer:abc',
    kind: 'wrong_answer',
    signature: '正文缺少内容',
    count: 1,
    cases: ['a'],
    samples: [
      {
        case: 'a',
        failures: ['正文缺少 "x"'],
        stopReason: 'end_turn',
        tokens: 1,
        iterations: 1,
        excerpt: '',
        traceId: 't-123',
        skills: [],
        subagents: [],
      },
    ],
    targets: [],
  };

  it('清单在提案时生成：假设/预测/风险齐全，证据带 case 与 trace', () => {
    const m = manifestFor(mode, 'agent:main');
    assert.ok(m.evidence.includes('trace:t-123'));
    assert.ok(m.evidence.includes('case:a'));
    assert.match(m.hypothesis, /wrong_answer/);
    assert.match(m.prediction, /agent:main/);
    assert.notEqual(m.risk, '');
  });

  it('traceId 从报告一路进到清单证据引用（不是测试手造样本）', () => {
    const report = summarize([{ ...result('a', false), traceId: 't-42' }], 'fp', 'main@1');
    const samples = collectFailures(report);
    assert.equal(samples[0]?.traceId, 't-42');
    const mode = attribute(samples)[0];
    assert.ok(mode !== undefined);
    assert.ok(manifestFor(mode, 'agent:main').evidence.includes('trace:t-42'));
  });

  it('手写清单的拼错字段与空预测必须拒', () => {
    const ok = {
      evidence: ['case:a'],
      hypothesis: 'h',
      prediction: 'p',
      risk: 'r',
    };
    assert.equal(validateManifest(ok, 'm').prediction, 'p');
    assert.throws(() => validateManifest({ ...ok, predicton: 'x' }, 'm'), /不认识的字段/);
    assert.throws(() => validateManifest({ ...ok, prediction: '' }, 'm'), /应是非空字符串/);
  });
});

describe('采纳判据', () => {
  const gateOk: GateResult = {
    ok: true,
    code: 'pass',
    reason: '修好 1 条',
    regressedCases: [],
    fixedCases: ['a'],
    passRateDelta: 0.5,
    tokenDelta: 0,
    costDelta: 0,
    costBasis: 'cost',
    sameAssets: false,
    sameCaseSet: true,
    onlyInBaseline: [],
    onlyInCandidate: [],
    sameModel: undefined,
    sameAgent: true,
  };
  const proposal = {
    id: 'p1',
    modeId: 'm',
    kind: 'wrong_answer' as const,
    rationale: 'r',
    layer: 'L1' as const,
    patch: { target: 'agent:main', before: 'a', after: 'b' },
  };
  const makeOutcome = (holdout?: HoldoutResult): VerifyOutcome => {
    const empty = summarize([result('a', true)], fingerprint('x'), 'main@1');
    return {
      proposal,
      baseline: empty,
      candidate: empty,
      gate: gateOk,
      ...(holdout !== undefined ? { holdout } : {}),
    };
  };
  const holdout = (ok: boolean): HoldoutResult => {
    const empty = summarize([result('b', true)], fingerprint('y'), 'main@1');
    return {
      baseline: empty,
      candidate: empty,
      gate: {
        ...gateOk,
        ok,
        code: ok ? 'pass' : 'case_regression',
        reason: ok ? '留出集无变化' : '留出集原本通过的用例变失败：b',
        fixedCases: [],
        passRateDelta: 0,
        regressedCases: ok ? [] : ['b'],
      },
    };
  };

  it('train 变好且留出集没退步才值得采纳', () => {
    assert.equal(isWorthAccepting(makeOutcome()), true);
    assert.equal(isWorthAccepting(makeOutcome(holdout(true))), true);
    assert.equal(isWorthAccepting(makeOutcome(holdout(false))), false);
  });
});
