import type { ModelClient } from '@migor/agentia';
import type { AssetSet } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import type { Proposer } from './propose.js';
import type { AudienceOf } from './propose-prompt.js';
import { targetCandidates } from './targets.js';
import type { FailureMode, LessonEntry, Proposal } from './types.js';

/**
 * 备用目标 —— 首选全被否之后，换**另一个资产**再提一次案。
 *
 * 真机上最常见的死法（2026-11-28）：归因指向一个技能 → 改技能 → 回归门否决 →
 * 整轮结束，而病根在 agent 的提示词上，它从头到尾没被考虑过。没有这一步，
 * `--rounds` 也救不回来：它只会在同一批失败上重复同一个目标（账本只进提示词，
 * 不改变目标选择），第一轮没采纳就直接收工。
 *
 * 三条边界：
 * - **简化轮不做**（由调用方判）：那一轮只接受净简化，换目标等于换个地方变胖；
 * - **每轮最多一次**：这是「被否之后的第二次机会」，不是「一直试到成功」——
 *   后者会把一轮的成本摊成无底洞，单变量原则也不再成立；
 * - **不占 `--max-verify` 配额**：那个上限管的是「一次提案能验几条」，与重试不是
 *   同一个概念，混在一起会让 `--max-verify 1` 把重试一起关掉。
 *
 * 为什么单独成模块：`loop.ts` 是编排，它该读起来像一条流水线；「换谁、还能不能换」
 * 是一份可以单独测的决策，放在编排里既撑破了文件行数上限，也只能靠端到端才验得到。
 */
export interface AlternateOptions {
  /** 本轮的失败模式（按失败数降序，取第一个还有未试目标的） */
  readonly modes: readonly FailureMode[];
  readonly assets: AssetSet;
  readonly config: HarnessConfig;
  readonly proposer: Proposer;
  /** 本轮已经试过的目标（提案里的 `patch.target`） */
  readonly avoided: readonly string[];
  readonly history: readonly LessonEntry[];
  /** 见 `ProposeContext.audience`（回归门的前置告知，备用目标同样需要） */
  readonly audience?: AudienceOf | undefined;
  readonly agent?: string | undefined;
  readonly client?: ModelClient | undefined;
  readonly signal?: AbortSignal | undefined;
  /** 远端只能改有文件映射的目标：不可写的候选不算「还能换」 */
  readonly allowedTargets?: ((target: string) => boolean) | undefined;
}

export interface AlternateResult {
  readonly modeId: string;
  readonly avoided: readonly string[];
  /**
   * 换上的那条提案。
   *
   * **可能缺席**，而花费照样要记：自定义 `Proposer` 可能无视 `avoidTargets` 交出
   * 同一个目标（或干脆返回空）。那条不能拿去验证（会重复花一遍评测钱），但这一次
   * 模型调用是真的发生了 —— 缺了 cost 就是又一次「闸静默偏低」。
   */
  readonly proposal?: Proposal | undefined;
  readonly cost: { readonly usd: number | undefined; readonly known: boolean };
}

/** 没有可换的目标时返回 `undefined`（连模型都不调，不花钱） */
export async function proposeAlternate(
  opts: AlternateOptions,
): Promise<AlternateResult | undefined> {
  const mode = opts.modes.find((m) => untriedTarget(m, opts) !== undefined);
  if (mode === undefined) return undefined;

  const avoided = [...new Set(opts.avoided)];
  const again = await opts.proposer.propose({
    modes: [mode],
    assets: opts.assets,
    config: opts.config,
    ...(opts.client !== undefined ? { client: opts.client } : {}),
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    history: opts.history,
    ...(opts.audience !== undefined ? { audience: opts.audience } : {}),
    avoidTargets: avoided,
  });
  return {
    modeId: mode.id,
    avoided,
    // 兜底：提案器没遵守排除列表时不验证那一条（同一个目标再验一遍只是重复花钱）
    proposal: again.proposals.find((p) => !avoided.includes(p.patch.target)),
    cost: again.cost,
  };
}

/**
 * 这个模式还有没有**没试过**的目标。
 *
 * 与提案器「下一个选谁」必须用同一张候选表（`targets.ts`），否则会出现
 * 「以为还有备选、叫过去却报无目标」的空转。
 */
function untriedTarget(mode: FailureMode, opts: AlternateOptions): string | undefined {
  const tried = new Set(opts.avoided);
  return targetCandidates({
    mode,
    assets: opts.assets,
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
  }).find((c) => !tried.has(c.key) && (opts.allowedTargets?.(c.key) ?? true))?.key;
}
