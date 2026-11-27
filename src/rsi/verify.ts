import { readFileSync } from 'node:fs';
import type { ModelClient } from '@migor/agentia';
import { setFingerprint } from '../assets/discover.js';
import { type AssetSet, assetKey, findAsset } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import { type GateOptions, gate } from '../evals/gate.js';
import { runSuite, type SuiteTuning } from '../evals/run.js';
import type { EvalReport } from '../evals/types.js';
import { parseFrontmatter } from '../util/frontmatter.js';
import { fingerprint } from '../util/hash.js';
import { isShrinkPatch } from './shrink.js';
import type { AssetPatch, Proposal, VerifyOutcome } from './types.js';

/**
 * 验证 —— RSI 里唯一有否决权的一步。
 *
 * 三个设计要点，每个都在防一种具体的失败：
 *
 * 1. **内存替换，不碰磁盘**。提案先在 `AssetSet` 的副本上生效（只换 body，重算指纹），
 *    跑完评测无论结果如何，源文件一个字都没动。这让「验证失败」是零成本的，
 *    从而敢于大量试错。
 * 2. **乐观锁**：`patch.before` 必须等于当前 body。不等就拒 —— 说明提案是基于旧版
 *    资产算出来的，此时合并会静默覆盖别人（或上一轮 RSI）的改动。
 * 3. **门在外部**：`gate()` 是纯函数、只吃两份报告。RSI 无法通过「改评分器」让自己
 *    通过 —— 评分器不在这条数据流上。
 */
export interface VerifyOptions extends SuiteTuning {
  readonly config: HarnessConfig;
  readonly assets: AssetSet;
  readonly baseline: EvalReport;
  readonly proposal: Proposal;
  readonly agent?: string | undefined;
  readonly client?: ModelClient | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly gateOptions?: GateOptions | undefined;
  /**
   * 只跑这些用例。RSI 传 train 用例名，`baseline` 也必须是 train 视图 ——
   * 两边口径不一致时，gate 比较的就不是一个东西（见 `evals/split.ts`）。
   */
  readonly only?: readonly string[] | undefined;
}

/** `isWorthAccepting` 的调用参数 —— 只有「这一轮的目标是什么」一个维度 */
export interface WorthAcceptingOptions {
  /**
   * 本轮是**简化轮**（净简化配额触发）。
   *
   * 存在的理由：简化轮想要的恰恰是「通过率不变、但资产更小」—— 而这在平时是
   * 明确不采纳的（"没有用例变好"）。不开口子的话，配额一旦触发就再也采纳不了任何
   * 东西：它会把闭环锁死在"必须修好一条用例"上，而这一轮的任务本来就不是修用例。
   *
   * 口子开得很窄：仍要过门（含留出集），且补丁必须**确实更小**
   * （`isShrinkPatch`）。不是"简化轮里什么都算数"。
   */
  readonly shrink?: boolean | undefined;
  /** 净减少下限（与 `shrinkState` 的 policy 同一个数，别两处各写一份） */
  readonly minReduction?: number | undefined;
}

/**
 * 门放行之后还要问的一句：**有没有用例真的变好？**
 *
 * `gate.ok` 只保证「没退步」：通过率不变、成本没涨时它也返回 true（reason 是
 * 「无变化」）。把它当采纳许可，git 历史会被一堆「改了提示词但没任何用例变好」的
 * no-op 污染 —— 下一轮再也分不清哪次改动真正起作用。
 *
 * 自动 RSI 与手写提案共用这一条：提案**来源**可以是人或模型，采纳标准不能变。
 * 唯一的例外是简化轮（见 `WorthAcceptingOptions.shrink`），而它换来的是「更小」，
 * 一个同样可机械核对、且平时拿不到的结果。
 */
export function isWorthAccepting(
  outcome: VerifyOutcome,
  opts: WorthAcceptingOptions = {},
): boolean {
  if (!outcome.gate.ok) return false;
  // 留出集用默认门：train 涨分但留出集退步，是过拟合最典型的形状，必须拒
  if (outcome.holdout !== undefined && !outcome.holdout.gate.ok) return false;
  if (outcome.gate.fixedCases.length > 0 || outcome.gate.passRateDelta > 0) return true;
  // 平时「只变小、没变好」不值得落盘（会污染 git 历史）；简化轮例外 ——
  // 那一轮的目标就是变小，而变小本身是**可机械核对**的收益
  return opts.shrink === true && isShrinkPatch(outcome.proposal.patch, opts.minReduction);
}

export async function verifyProposal(opts: VerifyOptions): Promise<VerifyOutcome> {
  const patched = applyPatch(opts.assets, opts.proposal.patch);
  const candidate = await runSuite({
    config: opts.config,
    assets: patched,
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.client !== undefined ? { client: opts.client } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    // 与基线**同一套**调优：否则门比较的不是同一个东西
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
    ...(opts.only !== undefined ? { only: opts.only } : {}),
  });
  return {
    proposal: opts.proposal,
    baseline: opts.baseline,
    candidate,
    gate: gate(opts.baseline, candidate, opts.gateOptions ?? {}),
  };
}

/**
 * 把补丁应用到资产集副本上。
 *
 * 指纹必须按**未来落盘后的真实文件内容**算（head 原样保留 + 新正文），否则
 * 「验证时看到的指纹」与「accept 之后 lock 里的指纹」会不一致，
 * `harness lock --check` 会在采纳后立刻报脏 —— 一个自己制造的假阳性。
 */
export function applyPatch(assets: AssetSet, patch: AssetPatch): AssetSet {
  const asset = findAsset(assets, patch.target);
  if (asset === undefined) {
    throw new HarnessError('asset.missing', `补丁指向不存在的资产 "${patch.target}"`);
  }
  if (asset.body !== patch.before) {
    throw new HarnessError(
      'asset.invalid',
      `补丁的基础版本已过期：${patch.target} 的正文与 patch.before 不一致（有人改过它）`,
    );
  }
  if (patch.after.trim() === '') {
    throw new HarnessError('asset.invalid', `补丁把 ${patch.target} 改成了空正文`);
  }

  const nextFingerprint = fingerprint(renderFile(asset.path, patch.after));
  const replace = <T extends { name: string; kind: string }>(list: readonly T[]): T[] =>
    list.map((a) =>
      assetKey({ kind: a.kind as 'skill' | 'agent', name: a.name }) === patch.target
        ? ({ ...a, body: patch.after, fingerprint: nextFingerprint } as T)
        : a,
    );

  const skills = replace(assets.skills);
  const agents = replace(assets.agents);
  return {
    skills,
    agents,
    fingerprint: setFingerprint(
      skills as readonly { name: string; fingerprint: string }[],
      agents as readonly { name: string; fingerprint: string }[],
    ),
  };
}

/**
 * 生成「落盘后的文件内容」：frontmatter 头与正文之间的**空行、结尾换行风格**逐字保留，
 * 只替换正文段。
 *
 * 这里踩过一次坑：早先的实现是 `head + '\n' + body + '\n'`，当原文件在 `---` 之后
 * 有空行时，渲染结果会比磁盘少一个字节 —— 于是 `acceptProposal` 的「验证后是否被改动」
 * 校验把**自己**渲染的差异当成了「有人手改」，采纳被误拒。修法不是放宽容差
 * （那会真的漏掉手改），而是让渲染对原排版透明。
 */
export function renderFile(path: string, body: string): string {
  const text = readFileSync(path, 'utf8');
  const fm = parseFrontmatter(text, path);
  const lines = text.split(/\r?\n/);
  const head = lines.slice(0, fm.headerLines);
  const tail = lines.slice(fm.headerLines);

  // frontmatter 之后的前导空行原样保留
  const firstContent = tail.findIndex((l) => l.trim() !== '');
  const leading = firstContent === -1 ? [] : tail.slice(0, firstContent);
  // 结尾是否带换行（split 会留下空串）—— 保留原风格，不擅自补
  const hadTrailingNewline = tail.length > 0 && tail[tail.length - 1] === '';

  return [...head, ...leading, body.trim(), ...(hadTrailingNewline ? [''] : [])].join('\n');
}
