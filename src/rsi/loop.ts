import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelClient } from '@migor/agentia';
import type { AssetSet } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import type { GateOptions } from '../evals/gate.js';
import { runSuite, type SuiteTuning } from '../evals/run.js';
import { acceptProposal } from './accept.js';
import { attribute, collectFailures } from './attribute.js';
import type { Proposer } from './propose.js';
import type { CycleBudget, CycleReport, Proposal, VerifyOutcome } from './types.js';
import { verifyProposal } from './verify.js';

/**
 * 一轮 RSI —— 五步编排。
 *
 * 一条**刻意写死**的规则：**一轮最多采纳一个提案**。
 *
 * 理由不是保守，是可归因性：同时采纳三个改动，评测从 70% 涨到 85%，没人知道是
 * 哪一个（或哪个组合）起的作用。下一轮再坏回去时，你也无法定位。单变量是唯一
 * 能让「采纳记录」变成可信知识的做法 —— 而可信知识正是 RSI 唯一有价值的产出。
 *
 * 代价是慢：一次只能试一个。这个代价是值的，因为 RSI 最贵的不是算力，是
 * **人重新信任一套自己看不懂的提示词**。
 */
export interface CycleOptions extends SuiteTuning {
  readonly config: HarnessConfig;
  readonly assets: AssetSet;
  readonly agent?: string | undefined;
  readonly client?: ModelClient | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly proposer: Proposer;
  readonly gateOptions?: GateOptions | undefined;
  /** 只验证不落盘（人审模式） */
  readonly dryRun?: boolean | undefined;
  /** 最多验证几个提案（超过的不跑评测，省成本） */
  readonly maxVerify?: number | undefined;
  /**
   * 本轮成本上限（美元）。超了就提前收工并如实记进记录。
   *
   * 与 `maxVerify` 是两个维度：那个限制**次数**，这个限制**钱**。设了上限后，
   * 第一遍基线跑完就可能已经超了 —— 此时连提案都不必提，那一步也烧钱。
   */
  readonly maxCostUsd?: number | undefined;
}

export async function runCycle(opts: CycleOptions): Promise<CycleReport> {
  const cycleId = makeCycleId();
  const dryRun = opts.dryRun === true;

  /**
   * 每一轮都落一份记录（含 dryRun）—— 这是 RSI 可审计的唯一物理依据。
   *
   * 写失败的策略是**让整轮失败**：一个「跑了但没记录」的 RSI 轮次比不跑更糟，
   * 因为它动过（或差点动过）资产，事后却无从复盘。
   */
  const emit = (body: Omit<CycleReport, 'cycleId' | 'path'>): CycleReport => {
    const path = persistCycle(opts.config, { cycleId, ...body });
    return { ...body, cycleId, path };
  };

  const limit = opts.maxCostUsd;
  let spent = 0;
  let costKnown = true;
  const budgetOf = (stopped: boolean): CycleBudget | undefined =>
    limit === undefined ? undefined : { limitUsd: limit, spentUsd: spent, stopped };

  const baseline = await runSuite({
    config: opts.config,
    assets: opts.assets,
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.client !== undefined ? { client: opts.client } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...tuning(opts),
  });

  spent += baseline.costUsd;
  costKnown = costKnown && baseline.costKnown;

  // 预算闸：基线就超了就直接收工。此时连提案都不提 —— 提案那一步要再调一次模型，
  // 在「已经超预算」的前提下继续花钱是最没道理的
  if (limit !== undefined && costKnown && spent > limit) {
    return emit({
      modes: [],
      proposals: [],
      verified: [],
      accepted: [],
      rejected: [],
      baseline,
      dryRun,
      costUsd: spent,
      costKnown,
      budget: budgetOf(true),
    });
  }

  const samples = collectFailures(baseline);
  if (samples.length === 0) {
    return emit({
      modes: [],
      proposals: [],
      verified: [],
      accepted: [],
      rejected: [],
      baseline,
      dryRun,
      costUsd: spent,
      costKnown,
      budget: budgetOf(false),
    });
  }

  const modes = attribute(samples);
  const proposals = await opts.proposer.propose({
    modes,
    assets: opts.assets,
    config: opts.config,
    ...(opts.client !== undefined ? { client: opts.client } : {}),
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
  });

  const maxVerify = opts.maxVerify ?? 3;
  const verified: VerifyOutcome[] = [];
  const accepted: Proposal[] = [];
  const rejected: { proposal: Proposal; reason: string }[] = [];
  let committed = false;

  let budgetStopped = false;
  for (const proposal of proposals.slice(0, maxVerify)) {
    if (limit !== undefined && costKnown && spent > limit) {
      budgetStopped = true;
      rejected.push({
        proposal,
        reason: `本轮预算已用完（已花 $${spent.toFixed(4)} ≥ 上限 $${limit.toFixed(4)}），下一轮再试`,
      });
      continue;
    }
    if (committed) {
      rejected.push({ proposal, reason: '本轮已采纳另一个提案（单变量原则），下一轮再试' });
      continue;
    }
    let outcome: VerifyOutcome;
    try {
      outcome = await verifyProposal({
        config: opts.config,
        assets: opts.assets,
        baseline,
        proposal,
        ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
        ...(opts.client !== undefined ? { client: opts.client } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(opts.gateOptions !== undefined ? { gateOptions: opts.gateOptions } : {}),
        ...tuning(opts),
      });
    } catch (e) {
      // 验证本身失败（补丁过期、装配错）不该让整轮崩掉：记下来，下一个提案继续
      rejected.push({
        proposal,
        reason: `验证失败: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    verified.push(outcome);
    spent += outcome.candidate.costUsd;
    costKnown = costKnown && outcome.candidate.costKnown;

    if (!outcome.gate.ok) {
      rejected.push({ proposal, reason: outcome.gate.reason });
      continue;
    }
    if (outcome.gate.fixedCases.length === 0 && outcome.gate.passRateDelta === 0) {
      // 门放行但没有任何用例变好：这只是「没变坏」，不值得落盘（会污染 git 历史）
      rejected.push({ proposal, reason: '没有任何用例变好（仅"没变差"，不值得改动资产）' });
      continue;
    }
    if (dryRun) {
      accepted.push(proposal);
      committed = true;
      continue;
    }
    acceptProposal(opts.config, opts.assets, outcome);
    accepted.push(proposal);
    committed = true;
  }

  for (const proposal of proposals.slice(maxVerify)) {
    rejected.push({ proposal, reason: `超过本轮验证上限（${maxVerify}），下一轮再试` });
  }

  return emit({
    modes,
    proposals,
    verified,
    accepted,
    rejected,
    baseline,
    dryRun,
    costUsd: spent,
    costKnown,
    budget: budgetOf(budgetStopped),
  });
}

/** 只把**给了值**的调优键往下传（显式 undefined 与不传不同，这里保持同一口径） */
function tuning(o: SuiteTuning): SuiteTuning {
  return {
    ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
    ...(o.concurrency !== undefined ? { concurrency: o.concurrency } : {}),
    ...(o.retries !== undefined ? { retries: o.retries } : {}),
  };
}

/** `2026-11-20T14-30-05-123Z`：ISO 直接当文件名，字典序即时间序 */
function makeCycleId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function cyclesDir(config: HarnessConfig): string {
  return join(config.workspaceDir, 'rsi', 'cycles');
}

function persistCycle(config: HarnessConfig, report: Omit<CycleReport, 'path'>): string {
  const dir = cyclesDir(config);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${report.cycleId}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}
