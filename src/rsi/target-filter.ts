/**
 * 提案的目标过滤 —— 「这个目标能不能被真正验证」。
 *
 * 单独一个文件，因为它是一个**纯判定**，与它所在的编排阶段（先筛再验）无关：
 * 放在 `loop.ts` 里时，那段代码被「简化轮」「远程映射」「预算」三套注释夹在中间，
 * 读的人要自己分辨哪几句是它的规则。
 */

import type { Proposal } from './types.js';

export interface TargetFilterResult {
  readonly stageable: readonly Proposal[];
  /** 被拒的提案与理由 —— 理由要**进记录**，否则事后只看到「少了一个提案」 */
  readonly rejected: readonly { proposal: Proposal; reason: string }[];
}

/**
 * 过滤掉「远端没有对应文件」的目标。
 *
 * 为什么要在花钱之前拒：`remote.prompts` 只为 agent 提示词指定了文件，指向 skill 的
 * 提案在 stage 阶段一定会抛错。等那一轮评测跑完再报错，代价是整轮验证的钱 ——
 * 而理由（「远端不读这份文件」）在提案那一刻就已经知道了。
 */
export function filterTargets(
  proposals: readonly Proposal[],
  allowed: ((target: string) => boolean) | undefined,
): TargetFilterResult {
  if (allowed === undefined) return { stageable: proposals, rejected: [] };
  const stageable: Proposal[] = [];
  const rejected: { proposal: Proposal; reason: string }[] = [];
  for (const proposal of proposals) {
    if (allowed(proposal.patch.target)) {
      stageable.push(proposal);
    } else {
      rejected.push({
        proposal,
        reason:
          `目标 ${proposal.patch.target} 在远端没有对应文件（remote.prompts 只映射了 agent 提示词），` +
          '本地验证它会验一份远端根本不会读的提示词，因此不验证',
      });
    }
  }
  return { stageable, rejected };
}
