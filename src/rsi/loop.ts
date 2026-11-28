import type { ModelClient } from '@migor/agentia';
import type { HarnessConfig } from '../config.js';
import type { GateOptions } from '../evals/gate.js';
import { pickTuning, runSuite } from '../evals/run.js';
import type { CycleOptions } from './cycle-options.js';

export type { CycleOptions } from './cycle-options.js';

import { splitReport, subsetReport } from '../evals/split.js';
import { acceptProposal } from './accept.js';
import { attribute, collectFailures } from './attribute.js';
import { makeSink } from './cycle-sink.js';
import { makeCycleId } from './cycles.js';
import { validateHoldout } from './holdout.js';
import { appendHoldoutUse, holdoutProgress, pickHoldoutBatch } from './holdout-batch.js';
import { lessonsOf } from './ledger.js';
import type { Proposer } from './propose.js';
import {
  DEFAULT_SHRINK_POLICY,
  partitionForShrink,
  type ShrinkPolicy,
  shrinkState,
} from './shrink.js';
import { Spender } from './spender.js';
import { filterTargets } from './target-filter.js';
import type { CycleReport, Proposal, VerifyOutcome } from './types.js';
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
export async function runCycle(opts: CycleOptions): Promise<CycleReport> {
  const cycleId = makeCycleId();
  const dryRun = opts.dryRun === true;

  /**
   * 每一轮都落一份记录（含 dryRun）—— 这是 RSI 可审计的唯一物理依据。
   *
   * 写失败的策略是**让整轮失败**：一个「跑了但没记录」的 RSI 轮次比不跑更糟，
   * 因为它动过（或差点动过）资产，事后却无从复盘。
   */
  // 成本账只有一个家（`Spender` → `Budget`）：`spent +=` / `costKnown &&` /
  // `budgetStopped` 曾在这个函数里各写四遍，新增一个花钱阶段就要同步改四处 ——
  // 漏一处的症状是**闸静默偏低**，不报错、只是多花钱。`--rounds` 的上限是整次运行
  // 的（prior 由调用方累加）。
  //
  // 余额窗口也开在这里，因为窗口的边界就是「一轮」；放在 CLI，`--rounds` 得在循环
  // 里再开一次，`--watch` 又是一处。拿不到余额就退回旧行为（估算 + `blind` 停机）：
  // **退化路径必须是旧的正确行为**，不是新的错行为。
  const spending = await Spender.open(opts.config, {
    ...(opts.maxCostUsd !== undefined ? { limitUsd: opts.maxCostUsd } : {}),
    ...(opts.maxTokens !== undefined ? { limitTokens: opts.maxTokens } : {}),
    ...(opts.priorSpentUsd !== undefined ? { priorUsd: opts.priorSpentUsd } : {}),
    ...(opts.priorTokens !== undefined ? { priorTokens: opts.priorTokens } : {}),
    ...(opts.meter !== undefined ? { meter: opts.meter } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  const { finish } = makeSink(opts.config, cycleId, spending);

  /**
   * 这一轮是普通的「修失败」轮，还是**简化轮**。
   *
   * 在花钱之前算：它决定「这一轮允许改什么」，而这件事必须在提案之前定下来 ——
   * 提完案再筛，等于让模型先用一次调用去写一份注定被丢弃的稿子。
   *
   * 状态从历史现算（`shrink.ts`），不落游标：`cycles/*.json` 已经是采纳与门结论的
   * 唯一真相，再加一个"当前是不是简化轮"的文件，就多了一处会与历史不一致的东西。
   */
  const shrink = shrinkState(opts.config, opts.shrinkPolicy);
  const minReduction = opts.shrinkPolicy?.minReduction ?? DEFAULT_SHRINK_POLICY.minReduction;
  // 三态口径：`required: false` 是「算过、这轮不用简化」，与「旧记录没有这个字段」不同
  const shrinkFacts: NonNullable<CycleReport['shrink']> = {
    required: shrink.required,
    ...(shrink.reason !== undefined ? { reason: shrink.reason } : {}),
    sinceShrink: shrink.sinceShrink,
    growth: shrink.growth,
    basis: shrink.basis,
  };

  // 先读教训、再跑基线。顺序有代价含义：账本坏了（半截 cycle JSON）要在花掉一遍
  // 评测钱**之前**炸；读失败也绝不能降级成「没有历史」——那正好是「提案器重复
  // 试同一个坏方向」的成因，而它看起来完全正常。
  const lessons = lessonsOf(opts.config);

  // 完整报告落盘（审计要看到全部用例），但归因与候选排序只准看 train。
  const fullBaseline = await runSuite({
    config: opts.config,
    assets: opts.assets,
    // **必须与候选同一个 runner**。漏了这一句的后果是实测到过的：远程模式下基线跑在本地、
    // 候选跑在服务上 —— 于是一个本地模型与一个远程服务的成绩被放进同一个门里比较，
    // 而报告里看起来完全正常（`model` 字段还都是各自报的）。归因也会失真：本地那次没有
    // 派单，于是「该改哪个资产」永远是空的。
    //
    // 基线不需要 `stage`：它用的就是当前资产，而预检已经保证远端跑的就是这一份。
    ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.client !== undefined ? { client: opts.client } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...pickTuning(opts),
  });
  const views = splitReport(fullBaseline);
  const baseline = views.train;
  const holdoutBaseline = views.holdout;

  await spending.charge(fullBaseline.costUsd, fullBaseline.costKnown, fullBaseline.tokens);

  // 预算闸：基线就跑完闸就关了，直接收工。此时连提案都不提 —— 提案那一步要再调一次
  // 模型，在「已经超预算」的前提下继续花钱是最没道理的。
  //
  // 这里同时覆盖 `blind`（设了美元上限但成本读不出、又没给 token 兜底）：那种情况下
  // 闸是瞎的，继续跑等于在一个看不见的账上烧钱。停下来并把原因写进报告（`stoppedBy`），
  // 比事后从账单上发现「--max-cost 从来没生效过」便宜得多。
  //
  // 但「瞎」有两种，只有一种是绝境：**能读余额的端点**上，刚才那一步已经用真实扣费
  // 对过账了（`reconcile`），`blind` 自然消失，闸按账单判 —— 这才是 `--max-cost`
  // 对未定价模型应有的行为。读不到余额时才退回停机。
  if (spending.exceeded()) {
    return finish(() => ({
      modes: [],
      proposals: [],
      verified: [],
      accepted: [],
      rejected: [],
      baseline: fullBaseline,
      dryRun,
      costUsd: spending.spentUsd,
      costKnown: spending.costKnown,
      budget: spending.snapshot(true),
      shrink: shrinkFacts,
      // 没有 historyConsulted：这条路径根本没走到提案那一步（见 CycleReport 的三态说明）
    }));
  }

  const samples = collectFailures(baseline);
  if (samples.length === 0) {
    return finish(() => ({
      modes: [],
      proposals: [],
      verified: [],
      accepted: [],
      rejected: [],
      baseline: fullBaseline,
      dryRun,
      costUsd: spending.spentUsd,
      costKnown: spending.costKnown,
      budget: spending.snapshot(false),
      shrink: shrinkFacts,
      // 同上：没有失败模式就没有提案，也就没有「参考了几条历史」
    }));
  }

  const modes = attribute(samples);
  const proposed = await opts.proposer.propose({
    modes,
    assets: opts.assets,
    config: opts.config,
    ...(opts.client !== undefined ? { client: opts.client } : {}),
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    history: lessons,
    // 只说"请简化"不够 —— 必须给出目标字数（`renderShrink`），否则模型交出的
    // 是措辞层面的微调，长度几乎不变，然后被配额判据一条条拒掉
    ...(shrink.required && shrink.reason !== undefined
      ? { shrink: { reason: shrink.reason, minReduction } }
      : {}),
  });
  const proposals = proposed.proposals;
  // 提案也烧钱，且发生在预算闸第一次检查之前 —— 只记基线与候选时 `--max-cost`
  // 是系统性偏低的（真模型上一轮提案器可能比一条用例还贵）。成本与产出同一次返回，
  // 不再有「必须先 propose 再读属性」的时序契约。
  await spending.charge(proposed.cost.usd, proposed.cost.known);

  const maxVerify = opts.maxVerify ?? 3;
  const verified: VerifyOutcome[] = [];
  const accepted: Proposal[] = [];
  const rejected: { proposal: Proposal; reason: string }[] = [];
  let winner: VerifyOutcome | undefined;
  let budgetStopped = false;

  // 简化轮：先筛再验（规则在 `shrink.ts`，这里是"用了它"而不是"又写一遍"）。
  // 顺序有成本含义：变胖的提案一条都不跑评测，而简化轮恰好是最缺钱的那一轮。
  // 目标过滤（远程只能改有文件映射的目标）的判据在 `target-filter.ts`，这里只收结果。
  const filtered = filterTargets(proposals, opts.allowedTargets);
  rejected.push(...filtered.rejected);
  const { allowed: candidates, blocked } = partitionForShrink(
    filtered.stageable,
    shrink,
    minReduction,
  );
  rejected.push(...blocked);

  for (const proposal of candidates.slice(0, maxVerify)) {
    if (spending.exceeded()) {
      budgetStopped = true;
      rejected.push({
        proposal,
        reason: `预算已用完（${spending.describe()}），本次不验证`,
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
        ...(opts.stage !== undefined ? { stage: opts.stage } : {}),
        ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
        ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
        ...(opts.client !== undefined ? { client: opts.client } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(opts.gateOptions !== undefined ? { gateOptions: opts.gateOptions } : {}),
        ...pickTuning(opts),
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
    await spending.charge(
      outcome.candidate.costUsd,
      outcome.candidate.costKnown,
      outcome.candidate.tokens,
    );

    if (!outcome.gate.ok) {
      rejected.push({ proposal, reason: outcome.gate.reason });
      continue;
    }
    if (!isWorthAccepting(outcome, { shrink: shrink.required, minReduction })) {
      // 门放行但没有任何用例变好：这只是「没变坏」，不值得落盘（会污染 git 历史）。
      // 简化轮是唯一例外 —— 那一轮想要的正是「不变差但更小」
      rejected.push({
        proposal,
        reason: shrink.required
          ? '没有用例变好，且补丁没有真正变小（简化轮要求净减少）'
          : '没有任何用例变好（仅"没变差"，不值得改动资产）',
      });
      continue;
    }
    // 只记住赢家，不在这里落盘：留出集验证还没做，落了就没法拒了
    winner = outcome;
  }

  for (const proposal of candidates.slice(maxVerify)) {
    rejected.push({ proposal, reason: `超过本轮验证上限（${maxVerify}），本次不验证` });
  }

  // 留出集只在赢家身上跑一次。跑完即使发现过拟合，也不回头试第二候选 ——
  // 否则留出集就成了第二个调参集，这一整层验证的意义会归零。
  //
  // 「一次」是**每一批**一次（`holdout-batch.ts`）：留出集不变而轮次无限时，
  // 30 轮 × 每轮 5% 的累积假阳性约 78% —— 每一轮的门都"合法地"放过一点噪声。
  let holdoutBatch: CycleReport['holdoutBatch'];
  if (winner !== undefined && holdoutBaseline !== undefined) {
    if (spending.exceeded()) {
      budgetStopped = true;
      rejected.push({
        proposal: winner.proposal,
        reason: `train 已选出候选，但预算不足以做留出集验证（${spending.describe()}），拒绝采纳`,
      });
      winner = undefined;
    } else {
      const progress = holdoutProgress(opts.config, holdoutBaseline.cases);
      const pick = pickHoldoutBatch(progress);
      if (!pick.ok) {
        // 用完就停，不"退回第一批发重新用"：同一批第二次被用来验候选时，
        // 它已经被候选挑选过一遍，事实上已经是第二个 train
        rejected.push({ proposal: winner.proposal, reason: `留出集不可用：${pick.reason}` });
        winner = undefined;
      } else {
        try {
          const holdout = await validateHoldout({
            config: opts.config,
            assets: opts.assets,
            proposal: winner.proposal,
            ...(opts.stage !== undefined ? { stage: opts.stage } : {}),
            ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
            // 基线跟着批次一起收窄：候选只跑这一批，拿整份留出集当基线会被门判成
            // 「用例集不一致」—— 那不是判定标准变了，是两边比的不是同一批
            baseline: subsetReport(holdoutBaseline, pick.batch.cases),
            cases: pick.batch.cases,
            ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
            ...(opts.client !== undefined ? { client: opts.client } : {}),
            ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
            ...pickTuning(opts),
          });
          await spending.charge(
            holdout.candidate.costUsd,
            holdout.candidate.costKnown,
            holdout.candidate.tokens,
          );
          winner = { ...winner, holdout };
          const i = verified.findIndex((v) => v.proposal.id === winner?.proposal.id);
          if (i >= 0) verified[i] = winner;
          // 消耗记账：**与结果无关**。通过也消耗、否决也消耗 —— 只在"通过"时记账，
          // 等于把没通过的尝试变成免费的重复抽样，而那正是假阳性的来源。
          //
          // dry-run 也消耗：验一眼就是看一眼，资产没动不代表数据没被看过。
          appendHoldoutUse(opts.config, {
            at: Date.now(),
            cycleId,
            proposalId: winner.proposal.id,
            phase: pick.batch.phase,
            cases: pick.batch.cases,
            passed: holdout.gate.ok,
            reason: holdout.gate.reason,
          });
          holdoutBatch = {
            phase: pick.batch.phase,
            cases: pick.batch.cases,
            priorUses: pick.batch.used,
            enforced: progress.enforced,
          };
        } catch (e) {
          // 验证本身崩掉（补丁过期、装配错）**不消耗批次**：那不是一次观测。
          // 这条缝的代价是「重试一次坏掉的验证」，收益是「配置错误不会烧掉一整批留出集」
          rejected.push({
            proposal: winner.proposal,
            reason: `留出集验证失败: ${e instanceof Error ? e.message : String(e)}`,
          });
          winner = undefined;
        }
      }
    }
  }
  if (
    winner !== undefined &&
    !isWorthAccepting(winner, { shrink: shrink.required, minReduction })
  ) {
    rejected.push({
      proposal: winner.proposal,
      reason: `留出集未通过：${winner.holdout?.gate.reason ?? '未知原因'}`,
    });
    winner = undefined;
  }
  if (winner !== undefined) {
    if (!dryRun) {
      const { assets: after } = acceptProposal(
        opts.config,
        opts.assets,
        winner,
        shrink.required
          ? {
              reasonSuffix: `简化轮（${shrink.reason ?? '配额到期'}）—— 采纳标准是"更小"，不是"变好"`,
            }
          : {},
      );
      await opts.onAcceptedAssets?.(after);
    }
    accepted.push(winner.proposal);
  }

  return finish(() => ({
    modes,
    proposals,
    verified,
    accepted,
    rejected,
    baseline: fullBaseline,
    dryRun,
    costUsd: spending.spentUsd,
    costKnown: spending.costKnown,
    // 跑完才发现超限也算「预算用完」：`--rounds` 若不据此收工，下一轮会先跑一遍
    // 基线才意识到已经没钱了 —— 那一遍基线是纯粹的浪费，而且会让记录里多出一条
    // 「预算已用完」的轮次，看起来像闸失灵
    budget: spending.snapshot(budgetStopped || spending.exceeded()),
    historyConsulted: lessons.length,
    shrink: shrinkFacts,
    ...(holdoutBatch === undefined ? {} : { holdoutBatch }),
  }));
}

// 轮次记录的读写都在 `cycles.ts`（那一侧是「记录长什么样」的唯一定义处，
// 读写分家时 schema 与版本迁移迟早会对不上）。这里 re-export 保持既有导入面不变。
export { makeCycleId, writeCycle } from './cycles.js';
