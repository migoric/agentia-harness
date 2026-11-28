import { HarnessError } from '../errors.js';
import { usd } from '../util/usd.js';
import type { CycleBudget } from './types.js';

/**
 * 闸为什么停下（写进报告，供事后判断「是钱花完了还是闸瞎了」）。
 *
 * - `usd`：美元闸生效且超了 —— 正常的预算收工；
 * - `tokens`：token 闸超了 —— 美元读数不可信时的兜底；
 * - `blind`：**设了美元上限，但读数不可信，且没有 token 兜底** —— 这是配置错误，
 *   不是「钱还没花完」。停下来是为了不再往一个看不见的账上继续烧。
 */
export type BudgetStop = 'usd' | 'tokens' | 'blind';

export interface BudgetOptions {
  /** 整次运行的美元上限；`undefined` = 不设闸 */
  readonly limitUsd?: number | undefined;
  /**
   * 整次运行的 token 上限。
   *
   * 存在理由是美元闸的一个死角：**模型不在价格表里时 `costUsd` 不可信**，于是
   * `--max-cost` 什么也拦不住（曾经是静默失效 —— 用户以为有闸，其实没有）。
   * token 数由端点/服务直接报，不依赖价格表，所以它是那个死角里唯一还能用的闸。
   */
  readonly limitTokens?: number | undefined;
  /** 本次（`--rounds`）之前已经花掉的 */
  readonly priorUsd?: number;
  readonly priorTokens?: number;
}

/**
 * 一轮 RSI 的成本账。
 *
 * 抽成值对象之前，同一件事在 `runCycle` 里写了 11 次（`spent +=` 4 处、
 * `costKnown = costKnown && …` 4 处、`budgetStopped` 3 处）。那不是行数问题：
 * **每新增一个花钱阶段，都要记得改四行**，漏一行的症状是预算闸静默偏低 —— 不报错，
 * 只是多花钱。历史上就漏过一次（提案成本后补），而漏掉的时候看不出来。
 *
 * 四条口径写在这里，别处不再各自解释：
 *
 * 1. **「没有读数」不是「免费」**：`charge(usd, known=false)` 会把成本标成不可信。
 * 2. **不可信 ≠ 放行**：旧实现里美元闸在不可信时直接返回「没超」，于是「给未定价
 *    模型设 `--max-cost`」看起来有保护、实际一分钱也没拦住。现在不可信时要么由
 *    token 闸接管，要么判 `blind` 停下来 —— 三种结局都写进报告，不允许「静默」。
 * 3. **本轮花费与总花费是两个数**：`spentUsd` 只算这一轮（记录要看得出「第 3 轮
 *    特别贵」），`totalUsd` 含 `--rounds` 之前几轮（闸判的是整次运行）。
 * 4. **token 闸永远可信**：端点数出来的，不查价格表（见 `limitTokens`）。
 */
export class Budget {
  /** 本轮（这一次 `runCycle`）累计 */
  private spent = 0;
  private tokens = 0;
  /** 本轮所有参与比较的读数都可信 */
  private reliable = true;

  constructor(private readonly o: BudgetOptions = {}) {
    const { limitUsd, limitTokens } = o;
    if (limitUsd !== undefined && (!Number.isFinite(limitUsd) || limitUsd < 0)) {
      // 负上限会让「已超限」永远成立、NaN 会让比较永远为 false —— 两种都是静默失效
      throw new HarnessError('config.invalid', `预算上限必须是非负有限数（收到 ${limitUsd}）`);
    }
    if (limitTokens !== undefined && (!Number.isInteger(limitTokens) || limitTokens < 0)) {
      // 小数 token 上限在比较时不会报错，但「上限 1.5 万 token」这种输入几乎总是
      // 单位写错（有人按「千 token」填），整数约束是最便宜的拦法
      throw new HarnessError(
        'config.invalid',
        `token 上限必须是正整数（收到 ${limitTokens}，单位是**个** token，不是千 token）`,
      );
    }
  }

  /** 记一笔花费。`usd === undefined` = 没有读数（`known` 应为 false，否则是调用方的 bug） */
  charge(usdAmount: number | undefined, known = true, tokens?: number): void {
    if (usdAmount !== undefined) this.spent += usdAmount;
    if (tokens !== undefined) this.tokens += tokens;
    if (!known) this.reliable = false;
  }

  /** 本轮花了多少（报告里的 `costUsd`） */
  get spentUsd(): number {
    return this.spent;
  }

  /** 本轮用了多少 token（端点报的，不依赖价格表） */
  get spentTokens(): number {
    return this.tokens;
  }

  /** 本轮读数是否可信（报告里的 `costKnown`） */
  get costKnown(): boolean {
    return this.reliable;
  }

  /** 整次运行（含之前几轮）花了多少 */
  get totalUsd(): number {
    return (this.o.priorUsd ?? 0) + this.spent;
  }

  get totalTokens(): number {
    return (this.o.priorTokens ?? 0) + this.tokens;
  }

  get limitUsd(): number | undefined {
    return this.o.limitUsd;
  }

  get limitTokens(): number | undefined {
    return this.o.limitTokens;
  }

  /** 设了美元上限却读不出成本 —— 这个闸此刻是瞎的（有没有 token 兜底是另一件事） */
  get usdBlind(): boolean {
    return this.o.limitUsd !== undefined && !this.reliable;
  }

  /**
   * 该不该停，以及为什么。
   *
   * 判定顺序就是安全性的顺序：
   * 1. 美元闸**只在可信时**判超（拿偏低数字判超限只会误伤）；
   * 2. token 闸无条件判超（读数永远可信）；
   * 3. 美元闸瞎了且没有 token 兜底 ⇒ `blind`，停。
   *
   * 第 3 条与「给个 token 兜底就继续跑」的区别是刻意的：用户同时给了两个上限时，
   * 他知道自己在干什么（用 token 换成本估算），此时报 `blind` 停下来只是添乱；
   * 只给了美元上限时，他以为自己有保护 —— 那必须停。
   */
  stopReason(): BudgetStop | undefined {
    const { limitUsd, limitTokens } = this.o;
    if (limitUsd !== undefined && this.reliable && this.totalUsd > limitUsd) return 'usd';
    if (limitTokens !== undefined && this.totalTokens > limitTokens) return 'tokens';
    if (limitUsd !== undefined && !this.reliable && limitTokens === undefined) return 'blind';
    return undefined;
  }

  /** 是否该停（`exceeded()` 这个名字留着，调用点很多；语义见 `stopReason()`） */
  exceeded(): boolean {
    return this.stopReason() !== undefined;
  }

  /** 报告里的预算快照；两个上限都没设时为 `undefined`（「没设闸」与「没超」不是一回事） */
  snapshot(stopped: boolean): CycleBudget | undefined {
    if (this.o.limitUsd === undefined && this.o.limitTokens === undefined) return undefined;
    const why = this.stopReason();
    return {
      ...(this.o.limitUsd !== undefined ? { limitUsd: this.o.limitUsd } : {}),
      ...(this.o.limitTokens !== undefined ? { limitTokens: this.o.limitTokens } : {}),
      spentUsd: this.totalUsd,
      spentTokens: this.totalTokens,
      stopped,
      ...(stopped && why !== undefined ? { stoppedBy: why } : {}),
      ...(this.usdBlind ? { usdBlind: true } : {}),
    };
  }

  /** 给报错/日志用的一句话（不参与判定） */
  describe(): string {
    const parts: string[] = [`已花 ${usd(this.spent)}`];
    if (this.o.limitUsd !== undefined) parts[0] += ` / 上限 ${usd(this.o.limitUsd)}`;
    if (this.o.limitTokens !== undefined) {
      parts.push(`${this.totalTokens} / ${this.o.limitTokens} token`);
    }
    return parts.join('，');
  }
}
