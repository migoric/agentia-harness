/**
 * 钱袋子 —— `Budget` 的装配壳。
 *
 * 为什么要有壳：`Budget` 只记账，不认「怎么读到真实扣费」；`CostMeter` 只读余额，
 * 不认「一轮的上限是多少」。两者必须在**同一处**绑定，否则每个花钱点都要自己写
 * 「先 charge 再 reconcile」，而漏掉 reconcile 的症状恰好是本轮引入这个功能之前
 * 那个 bug 的样子 —— 闸静默失效。绑定一次，调用点只有 `charge()`。
 *
 * 抽出来的第二个理由是可读性：`loop.ts` 是编排，不该有 40 行预算装配。文件上限
 * 400 行（`tests/architecture.test.ts`）不是洁癖，它逼着「钱」这一层独立成模块。
 */

import type { HarnessConfig } from '../config.js';
import type { CostMeter } from './billing.js';
import { openMeter } from './billing.js';
import { Budget } from './budget.js';
import type { CycleBudget, CycleReport } from './types.js';

export interface SpenderOptions {
  readonly limitUsd?: number | undefined;
  readonly limitTokens?: number | undefined;
  readonly priorUsd?: number | undefined;
  readonly priorTokens?: number | undefined;
  /** 缺省自动开（端点支持余额查询时才有）；`null` 明确关闭 */
  readonly meter?: CostMeter | null | undefined;
  readonly signal?: AbortSignal | undefined;
  /** 测试注入（透传给余额盘） */
  readonly fetchImpl?: typeof fetch | undefined;
}

export class Spender {
  private constructor(
    private readonly budget: Budget,
    private readonly meter: CostMeter | undefined,
  ) {}

  /**
   * 开一本账。
   *
   * 静态工厂而不是构造函数，只因为余额盘要 await —— 把它做成构造函数里的
   * 「稍后自己初始化」，会让第一个 `charge()` 变成隐式的异步依赖，而那种东西
   * 在 `--watch` 里迟早被并发调用撞上。
   */
  static async open(config: HarnessConfig, opts: SpenderOptions = {}): Promise<Spender> {
    const budget = new Budget({
      ...(opts.limitUsd !== undefined ? { limitUsd: opts.limitUsd } : {}),
      ...(opts.limitTokens !== undefined ? { limitTokens: opts.limitTokens } : {}),
      ...(opts.priorUsd !== undefined ? { priorUsd: opts.priorUsd } : {}),
      ...(opts.priorTokens !== undefined ? { priorTokens: opts.priorTokens } : {}),
    });
    const meter =
      opts.meter === null
        ? undefined
        : (opts.meter ??
          (await openMeter(config, {
            ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
            ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
          })));
    return new Spender(budget, meter);
  }

  /**
   * 记一笔花费并**立刻**对账。
   *
   * 顺序不能反：先估算、再对账，这样对账失败时手里至少还有一个偏保守的估算值；
   * 反过来则会变成「对账失败 ⇒ 这一阶段的花费一笔没记」。
   */
  async charge(usdAmount: number | undefined, known: boolean, tokens?: number): Promise<void> {
    this.budget.charge(usdAmount, known, tokens);
    await this.reconcile();
  }

  /**
   * 用真实扣费覆盖本轮估算。读不到就什么都不做（保留估算），
   * 余额接口抖一下不该让报告看起来像免费。
   */
  async reconcile(): Promise<void> {
    const billed = await this.meter?.billedUsd();
    if (billed !== undefined) this.budget.reconcile(billed);
  }

  get spentUsd(): number {
    return this.budget.spentUsd;
  }

  get spentTokens(): number {
    return this.budget.spentTokens;
  }

  get costKnown(): boolean {
    return this.budget.costKnown;
  }

  exceeded(): boolean {
    return this.budget.exceeded();
  }

  describe(): string {
    return this.budget.describe();
  }

  snapshot(stopped: boolean): CycleBudget | undefined {
    return this.budget.snapshot(stopped);
  }

  /** 报告里的余额明细（原币 + 折算）；没对过账时 `undefined` */
  billed(): CycleReport['billed'] {
    return this.meter?.last();
  }

  /** 开跑那一刻的余额（CLI 拿它做「余额不足」提醒） */
  get before(): CostMeter['before'] | undefined {
    return this.meter?.before;
  }
}
