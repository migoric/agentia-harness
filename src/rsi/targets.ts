import type { AssetSet } from '../assets/types.js';
import { findAsset } from '../assets/types.js';
import type { FailureMode } from './types.js';

/**
 * 「这个失败模式可以改谁」—— **有序**候选表，提案器与轮次编排共用同一份。
 *
 * 此前这段逻辑埋在 `LlmProposer.pickTarget` 里，只返回**第一个**目标。后果在真机上
 * 实测到了（2026-11-28）：一条本该改 agent 输出格式的失败，因为用例调过一个技能，
 * 归因就指向了那个技能；提案改了技能、回归门否决，然后**整轮结束** —— 主 agent 的
 * 提示词从头到尾没被考虑过，而它才是病根。
 *
 * 所以候选必须是一张**表**而不是一个值：主选择失败后还能换下一个。
 *
 * 顺序（先试影响面小的）：
 * 1. 归因给出的 `targets` —— 失败用例实际走过的技能与子 agent，按覆盖用例数降序；
 * 2. **主 agent** —— 回答这些用例的那个 agent（`FailureSample.routedTo` 的多数派），
 *    没有观测时退回配置里指定的 / 第一个 agent。
 *
 * 主 agent 刻意排最后，且**不参与**「覆盖用例数」排序：它几乎覆盖全部失败用例
 * （它就是答的那个人），按数量排它永远第一 —— 那会让每一条提案都去改最宽的那份
 * 提示词，「窄优先」这条设计就名存实亡了。
 */
export interface TargetCandidate {
  /** `skill:name` / `agent:name` */
  readonly key: string;
  /** 此刻磁盘上的正文（提案的 `before`，也是乐观锁的比对值） */
  readonly body: string;
  /** 为什么选它 —— 进 rationale，人从账本里能读出依据 */
  readonly why: string;
  /** 是不是主 agent（用来说清「这个是兜底，影响面最大」） */
  readonly root: boolean;
}

export interface CandidateArgs {
  readonly mode: FailureMode;
  readonly assets: AssetSet;
  /** `--agent` 指定的 agent（没指定时用 routedTo 多数派，再用第一个） */
  readonly agent?: string | undefined;
}

/** 有序候选表；资产不足时返回空数组（调用方负责报错，文案一致） */
export function targetCandidates(args: CandidateArgs): TargetCandidate[] {
  const { mode, assets } = args;
  const out: TargetCandidate[] = [];
  const seen = new Set<string>();

  for (const hint of mode.targets) {
    const asset = findAsset(assets, hint.target);
    if (asset === undefined) continue;
    if (seen.has(hint.target)) continue;
    seen.add(hint.target);
    out.push({
      key: hint.target,
      body: asset.body,
      why: `${hint.cases.length} 条失败用例走过它：${hint.cases.join(', ')}`,
      root: false,
    });
  }

  const root = rootAgent(assets, args.agent, mode);
  if (root !== undefined && !seen.has(root.key)) {
    out.push({
      key: root.key,
      body: root.body,
      why:
        out.length === 0
          ? '没有任何资产被调用过，只能改主 system'
          : `${root.reason}；影响面比技能大，所以排在候选表最后`,
      root: true,
    });
  }
  return out;
}

/**
 * 主 agent 是谁。
 *
 * 三级回落，各自的理由不同：
 * - `--agent`：人明确指定了，它优先于一切统计；
 * - `routedTo` 多数派：**实际回答了这些用例**的那个 agent。多 agent 工程里这才是
 *   「主 system」的真实含义，用 `assets.agents[0]` 会改到另一个 agent 的提示词上；
 * - 第一个 agent：没有任何运行观测（例如样本是手写的）时的最后手段。
 */
function rootAgent(
  assets: AssetSet,
  pinned: string | undefined,
  mode: FailureMode,
): { key: string; body: string; reason: string } | undefined {
  const pick = (name: string | undefined, reason: string) => {
    if (name === undefined) return undefined;
    const asset = assets.agents.find((a) => a.name === name);
    if (asset === undefined) return undefined;
    return { key: `agent:${asset.name}`, body: asset.body, reason };
  };

  const pinnedHit = pick(pinned, '由 --agent 指定');
  if (pinnedHit !== undefined) return pinnedHit;

  const voted = vote(mode.samples.map((s) => s.routedTo));
  const votedHit = pick(voted, '这些用例实际由它作答');
  if (votedHit !== undefined) return votedHit;

  const first = assets.agents[0];
  if (first === undefined) return undefined;
  return {
    key: `agent:${first.name}`,
    body: first.body,
    reason: '没有运行观测可判，取工程里的第一个 agent',
  };
}

/** 取出现次数最多的非空值；平票时取先出现的那个（样本顺序 = 用例顺序，稳定） */
function vote(values: readonly (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (v === undefined || v === '') continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: { name: string; n: number } | undefined;
  for (const [name, n] of counts) {
    if (best === undefined || n > best.n) best = { name, n };
  }
  return best?.name;
}
