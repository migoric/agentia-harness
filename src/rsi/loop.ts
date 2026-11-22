import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelClient } from '@migor/agentia';
import type { AssetSet } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import type { GateOptions } from '../evals/gate.js';
import { runSuite, type SuiteTuning } from '../evals/run.js';
import { splitReport } from '../evals/split.js';
import { usd } from '../util/usd.js';
import { acceptProposal } from './accept.js';
import { attribute, collectFailures } from './attribute.js';
import { validateHoldout } from './holdout.js';
import { atomicWrite } from './journal.js';
import { lessonsOf } from './ledger.js';
import { cyclesDir } from './paths.js';
import type { Proposer } from './propose.js';
import type { CycleBudget, CycleReport, Proposal, VerifyOutcome } from './types.js';
import { isWorthAccepting, verifyProposal } from './verify.js';

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
   * 成本上限（美元）。超了就提前收工并如实记进记录。
   *
   * 口径是**整次运行**，不是本轮：`--rounds` 连跑时上限只在整段运行上生效
   * （`priorSpentUsd` 把前几轮的花费累加进来）。每轮各自重置的话，
   * `--rounds 5 --max-cost 1` 会花掉 5 美元 —— 而配置里写的是一个数。
   *
   * 与 `maxVerify` 是两个维度：那个限制**次数**，这个限制**钱**。设了上限后，
   * 第一遍基线跑完就可能已经超了 —— 此时连提案都不必提，那一步也烧钱。
   */
  readonly maxCostUsd?: number | undefined;
  /**
   * 本轮之前已经花掉的钱（`--rounds` 连续跑时由调用方累加）。
   *
   * 只影响预算闸与 `budget.spentUsd` 的口径；本轮 `costUsd` 仍然只算这一轮 ——
   * 把「这次花了多少」与「一共花了多少」混成一个数，看记录的人就无法判断
   * 「第 3 轮是不是特别贵」。
   */
  readonly priorSpentUsd?: number | undefined;
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
  const emit = (body: Omit<CycleReport, 'cycleId' | 'path' | 'at'>): CycleReport =>
    writeCycle(opts.config, body, cycleId);

  const limit = opts.maxCostUsd;
  let spent = 0;
  let costKnown = true;
  // `--rounds` 连续跑时，预算上限是**整次运行**的上限，不是每轮各自一份：
  // 每轮重置的话，N 轮就能花掉 N 倍预算，而配置里写的是一个数。
  const prior = opts.priorSpentUsd ?? 0;
  const totalSpent = (): number => prior + spent;
  const budgetOf = (stopped: boolean): CycleBudget | undefined =>
    limit === undefined ? undefined : { limitUsd: limit, spentUsd: totalSpent(), stopped };

  // 先读教训、再跑基线。顺序有代价含义：账本坏了（半截 cycle JSON）要在花掉一遍
  // 评测钱**之前**炸；读失败也绝不能降级成「没有历史」——那正好是「提案器重复
  // 试同一个坏方向」的成因，而它看起来完全正常。
  const lessons = lessonsOf(opts.config);

  // 完整报告落盘（审计要看到全部用例），但归因与候选排序只准看 train。
  const fullBaseline = await runSuite({
    config: opts.config,
    assets: opts.assets,
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.client !== undefined ? { client: opts.client } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...tuning(opts),
  });
  const views = splitReport(fullBaseline);
  const baseline = views.train;
  const holdoutBaseline = views.holdout;

  spent += fullBaseline.costUsd;
  costKnown = costKnown && fullBaseline.costKnown;

  // 预算闸：基线就超了就直接收工。此时连提案都不提 —— 提案那一步要再调一次模型，
  // 在「已经超预算」的前提下继续花钱是最没道理的
  if (limit !== undefined && costKnown && totalSpent() > limit) {
    return emit({
      modes: [],
      proposals: [],
      verified: [],
      accepted: [],
      rejected: [],
      baseline: fullBaseline,
      dryRun,
      costUsd: spent,
      costKnown,
      budget: budgetOf(true),
      // 没有 historyConsulted：这条路径根本没走到提案那一步（见 CycleReport 的三态说明）
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
      baseline: fullBaseline,
      dryRun,
      costUsd: spent,
      costKnown,
      budget: budgetOf(false),
      // 同上：没有失败模式就没有提案，也就没有「参考了几条历史」
    });
  }

  const modes = attribute(samples);
  const proposals = await opts.proposer.propose({
    modes,
    assets: opts.assets,
    config: opts.config,
    ...(opts.client !== undefined ? { client: opts.client } : {}),
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    history: lessons,
  });
  // 提案也烧钱，而且发生在预算闸第一次检查之前 —— 此前只记基线与候选，
  // `--max-cost` 是系统性偏低的（真模型上一轮提案器可能比一条用例还贵）
  const proposalCost = opts.proposer.costUsd;
  if (proposalCost !== undefined) spent += proposalCost;
  costKnown = costKnown && (opts.proposer.costKnown ?? true);

  const maxVerify = opts.maxVerify ?? 3;
  const verified: VerifyOutcome[] = [];
  const accepted: Proposal[] = [];
  const rejected: { proposal: Proposal; reason: string }[] = [];
  let winner: VerifyOutcome | undefined;
  let budgetStopped = false;

  for (const proposal of proposals.slice(0, maxVerify)) {
    if (limit !== undefined && costKnown && totalSpent() > limit) {
      budgetStopped = true;
      rejected.push({
        proposal,
        reason: `预算已用完（已花 ${usd(totalSpent())} ≥ 上限 ${usd(limit)}），本次不验证`,
      });
      continue;
    }
    if (winner !== undefined) {
      rejected.push({ proposal, reason: '本轮已选定另一个提案（单变量原则），本次不验证' });
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
        only: views.trainCases,
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
    if (!isWorthAccepting(outcome)) {
      // 门放行但没有任何用例变好：这只是「没变坏」，不值得落盘（会污染 git 历史）
      rejected.push({ proposal, reason: '没有任何用例变好（仅"没变差"，不值得改动资产）' });
      continue;
    }
    // 只记住赢家，不在这里落盘：留出集验证还没做，落了就没法拒了
    winner = outcome;
  }

  for (const proposal of proposals.slice(maxVerify)) {
    rejected.push({ proposal, reason: `超过本轮验证上限（${maxVerify}），本次不验证` });
  }

  // 留出集只在赢家身上跑一次。跑完即使发现过拟合，也不回头试第二候选 ——
  // 否则留出集就成了第二个调参集，这一整层验证的意义会归零。
  if (winner !== undefined && holdoutBaseline !== undefined) {
    if (limit !== undefined && costKnown && totalSpent() > limit) {
      budgetStopped = true;
      rejected.push({
        proposal: winner.proposal,
        reason: `train 已选出候选，但预算不足以做留出集验证（${usd(totalSpent())} / ${usd(limit)}），拒绝采纳`,
      });
      winner = undefined;
    } else {
      try {
        const holdout = await validateHoldout({
          config: opts.config,
          assets: opts.assets,
          proposal: winner.proposal,
          baseline: holdoutBaseline,
          cases: views.holdoutCases,
          ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
          ...(opts.client !== undefined ? { client: opts.client } : {}),
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
          ...tuning(opts),
        });
        spent += holdout.candidate.costUsd;
        costKnown = costKnown && holdout.candidate.costKnown;
        winner = { ...winner, holdout };
        const i = verified.findIndex((v) => v.proposal.id === winner?.proposal.id);
        if (i >= 0) verified[i] = winner;
      } catch (e) {
        rejected.push({
          proposal: winner.proposal,
          reason: `留出集验证失败: ${e instanceof Error ? e.message : String(e)}`,
        });
        winner = undefined;
      }
    }
  }
  if (winner !== undefined && !isWorthAccepting(winner)) {
    rejected.push({
      proposal: winner.proposal,
      reason: `留出集未通过：${winner.holdout?.gate.reason ?? '未知原因'}`,
    });
    winner = undefined;
  }
  if (winner !== undefined) {
    if (!dryRun) acceptProposal(opts.config, opts.assets, winner);
    accepted.push(winner.proposal);
  }

  return emit({
    modes,
    proposals,
    verified,
    accepted,
    rejected,
    baseline: fullBaseline,
    dryRun,
    costUsd: spent,
    costKnown,
    // 跑完才发现超限也算「预算用完」：`--rounds` 若不据此收工，下一轮会先跑一遍
    // 基线才意识到已经没钱了 —— 那一遍基线是纯粹的浪费，而且会让记录里多出一条
    // 「预算已用完」的轮次，看起来像闸失灵
    budget: budgetOf(budgetStopped || (limit !== undefined && costKnown && totalSpent() > limit)),
    historyConsulted: lessons.length,
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

// 路径定义搬到 paths.ts（ledger 也要用，留在 loop 会形成 loop ↔ ledger 的值循环）。
// 这里继续 re-export：`index.ts` 与既有调用一直从 loop 取它。
export { cyclesDir };

/**
 * 落一份轮次记录。**自动 RSI 与手工采纳共用** —— 手工 `rsi accept` 若不落记录，
 * `rsi regress` 就永远找不到那次采纳的基准（于是手工采纳的改动永远监测不到），
 * `rsi ledger` 也只能把它标成 `unverified`。
 */
export function writeCycle(
  config: HarnessConfig,
  body: Omit<CycleReport, 'cycleId' | 'path' | 'at'>,
  cycleId = makeCycleId(),
): CycleReport {
  // 时刻写成**字段**，不靠文件名反解：文件名是给人看的，不该同时是数据接口
  const at = new Date().toISOString();
  const path = persistCycle(config, { at, cycleId, ...body });
  return { at, ...body, cycleId, path };
}

function persistCycle(config: HarnessConfig, report: Omit<CycleReport, 'path'>): string {
  const dir = cyclesDir(config);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${report.cycleId}.json`);
  // 与 journal 同款：写到一半崩了不能留下半个 cycle JSON —— 那是 RSI 唯一的审计依据
  atomicWrite(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}
