import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { addSpend, readSpendWindow, spendWindowPath } from '../src/rsi/spend-ledger.ts';

/**
 * 预算窗口：`--watch --max-cost` 的账跨进程连续。
 *
 * 缺口是具体的：累计花费此前只在内存里，进程被 kill 重启就从 0 开始，一个写死
 * `--max-cost 2` 的 worker 一夜重启五次能花 10 美元，而每一轮的「单轮花费」都合格。
 */
function project() {
  const root = mkdtempSync(join(tmpdir(), 'harness-spend-'));
  mkdirSync(join(root, 'agents'), { recursive: true });
  writeFileSync(join(root, 'harness.config.json'), '{"model":"claude-opus-5"}');
  return loadConfig(root);
}

const HOUR = 3_600_000;

describe('预算窗口', () => {
  it('没有记录时从 0 起算', () => {
    const { window } = readSpendWindow(project());
    assert.equal(window.usd, 0);
    assert.equal(window.runs, 0);
  });

  it('多次记账累加，窗口起点不变', () => {
    const config = project();
    const first = addSpend(config, { usd: 0.4, tokens: 100 }, { now: 1_000_000 });
    const second = addSpend(config, { usd: 0.35, tokens: 80 }, { now: 1_000_500 });
    assert.equal(first.startedAt, 1_000_000);
    assert.equal(second.startedAt, 1_000_000, '起点是第一次记账，不是最后一次');
    assert.ok(Math.abs(second.usd - 0.75) < 1e-9);
    assert.equal(second.tokens, 180);
    assert.equal(second.runs, 2);
  });

  it('超过窗口就重置（否则 worker 跑几天后永远停在那里）', () => {
    const config = project();
    addSpend(config, { usd: 1.9 }, { now: 1_000_000 });
    const later = readSpendWindow(config, { now: 1_000_000 + 25 * HOUR });
    assert.equal(later.window.usd, 0);
    assert.match(String(later.note), /窗口已过期/);
  });

  it('负增量不采纳（坏读数不该让预算往「永远不超」的方向倒）', () => {
    const config = project();
    addSpend(config, { usd: 1 }, { now: 1_000_000 });
    const w = addSpend(config, { usd: -5 }, { now: 1_000_100 });
    assert.equal(w.usd, 1);
  });

  it('文件坏了：开新窗口、留存旧文件、并说出来（不能静默归零）', () => {
    const config = project();
    mkdirSync(join(config.workspaceDir, 'rsi'), { recursive: true });
    writeFileSync(spendWindowPath(config), '{ half', 'utf8');
    const { window, note } = readSpendWindow(config);
    assert.equal(window.usd, 0);
    assert.match(String(note), /读不出来/);
    const kept = readdirSync(join(config.workspaceDir, 'rsi')).filter((n) =>
      n.includes('spend.json.corrupt-'),
    );
    assert.equal(kept.length, 1, '旧文件要留存，它是这类故障里唯一还能查的东西');
    assert.ok(existsSync(join(config.workspaceDir, 'rsi', kept[0] ?? '')));
  });
});
