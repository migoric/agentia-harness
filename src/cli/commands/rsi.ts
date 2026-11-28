import { DEFAULT_PER_USD } from '../../config-balance.js';
import { HarnessError } from '../../errors.js';
import { lowBalanceWarning } from '../../rsi/billing.js';
import { assertBudgetEnforceable } from '../../rsi/budget-guard.js';
import { withRsiLock, withRsiLockAsync } from '../../rsi/lock-guard.js';
import { LlmProposer } from '../../rsi/propose.js';
import { type RoundStopReason, runRounds } from '../../rsi/rounds.js';
import type { CycleReport, VerifyOutcome } from '../../rsi/types.js';
import { readBalance } from '../../run/balance.js';
import { usd } from '../../util/usd.js';
import { boolFlag, numFlag, strFlag } from '../args.js';
import { assetsOf, type CliContext } from '../context.js';
import { json, say, warn } from '../output.js';
import { maybeRemoteStage, type RemoteStage } from '../remote-stage.js';
import { requireModel } from '../require-model.js';
import { doctor } from './rsi-doctor.js';
import { journal, ledger, regress, status } from './rsi-inspect.js';
import { acceptFrom, proposeFrom, revert } from './rsi-manual.js';
import { announceRecovery } from './rsi-recover.js';
import { watchCommand } from './rsi-watch.js';
import { tuningOf } from './run.js';

/** `harness rsi [revert|status|propose|accept]` —— 闭环的入口 */
export async function rsiCommand(
  ctx: CliContext,
  sub: string | undefined,
  argsId?: string,
): Promise<number> {
  // `--remote` 只对「跑轮次」有意义：其余子命令各自只读/回滚，给它一个远程地址
  // 要么被静默忽略（人以为在测远程，其实在测本地），要么得为每个子命令想一套语义
  if (
    strFlag(ctx.flags, 'remote') !== undefined &&
    !(sub === undefined || sub === 'accept' || sub === 'regress')
  ) {
    throw new HarnessError(
      'config.invalid',
      `--remote 只用于跑轮次与回归检查（rsi / rsi --watch / rsi accept / rsi regress），` +
        `不能与 "${sub}" 一起用`,
    );
  }
  if (sub === 'revert') return withRsiLock(ctx.config, 'rsi revert', () => revert(ctx, argsId));
  // 体检不需要模型凭据：它回答的正是「为什么现在跑不起来」，而最常见的原因之一
  // 就是凭据没配 —— 让它卡在同一道闸后面，等于把诊断工具锁在故障里
  if (sub === 'doctor') return doctor(ctx);
  // 用法错误先于凭据错误。`--rounds 0` 与「没配 key」都是退出码 2，但先看到哪个
  // 决定人下一步去改什么：报凭据 ⇒ 他去配一个用完才发现参数还是错的 key。
  // 这三条与 `runRounds` 内部那份一致（那里是库 API 直调时的兜底），只是提前一次。
  assertRsiUsage(ctx);
  requireModel(ctx);
  if (sub === 'status') return status(ctx);
  if (sub === 'ledger') return ledger(ctx);
  if (sub === 'regress') {
    // 只读：不写候选，所以不需要 allowStaging 那道签字。但 `--revert` 会写资产，
    // 所以整条命令还是进锁 —— 与常驻 worker 并发回滚会把它的归因基础拆掉
    return withRsiLockAsync(ctx.config, 'rsi regress', async () =>
      regress(ctx, undefined, await maybeRemoteStage(ctx, { needsStaging: false })),
    );
  }
  if (sub === 'journal') return journal(ctx);
  if (sub === 'propose') return proposeFrom(ctx);
  if (sub === 'accept') {
    // 手写采纳同样改资产与 journal：与常驻 worker 并发时，两边都会以为自己是
    // 「最近一条采纳」，回滚基准随即错位。锁在远端装配之前拿 —— 那一步也会写文件。
    return withRsiLockAsync(ctx.config, 'rsi accept', async () =>
      acceptFrom(ctx, undefined, await maybeRemoteStage(ctx)),
    );
  }
  // `--watch` 自己拿锁（在装配远端之前），所以这条分支不再进 `withRsiLock`
  if (boolFlag(ctx.flags, 'watch')) return watchCommand(ctx, () => maybeRemoteStage(ctx));
  if (sub !== undefined) {
    throw new HarnessError(
      'config.invalid',
      `rsi 没有子命令 "${sub}"（可用: doctor, revert, status, ledger, regress, journal, propose, accept）`,
    );
  }
  return cycle(ctx, () => maybeRemoteStage(ctx));
}

/**
 * 一次跑完的轮次 —— **先拿锁再装配远端**。
 *
 * 锁的位置有讲究：`maybeRemoteStage` 会做「回收上次崩溃留下的候选」「对齐远端」
 * 两个写动作，把它们留在锁外，等于在最容易出事的窗口里让两个进程同时写。
 * 而 `--watch` 不走这里（它自己持锁并刷心跳，见 `runWatch`）。
 */
async function cycle(
  ctx: CliContext,
  makeRemote: () => Promise<RemoteStage | undefined>,
): Promise<number> {
  return withRsiLockAsync(ctx.config, 'rsi', () => runCycleCommand(ctx, makeRemote));
}

async function runCycleCommand(
  ctx: CliContext,
  makeRemote: () => Promise<RemoteStage | undefined>,
): Promise<number> {
  // 锁在手上、还没开始花钱：先修上一次的中间态（资产已改但账本缺条目）
  announceRecovery(ctx.config);
  const remote = await makeRemote();
  const rounds = roundsFlag(ctx);
  const maxModes = numFlag(ctx.flags, 'max-modes');
  const maxVerify = numFlag(ctx.flags, 'max-verify');
  // 配额的触发间隔可临时收窄（例如 CI 里想每 2 条改动就强制简化一次）。
  // 只开放 every：`maxGrowth` 与 `minReduction` 改的是判据的语义，不该由命令行随手调
  const shrinkEvery = numFlag(ctx.flags, 'shrink-every');
  const dryRun = boolFlag(ctx.flags, 'dry-run');
  // `--max-cost` 覆盖配置：CI 里想临时收紧预算不必改文件
  const maxCost = numFlag(ctx.flags, 'max-cost') ?? ctx.config.maxCostUsd;
  // 美元闸在「模型没定价」时读不出数（见 `budget.ts`）—— 开跑前就确认它到底有没有闸，
  // 而不是等花完一圈才发现报告里少了个 $ 号
  const maxTokens = numFlag(ctx.flags, 'max-tokens');
  const guardNote = assertBudgetEnforceable({
    config: ctx.config,
    assets: assetsOf(ctx),
    ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
    ...(maxCost !== undefined ? { maxCostUsd: maxCost } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(remote !== undefined ? { remote: true } : {}),
  });
  if (guardNote !== undefined) warn(guardNote);

  // 余额告警：只在配了 `balance.warnBelowUsd` 时多花一次 GET。它说的是**开跑前唯一
  // 确定的事** —— 账户里还剩多少钱。而「跑到一半没钱」的后果很容易被误读成评测结论
  // （一排 stopReason=error 的用例）。
  const warnBelow = ctx.config.balance?.warnBelowUsd;
  if (warnBelow !== undefined) {
    const probe = await readBalance(ctx.config);
    if (probe.ok) {
      const low = lowBalanceWarning(
        probe.snapshot,
        ctx.config.balance?.perUsd ?? DEFAULT_PER_USD,
        warnBelow,
      );
      if (low !== undefined) warn(low);
    }
  }
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
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(shrinkEvery !== undefined ? { shrinkPolicy: { every: shrinkEvery } } : {}),
    ...(dryRun ? { dryRun: true } : {}),
    ...(remote !== undefined
      ? {
          stage: remote.stage,
          runner: remote.runner,
          // 远端只有 agent 提示词有文件可写：指向 skill 的提案在这里就拒掉（见 canStage），
          // 而不是等评测跑完再在 stage 阶段抛错
          allowedTargets: (t: string) => remote.canStage(t),
          // 采纳后推远端：不推的话服务还跑旧提示词，而下一轮预检立刻报漂移
          onAcceptedAssets: async (a: Parameters<RemoteStage['push']>[0]) => {
            await remote.push(a);
          },
        }
      : {}),
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
    if (maxTokens !== undefined) {
      // token 闸与美元闸并行印：读不出成本时它是唯一有意义的那个数
      say(`累计 token ${result.tokens} / ${maxTokens}`);
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

/**
 * 只看 flags 的用法校验 —— 不读磁盘、不发请求，所以能排在凭据检查之前。
 *
 * 与 `runRounds` 里那两条重复是**刻意的**：那边是库 API 的入口（绕过 CLI 也得拦），
 * 这边是 CLI 的顺序保证（用法错要先于环境错被说出来）。文案保持一致，免得同一个
 * 错误在两个入口有两套说法。
 */
function assertRsiUsage(ctx: CliContext): void {
  const rounds = numFlag(ctx.flags, 'rounds');
  if (rounds === undefined) return;
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new HarnessError('config.invalid', `--rounds 必须是正整数（收到 ${rounds}）`);
  }
  if (rounds > 1 && boolFlag(ctx.flags, 'dry-run')) {
    throw new HarnessError(
      'config.invalid',
      'dryRun 与多轮不能同时用：dry-run 不落盘，资产没变，后面几轮只会重复第一轮',
    );
  }
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
    report.billed !== undefined
      ? // 有账单就以账单为主：它才是真的扣掉的钱，估算只是同一次花的另一种算法。
        // 「下界」两个字不能省 —— 余额只有两位小数，小额花费读出来是 0
        `\n本轮成本 ${usd(report.costUsd)}（账单下界 ${report.billed.amount.toFixed(2)} ${report.billed.currency}` +
          `${report.billed.perUsd === undefined ? '' : `，按 1 USD = ${report.billed.perUsd} 折算`}）`
      : report.costKnown
        ? `\n本轮成本 ${usd(report.costUsd)}`
        : `\n本轮成本未知（模型不在价格表内、端点也没报计量），token 只能当代理`,
  );
  if (report.budget !== undefined) {
    const b = report.budget;
    // spentUsd 是**跨轮累计**（`--rounds` 下上限只在整次运行上生效），措辞必须跟着变，
    // 否则第 3 轮会显示「预算 12.4 / 5 —— 本轮提前收工」，读起来像闸每轮都失灵
    const usdPart =
      b.limitUsd !== undefined ? `累计已花 ${usd(b.spentUsd)} / 上限 ${usd(b.limitUsd)}` : '';
    const tokenPart =
      b.limitTokens !== undefined ? `${b.spentTokens ?? 0} / ${b.limitTokens} token` : '';
    say(`预算：${[usdPart, tokenPart].filter((x) => x !== '').join('，')}${stopNote(b)}`);
  }
  say(`\n提出 ${report.proposals.length} 个提案，验证 ${report.verified.length} 个：`);
  if (report.alternate !== undefined) {
    // 不说这一句，人只看到「提了 2 个」—— 会以为模型自己给了两个方案，
    // 于是下次调模型参数试图「让它多提几个」，而真正的机制是换目标重试
    say(
      `  首选目标被否，换目标再试一次：${report.alternate.avoided.join(', ')} → ${report.alternate.target}`,
    );
  }
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

/**
 * 预算闸的收工说明。
 *
 * `blind` 与「钱花完了」必须分开说：前者的下一步是去配 pricing 或加 `--max-tokens`，
 * 后者是加预算。混成一句「预算用完」，人会以为加钱就能继续 —— 而加多少都不管用。
 */
function stopNote(b: NonNullable<CycleReport['budget']>): string {
  if (!b.stopped) return '';
  switch (b.stoppedBy) {
    case 'tokens':
      return ' —— token 闸已到，不再开下一轮';
    case 'blind':
      return ' —— 美元闸读不出成本（模型未定价且没给 --max-tokens），停下以免继续花看不见的钱';
    case 'usd':
    case undefined:
      return ' —— 已用完，不再开下一轮';
  }
}
