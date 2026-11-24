import { HarnessError } from '../errors.js';
import { usd } from '../util/usd.js';
import type { CycleBudget } from './types.js';

/**
 * 一轮 RSI 的成本账。
 *
 * 抽成值对象之前，同一件事在 `runCycle` 里写了 11 次（`spent +=` 4 处、
 * `costKnown = costKnown && …` 4 处、`budgetStopped` 3 处）。那不是行数问题：
 * **每新增一个花钱阶段，都要记得改四行**，漏一行的症状是预算闸静默偏低 —— 不报错，
 * 只是多花钱。历史上就漏过一次（提案成本后补），而漏掉的时候看不出来。
 *
 * 三条口径写在这里，别处不再各自解释：
 *
 * 1. **「没有读数」不是「免费」**：`charge(usd, known=false)` 会把成本标成不可信，
 *    而不可信时闸**不生效**（并如实记进报告），而不是拿偏低的数字假装闸住了。
 * 2. **本轮花费与总花费是两个数**：`spentUsd` 只算这一轮（记录要看得出「第 3 轮
 *    特别贵」），`totalUsd` 含 `--rounds` 之前几轮（闸判的是整次运行）。
 * 3. **超限只在成本可信时成立**：`exceeded()` 里 `known` 是前置条件。
 */
export class Budget {
  /** 本轮（这一次 `runCycle`）累计 */
  private spent = 0;
  /** 本轮所有参与比较的读数都可信 */
  private reliable = true;

  constructor(
    /** 整次运行的美元上限；`undefined` = 不设闸 */
    readonly limitUsd: number | undefined,
    /** 本轮之前已经花掉的（`--rounds` 由调用方累加） */
    private readonly priorUsd = 0,
  ) {
    if (limitUsd !== undefined && (!Number.isFinite(limitUsd) || limitUsd < 0)) {
      // 负上限会让「已超限」永远成立、NaN 会让比较永远为 false —— 两种都是静默失效
      throw new HarnessError('config.invalid', `预算上限必须是非负有限数（收到 ${limitUsd}）`);
    }
  }

  /** 记一笔花费。`usd === undefined` = 没有读数（`known` 应为 false，否则是调用方的 bug） */
  charge(usdAmount: number | undefined, known = true): void {
    if (usdAmount !== undefined) this.spent += usdAmount;
    if (!known) this.reliable = false;
  }

  /** 本轮花了多少（报告里的 `costUsd`） */
  get spentUsd(): number {
    return this.spent;
  }

  /** 本轮读数是否可信（报告里的 `costKnown`） */
  get costKnown(): boolean {
    return this.reliable;
  }

  /** 整次运行（含之前几轮）花了多少 */
  get totalUsd(): number {
    return this.priorUsd + this.spent;
  }

  /** 是否已超限。成本不可信时**一律不算超**（拿偏低数字判超限只会误伤） */
  exceeded(): boolean {
    return this.limitUsd !== undefined && this.reliable && this.totalUsd > this.limitUsd;
  }

  /** 报告里的预算快照；没设上限时为 `undefined`（「没设闸」与「没超」不是一回事） */
  snapshot(stopped: boolean): CycleBudget | undefined {
    if (this.limitUsd === undefined) return undefined;
    return { limitUsd: this.limitUsd, spentUsd: this.totalUsd, stopped };
  }

  /** 给报错/日志用的一句话（不参与判定） */
  describe(): string {
    if (this.limitUsd === undefined) return `已花 ${usd(this.spent)}（未设上限）`;
    return `已花 ${usd(this.totalUsd)} / 上限 ${usd(this.limitUsd)}`;
  }
}
