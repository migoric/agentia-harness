import type { WorkspacePaths } from '../../config.js';
import { readCycles } from '../../rsi/cycles.js';
import { readJournal } from '../../rsi/journal.js';
import { describeWorker } from '../../rsi/worker-lock.js';

/**
 * 读 RSI 的产物：轮次记录、账本、worker 状态。
 *
 * 三件事都**复用 CLI 用的同一个读入口**（`readCycles` / `readJournal`），不在这里
 * 再解析一遍 JSON。理由是那两处已经有一套「坏记录拒绝跳过」的策略：`readCycles`
 * 遇到格式不对的记录会抛 `rsi.no_signal` 并指出文件与下标。看板若自己读，就会长出
 * 第二套宽容度 —— 于是同一份坏记录，`rsi ledger` 报错而看板显示「0 轮」，
 * 两边吵架时没人知道该信谁。
 *
 * 代价是看板在「记录坏了」时会整块失败。这个代价是**故意付的**：轮次记录是审计
 * 证据，坏了就该让人知道，而不是让看板安静地显示一份空表。
 */
export interface CycleSummary {
  readonly cycleId: string;
  readonly at?: string;
  readonly dryRun: boolean;
  readonly schemaVersion: number;
  /** 这一轮验证了几个提案 / 采纳了几条（看板第一眼要看的就是这两个数） */
  readonly verified: number;
  readonly accepted: number;
  readonly acceptedIds: readonly string[];
  /** 采纳涉及的目标（`skill:foo` / `agent:bar` 这样的标签，来自提案） */
  readonly targets: readonly string[];
}

export interface CycleList {
  readonly dir: string;
  readonly cycles: readonly CycleSummary[];
}

export function listCycles(p: WorkspacePaths): CycleList {
  const records = readCycles(p);
  const cycles = records
    .map((r) => toSummary(r))
    // 新的在前：与报告列表同一个口径。
    //
    // 这里的比较器必须**整段**比较，不能写成 `a.at ?? '' < b.at` —— `??` 的优先级
    // 低于 `<`，那样写出来的表达式实际是 `a.at ?? ('' < b.at)`，两边都有 `at` 时
    // 返回值是那个字符串本身（真值），比较器退化成「一切大于一切」，顺序等于没排。
    // 症状极其安静：概览的「最近一轮 RSI」一直显示最早的那一轮。
    .sort((a, b) => {
      const x = a.at ?? '';
      const y = b.at ?? '';
      if (x === y) return 0;
      return x < y ? 1 : -1;
    });
  return { dir: p.workspaceDir, cycles };
}

function toSummary(r: ReturnType<typeof readCycles>[number]): CycleSummary {
  const targets = new Set<string>();
  for (const v of r.verified) {
    // `readCycles` 只校验 proposal.id 与 candidate.cases（按「谁会立刻崩」定的深度），
    // 所以 `patch.target` 可能缺席（手写的记录）。看板不该因为一个展示字段就 500
    const t = v.proposal.patch?.target;
    if (typeof t === 'string') targets.add(t);
  }
  return {
    cycleId: r.cycleId,
    ...(r.at !== undefined ? { at: r.at } : {}),
    dryRun: r.dryRun,
    schemaVersion: r.schemaVersion,
    verified: r.verified.length,
    accepted: r.accepted.length,
    acceptedIds: r.accepted.map((a) => a.id),
    targets: [...targets].sort(),
  };
}

export type CycleLoad =
  | { readonly ok: true; readonly cycle: Record<string, unknown> }
  | { readonly ok: false; readonly why: 'not_found' };

/**
 * 单轮明细。**去掉 `path` 字段**：它是宿主机上的绝对路径，看板没有展示它的必要，
 * 而绝对路径是最容易随截图/工单外流的东西。
 */
export function loadCycle(p: WorkspacePaths, id: string): CycleLoad {
  const hit = readCycles(p).find((r) => r.cycleId === id);
  if (hit === undefined) return { ok: false, why: 'not_found' };
  const { path: _path, ...rest } = hit;
  void _path;
  return { ok: true, cycle: rest as unknown as Record<string, unknown> };
}

export interface JournalTail {
  readonly total: number;
  readonly entries: readonly unknown[];
}

/** 账本尾部。`limit` 默认 50、上限 500 —— 账本是 append-only，可能很长 */
export function journalTail(p: WorkspacePaths, limit: number | undefined): JournalTail {
  const all = readJournal(p);
  const n = Math.min(Math.max(limit ?? 50, 1), 500);
  return { total: all.length, entries: all.slice(-n) };
}

export function workerState(p: WorkspacePaths): ReturnType<typeof describeWorker> {
  return describeWorker(p);
}
