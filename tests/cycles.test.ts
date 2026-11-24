import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type HarnessConfig, loadConfig } from '../src/config.ts';
import { HarnessError } from '../src/errors.ts';
import { CYCLE_SCHEMA, readCycles } from '../src/rsi/cycles.ts';
import { readLedger } from '../src/rsi/ledger.ts';
import { writeCycle } from '../src/rsi/loop.ts';
import { cyclesDir } from '../src/rsi/paths.ts';

/**
 * `cycles/*.json` 的读取契约。
 *
 * 这层此前不存在：`regress` 与 `ledger` 各有一份读实现，且对同一条坏记录的反应不同
 * （一个 `HarnessError`、一个原生 `TypeError: report.verified is not iterable`）。
 * 这里的断言守两件事：坏记录一律可读地报错；老记录（无 `schema` / 无 `at`）照常可读。
 */

function project(): HarnessConfig {
  const root = mkdtempSync(join(tmpdir(), 'cycles-'));
  writeFileSync(join(root, 'harness.config.json'), '{}');
  const config = loadConfig(root);
  mkdirSync(cyclesDir(config), { recursive: true });
  return config;
}

function put(config: HarnessConfig, name: string, body: unknown): string {
  const path = join(cyclesDir(config), name);
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return path;
}

function base(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cycleId: '2026-01-01T00-00-00-000Z',
    modes: [],
    proposals: [],
    verified: [],
    accepted: [],
    rejected: [],
    dryRun: false,
    costUsd: 0,
    costKnown: true,
    ...extra,
  };
}

describe('cycles 读取：坏记录必须说清是哪儿坏', () => {
  it('缺 verified ⇒ HarnessError（曾经这里是 TypeError: not iterable）', () => {
    const config = project();
    put(config, 'a.json', { cycleId: 'a', accepted: [] });

    assert.throws(
      () => readCycles(config),
      (e: unknown) =>
        e instanceof HarnessError && e.code === 'rsi.no_signal' && /verified/.test(e.message),
    );
    // 账本与回归共用同一处判定：同一条坏记录不该在两处得到两种错误
    assert.throws(
      () => readLedger(config),
      (e: unknown) => e instanceof HarnessError,
    );
  });

  it('verified 里的条目缺 candidate.cases ⇒ 报出下标', () => {
    const config = project();
    put(config, 'a.json', base({ verified: [{ proposal: { id: 'p1' }, candidate: {} }] }));

    assert.throws(
      () => readCycles(config),
      (e: unknown) =>
        e instanceof HarnessError && /verified\[0\]\.candidate\.cases/.test(e.message),
    );
  });

  it('accepted 里的条目缺 id ⇒ 报出下标', () => {
    const config = project();
    put(config, 'a.json', base({ accepted: [{ patch: {} }] }));

    assert.throws(
      () => readCycles(config),
      (e: unknown) => e instanceof HarnessError && /accepted\[0\]\.id/.test(e.message),
    );
  });

  it('整个文件不是 JSON ⇒ 报路径，不跳过', () => {
    const config = project();
    const path = join(cyclesDir(config), 'a.json');
    writeFileSync(path, '{"cycleId":', 'utf8');

    assert.throws(
      () => readCycles(config),
      (e: unknown) => e instanceof HarnessError && e.message.includes(path),
    );
  });
});

describe('cycles 读取：版本与时间', () => {
  it('老记录（无 schema / 无 at）⇒ schemaVersion 0，时刻从 cycleId 反解', () => {
    const config = project();
    // 文件名与 cycleId 故意不一致：改文件名不该改变「这是哪一轮」
    put(config, 'renamed.json', base());

    const [record] = readCycles(config);
    assert.ok(record !== undefined);
    assert.equal(record.schemaVersion, 0);
    assert.equal(record.at, undefined);
    assert.equal(record.timeMs, Date.parse('2026-01-01T00:00:00.000Z'));
  });

  it('连 cycleId 都没有 ⇒ 用文件名兜底（不报错：文件名就是它的来源）', () => {
    const config = project();
    const { cycleId: _drop, ...rest } = base();
    put(config, '2026-03-04T05-06-07-008Z.json', rest);

    const [record] = readCycles(config);
    assert.equal(record?.cycleId, '2026-03-04T05-06-07-008Z');
    assert.equal(record?.timeMs, Date.parse('2026-03-04T05:06:07.008Z'));
  });

  it('新记录 ⇒ schemaVersion 是写入值，时刻优先取 at 字段', () => {
    const config = project();
    put(
      config,
      '2026-03-04T05-06-07-008Z.json',
      base({ schema: CYCLE_SCHEMA, at: '2026-05-06T00:00:00.000Z' }),
    );

    const [record] = readCycles(config);
    assert.equal(record?.schemaVersion, CYCLE_SCHEMA);
    assert.equal(record?.timeMs, Date.parse('2026-05-06T00:00:00.000Z'));
  });

  it('文件名读不出时间 ⇒ 0（排到最后，但不阻塞整本账）', () => {
    const config = project();
    put(config, 'hand-renamed.json', base({ cycleId: 'hand-renamed' }));

    assert.equal(readCycles(config)[0]?.timeMs, 0);
  });

  it('writeCycle 落盘带 schema（读取侧据此迁移）', () => {
    const config = project();
    const report = writeCycle(config, {
      modes: [],
      proposals: [],
      verified: [],
      accepted: [],
      rejected: [],
      baseline: undefined,
      dryRun: true,
      costUsd: 0,
      costKnown: true,
      budget: undefined,
    });

    const raw = JSON.parse(readFileSync(report.path, 'utf8')) as { schema?: number };
    assert.equal(raw.schema, CYCLE_SCHEMA);
    assert.equal(readCycles(config)[0]?.dryRun, true);
  });
});
