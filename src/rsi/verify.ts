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
