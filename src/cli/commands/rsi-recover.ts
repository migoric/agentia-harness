import type { WorkspacePaths } from '../../config.js';
import { recoverAccept } from '../../rsi/commit.js';
import { warn } from '../output.js';

/**
 * 每个写入口开跑前的自愈：把「上次崩溃留下的采纳中间态」补到与磁盘一致。
 *
 * 放在 CLI 层而不是 `rsi/` 里，是因为它要**出声**（`warn`）：自动补一条 journal
 * 条目是改账本的动作，人必须知道它发生过，否则下次看到一条自己没印象的采纳记录
 * 只会怀疑工具在乱写。
 *
 * 不放在 `runCycle` 里：那条路径也被 `watch` 每轮调用，而恢复只需要在**进程启动**
 * 时做一次（上一进程崩了才会有残留）。每轮都扫一遍盘是白花 IO。
 */
export function announceRecovery(p: WorkspacePaths): void {
  const note = recoverAccept(p);
  if (note !== undefined) warn(note);
}
