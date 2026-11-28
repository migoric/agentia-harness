import { existsSync } from 'node:fs';
import type { ModelClient } from '@migor/agentia';
import type { AssetSet } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import { runSuite, type SuiteTuning } from '../evals/run.js';
import type { EvalReport } from '../evals/types.js';
import type { CaseRunner } from '../run/case-runner.js';
import { type CycleRecord, readCycles } from './cycles.js';
import { liveAccepted, readJournal } from './journal.js';
import { cyclesDir } from './paths.js';
import type { JournalEntry } from './types.js';

/**
 * 采纳之后的回归监测。
 *
 * RSI 的采纳是一次「用一批用例换来的改动」。但资产会继续演化（后续采纳、人手改），
 * 一条曾经兑现的改动完全可能被后来的改动抵掉 —— 而 journal 里那条记录仍然是
 * `accepted`，看起来一切正常。这个模块专门回答一句话：
 *
 * **当初采纳时通过的那些用例，现在还通过吗？**
 *
 * 三条刻意的边界：
 * 1. **只监测最近一条采纳**。更早的采纳早已被后续改动覆盖，拿它当基准会把
 *    「正常演进」误报成回归。
 * 2. **找不到当时的验证记录就报错**，不猜。没有 `candidate` 报告时无法区分
 *    「用例本来就没过」与「它退步了」，猜出来的回归比不报更坏。
 * 3. **只读**。回滚是调用方（CLI 的 `--revert`）显式决定的事，且仍走
 *    `revertLast` 的指纹校验 —— 监测自己不许动资产。
 */
export interface Regression {
  readonly case: string;
  /** 现在的失败原因（采纳时它是通过的，所以这里一定有内容） */
  readonly failures: readonly string[];
}

export interface RegressReport {
  readonly proposalId: string;
  readonly cycleId: string;
  /** 采纳当时通过的用例（train + holdout 合并） */
  readonly expected: readonly string[];
  /** 现在通过的用例 */
  readonly actual: readonly string[];
  /** 采纳时通过、现在挂了的用例 */
  readonly regressed: readonly Regression[];
  /** 采纳时通过、但现在连用例都不存在的（被删/改名）—— 监测覆盖不到，不能算绿 */
  readonly missingCases: readonly string[];
  readonly current: EvalReport;
  /** 采纳后的资产指纹（journal 里记的） */
  readonly assetsAtAccept: string;
  /** 当前资产指纹 —— 与上面不同说明期间有人手改过 */
  readonly assetsNow: string;
}

export interface RegressOptions extends SuiteTuning {
  readonly config: HarnessConfig;
  readonly assets: AssetSet;
  readonly agent?: string | undefined;
  readonly client?: ModelClient | undefined;
  readonly signal?: AbortSignal | undefined;
  /**
   * 换一个「谁来跑」的实现（远程服务）。
   *
   * 回归检查的意义是「采纳之后那条用例还过不过」——所以它必须评测**真正在服务的那份**。
   * 不接 runner 的话，远程模式下它会退回本地装配：那样得到的是本地资产的成绩，而线上
   * 到底怎么样没人知道，报告却是一份绿。
   */
  readonly runner?: CaseRunner | undefined;
}

export async function checkRegression(opts: RegressOptions): Promise<RegressReport> {
  const last = lastAccepted(opts.config);
  const { cycle, candidate } = findCandidate(opts.config, last.proposalId);

  const current = await runSuite({
    config: opts.config,
    assets: opts.assets,
    ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.client !== undefined ? { client: opts.client } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
    ...(opts.repeat !== undefined ? { repeat: opts.repeat } : {}),
  });

  // 全部用例都跑崩 ≠ 回归。缺凭据 / 端点挂掉时每条都是 error，若当成回归，
  // `--revert` 会把一条本来正常的采纳回滚掉 —— 那是这套系统里最不该发生的误伤
  const broken = current.cases.filter(
    (c) => c.stopReason === 'error' || c.stopReason === 'threw' || c.stopReason === 'timeout',
  );
  if (current.cases.length > 0 && broken.length === current.cases.length) {
    throw new HarnessError(
      'rsi.no_baseline',
      `所有用例都没跑起来（stopReason=${broken[0]?.stopReason ?? 'error'}）—— 这不是回归，` +
        '先检查凭据、端点与网络。拒绝在基础设施故障上判回归（会误回滚正常采纳）',
    );
  }

  const expected = candidate.cases.filter((c) => c.passed).map((c) => c.name);
  const nowPassing = new Set(current.cases.filter((c) => c.passed).map((c) => c.name));
  const regressed: Regression[] = current.cases
    .filter((c) => expected.includes(c.name) && !nowPassing.has(c.name))
    .map((c) => ({
      case: c.name,
      failures: c.failures.length === 0 ? [`stopReason=${c.stopReason}`] : c.failures,
    }));
  // 采纳时通过、现在**连用例都不在了**（被删/改名）：监测覆盖不到，不能算绿
  const present = new Set(current.cases.map((c) => c.name));
  const missingCases = expected.filter((n) => !present.has(n));

  return {
    proposalId: last.proposalId,
    cycleId: cycle.cycleId,
    expected,
    actual: current.cases.filter((c) => c.passed).map((c) => c.name),
    regressed,
    missingCases,
    current,
    assetsAtAccept: last.assetsAfter,
    assetsNow: opts.assets.fingerprint,
  };
}

/** journal 里最近一条**仍生效**的文本采纳（代码补丁有自己的回滚入口，不混） */
export function lastAccepted(config: HarnessConfig): JournalEntry {
  // 必须排除已回滚的采纳：回滚是 append-only，原 accepted 行不动 —— 不排除的话，
  // 回滚之后本函数仍盯着已作废的提案，把「回滚的预期结果」报成回归
  const accepted = liveAccepted(readJournal(config), 'asset');
  const last = accepted[accepted.length - 1];
  if (last === undefined) {
    throw new HarnessError(
      'rsi.no_baseline',
      'journal 里没有任何采纳记录 —— 还没改过东西，没有可监测的回归',
    );
  }
  return last;
}

/**
 * 从轮次记录里找回「那次采纳时的候选结果」。
 *
 * 刻意**不**用 journal 里的 `after` 重跑一遍去重建基准：那是「现在能不能过」，
 * 而监测要的是「当时过没过」—— 两者混用会把回归判成通过。
 */
function findCandidate(
  config: HarnessConfig,
  proposalId: string,
): { cycle: CycleRecord; candidate: EvalReport } {
  const dir = cyclesDir(config);
  if (!existsSync(dir)) {
    throw new HarnessError(
      'rsi.no_baseline',
      `找不到 ${proposalId} 的验证记录（${dir} 不存在）—— 没有基准就无法判断回归`,
    );
  }
  // 解析与形状校验都归 cycles.ts：同一份目录此前有两份读实现，且两份对坏记录的
  // 表现不一样（这里 HarnessError、账本里原生 TypeError）
  const hits: { cycle: CycleRecord; candidate: EvalReport }[] = [];
  for (const cycle of readCycles(config)) {
    const hit = cycle.verified.find((v) => v.proposal.id === proposalId);
    if (hit === undefined) continue;
    // train 与 holdout 的候选结果分开存（验证是两个口径），基准要合起来才是完整集合
    const cases = [...hit.candidate.cases, ...(hit.holdout?.candidate.cases ?? [])];
    hits.push({ cycle, candidate: { ...hit.candidate, cases } });
  }
  if (hits.length === 0) {
    throw new HarnessError(
      'rsi.no_baseline',
      `轮次记录里找不到 ${proposalId} 的验证结果 —— 没有基准就无法判断回归（不猜）`,
    );
  }
  // 优先「这一轮真的采纳了它」的那份记录：手工提案 id 被复用时（先失败、后成功），
  // 取第一个命中会拿到旧的失败验证。同 id 多条采纳记录时取最后一条（最新）。
  const accepted = hits.filter((h) => h.cycle.accepted.some((p) => p.id === proposalId));
  const pool = accepted.length > 0 ? accepted : hits;
  const chosen = pool[pool.length - 1];
  if (chosen === undefined) {
    throw new HarnessError('rsi.no_baseline', `找不到 ${proposalId} 的可用基准`);
  }
  return chosen;
}
