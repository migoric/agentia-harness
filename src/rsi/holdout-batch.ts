import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorkspacePaths } from '../config.js';
import { HarnessError } from '../errors.js';

/**
 * 留出集的**消耗账** —— 不变量 8（「留出集只验一次」）的跨轮实现。
 *
 * 一轮之内只验一次是对的，但它只保护**有限轮次**：留出集不变而轮次无限时，
 * 30 轮 × 每轮 5% 显著性的累积假阳性约 78%。每一轮的门都在「合法地」放过一点噪声，
 * 而每一轮都比上一轮更自信 —— RRSI 的对照组正是这么长出来的。
 *
 * 修法不是「多留一点用例」（那只是把常数改大），是**让留出集可消耗**：
 * 把留出集切成 K 批（`evals/*.md` 的 `phase`），每批**只用一次**，用掉就换下一批，
 * K 批用完就拒绝继续验 —— 此时唯一的出路是补新一批用例。
 *
 * 三条纪律：
 *
 * 1. **消耗与结果无关**。验一眼就是消耗一眼，通过也好、否决也好，这一批都用掉了。
 *    只在「通过」时才记账，等于把通不过的尝试变成免费的重复抽样，而那正是假阳性的来源。
 * 2. **未分期 ≠ 分批**。没写 `phase` 的工程照旧（整份留出集算一批，不硬拦），
 *    但复用次数会被记下来并出声。加字段之前行为不被悄悄改掉：老工程第一次跑新版本
 *    不该突然收到「你的留出集用完了」。
 * 3. **账本坏了就炸**。半截 JSON 一律报错，不跳过 —— 静默少一条消耗记录，
 *    等于白送你一批已经用过的留出集。
 */
export interface HoldoutUse {
  readonly at: number;
  readonly cycleId: string;
  readonly proposalId: string;
  /** 批次号；未分期时是 1 */
  readonly phase: number;
  /** 这次验的是哪些用例（落盘，事后能看出「当时那一批」是什么） */
  readonly cases: readonly string[];
  readonly passed: boolean;
  readonly reason: string;
}

export interface BatchProgress {
  readonly phase: number;
  readonly cases: readonly string[];
  /** 这一批被用过几次；`0` = 还没用过 */
  readonly used: number;
  /** 最近一次被用掉的时刻（毫秒） */
  readonly lastUsedAt: number | undefined;
  /** 最近一次用它验的提案 —— 人要回查时唯一有用的线索 */
  readonly lastProposalId: string | undefined;
}

export interface HoldoutProgress {
  /**
   * 工程是否**声明了**批次（至少一条留出用例写了 `phase`）。
   *
   * false = 未分期：`batches` 里只有合成的一批（phase 1），复用不拦只数。
   * 这个布尔不进 `EvalReport`（它不是报告事实，是配置事实），由用例现算。
   */
  readonly enforced: boolean;
  readonly batches: readonly BatchProgress[];
}

export type BatchPick =
  | { readonly ok: true; readonly batch: BatchProgress }
  | { readonly ok: false; readonly reason: string };

export function holdoutUsePath(config: WorkspacePaths): string {
  return join(config.workspaceDir, 'rsi', 'holdout-uses.jsonl');
}

export function readHoldoutUses(config: WorkspacePaths): HoldoutUse[] {
  const path = holdoutUsePath(config);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: HoldoutUse[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new HarnessError(
        'rsi.no_signal',
        `留出集消耗账第 ${i + 1} 行不是合法 JSON（${path}）—— 拒绝跳过：` +
          '漏读一条消耗记录等于白送一批已经用过的留出集。请手工核对哪几批确实用过，再修好这一行',
        e,
      );
    }
    out.push(useAt(parsed, path, i));
  }
  return out;
}

function useAt(v: unknown, path: string, i: number): HoldoutUse {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new HarnessError('rsi.no_signal', `留出集消耗账第 ${i + 1} 行不是对象（${path}）`);
  }
  const o = v as Record<string, unknown>;
  const phase = o.phase;
  if (typeof phase !== 'number' || !Number.isInteger(phase) || phase < 1) {
    throw new HarnessError(
      'rsi.no_signal',
      `留出集消耗账第 ${i + 1} 行缺少合法的 phase（${path}）—— 这一批算不算用过无从判断`,
    );
  }
  return {
    at: typeof o.at === 'number' ? o.at : 0,
    cycleId: typeof o.cycleId === 'string' ? o.cycleId : '',
    proposalId: typeof o.proposalId === 'string' ? o.proposalId : '',
    phase,
    cases: Array.isArray(o.cases) ? o.cases.filter((c): c is string => typeof c === 'string') : [],
    passed: o.passed === true,
    reason: typeof o.reason === 'string' ? o.reason : '',
  };
}

export function appendHoldoutUse(config: WorkspacePaths, use: HoldoutUse): void {
  const path = holdoutUsePath(config);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(use)}\n`, 'utf8');
}

/** 只需要「名字 + 批次号」—— 事件源既可以是报告里的 `CaseResult`，也可以是磁盘上的 `EvalCase` */
export interface HoldoutCase {
  readonly name: string;
  readonly phase?: number | undefined;
}

/**
 * 算出分批进度。
 *
 * 传进来的必须**只有留出用例**：这个函数不管 train/holdout 的划分，那件事只有一个判法
 * （`split.ts`）。之所以收窄到 `{name, phase}` 而不是整份 `EvalReport`，是为了让
 * `rsi status` 能在**不跑评测**的前提下回答「还剩几批」—— 那是人最想知道的一句。
 */
export function holdoutProgress(
  config: WorkspacePaths,
  holdout: readonly HoldoutCase[],
): HoldoutProgress {
  const grouped = new Map<number, string[]>();
  let enforced = false;
  for (const c of holdout) {
    if (c.phase !== undefined) enforced = true;
    const phase = c.phase ?? 1;
    const list = grouped.get(phase) ?? [];
    list.push(c.name);
    grouped.set(phase, list);
  }
  const uses = readHoldoutUses(config);
  const batches = [...grouped.entries()]
    .sort(([a], [b]) => a - b)
    .map(([phase, names]): BatchProgress => {
      const mine = uses.filter((u) => u.phase === phase);
      const last = mine[mine.length - 1];
      return {
        phase,
        cases: [...names].sort(),
        used: mine.length,
        lastUsedAt: last?.at,
        lastProposalId: last?.proposalId,
      };
    });
  return { enforced, batches };
}

/**
 * 挑这一轮该用哪一批。
 *
 * 声明了批次 ⇒「序号最小、还没用过」的那一批；全用过则**拒绝**（不是退回第一批发重新用）。
 * 未声明 ⇒ 合成一批，永远可挑（复用照旧），由调用方把复用次数说出来。
 *
 * 为什么是「最小未用」而不是「随机」或「轮转」：轮转会在中途重排批次身份，
 * 于是「这一批用过几次」变得依赖轮转历史；而消耗账是按 `phase` 记的，两者一错位，
 * 消耗就再也算不清。
 */
export function pickHoldoutBatch(progress: HoldoutProgress): BatchPick {
  const first = progress.batches[0];
  if (first === undefined) {
    return { ok: false, reason: '留出集是空的 —— 没有任何用例可验' };
  }
  const fresh = progress.batches.find((b) => b.used === 0);
  if (!progress.enforced) {
    // 未分期：整份留出集就是一批。`used` 累计着复用次数（调用方据此出声）
    return { ok: true, batch: fresh ?? first };
  }
  if (fresh === undefined) {
    const list = progress.batches
      .map((b) => {
        const when =
          b.lastUsedAt === undefined
            ? ''
            : `（${new Date(b.lastUsedAt).toISOString().slice(0, 10)}）`;
        return `第 ${b.phase} 批 ${b.cases.length} 条${when}`;
      })
      .join('、');
    return {
      ok: false,
      reason:
        `留出集的 ${progress.batches.length} 批全部用过了（${list}）—— 拒绝再用其中任何一批：` +
        '同一批验第二次时，它已经是被候选挑选过的数据，等于把留出集变成第二个 train。' +
        '补一批新用例（给它们一个没出现过的 phase 号）再继续，或就此收工',
    };
  }
  return { ok: true, batch: fresh };
}

/** 便于人读的一行 —— CLI 与轮次记录共用同一句措辞，避免两处说法不一致 */
export function describeProgress(progress: HoldoutProgress): string {
  if (progress.batches.length === 0) return '留出集为空';
  const used = progress.batches.filter((b) => b.used > 0).length;
  const total = progress.batches.length;
  const cases = progress.batches.reduce((sum, b) => sum + b.cases.length, 0);
  if (!progress.enforced) {
    const reuse = progress.batches[0]?.used ?? 0;
    return reuse === 0
      ? `留出集 ${cases} 条（未分期：算作同一批，可复用）`
      : `留出集 ${cases} 条（未分期：已复用 ${reuse} 次 —— 每多用一次，假阳性就多积一点）`;
  }
  return `留出集 ${total} 批共 ${cases} 条（已用 ${used}/${total} 批）`;
}
