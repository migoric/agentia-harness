import { HarnessError } from '../../errors.js';
import { assertBudgetEnforceable } from '../../rsi/budget-guard.js';
import { holdRsiLock } from '../../rsi/lock-guard.js';
import { LlmProposer } from '../../rsi/propose.js';
import { runRounds } from '../../rsi/rounds.js';
import { addSpend, DEFAULT_WINDOW_MS, readSpendWindow } from '../../rsi/spend-ledger.js';
import type { CycleReport } from '../../rsi/types.js';
import { type RoundTick, runWatch, type WatchStopReason } from '../../rsi/watch.js';
import { usd } from '../../util/usd.js';
import { boolFlag, numFlag, strFlag } from '../args.js';
import { assetsOf, type CliContext } from '../context.js';
import { say, warn } from '../output.js';
import type { RemoteStage } from '../remote-stage.js';
import { announceRecovery } from './rsi-recover.js';
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
export async function watchCommand(
  ctx: CliContext,
  makeRemote: () => Promise<RemoteStage | undefined>,
): Promise<number> {
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
  const isRemote = strFlag(ctx.flags, 'remote') !== undefined;

  /**
   * 常驻形态下「整次运行」跨**进程**：从窗口账里接着算。
   *
   * 只跨轮不够：`priorCost` 活在内存里，被 OOM kill 重启后从 0 开始，于是一个
   * 写死 `--max-cost 2` 的 worker 一夜重启五次就能花掉 10 美元，而每一轮的单轮
   * 花费都在上限内。窗口默认 24h 滚动（见 `spend-ledger.ts`）。
   */
  const carried = readSpendWindow(ctx.config, { windowMs: DEFAULT_WINDOW_MS });
  if (carried.note !== undefined) warn(carried.note);
  let priorCost = carried.window.usd;
  let priorTokens = carried.window.tokens;
  if (priorCost > 0) {
    say(
      `本预算窗口（自 ${new Date(carried.window.startedAt).toISOString()} 起 ` +
        `${DEFAULT_WINDOW_MS / 3_600_000}h）已花 ${usd(priorCost)} —— 重启不清零`,
    );
  }

  const guardNote = assertBudgetEnforceable({
    config: ctx.config,
    assets: assetsOf(ctx),
    ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
    ...(maxCost !== undefined ? { maxCostUsd: maxCost } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(isRemote ? { remote: true } : {}),
  });
  if (guardNote !== undefined) warn(guardNote);

  // **先拿锁，再装配远端**：`maybeRemoteStage` 会回收上次崩溃留下的候选、必要时
  // 对齐远端 —— 那两步都在写文件。放在锁外，等于把最危险的动作留给两个进程竞争。
  const lock = holdRsiLock(ctx.config, 'rsi --watch', {
    onReclaim: (why) => warn(`回收了一个陈旧的锁：${why}`),
  });

  try {
    // 上一进程崩在采纳中间态时，先补账再装配远端 —— 顺序反了会带着一份
    // 与磁盘不一致的账本去跑基线，而基线结果看起来完全正常
    announceRecovery(ctx.config);
    const remote = await makeRemote();

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
      lock,
      ...(every !== undefined ? { everySec: every } : {}),
      ...(maxRounds !== undefined ? { maxRounds } : {}),
      ...(until !== undefined ? { until } : {}),
      // 失败要说原因：只看到「退避重试」而不知道为什么，人会立刻去翻日志
      onRoundError: (err, round) => {
        warn(`第 ${round} 轮失败：${err instanceof Error ? err.message : String(err)}`);
      },
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
        // 落盘：下一轮哪怕换了进程（被 kill 后由 supervisor 重启）也接得上。
        // 写失败不该让一个已经跑完的轮次变成失败 —— 它只影响「重启后是否还记得」
        try {
          addSpend(
            ctx.config,
            { usd: first.costUsd, tokens: first.tokens ?? 0 },
            { windowMs: DEFAULT_WINDOW_MS },
          );
        } catch (e) {
          warn(`预算窗口没能落盘（重启后会从头计）：${e instanceof Error ? e.message : String(e)}`);
        }
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
        (report.failures > 0 ? `，${report.failures} 轮失败` : '') +
        (report.costKnown
          ? `，累计 ${usd(report.costUsd)}`
          : `，累计未知（已知下限 ${usd(report.costUsd)}）`),
    );
    // 信号收尾算正常退出：cron 不该把「按我的要求停的」记成失败。
    // 但「连续失败到上限」必须非零：那说明这段时间**一轮都没跑成**，
    // 而 cron 只看得懂退出码 —— 返回 0 等于让一个死掉的 worker 看起来健康。
    return report.stopReason === 'error' ? 1 : 0;
  } finally {
    lock.release();
  }
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
    case 'error':
      return '连续失败到上限';
  }
}
