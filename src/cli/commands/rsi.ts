import { resolve } from 'node:path';
import type { ModelClient } from '@migor/agentia';
import { describeError, HarnessError } from '../../errors.js';
import { runSuite } from '../../evals/run.js';
import { splitReport } from '../../evals/split.js';
import { assertBudgetEnforceable } from '../../rsi/budget-guard.js';
import { makeCycleId, writeCycle } from '../../rsi/loop.js';
import { LlmProposer } from '../../rsi/propose.js';
import { type RoundStopReason, runRounds } from '../../rsi/rounds.js';
import type { CycleReport, HoldoutResult, VerifyOutcome } from '../../rsi/types.js';
import { usd } from '../../util/usd.js';
import { boolFlag, numFlag, strFlag } from '../args.js';
import { assetsOf, type CliContext } from '../context.js';
import { json, say, warn } from '../output.js';
import { maybeRemoteStage, type RemoteStage } from '../remote-stage.js';
import { journal, ledger, regress, status } from './rsi-inspect.js';
import { acceptFrom, proposeFrom, revert } from './rsi-manual.js';
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
  if (sub === 'revert') return revert(ctx, argsId);
  if (sub === 'status') return status(ctx);
  if (sub === 'ledger') return ledger(ctx);
  if (sub === 'regress') {
    // 只读：不写候选，所以不需要 allowStaging 那道签字
    return regress(ctx, undefined, await maybeRemoteStage(ctx, { needsStaging: false }));
  }
  if (sub === 'journal') return journal(ctx);
  if (sub === 'propose') return proposeFrom(ctx);
  if (sub === 'accept') return acceptFrom(ctx, undefined, await maybeRemoteStage(ctx));
  // `--watch` 是「跑很多轮」的常驻形态，与 `--rounds` 互斥（后者是一次性跑完就退）
  if (boolFlag(ctx.flags, 'watch')) return watchCommand(ctx, await maybeRemoteStage(ctx));
  if (sub !== undefined) {
    throw new HarnessError(
      'config.invalid',
      `rsi 没有子命令 "${sub}"（可用: revert, status, ledger, regress, journal, propose, accept）`,
    );
  }
  return cycle(ctx, await maybeRemoteStage(ctx));
}

async function cycle(ctx: CliContext, remote?: RemoteStage): Promise<number> {
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
    const usdPart =
      b.limitUsd !== undefined ? `累计已花 ${usd(b.spentUsd)} / 上限 ${usd(b.limitUsd)}` : '';
    const tokenPart =
      b.limitTokens !== undefined ? `${b.spentTokens ?? 0} / ${b.limitTokens} token` : '';
    say(`预算：${[usdPart, tokenPart].filter((x) => x !== '').join('，')}${stopNote(b)}`);
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
