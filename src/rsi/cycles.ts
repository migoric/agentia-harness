import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { WorkspacePaths } from '../config.js';
import { HarnessError } from '../errors.js';
import { objectAt, readJsonObject, requiredText } from '../util/shape.js';
import { cyclesDir } from './paths.js';
import type { Proposal, VerifyOutcome } from './types.js';

/**
 * `cycles/*.json` 的**唯一读入口**。
 *
 * 抽这件不是因为「文件太长」，是因为同一份目录此前有两份读实现（`regress` 找候选基准、
 * `ledger` 拼决策史），而且两份的健壮性不一致：`regress` 检查了 `verified` 是不是数组，
 * `ledger` 直接 `for...of` —— 同一条坏记录，`rsi regress` 报 `HarnessError`，
 * `rsi ledger` 抛原生 `TypeError: report.verified is not iterable`。
 *
 * 两条策略现在只有一处：
 *
 * 1. **坏记录拒绝跳过**。静默跳过会让「预测兑现率」失去意义（分母被悄悄改小），
 *    所以读失败一律 `rsi.no_signal`，并带上路径与下标 —— 报错要能直接定位到文件。
 * 2. **版本迁移集中在这里**。`schema` 是写入侧打的标；没有它的记录按 0（
 *    版本化之前的格式）处理，字段缺失的兜底也全部落在本文件，别处不再各自 `??`。
 *
 * 字段校验只做「能立刻证伪」的那几条：`verified[].proposal.id`、`verified[].candidate.cases`、
 * `accepted[].id`。这三条正好是三个消费点（`findCandidate` / `ledger` / `rounds`）会
 * 立刻解引用的路径 —— 校验深度按「谁会立刻崩」定，不追求完整 schema。
 */
export const CYCLE_SCHEMA = 2;

export interface CycleRecord {
  readonly path: string;
  /** 记录格式版本；0 = 版本化之前写下的（那时连 `at` 都没有） */
  readonly schemaVersion: number;
  readonly cycleId: string;
  readonly at: string | undefined;
  /**
   * 排序 / 取最近用的毫秒时刻：`at` 字段优先，文件名兜底。
   *
   * 文件名只该给人看，但老记录没有 `at`，只能从 `2026-11-20T14-30-05-123Z` 反解 ——
   * 解析失败返回 0（排到最后），而不是抛错：老记录不该让整本账读不出来。
   */
  readonly timeMs: number;
  readonly dryRun: boolean;
  readonly verified: readonly VerifyOutcome[];
  readonly accepted: readonly Proposal[];
}

/** 读全部轮次记录（按文件名排序 = 时间序）。目录不存在返回空数组。 */
export function readCycles(config: WorkspacePaths): CycleRecord[] {
  const dir = cyclesDir(config);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => readCycle(join(dir, file)));
}

function readCycle(path: string): CycleRecord {
  const raw = readJsonObject(path, (message, cause) => {
    throw new HarnessError('rsi.no_signal', `坏掉的轮次记录 ${message} —— 账本拒绝跳过它`, cause);
  });
  const fail = (message: string): never => {
    throw new HarnessError('rsi.no_signal', `${path}: ${message} —— 账本拒绝读坏记录`);
  };

  // 老记录一定有 cycleId（它同时是文件名来源），但人手改名/早期手工文件可能缺 ——
  // 用文件名兜底而不是报错：cycleId 是「哪一轮」的标识，文件名就是它的来源
  const cycleId =
    typeof raw.cycleId === 'string' && raw.cycleId.trim() !== ''
      ? raw.cycleId
      : basename(path, '.json');
  const at = typeof raw.at === 'string' ? raw.at : undefined;
  const verified = arrayAt(raw.verified, `${path} 的 verified`, fail).map((v, i) =>
    verifyAt(v, `${path} 的 verified[${i}]`, fail),
  );
  const accepted = arrayAt(raw.accepted, `${path} 的 accepted`, fail).map((p, i) => {
    const o = objectAt(p, `${path} 的 accepted[${i}]`, fail);
    requiredText(o.id, `${path} 的 accepted[${i}].id`, fail);
    return o as unknown as Proposal;
  });

  return {
    path,
    schemaVersion: typeof raw.schema === 'number' ? raw.schema : 0,
    cycleId,
    at,
    timeMs: timeOf(at, cycleId),
    dryRun: raw.dryRun === true,
    verified,
    accepted,
  };
}

function verifyAt(v: unknown, where: string, fail: (m: string) => never): VerifyOutcome {
  const o = objectAt(v, where, fail);
  const proposal = objectAt(o.proposal, `${where}.proposal`, fail);
  requiredText(proposal.id, `${where}.proposal.id`, fail);
  const candidate = objectAt(o.candidate, `${where}.candidate`, fail);
  arrayAt(candidate.cases, `${where}.candidate.cases`, fail);
  return o as unknown as VerifyOutcome;
}

function arrayAt(v: unknown, where: string, fail: (m: string) => never): readonly unknown[] {
  if (!Array.isArray(v)) fail(`${where} 应是数组`);
  return v;
}

/** `at` 优先，文件名兜底；两者都读不出时间就是 0（排到最后，但不阻塞） */
function timeOf(at: string | undefined, cycleId: string): number {
  if (at !== undefined) {
    const t = Date.parse(at);
    if (!Number.isNaN(t)) return t;
  }
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(cycleId);
  if (m === null) return 0;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(t) ? 0 : t;
}
