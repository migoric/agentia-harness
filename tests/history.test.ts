import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  appendRun,
  caseTrends,
  flakyCases,
  historyPath,
  readHistory,
} from '../src/evals/history.ts';
import { summarize } from '../src/evals/report.ts';
import type { CaseResult, EvalReport } from '../src/evals/types.ts';

function tmp(): { workspaceDir: string } {
  return { workspaceDir: mkdtempSync(join(tmpdir(), 'harness-hist-')) };
}

function sample(name: string, passed: boolean, extra: Partial<CaseResult> = {}): CaseResult {
  return {
    name,
    task: '做点事',
    passed,
    failures: passed ? [] : ['正文缺少 "要点"'],
    tokens: 100,
    costUsd: 0.01,
    iterations: 1,
    durationMs: 50,
    stopReason: 'end_turn',
    excerpt: 'x',
    traceId: 'tr',
    skills: [],
    subagents: [],
    ...extra,
  };
}

/** 造一份报告；`asset` 区分「同一份资产」与「改过资产」 */
function report(rows: readonly CaseResult[], asset = 'A', cases = 'C'): EvalReport {
  return { ...summarize(rows, asset, 'main@1'), caseFingerprint: cases };
}

function record(
  ws: { workspaceDir: string },
  rows: readonly CaseResult[],
  opts: { asset?: string; cases?: string; at?: string } = {},
): void {
  const r = report(rows, opts.asset ?? 'A', opts.cases ?? 'C');
  appendRun(ws, { ...r, finishedAt: opts.at ?? new Date().toISOString() });
}

describe('appendRun / readHistory', () => {
  it('一次运行一行，能原样读回（含成本与耗时）', () => {
    const ws = tmp();
    record(ws, [sample('a', true)], { at: '2026-11-28T10:00:00.000Z' });
    record(ws, [sample('a', false)], { at: '2026-11-28T11:00:00.000Z' });

    const raw = readFileSync(historyPath(ws), 'utf8').trimEnd().split('\n');
    assert.equal(raw.length, 2, '一次运行一行 —— 半行写坏不会污染其余运行');

    const { runs, skipped } = readHistory(ws);
    assert.equal(skipped, 0);
    assert.equal(runs.length, 2);
    assert.equal(runs[0]?.at, '2026-11-28T10:00:00.000Z');
    assert.equal(runs[0]?.outcomes[0]?.costUsd, 0.01);
    assert.equal(runs[1]?.outcomes[0]?.passed, false);
  });

  it('老报告没有 samples ⇒ 按 1 次采样记，不丢', () => {
    const ws = tmp();
    record(ws, [sample('a', true)]);
    const c = readHistory(ws).runs[0]?.outcomes[0];
    assert.equal(c?.samples, 1);
    assert.equal(c?.passedSamples, 1);
  });

  it('坏行计数跳过，其余照读（历史是旁证，不该挡住主流程）', () => {
    const ws = tmp();
    record(ws, [sample('a', true)]);
    writeFileSync(historyPath(ws), `${readFileSync(historyPath(ws), 'utf8')}{不是 json}\n`, 'utf8');
    record(ws, [sample('a', true)]);
    const { runs, skipped } = readHistory(ws);
    assert.equal(skipped, 1);
    assert.equal(runs.length, 2);
  });

  it('没有账本时返回空而不是抛错（第一次跑之前就是这个状态）', () => {
    assert.deepEqual(readHistory(tmp()), { runs: [], skipped: 0 });
  });
});

describe('caseTrends —— 抖动的判据是「同条件矛盾」', () => {
  it('同样资产 + 同样用例集下既过又挂 ⇒ 抖动，且理由能复核', () => {
    const ws = tmp();
    record(ws, [sample('a', true)]);
    record(ws, [sample('a', false)]);
    const [t] = caseTrends(readHistory(ws).runs);
    assert.equal(t?.flaky, true);
    assert.equal(t?.recent, 'PF');
    assert.match(
      t?.why ?? '',
      /1 次全过、1 次全挂/,
      '理由要写事实（几次过几次挂），不是「不稳定」三个字',
    );
  });

  it('资产改过 ⇒ 不算抖动（那是真的动了东西，不是同条件矛盾）', () => {
    const ws = tmp();
    record(ws, [sample('a', false)], { asset: 'A' });
    record(ws, [sample('a', true)], { asset: 'B' });
    const [t] = caseTrends(readHistory(ws).runs);
    assert.equal(t?.flaky, false, '修复会改变资产指纹；按指纹分组才能把「修好了」与「在抖」分开');
  });

  it('用例集指纹改了（断言收紧）⇒ 也不算抖动', () => {
    const ws = tmp();
    record(ws, [sample('a', true)], { cases: 'C1' });
    record(ws, [sample('a', false)], { cases: 'C2' });
    assert.equal(caseTrends(readHistory(ws).runs)[0]?.flaky, false);
  });

  it('同一次运行内既有通过也有失败 ⇒ 直接判抖动（这是抖动的定义式证据）', () => {
    const ws = tmp();
    record(ws, [sample('a', true, { samples: 3, passedSamples: 2 })]);
    const [t] = caseTrends(readHistory(ws).runs);
    assert.equal(t?.flaky, true);
    assert.match(t?.why ?? '', /运行内部/);
    assert.equal(t?.recent, '·');
  });

  it('始终通过或始终失败不算抖动（失败是坏的，但不是「不可信」）', () => {
    const ws = tmp();
    for (const p of [true, true, true]) record(ws, [sample('a', p)]);
    assert.equal(caseTrends(readHistory(ws).runs)[0]?.flaky, false);
  });

  /**
   * 真机误判的回归测试：用错 key 跑了一轮 nightly，三条用例全 `stopReason=error`，
   * 于是账本里出现「同样条件下既过又挂」，三条用例被标成抖动、失去否决权。
   * 那次失败说明的是 key 错了，与用例稳不稳毫无关系。
   */
  it('跑成了 + 401 失败 ⇒ 不算抖动，只记一次「没跑成」', () => {
    const ws = tmp();
    record(ws, [sample('a', true)]);
    record(ws, [sample('a', false, { stopReason: 'error' })]);
    const [t] = caseTrends(readHistory(ws).runs);
    assert.equal(t?.flaky, false, '基础设施失败不携带任何关于用例稳定性的信息');
    assert.equal(t?.infraRuns, 1);
    assert.equal(t?.recent, 'PE', 'E 是「没跑成」，不能与 F（跑了没过）混成一个符号');
  });

  it('超时与抛异常同样不算证据', () => {
    const ws = tmp();
    record(ws, [sample('a', true)]);
    record(ws, [sample('a', false, { stopReason: 'timeout' })]);
    record(ws, [sample('a', false, { stopReason: 'threw' })]);
    assert.equal(caseTrends(readHistory(ws).runs)[0]?.flaky, false);
  });

  it('但正常收尾的失败仍然是证据（`max_iterations` 是行为，不是环境）', () => {
    const ws = tmp();
    record(ws, [sample('a', true)]);
    record(ws, [sample('a', false, { stopReason: 'max_iterations' })]);
    assert.equal(caseTrends(readHistory(ws).runs)[0]?.flaky, true);
  });

  it('通过率是真的（样本级），均 token 与均成本按运行取平均', () => {
    const ws = tmp();
    record(ws, [sample('a', true, { tokens: 100, costUsd: 0.02 })]);
    record(ws, [sample('a', false, { tokens: 300, costUsd: 0.04 })]);
    const [t] = caseTrends(readHistory(ws).runs);
    assert.equal(t?.passRate, 0.5);
    assert.equal(t?.avgTokens, 200);
    assert.ok(Math.abs((t?.avgCostUsd ?? 0) - 0.03) < 1e-9);
  });

  it('只按「出现过该用例的运行」取窗口（--only 跑一部分是常态）', () => {
    const ws = tmp();
    record(ws, [sample('a', true)]);
    for (let i = 0; i < 5; i += 1) record(ws, [sample('b', true)]);
    record(ws, [sample('a', false)]);
    const trends = caseTrends(readHistory(ws).runs);
    const a = trends.find((t) => t.name === 'a');
    assert.equal(a?.runs, 2, '五条 b 的运行不该把 a 的次数稀释成 2/7');
  });

  it('窗口之外的旧记录不参与抖动判定', () => {
    const ws = tmp();
    record(ws, [sample('a', false)]);
    for (let i = 0; i < 4; i += 1) record(ws, [sample('a', true)]);
    assert.equal(caseTrends(readHistory(ws).runs, { window: 4 })[0]?.flaky, false);
    assert.equal(caseTrends(readHistory(ws).runs)[0]?.flaky, true);
  });

  it('flakyCases 只交出抖动的那些', () => {
    const ws = tmp();
    record(ws, [sample('a', true), sample('b', true)]);
    record(ws, [sample('a', false), sample('b', true)]);
    assert.deepEqual([...flakyCases(ws)], ['a']);
  });

  it('抖动排在最前（人打开 history 第一眼要看的就是它们）', () => {
    const ws = tmp();
    record(ws, [sample('a', true), sample('z', true)]);
    record(ws, [sample('a', false), sample('z', true)]);
    assert.equal(caseTrends(readHistory(ws).runs)[0]?.name, 'a');
  });
});
