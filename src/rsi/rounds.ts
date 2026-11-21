import type { ModelClient } from '@migor/agentia';
import { discoverAssets } from '../assets/discover.js';
import type { AssetSet } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import type { GateOptions } from '../evals/gate.js';
import { runCycle } from './loop.js';
import type { Proposer } from './propose.js';
import type { CycleReport } from './types.js';

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
  /** 每轮一个新的提案器 —— 提案器带累计花费状态，复用会把两轮的账并成一条 */
  readonly makeProposer: (round: number) => Proposer;
  readonly maxVerify?: number | undefined;
  readonly maxCostUsd?: number | undefined;
  readonly dryRun?: boolean | undefined;
  readonly gateOptions?: GateOptions | undefined;
  readonly timeoutMs?: number | undefined;
  readonly concurrency?: number | undefined;
  readonly retries?: number | undefined;
  /** 每轮结束后的回调（CLI 用它打印） */
  readonly onRound?: ((report: CycleReport, index: number) => void) | undefined;
}

export type RoundStopReason = 'rounds' | 'budget' | 'no_progress' | 'no_failures';

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
  let stopReason: RoundStopReason = 'rounds';

  for (let i = 0; i < opts.rounds; i++) {
    // 每轮**重新发现资产**：采纳只写磁盘，不更新内存里的 `AssetSet`。复用同一份
    // 快照会让第 2 轮的基线仍用改前的 system（刚修好的失败又出现），并且提案的
    // `patch.before` 是旧正文 —— accept 的乐观锁必然抛 asset.invalid。
    const assets =
      i === 0
        ? opts.assets
        : discoverAssets({ skills: opts.config.skillsDir, agents: opts.config.agentsDir });
    const report = await runCycle({
      config: opts.config,
      assets,
      proposer: opts.makeProposer(i),
      ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
      ...(opts.client !== undefined ? { client: opts.client } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.maxVerify !== undefined ? { maxVerify: opts.maxVerify } : {}),
      ...(opts.maxCostUsd !== undefined ? { maxCostUsd: opts.maxCostUsd } : {}),
      ...(priorSpent > 0 ? { priorSpentUsd: priorSpent } : {}),
      ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
      ...(opts.gateOptions !== undefined ? { gateOptions: opts.gateOptions } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
      ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
    });
    reports.push(report);
    priorSpent += report.costUsd;
    opts.onRound?.(report, i);

    if (report.budget?.stopped === true) {
      stopReason = 'budget';
      break;
    }
    if (report.accepted.length === 0) {
      stopReason = report.modes.length === 0 ? 'no_failures' : 'no_progress';
      break;
    }
  }

  return {
    rounds: reports,
    acceptedRounds: reports.filter((r) => r.accepted.length > 0).length,
    stopReason,
    costUsd: reports.reduce((sum, r) => sum + r.costUsd, 0),
    costKnown: reports.every((r) => r.costKnown),
  };
}
