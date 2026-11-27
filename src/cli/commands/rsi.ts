import { resolve } from 'node:path';
import type { ModelClient } from '@migor/agentia';
import { describeError, HarnessError } from '../../errors.js';
import { runSuite } from '../../evals/run.js';
import { splitReport } from '../../evals/split.js';
import { acceptProposal, revertLast } from '../../rsi/accept.js';
import { Budget } from '../../rsi/budget.js';
import { validateHoldout } from '../../rsi/holdout.js';
import { appendHoldoutUse, holdoutProgress, pickHoldoutBatch } from '../../rsi/holdout-batch.js';
import { makeCycleId, writeCycle } from '../../rsi/loop.js';
import { readProposal, writeProposal } from '../../rsi/manual.js';
import { LlmProposer } from '../../rsi/propose.js';
import { type RoundStopReason, runRounds } from '../../rsi/rounds.js';
import type { CycleReport, HoldoutResult, VerifyOutcome } from '../../rsi/types.js';
import { isWorthAccepting, verifyProposal } from '../../rsi/verify.js';
import { usd } from '../../util/usd.js';
import { boolFlag, numFlag, strFlag } from '../args.js';
import { assetsOf, type CliContext } from '../context.js';
import { json, say, warn } from '../output.js';
import { journal, ledger, regress, status } from './rsi-inspect.js';
import { tuningOf } from './run.js';

/** `harness rsi [revert|status|propose|accept]` —— 闭环的入口 */
export async function rsiCommand(
  ctx: CliContext,
  sub: string | undefined,
  argsId?: string,
): Promise<number> {
  if (sub === 'revert') return revert(ctx, argsId);
  if (sub === 'status') return status(ctx);
  if (sub === 'ledger') return ledger(ctx);
  if (sub === 'regress') return regress(ctx);
  if (sub === 'journal') return journal(ctx);
  if (sub === 'propose') return proposeFrom(ctx);
  if (sub === 'accept') return acceptFrom(ctx);
  if (sub !== undefined) {
    throw new HarnessError(
      'config.invalid',
      `rsi 没有子命令 "${sub}"（可用: revert, status, ledger, regress, journal, propose, accept）`,
    );
  }
  return cycle(ctx);
}

function fromFlag(ctx: CliContext, sub: string): string {
  const p = strFlag(ctx.flags, 'from');
  if (p === undefined) {
    throw new HarnessError('config.invalid', `rsi ${sub} 需要 --from <提案.json>`);
  }
  return resolve(ctx.root, p);
}

/** 登记一份手写的 L1 提案。只校验与落盘，不调模型、不改源文件 */
function proposeFrom(ctx: CliContext): number {
  const proposal = readProposal(fromFlag(ctx, 'propose'));
  const path = writeProposal(ctx.config, proposal);
  if (boolFlag(ctx.flags, 'json')) json({ id: proposal.id, path });
  else say(`已登记手写提案 ${proposal.id} → ${path}`);
  return 0;
}

/**
 * 采纳手写提案。**同样跑完整的两遍评测 + 回归门** —— 来源可以变，门不能变。
 *
 * 没有 `--yes` 之类的跳门开关是刻意的：`acceptManually` 作为库 API 存在，但把它
 * 暴露成 CLI 选项，等于给「评测门在 RSI 写权限之外」这条不变量开后门。
 */
export async function acceptFrom(ctx: CliContext, client?: ModelClient): Promise<number> {
  const proposal = readProposal(fromFlag(ctx, 'accept'));
  // 轮次 id 先生成：留出集消耗账要用它，而记账发生在 `writeCycle` **之前** ——
  // 反过来的话，写记录失败会让这一批在账上"看起来没用过"，下一轮白送一次复用
  const cycleId = makeCycleId();
  const assets = assetsOf(ctx);
  const shared = {
    config: ctx.config,
    assets,
    ...(client !== undefined ? { client } : {}),
    ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
    ...tuningOf(ctx),
  };
  const fullBaseline = await runSuite(shared);
  const views = splitReport(fullBaseline);
  let outcome = await verifyProposal({
    ...shared,
    baseline: views.train,
    proposal,
    only: views.trainCases,
  });
  if (!outcome.gate.ok) {
    warn(`train 验证门未通过，拒绝采纳 ${proposal.id}：${outcome.gate.reason}`);
    return 1;
  }
  // 与自动 RSI 同一道「必须真的变好」检查 —— 手写提案不许靠 no-op 改动混进 git 历史
  if (!isWorthAccepting(outcome)) {
    warn(`提案 ${proposal.id} 没有任何用例变好（仅"没变差"），拒绝采纳`);
    return 1;
  }
  let holdoutBatch: CycleReport['holdoutBatch'];
  if (views.holdout !== undefined) {
    // 与自动 RSI **同一条**分批规则：手写提案不是绕开消耗账的后门。
    // 否则「自动路径的留出集用完了」只对自动路径成立，人对同一条门就免费了
    const progress = holdoutProgress(ctx.config, views.holdout.cases);
    const pick = pickHoldoutBatch(progress);
    if (!pick.ok) {
      warn(`留出集不可用，拒绝采纳 ${proposal.id}：${pick.reason}`);
      return 1;
    }
    let holdout: HoldoutResult | undefined;
    try {
      holdout = await validateHoldout({
        ...shared,
        proposal,
        baseline: views.holdout,
        cases: pick.batch.cases,
      });
    } catch (e) {
      // 与 runCycle 同口径：验证本身出问题记为「拒绝」，不让命令以异常退出
      warn(
        `留出集验证失败，拒绝采纳 ${proposal.id}：${e instanceof Error ? e.message : String(e)}`,
      );
      return 1;
    }
    outcome = { ...outcome, holdout };
    if (!isWorthAccepting(outcome)) {
      warn(`留出集未通过，拒绝采纳 ${proposal.id}：${holdout.gate.reason}`);
      return 1;
    }
    // 消耗与结果无关：这一次观测已经发生，即使结论是"不通过"
    appendHoldoutUse(ctx.config, {
      at: Date.now(),
      cycleId,
      proposalId: proposal.id,
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
    say(`留出集验证通过：${holdout.gate.reason}`);
  }
  const dryRun = boolFlag(ctx.flags, 'dry-run');
  // 成本口径与自动 RSI 一致：基线 + 候选（+ 留出集候选）。走同一个 `Budget` 而不是
  // 在这里再写一遍累加 —— 「花费怎么算」只能有一处定义，否则两条路径迟早对不上
  const budget = new Budget(undefined, 0);
  budget.charge(fullBaseline.costUsd, fullBaseline.costKnown);
  budget.charge(outcome.candidate.costUsd, outcome.candidate.costKnown);
  if (outcome.holdout !== undefined) {
    budget.charge(outcome.holdout.candidate.costUsd, outcome.holdout.candidate.costKnown);
  }
  if (dryRun) {
    say(`dry-run：${proposal.id} 过了门，未落盘（${outcome.gate.reason}）`);
  } else {
    const { entry } = acceptProposal(ctx.config, assets, outcome);
    say(`已采纳 ${entry.proposalId} → ${entry.target}（${entry.reason}）`);
  }
  // 手工采纳也要落一份轮次记录：`rsi regress` 的基准取自 cycle JSON 的 candidate，
  // 没有记录就只能报「找不到基准」—— 而那意味着手工采纳的改动永远监测不到
  try {
    writeCycle(
      ctx.config,
      {
        modes: [],
        proposals: [proposal],
        verified: [outcome],
        accepted: [proposal],
        rejected: [],
        baseline: fullBaseline,
        dryRun,
        costUsd: budget.spentUsd,
        costKnown: budget.costKnown,
        budget: undefined,
        ...(holdoutBatch === undefined ? {} : { holdoutBatch }),
      },
      cycleId,
    );
  } catch (e) {
    // 采纳已经落盘了，记录写失败不能反过来把这条命令判死 —— 但要喊出来：
    // 缺这条记录等于这条改动以后没法做回归监测
    warn(`轮次记录写入失败（采纳已生效，但 rsi regress 将找不到基准）：${describeError(e)}`);
  }
  return 0;
}

async function cycle(ctx: CliContext): Promise<number> {
  const rounds = roundsFlag(ctx);
  const maxModes = numFlag(ctx.flags, 'max-modes');
  const maxVerify = numFlag(ctx.flags, 'max-verify');
  // 配额的触发间隔可临时收窄（例如 CI 里想每 2 条改动就强制简化一次）。
  // 只开放 every：`maxGrowth` 与 `minReduction` 改的是判据的语义，不该由命令行随手调
  const shrinkEvery = numFlag(ctx.flags, 'shrink-every');
  const dryRun = boolFlag(ctx.flags, 'dry-run');
  // `--max-cost` 覆盖配置：CI 里想临时收紧预算不必改文件
  const maxCost = numFlag(ctx.flags, 'max-cost') ?? ctx.config.maxCostUsd;
  const asJson = boolFlag(ctx.flags, 'json');

  const result = await runRounds({
    config: ctx.config,
    assets: assetsOf(ctx),
    rounds,
    // 每轮新建提案器：它带累计花费状态，复用会把两轮的账并成一条
    makeProposer: () =>
      new LlmProposer(ctx.config, {
        ...(maxModes !== undefined ? { maxModes } : {}),
        // 提不出方案的模式要**说出来**：静默跳过会让「这轮为什么没改」无从解释
        onSkip: (modeId, reason) => warn(`  跳过 ${modeId}: ${reason}`),
      }),
    ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
    ...(maxVerify !== undefined ? { maxVerify } : {}),
    ...(maxCost !== undefined ? { maxCostUsd: maxCost } : {}),
    ...(shrinkEvery !== undefined ? { shrinkPolicy: { every: shrinkEvery } } : {}),
    ...(dryRun ? { dryRun: true } : {}),
    ...tuningOf(ctx),
    ...(asJson
      ? {}
      : {
          onRound: (report: CycleReport, i: number) => {
            if (rounds > 1) say(`\n=== 第 ${i + 1}/${rounds} 轮 ===`);
            renderCycle(report);
          },
        }),
  });

  if (asJson) {
    json(rounds === 1 ? result.rounds[0] : result);
  } else if (rounds > 1) {
    const why =
      result.stopReason === 'rounds' ? '' : `（提前结束：${stopLabel(result.stopReason)}）`;
    say(`\n共跑 ${result.rounds.length} 轮，采纳 ${result.acceptedRounds} 轮${why}`);
    if (maxCost !== undefined) {
      // 成本未知时不能印一个确切的美元数：它只是**已知部分**的下限
      say(
        result.costKnown
          ? `累计成本 ${usd(result.costUsd)} / ${usd(maxCost)}`
          : `累计成本未知（已知下限 ${usd(result.costUsd)} / ${usd(maxCost)}）—— 有轮次没定价或端点没报计量`,
      );
    }
  }

  // 「没有失败样本」是正常状态（资产已经够了），不能算失败 —— 否则全绿的仓
  // 跑一次 RSI 就红，CI 会教人忽略这个退出码
  return result.acceptedRounds > 0 || result.stopReason === 'no_failures' ? 0 : 1;
}

function roundsFlag(ctx: CliContext): number {
  const raw = numFlag(ctx.flags, 'rounds');
  if (raw === undefined) return 1;
  if (!Number.isInteger(raw) || raw < 1) {
    throw new HarnessError('config.invalid', `--rounds 必须是正整数（收到 ${raw}）`);
  }
  return raw;
}

function stopLabel(reason: RoundStopReason): string {
  switch (reason) {
    case 'rounds':
      return '跑满轮数';
    case 'budget':
      return '预算用完';
    case 'no_progress':
      return '本轮没有可采纳的改动';
    case 'no_failures':
      return '没有失败样本';
    case 'shrink_stalled':
      return '简化轮没交出可用的删除（配额到期，只接受净简化提案）';
  }
}

/** 单轮的完整回执（多轮时每轮打一遍） */
function renderCycle(report: CycleReport): void {
  say(`轮次 ${report.cycleId}（记录 ${report.path}）`);
  if (report.shrink?.required === true) {
    say(`简化轮：${report.shrink.reason ?? '配额已到期'}`);
  }
  if (report.modes.length === 0) {
    say('没有失败样本，无需改进');
    return;
  }
  say(`失败模式 ${report.modes.length} 个：`);
  // 账本回灌是软约束（写进提示词），看不见就等于没有 —— 把条数打出来，
  // 「这轮为什么又提了同一个方向」才有第一个可查的地方
  if ((report.historyConsulted ?? 0) > 0) {
    say(`（提案前参考了 ${report.historyConsulted} 条历史教训：试过但没成立的方向）`);
  }
  for (const m of report.modes) {
    const target = m.targets[0]?.target ?? '（无资产命中）';
    say(`  [${m.kind}] ${m.signature}  ×${m.count} → 偏向改 ${target}`);
  }
  say(
    report.costKnown
      ? `\n本轮成本 ${usd(report.costUsd)}`
      : `\n本轮成本未知（模型不在价格表内或端点没报计量），token 只能当代理`,
  );
  if (report.budget !== undefined) {
    const b = report.budget;
    // spentUsd 是**跨轮累计**（`--rounds` 下上限只在整次运行上生效），措辞必须跟着变，
    // 否则第 3 轮会显示「预算 12.4 / 5 —— 本轮提前收工」，读起来像闸每轮都失灵
    say(
      `预算：累计已花 ${usd(b.spentUsd)} / 上限 ${usd(b.limitUsd)}` +
        (b.stopped ? ' —— 已用完，不再开下一轮' : ''),
    );
  }
  say(`\n提出 ${report.proposals.length} 个提案，验证 ${report.verified.length} 个：`);
  for (const v of report.verified) {
    say(
      `  ${v.gate.ok ? 'PASS ' : 'BLOCK'}  ${v.proposal.id} → ${v.proposal.patch.target}：${v.gate.reason}`,
    );
    const hint = diffHint(v);
    if (hint !== undefined) say(`        ${hint}`);
  }
  if (report.holdoutBatch !== undefined) {
    const b = report.holdoutBatch;
    // 复用（只在未分期工程里可能）必须明说：它不会报错，但那一次验证的假阳性已经
    // 不再是 5%，而通过率看起来与第一次一模一样
    const reuse =
      b.priorUses > 0
        ? `（⚠️ 复用第 ${b.priorUses + 1} 次${b.enforced ? '' : '：工程未分期留出集'}）`
        : '';
    say(`\n留出集第 ${b.phase} 批 ${b.cases.length} 条${b.enforced ? '' : '（未分期）'}${reuse}`);
  }
  if (report.accepted.length > 0) {
    const suffix = report.dryRun ? '（dry-run，未落盘）' : '';
    say(
      `\n采纳 ${report.accepted.length} 个${suffix}：${report.accepted.map((p) => p.id).join(', ')}`,
    );
  }
  for (const r of report.rejected) say(`  拒绝 ${r.proposal.id}：${r.reason}`);
}

/**
 * 「差在哪」的下一步 —— 门只说得出哪条用例退步，说不出行为上差了什么。
 *
 * 刻意**只给命令、不自动 diff**：评测默认不落 trace（`runSuite` 的 `keepTraces: false`
 * 是刻意的，否则 `traces.jsonl` 会被几十上百条跑分撑成垃圾场）。默认配置下自动 diff
 * 拿不到任何一条 trace，会静默变成空操作 —— 而一个大多数时候什么都不做的自动化，
 * 比一条说清前提的命令有害。
 */
function diffHint(v: VerifyOutcome): string | undefined {
  const baselineIds = new Map(v.baseline.cases.map((c) => [c.name, c.traceId]));
  for (const name of v.gate.regressedCases) {
    const a = baselineIds.get(name);
    const b = v.candidate.cases.find((c) => c.name === name)?.traceId;
    if (a !== undefined && b !== undefined) {
      return `想看「${name}」差在哪：harness diff ${a} ${b}（需那两次跑都开了 --keep-traces）`;
    }
  }
  return undefined;
}

function revert(ctx: CliContext, id: string | undefined): number {
  const r = revertLast(ctx.config, id);
  say(`已回滚 ${r.entry.proposalId}：${r.entry.target}`);
  return 0;
}
