import { HarnessError } from '../../errors.js';
import { assertBudgetEnforceable } from '../../rsi/budget-guard.js';
import { LlmProposer } from '../../rsi/propose.js';
import { runRounds } from '../../rsi/rounds.js';
import type { CycleReport } from '../../rsi/types.js';
import { type RoundTick, runWatch, type WatchStopReason } from '../../rsi/watch.js';
import { usd } from '../../util/usd.js';
import { boolFlag, numFlag, strFlag } from '../args.js';
import { assetsOf, type CliContext } from '../context.js';
import { say, warn } from '../output.js';
import type { RemoteStage } from '../remote-stage.js';
import { tuningOf } from './run.js';

/**
 * `harness rsi --watch` —— 常驻推进 RSI 轮次。
 *
 * 这个文件只做**接线**：把 CLI 的 flag 翻译成 `runWatch` 的选项，把「一轮」实现成
 * `runRounds({ rounds: 1 })`。调度语义（锁、心跳、节流、停止条件）全在
 * `rsi/watch.ts` 里，并且**不依赖模型** —— 那种东西必须能被单测钉住。
 *
 * 三条提醒是给运维的（都在输出里说出来，而不是只写在文档里）：
 *
 * 1. **它不 fork 自己**。一个进程一轮一改，靠锁保证单实例；不要再套一层 supervisor
 *    去「保活」，否则两个 supervisor 会互相抢锁 —— 那种故障看起来像 worker 反复重启。
 * 2. **它不做回滚**。回归检测与回滚是 `rsi regress --revert` 的事，且要过指纹校验。
 * 3. **停止条件比「一直跑」重要**。预算、到点、无进展、信号，四条都在开下一轮之前判。
 */
export async function watchCommand(ctx: CliContext, remote?: RemoteStage): Promise<number> {
  if (boolFlag(ctx.flags, 'dry-run')) {
    throw new HarnessError(
      'config.invalid',
      '--watch 与 --dry-run 不能同时用：dry-run 不落盘，常驻跑它只会把同一轮重复到预算耗尽',
    );
  }
  const every = numFlag(ctx.flags, 'every');
  const maxRounds = numFlag(ctx.flags, 'max-rounds');
  const until = untilMs(strFlag(ctx.flags, 'until'));
  const maxCost = numFlag(ctx.flags, 'max-cost') ?? ctx.config.maxCostUsd;
  const maxTokens = numFlag(ctx.flags, 'max-tokens');
  const maxVerify = numFlag(ctx.flags, 'max-verify');
  const maxModes = numFlag(ctx.flags, 'max-modes');

  // 常驻形态下「整次运行」= 这个进程活着的全部时间。少了这两行累加，
  // `--watch --max-cost 5` 会**每轮**各花 5 美元（每轮都是新的 Budget，prior=0），
  // 而参数语义明明写着跨轮共享 —— 一晚上能把一个月预算烧掉，且没有任何报错。
  let priorCost = 0;
  let priorTokens = 0;

  const guardNote = assertBudgetEnforceable({
    config: ctx.config,
    assets: assetsOf(ctx),
    ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
    ...(maxCost !== undefined ? { maxCostUsd: maxCost } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(remote !== undefined ? { remote: true } : {}),
  });
  if (guardNote !== undefined) warn(guardNote);

  const controller = new AbortController();
  const stop = (sig: string): void => {
    // 不立刻退出：当前这一轮要跑完（资产写入是原子的，但半轮中断会让这一轮的
    // 成本白花）。信号只表示「别开下一轮」。
    warn(`收到 ${sig}：跑完当前这一轮就停（再按一次不会更快，锁与心跳还需要正常收尾）`);
    controller.abort();
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  say(
    `worker 启动：每轮一改，间隔 ${every ?? 900}s` +
      `${maxRounds !== undefined ? `，最多 ${maxRounds} 轮` : ''}` +
      `${maxCost !== undefined ? `，预算 ${usd(maxCost)}` : ''}` +
      '\n  触发建议：cron / systemd timer 敲一条 `harness rsi --watch`，不要重复起进程（锁会拒绝第二个）',
  );

  const report = await runWatch({
    config: ctx.config,
    signal: controller.signal,
    ...(every !== undefined ? { everySec: every } : {}),
    ...(maxRounds !== undefined ? { maxRounds } : {}),
    ...(until !== undefined ? { until } : {}),
    onReclaim: (why) => warn(`回收了一个陈旧的 worker 锁：${why}`),
    runRound: async (signal, round) => {
      say(`\n=== 第 ${round} 轮 ===`);
      const result = await runRounds({
        ...(remote !== undefined
          ? {
              stage: remote.stage,
              runner: remote.runner,
              allowedTargets: (t: string) => remote.canStage(t),
              onAcceptedAssets: async (a: Parameters<RemoteStage['push']>[0]) => {
                await remote.push(a);
              },
            }
          : {}),
        config: ctx.config,
        // 每轮重扫资产：上一轮采纳之后磁盘变了，用旧快照会让这一轮基线仍在旧 prompt 上
        assets: assetsOf(ctx),
        rounds: 1,
        // 每轮新建提案器：它带累计花费状态，复用会把两轮的账并成一条
        makeProposer: () =>
          new LlmProposer(ctx.config, {
            ...(maxModes !== undefined ? { maxModes } : {}),
            onSkip: (modeId, reason) => warn(`  跳过 ${modeId}: ${reason}`),
          }),
        signal,
        onRound: (r: CycleReport) => render(r, round),
        ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
        ...(maxVerify !== undefined ? { maxVerify } : {}),
        ...(maxCost !== undefined ? { maxCostUsd: maxCost } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(priorCost > 0 ? { priorSpentUsd: priorCost } : {}),
        ...(priorTokens > 0 ? { priorTokens } : {}),
        ...tuningOf(ctx),
      });
      const first = result.rounds[0];
      if (first === undefined) {
        throw new HarnessError('rsi.no_signal', '这一轮跑完了却没有产出记录（不该发生）');
      }
      // 先累加再返回 tick：下一轮的 prior 必须包含这一轮（含被闸拦下的那部分）
      priorCost += first.costUsd;
      priorTokens += first.tokens ?? 0;
      const tick: RoundTick = {
        accepted: first.accepted.length,
        costUsd: first.costUsd,
        costKnown: first.costKnown,
        ...(mapStop(result.stopReason) !== undefined ? { stop: mapStop(result.stopReason) } : {}),
      };
      return tick;
    },
  });

  say(
    `\nworker 停止：${label(report.stopReason)}；共 ${report.rounds} 轮，采纳 ${report.accepted} 轮` +
      (report.costKnown
        ? `，累计 ${usd(report.costUsd)}`
        : `，累计未知（已知下限 ${usd(report.costUsd)}）`),
  );
  // 信号收尾算正常退出：cron 不该把「按我的要求停的」记成失败
  return 0;
}

function render(r: CycleReport, round: number): void {
  const cost = r.costKnown ? usd(r.costUsd) : `未知（下限 ${usd(r.costUsd)}）`;
  say(
    `第 ${round} 轮：失败模式 ${r.modes.length} 个，验证 ${r.verified.length} 个，` +
      `采纳 ${r.accepted.length} 条，成本 ${cost}`,
  );
  for (const a of r.accepted) say(`  采纳 ${a.id} → ${a.patch.target}`);
}

/** `runRounds` 的停止理由 → worker 的停止理由。`rounds`/`no_progress` 由调用方自行判定 */
function mapStop(
  reason: 'rounds' | 'budget' | 'no_progress' | 'no_failures' | 'shrink_stalled',
): RoundTick['stop'] {
  switch (reason) {
    case 'budget':
      return 'budget';
    case 'no_failures':
      return 'no_failures';
    case 'shrink_stalled':
      return 'shrink_stalled';
    case 'rounds':
    case 'no_progress':
      return undefined;
  }
}

function untilMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) {
    throw new HarnessError(
      'config.invalid',
      `--until 要能被 Date.parse 解析（例如 2026-11-29T08:00），收到 "${raw}"`,
    );
  }
  return t;
}

function label(reason: WatchStopReason): string {
  switch (reason) {
    case 'max_rounds':
      return '跑满上限轮数';
    case 'until':
      return '到点';
    case 'no_progress':
      return '这一轮没有可采纳的改动';
    case 'no_failures':
      return '没有失败样本';
    case 'shrink_stalled':
      return '简化轮没交出可用的删除';
    case 'budget':
      return '预算用完';
    case 'signal':
      return '收到停止信号';
  }
}
