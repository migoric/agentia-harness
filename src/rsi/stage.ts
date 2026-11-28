/**
 * 「搬上舞台 → 跑 → 撤台」的唯一实现。
 *
 * 单独一个函数是为了让「撤台一定执行」只有一处可以写错。此前这个模式在
 * `verifyProposal` 与 `validateHoldout` 里各要写一遍 `try/finally`，而漏掉 finally 的
 * 后果特别隐蔽：远程停在一个没被验证过的提示词上，而报告里一切正常。
 */

import type { AssetSet } from '../assets/types.js';
import type { Proposal, StageHook } from './types.js';

export async function withStage<T>(
  hook: StageHook | undefined,
  args: { proposal: Proposal; patched: AssetSet },
  run: () => Promise<T>,
): Promise<T> {
  if (hook === undefined) return run();
  const restore = await hook(args);
  try {
    return await run();
  } finally {
    // 撤台失败必须冒出来：它意味着远端还跑着候选，而调用方多半以为已经回滚了
    await restore();
  }
}
