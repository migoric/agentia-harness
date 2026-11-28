import type { ModelClient } from '@migor/agentia';
import type { AssetSet } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import type { GateOptions } from '../evals/gate.js';
import type { CaseRunner } from '../run/case-runner.js';
import { runCycle } from './loop.js';
import type { Proposer } from './propose.js';
import type { ShrinkPolicy } from './shrink.js';
import type { CycleReport, StageHook } from './types.js';

/**
 * 连续跑 N 轮 RSI。
 *
 * 为什么要有它：一轮 RSI 只采纳一条改动（单变量原则），而真实的提示词工程从来不是
 * 一条就够。此前只能靠人反复敲命令，代价是**人必须一直在线**——而「自进化」如果
 * 需要人守着手动重跑，它就只是「自助手进化」。
 *
 * 三条停止条件，各有各的理由：
 *
 * 1. **没有可采纳的改动就停**。继续跑只会在同一批失败上提同一批方案（账本已经
 *    记下了这些方向，下一轮只会更贵不会更聪明）。这不是失败，是「这轮已经到底了」。
 * 2. **预算用完就停**。`maxCostUsd` 是**整次运行**的上限，跨轮共享 —— 每轮各自
 *    重置的话，`--rounds 5 --max-cost 1` 会花掉 5 美元，而配置里写的是 1。
 * 3. **跑满 N 轮**。正常收尾。
 *
 * 刻意**不**做的事：不自动回滚（那是 `rsi regress --revert` 的职责，且要过指纹
 * 校验）、不在轮与轮之间重跑 holdout（留出集只该在候选选定后验一次，反复验就
 * 变成第二个 train）。
 */
export interface RunRoundsOptions {
  readonly config: HarnessConfig;
  readonly assets: AssetSet;
  readonly agent?: string | undefined;
  readonly client?: ModelClient | undefined;
  readonly signal?: AbortSignal | undefined;
  /** 最多跑几轮（≥ 1） */
  readonly rounds: number;
  /**
   * 每轮一个提案器。
   *
   * 现在**复用同一个实例也是安全的**（`propose()` 把成本随产出一起返回，不再靠
   * 「先调再读属性」的累计字段）。保留成工厂是为了让「每轮可以换模型/换策略」
   * 这件事在签名上说得出口。
   */
  readonly makeProposer: (round: number) => Proposer;
  readonly maxVerify?: number | undefined;
  readonly maxCostUsd?: number | undefined;
  /** token 上限（美元闸读不出成本时的兜底），见 `CycleOptions.maxTokens` */
  readonly maxTokens?: number | undefined;
  readonly dryRun?: boolean | undefined;
  readonly gateOptions?: GateOptions | undefined;
  readonly timeoutMs?: number | undefined;
  readonly concurrency?: number | undefined;
  readonly retries?: number | undefined;
  /**
   * 每条用例重复采样几次（见 `SuiteTuning.repeat`）。
   *
   * 跨轮必须**同一个值**：第 1 轮采 1 次、第 2 轮采 3 次时，两轮的通过率不在同一个
   * 噪声水平上，`gate` 会拿一个更稳的读数去比一个更抖的读数 —— 那让「本轮变好了」
   * 变成采样次数的函数。
   */
  readonly repeat?: number | undefined;
  /** 净简化配额的阈值（每轮现算状态，不跨轮维护游标） */
  readonly shrinkPolicy?: ShrinkPolicy | undefined;
  /** 每轮结束后的回调（CLI 用它打印） */
  readonly onRound?: ((report: CycleReport, index: number) => void) | undefined;
  /** 远程 stage 钩子（本地不传），见 `CycleOptions.stage` */
  readonly stage?: StageHook | undefined;
  readonly runner?: CaseRunner | undefined;
  /** 见 `CycleOptions.allowedTargets`（远程：只验证有文件映射的目标） */
  readonly allowedTargets?: ((target: string) => boolean) | undefined;
  /**
   * 采纳之后把新资产交回调用方（远程模式用它把新提示词推到服务）。
   *
   * 与 `onAcceptedAssets` 的分工：那个是内部记账（更新本轮快照），这个是外部副作用
   * （推到远端）。放在一起会让「快照更新失败」和「远端推送失败」分不清。
   */
  readonly onAcceptedAssets?: ((assets: AssetSet) => void | Promise<void>) | undefined;
}

export type RoundStopReason =
  | 'rounds'
  | 'budget'
  | 'no_progress'
  | 'no_failures'
  | 'shrink_stalled';

export interface RoundsReport {
  readonly rounds: readonly CycleReport[];
  /** 有几轮真的采纳了改动 */
  readonly acceptedRounds: number;
  readonly stopReason: RoundStopReason;
  /** 所有轮次的花费总和（`costKnown=false` 时是**偏低**的，不是真实账单） */
  readonly costUsd: number;
  /**
   * 所有轮次都有成本读数。
   *
   * 不给这个字段，CLI 就只能拿 `costUsd` 直接印一个美元数 —— 而它在一部分轮次
   * 没定价时是偏低的，读起来却像确切账单。成本未知不是免费。
   */
  readonly costKnown: boolean;
  /** 所有轮次用掉的 token 总和 */
  readonly tokens: number;
}

export async function runRounds(opts: RunRoundsOptions): Promise<RoundsReport> {
  if (!Number.isInteger(opts.rounds) || opts.rounds < 1) {
    throw new HarnessError('config.invalid', `rounds 必须是正整数（收到 ${opts.rounds}）`);
  }
  if (opts.dryRun === true && opts.rounds > 1) {
    throw new HarnessError(
      'config.invalid',
      'dryRun 与多轮不能同时用：dry-run 不落盘，资产没变，后面几轮只会重复第一轮',
    );
  }

  const reports: CycleReport[] = [];
  let priorSpent = 0;
  let priorTokens = 0;
  let stopReason: RoundStopReason = 'rounds';

  // 资产快照跟着「上一轮的采纳结果」走：复用旧快照会让第 2 轮的基线仍用改前的
  // system（刚修好的失败又出现），且提案的 `patch.before` 是旧正文 —— accept 的
  // 乐观锁必然抛 asset.invalid。采纳之后的新快照由 `runCycle` 回调交回，
  // 不再需要每轮重新扫磁盘（扫描本身没问题，但那是让调用方替实现兜底）。
  let current = opts.assets;
  for (let i = 0; i < opts.rounds; i++) {
    const report = await runCycle({
      config: opts.config,
      assets: current,
      proposer: opts.makeProposer(i),
      onAcceptedAssets: async (next) => {
        current = next;
        // 推送失败必须冒出来：本地已经记「已采纳」而远端还是旧提示词，
        // 下一轮预检会报漂移 —— 早报比晚报好
        await opts.onAcceptedAssets?.(next);
      },
      ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
      ...(opts.client !== undefined ? { client: opts.client } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.maxVerify !== undefined ? { maxVerify: opts.maxVerify } : {}),
      ...(opts.maxCostUsd !== undefined ? { maxCostUsd: opts.maxCostUsd } : {}),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(priorSpent > 0 ? { priorSpentUsd: priorSpent } : {}),
      ...(priorTokens > 0 ? { priorTokens } : {}),
      ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
      ...(opts.gateOptions !== undefined ? { gateOptions: opts.gateOptions } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
      ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
      ...(opts.repeat !== undefined ? { repeat: opts.repeat } : {}),
      ...(opts.shrinkPolicy !== undefined ? { shrinkPolicy: opts.shrinkPolicy } : {}),
      ...(opts.stage !== undefined ? { stage: opts.stage } : {}),
      ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
      ...(opts.allowedTargets !== undefined ? { allowedTargets: opts.allowedTargets } : {}),
    });
    reports.push(report);
    priorSpent += report.costUsd;
    priorTokens += report.tokens ?? 0;

    opts.onRound?.(report, i);

    if (report.budget?.stopped === true) {
      stopReason = 'budget';
      break;
    }
    if (report.accepted.length === 0) {
      // 简化轮零采纳要单独说：这不是「改不动了」，是「这一轮被配额限定为只许删，
      // 而模型没交出可用的删除」。两者的下一步完全不同（继续提 vs 人去删/放宽配额），
      // 混成 no_progress 会让人对着一个"再跑一次"永远不会变的结果反复重跑
      stopReason =
        report.shrink?.required === true
          ? 'shrink_stalled'
          : report.modes.length === 0
            ? 'no_failures'
            : 'no_progress';
      break;
    }
  }

  return {
    rounds: reports,
    acceptedRounds: reports.filter((r) => r.accepted.length > 0).length,
    stopReason,
    costUsd: reports.reduce((sum, r) => sum + r.costUsd, 0),
    costKnown: reports.every((r) => r.costKnown),
    tokens: reports.reduce((sum, r) => sum + (r.tokens ?? 0), 0),
  };
}
