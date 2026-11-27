import type { WorkspacePaths } from '../config.js';
import { HarnessError } from '../errors.js';
import type { CycleRecord } from './cycles.js';
import { readCycles } from './cycles.js';
import type { AssetPatch, Proposal } from './types.js';

/**
 * 净简化配额 —— 给「成本只涨不跌」这道单向棘轮装一个刹车。
 *
 * 回归门的第 5 行是刻意的宽容：**通过率提升时，成本涨多少都放行（只记录）**。
 * 理由成立 —— 用预算换能力是合理交易，把上限定死会让所有「更努力」的改动一律被拒，
 * 于是 RSI 只能学会偷懒。
 *
 * 但宽容是**单向**的：每一轮都可以加一点，没有任何一轮被迫删。RRSI 的对照组正是
 * 这么长成 3.80M tokens / 更低 OOD 的（进化集 92.8、OOD 40.3、tokens 3.80M；
 * 加上提议端限编辑数 + 选择端剪枝之后是 90.5 / 43.6 / 2.42M）。
 *
 * 所以这里**不改否决条件**（那会改掉「什么算变好」的对外解释），改的是**调度**：
 * 累计涨超阈值、或连续 N 条改动都没让资产变小，下一轮就变成**简化轮** ——
 * 只接受让正文净变短的提案。一轮一改不变，变的是「这一轮允许改什么」。
 *
 * 三个刻意的选择：
 *
 * 1. **状态从记录里现算，不落盘**。`cycles/*.json` 已经有每一条采纳与它的门结论，
 *    再加一个"当前是不是简化轮"的游标文件，就多了一处会与历史不一致的真相。
 *    现算的代价是每轮读一遍目录（几 KB），换来的是「历史改了，状态自动跟着改」。
 * 2. **用文本长度当复杂度的代理**。L1 只能改正文，没有代码、没有工具，
 *    长度是唯一可机械检查、又不可被话术讨好的量。它不完美（删掉一段有用的说明
 *    也是"变小"），但留出集与回归门会拦住真正有害的删除 —— 而"没变好但更小"，
 *    本来就是这一轮想要的。
 * 3. **配额是硬拒绝，不是偏好**。软偏好等于没有：模型永远有理由再补一段。
 */

export interface ShrinkPolicy {
  /** 距上次净简化已采纳这么多条改动，就要求下一轮简化（默认 5） */
  readonly every?: number;
  /**
   * 自上次简化以来，已采纳改动的累计成本增幅超过它，就要求简化（默认 0.5 = 50%）。
   *
   * 口径是**相对增幅逐条相加**，不是复利：它比真实复利偏保守（少算），
   * 而少算的那部分由 `every` 兜底 —— 两条触发条件同时存在，是为了让「成本读数缺失」
   * 的工程也迟早会遇到配额（读数缺失时增长那条永远不响）。
   */
  readonly maxGrowth?: number;
  /** 净减少的下限（占原正文比例，默认 0.05 = 5%） */
  readonly minReduction?: number;
}

export interface ShrinkState {
  /** true = 这一轮只接受净简化提案 */
  readonly required: boolean;
  /** 为什么（人话，进轮次记录与 CLI 输出）；不需要简化时为 undefined */
  readonly reason: string | undefined;
  /** 距上次净简化已采纳几条改动 */
  readonly sinceShrink: number;
  /**
   * 自上次简化以来累计成本增幅（相对增幅逐条相加）。
   *
   * 有采纳记录缺读数时它是**下界**：`basis === 'unknown'` 说明至少一条改动没测到，
   * 此时不要把 42% 读成"一共涨了 42%"。
   */
  readonly growth: number;
  readonly basis: 'cost' | 'tokens' | 'mixed' | 'unknown';
}

export const DEFAULT_SHRINK_POLICY: Required<ShrinkPolicy> = Object.freeze({
  every: 5,
  maxGrowth: 0.5,
  minReduction: 0.05,
});

/**
 * 这条补丁算不算「净简化」。
 *
 * 判据是正文长度的净减少，且要过 `minReduction` 的下限 —— 只删一个字就能"满足配额"
 * 的话，配额会被最小化成一枚印章。5% 对一份 60 行的提示词约等于删掉 3 行，
 * 正好是"合并两个重复段落"的量级。
 */
export function isShrinkPatch(
  patch: AssetPatch,
  minReduction = DEFAULT_SHRINK_POLICY.minReduction,
): boolean {
  const before = patch.before.trim().length;
  const after = patch.after.trim().length;
  if (before === 0) return false;
  return after <= before * (1 - minReduction);
}

export interface ShrinkPartition {
  /** 可以进入验证的提案 */
  readonly allowed: readonly Proposal[];
  /** 被配额挡下的提案 + 拒绝理由（要写进轮次记录，人得看得见配额怎么工作的） */
  readonly blocked: readonly { readonly proposal: Proposal; readonly reason: string }[];
}

/**
 * 简化轮的分区：**先筛再验**。
 *
 * 顺序有成本含义：变胖的提案一条都不跑评测。提完再验、验完再拒，等于为了说一句
 * "这条不算简化"而付一遍评测钱 —— 而简化轮本来就是成本最紧张的那一轮。
 *
 * 非简化轮原样放行（`blocked` 为空），调用方不必写分支。
 */
export function partitionForShrink(
  proposals: readonly Proposal[],
  state: ShrinkState,
  minReduction = DEFAULT_SHRINK_POLICY.minReduction,
): ShrinkPartition {
  if (!state.required) return { allowed: proposals, blocked: [] };
  const allowed: Proposal[] = [];
  const blocked: { proposal: Proposal; reason: string }[] = [];
  for (const p of proposals) {
    if (isShrinkPatch(p.patch, minReduction)) {
      allowed.push(p);
      continue;
    }
    const { before, after, delta } = sizeDelta(p.patch);
    blocked.push({
      proposal: p,
      reason:
        `简化轮只接受净简化提案：这条把 ${p.patch.target} 从 ${before} 字改到 ${after} 字` +
        `（${delta > 0 ? '+' : ''}${delta}，要求至少少 ${(minReduction * 100).toFixed(0)}%），本次不验证`,
    });
  }
  return { allowed, blocked };
}

/** 补丁的净变化（负数 = 变短），给提示词与人读用 */
export function sizeDelta(patch: AssetPatch): { before: number; after: number; delta: number } {
  const before = patch.before.trim().length;
  const after = patch.after.trim().length;
  return { before, after, delta: after - before };
}

export function shrinkState(config: WorkspacePaths, policy: ShrinkPolicy = {}): ShrinkState {
  return shrinkStateOf(readCycles(config), policy);
}

/**
 * 纯函数版本（测试与「回放历史」用）。
 *
 * 只数 `accepted`：被门拒掉的提案没有改变资产，它对"资产是不是越来越胖"没有贡献。
 * 一条净简化被采纳时两个计数一起归零 —— 那是配额**兑现**的时刻。
 */
export function shrinkStateOf(
  records: readonly CycleRecord[],
  policy: ShrinkPolicy = {},
): ShrinkState {
  const p = resolvePolicy(policy);
  let sinceShrink = 0;
  let growth = 0;
  let costSeen = 0;
  let tokenSeen = 0;
  let missing = 0;

  // `readCycles` 已按文件名（= 时间序）返回；这里不再排序，避免两处各有一套顺序口径
  for (const record of records) {
    // dry-run 的「采纳」是**本会采纳**：资产一个字都没动，所以它对"资产是不是越来越胖"
    // 没有贡献。把它数进来，会让一个天天 `--dry-run` 看方案的人被配额莫名其妙地拦住
    if (record.dryRun) continue;
    for (const proposal of record.accepted) {
      if (isShrinkPatch(proposal.patch, p.minReduction)) {
        sinceShrink = 0;
        growth = 0;
        costSeen = 0;
        tokenSeen = 0;
        missing = 0;
        continue;
      }
      sinceShrink += 1;
      const outcome = record.verified.find((v) => v.proposal.id === proposal.id);
      if (outcome === undefined) {
        missing += 1;
        continue;
      }
      // 与门同口径：有成本读数就用成本，没有才退回 token。两者都是相对增幅，
      // 相加仍有意义（"涨了几个百分点"），只是精度不同 —— 所以 basis 要一起记
      if (outcome.gate.costDelta !== undefined) {
        growth += outcome.gate.costDelta;
        costSeen += 1;
      } else {
        growth += outcome.gate.tokenDelta;
        tokenSeen += 1;
      }
    }
  }

  const basis: ShrinkState['basis'] =
    missing > 0
      ? 'unknown'
      : costSeen > 0 && tokenSeen === 0
        ? 'cost'
        : tokenSeen > 0 && costSeen === 0
          ? 'tokens'
          : costSeen > 0 && tokenSeen > 0
            ? 'mixed'
            : 'unknown';

  const why: string[] = [];
  if (sinceShrink >= p.every) why.push(`距上次净简化已采纳 ${sinceShrink} 条改动`);
  if (growth >= p.maxGrowth) why.push(costNote(growth, basis));
  const required = why.length > 0;
  return {
    required,
    reason: required
      ? `${why.join('；')}（阈值 ${p.every} 条 / ${(p.maxGrowth * 100).toFixed(0)}%）—— 这一轮只接受净简化提案`
      : undefined,
    sinceShrink,
    growth,
    basis,
  };
}

function costNote(growth: number, basis: ShrinkState['basis']): string {
  const pct = `${(growth * 100).toFixed(0)}%`;
  if (basis === 'cost') return `自上次净简化以来成本累计涨了 ${pct}`;
  if (basis === 'tokens')
    return `自上次净简化以来 token 累计涨了 ${pct}（成本读数缺失，按 token 判）`;
  if (basis === 'mixed') {
    return `自上次净简化以来成本/token 累计涨了 ${pct}（部分改动只有 token 读数）`;
  }
  return `自上次净简化以来可测到的成本增幅已有 ${pct}（至少一条改动没有读数，真实值不低于此）`;
}

function resolvePolicy(policy: ShrinkPolicy): Required<ShrinkPolicy> {
  const every = policy.every ?? DEFAULT_SHRINK_POLICY.every;
  const maxGrowth = policy.maxGrowth ?? DEFAULT_SHRINK_POLICY.maxGrowth;
  const minReduction = policy.minReduction ?? DEFAULT_SHRINK_POLICY.minReduction;
  if (!Number.isInteger(every) || every < 1) {
    throw new HarnessError(
      'config.invalid',
      `简化配额的 every 必须是 ≥1 的整数（收到 ${every}）—— 否则配额要么永不触发，要么每轮都触发`,
    );
  }
  if (!(maxGrowth > 0)) {
    throw new HarnessError('config.invalid', `简化配额的 maxGrowth 必须 > 0（收到 ${maxGrowth}）`);
  }
  if (!(minReduction > 0 && minReduction < 1)) {
    throw new HarnessError(
      'config.invalid',
      `简化配额的 minReduction 必须在 (0, 1) 之间（收到 ${minReduction}）`,
    );
  }
  return { every, maxGrowth, minReduction };
}
