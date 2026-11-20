import { HarnessError } from '../../errors.js';
import { readJournal, revertLast } from '../../rsi/accept.js';
import { runCycle } from '../../rsi/loop.js';
import { LlmProposer } from '../../rsi/propose.js';
import { boolFlag, numFlag } from '../args.js';
import { assetsOf, type CliContext } from '../context.js';
import { json, say, warn } from '../output.js';
import { tuningOf } from './run.js';

/** `harness rsi [revert|status]` —— 闭环的三个入口 */
export async function rsiCommand(ctx: CliContext, sub: string | undefined): Promise<number> {
  if (sub === 'revert') return revert(ctx);
  if (sub === 'status') return status(ctx);
  if (sub !== undefined) {
    throw new HarnessError('config.invalid', `rsi 没有子命令 "${sub}"（可用: revert, status）`);
  }
  return cycle(ctx);
}

async function cycle(ctx: CliContext): Promise<number> {
  const maxModes = numFlag(ctx.flags, 'max-modes');
  const maxVerify = numFlag(ctx.flags, 'max-verify');
  const dryRun = boolFlag(ctx.flags, 'dry-run');
  // `--max-cost` 覆盖配置：CI 里想临时收紧预算不必改文件
  const maxCost = numFlag(ctx.flags, 'max-cost') ?? ctx.config.maxCostUsd;

  const report = await runCycle({
    config: ctx.config,
    assets: assetsOf(ctx),
    ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
    proposer: new LlmProposer(ctx.config, {
      ...(maxModes !== undefined ? { maxModes } : {}),
      // 提不出方案的模式要**说出来**：静默跳过会让「这轮为什么没改」无从解释
      onSkip: (modeId, reason) => warn(`  跳过 ${modeId}: ${reason}`),
    }),
    ...(maxVerify !== undefined ? { maxVerify } : {}),
    ...(maxCost !== undefined ? { maxCostUsd: maxCost } : {}),
    ...(dryRun ? { dryRun: true } : {}),
    ...tuningOf(ctx),
  });

  if (boolFlag(ctx.flags, 'json')) {
    json(report);
    return report.accepted.length > 0 ? 0 : 1;
  }

  say(`轮次 ${report.cycleId}（记录 ${report.path}）`);
  if (report.modes.length === 0) {
    say('没有失败样本，无需改进');
    return 0;
  }
  say(`失败模式 ${report.modes.length} 个：`);
  for (const m of report.modes) {
    const target = m.targets[0]?.target ?? '（无资产命中）';
    say(`  [${m.kind}] ${m.signature}  ×${m.count} → 偏向改 ${target}`);
  }
  say(
    report.costKnown
      ? `\n本轮成本 $${report.costUsd.toFixed(4)}`
      : `\n本轮成本未知（模型不在价格表内），token 只能当代理`,
  );
  if (report.budget !== undefined) {
    const b = report.budget;
    say(
      `预算 $${b.spentUsd.toFixed(4)} / $${b.limitUsd.toFixed(4)}` +
        (b.stopped ? ' —— 已超限，本轮提前收工' : ''),
    );
  }
  say(`\n提出 ${report.proposals.length} 个提案，验证 ${report.verified.length} 个：`);
  for (const v of report.verified) {
    say(
      `  ${v.gate.ok ? 'PASS ' : 'BLOCK'}  ${v.proposal.id} → ${v.proposal.patch.target}：${v.gate.reason}`,
    );
  }
  if (report.accepted.length > 0) {
    const suffix = report.dryRun ? '（dry-run，未落盘）' : '';
    say(
      `\n采纳 ${report.accepted.length} 个${suffix}：${report.accepted.map((p) => p.id).join(', ')}`,
    );
  }
  for (const r of report.rejected) say(`  拒绝 ${r.proposal.id}：${r.reason}`);
  return report.accepted.length > 0 ? 0 : 1;
}

function revert(ctx: CliContext): number {
  const r = revertLast(ctx.config);
  say(`已回滚 ${r.entry.proposalId}：${r.entry.target}`);
  return 0;
}

function status(ctx: CliContext): number {
  const entries = readJournal(ctx.config);
  if (entries.length === 0) {
    say('还没有任何采纳记录');
    return 0;
  }
  for (const e of entries) {
    const when = new Date(e.at).toISOString().replace('T', ' ').slice(0, 19);
    say(`${when}  ${e.status.padEnd(8)}  ${e.proposalId}  ${e.target}`);
    say(`            ${e.reason}`);
  }
  return 0;
}
