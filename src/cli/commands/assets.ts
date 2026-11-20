import {
  buildLock,
  describeDrift,
  diffLock,
  driftIsEmpty,
  readLock,
  writeLock,
} from '../../assets/lockfile.js';
import { boolFlag } from '../args.js';
import { assetsOf, type CliContext } from '../context.js';
import { say } from '../output.js';

/**
 * `harness lock` / `harness lock --check`。
 *
 * `--check` 是 CI 门：资产改了但锁没重写就失败。它的价值不在「防止忘记提交锁」，
 * 而在**防止提示词被偷偷改**：一次不经评测的提示词改动，比十次失败的评测危险得多。
 */
export function lockCommand(ctx: CliContext): number {
  const assets = assetsOf(ctx);
  if (boolFlag(ctx.flags, 'check')) {
    const drift = diffLock(readLock(ctx.config.lockPath), assets);
    say(describeDrift(drift));
    return driftIsEmpty(drift) ? 0 : 1;
  }
  const lock = buildLock(assets);
  writeLock(ctx.config.lockPath, lock);
  say(`已写入 ${ctx.config.lockPath}（${Object.keys(lock.assets).length} 个资产）`);
  return 0;
}
