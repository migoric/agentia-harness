/**
 * 成本计量器 —— 把「余额盘」包成 RSI 认得的一种东西。
 *
 * 存在理由（与 `run/balance.ts` 的分工）：那边只管「怎么问一次余额」，这边管
 * **「从开跑到现在扣了多少」这个时间窗口**。窗口必须在这里定，因为只有编排者知道
 * 一轮从哪开始；放在余额盘里，它会变成一个有状态的全局，而那种东西在 `--rounds`
 * 与 `--watch` 下第一件事就是算错。
 *
 * 语义只有一条，且是**累计**不是增量：`billedUsd()` 永远返回「自 `openMeter` 起」的
 * 总扣费。这样调用方可以随便调用多少次（每个阶段结束都调），每次都直接**覆盖**预算账
 * 的本轮花费（`Budget.reconcile`）—— 幂等，不需要记「上次读到哪」。
 */

import type { HarnessConfig } from '../config.js';
import { DEFAULT_PER_USD } from '../config-balance.js';
import { type BalanceSnapshot, type Billed, billedSince, readBalance } from '../run/balance.js';

export interface CostMeter {
  /** 开跑那一刻的余额快照（诊断与「余额不足」提醒都看它） */
  readonly before: BalanceSnapshot;
  /** 这个账户用的折算率（非美元币种才有意义） */
  readonly perUsd: number;
  /** 自开跑起累计扣了多少美元；读不到时 `undefined`（调用方保留估算值） */
  billedUsd(): Promise<number | undefined>;
  /** 最近一次成功观测的原币明细（报告里要留没被汇率污染的数） */
  last(): Billed | undefined;
}

export interface OpenMeterOptions {
  readonly signal?: AbortSignal | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

/**
 * 开一个计量窗口。端点不支持、没有 key、接口报错都只是 `undefined` ——
 * **拿不到余额不等于跑不了评测**，那是这个模块唯一必须守住的边界。
 */
export async function openMeter(
  config: HarnessConfig,
  opts: OpenMeterOptions = {},
): Promise<CostMeter | undefined> {
  const first = await readBalance(config, opts);
  if (!first.ok) return undefined;
  const before = first.snapshot;
  const perUsd = config.balance?.perUsd ?? DEFAULT_PER_USD;
  let lastBilled: Billed | undefined;

  return {
    before,
    perUsd,
    async billedUsd(): Promise<number | undefined> {
      const now = await readBalance(config, opts);
      if (!now.ok) return undefined;
      const b = billedSince(before, now.snapshot, perUsd);
      if (b === undefined) return undefined;
      lastBilled = b;
      return b.usd;
    },
    last: () => lastBilled,
  };
}

/**
 * 余额够不够跑 —— 开跑前的硬提醒（**不拦**，只说话）。
 *
 * 为什么不拦：`warnBelowUsd` 是用户自己设的阈值，而「一轮要花多少」事先不可知
 * （基线用例数与模型价格共同决定）。拦下来只会让人把阈值调到 0 —— 那这个功能就没了。
 * 说出来则有用：「账户里只剩 0.41 美元」是人做决定时唯一需要的事实。
 */
export function lowBalanceWarning(
  before: BalanceSnapshot,
  perUsd: number,
  warnBelowUsd: number | undefined,
): string | undefined {
  if (warnBelowUsd === undefined) return undefined;
  const e = before.entries.find((x) => x.currency === 'USD') ?? before.entries[0];
  if (e === undefined) return undefined;
  const dollars = e.currency === 'USD' ? e.total : e.total / perUsd;
  if (dollars >= warnBelowUsd) return undefined;
  return (
    `账户余额 ${e.total} ${e.currency}（约 $${dollars.toFixed(4)}）低于告警线 ` +
    `$${warnBelowUsd} —— 跑到一半没钱会让这一轮以「模型调用失败」结束，` +
    '那不是评测结论，别当成结论看。'
  );
}
