import { readFileSync } from 'node:fs';
import type { ModelClient } from '@migor/agentia';
import { setFingerprint } from '../assets/discover.js';
import { type AssetSet, assetKey, findAsset } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import { type GateOptions, gate } from '../evals/gate.js';
import { flakyCases } from '../evals/history.js';
import { runSuite, type SuiteTuning } from '../evals/run.js';
import type { EvalReport } from '../evals/types.js';
import type { CaseRunner } from '../run/case-runner.js';
import { parseFrontmatter } from '../util/frontmatter.js';
import { fingerprint } from '../util/hash.js';
import { allowedSettings, applySettings } from './settings.js';
import { isShrinkPatch } from './shrink.js';
import { withStage } from './stage.js';
import type { AssetPatch, Proposal, StageHook, VerifyOutcome } from './types.js';

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
  /**
   * 远程 stage 钩子：跑之前把候选搬到被测环境，跑完撤台。
   * 本地不传（资产在内存里，`assets: patched` 就够了）。
   */
  readonly stage?: StageHook | undefined;
  /** 远程 runner（`harness eval --remote` 那个）。不传就是本地装配 */
  readonly runner?: CaseRunner | undefined;
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
  // 路由不塌缩（判据 27）：通过率涨了、但路由准确率掉了同样不采纳。
  // 典型形状是「所有请求都被派给同一个 agent」—— 通过率可能微涨（那个 agent 确实
  // 也能答），而意图层与成本模型同时失效，单一 passRate 看不出来。
  const rb = outcome.baseline.routeAccuracy;
  const rc = outcome.candidate.routeAccuracy;
  if (rb !== undefined && rc !== undefined && rc < rb) return false;
  if (outcome.gate.fixedCases.length > 0 || outcome.gate.passRateDelta > 0) return true;
  // 平时「只变小、没变好」不值得落盘（会污染 git 历史）；简化轮例外 ——
  // 那一轮的目标就是变小，而变小本身是**可机械核对**的收益
  return opts.shrink === true && isShrinkPatch(outcome.proposal.patch, opts.minReduction);
}

export async function verifyProposal(opts: VerifyOptions): Promise<VerifyOutcome> {
  const patched = applyPatch(opts.assets, opts.proposal.patch);
  // 远程：候选必须先写进服务读的那个文件才可能被看见。`withStage` 保证撤台执行，
  // 包括「跑评测抛错」与「预算中止」这两条非常规路径
  const candidate = await withStage(opts.stage, { proposal: opts.proposal, patched }, () =>
    runSuite({
      config: opts.config,
      assets: patched,
      ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
      ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
      ...(opts.client !== undefined ? { client: opts.client } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      // 与基线**同一套**调优：否则门比较的不是同一个东西
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
      ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
      ...(opts.repeat !== undefined ? { repeat: opts.repeat } : {}),
      ...(opts.only !== undefined ? { only: opts.only } : {}),
    }),
  );
  return {
    proposal: opts.proposal,
    baseline: opts.baseline,
    candidate,
    gate: gate(opts.baseline, candidate, {
      ...opts.gateOptions,
      // 抖动名单由 verify 自己读，而不是从 CLI 一路透传：这条路径有四个调用方
      // （`rsi` / `rounds` / `rsi accept` / 回归检查），漏传一处的症状是「有时认抖动、
      // 有时不认」—— 而那是一种最难查的不一致（同一份提案两处结论不同）
      ...(opts.gateOptions?.flaky !== undefined ? {} : { flaky: flakyCases(opts.config) }),
    }),
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

  // 白名单守卫：settings 里的键必须都属于这个资产、值必须合法。任何非法字段 ⇒ 整份拒。
  // 外部提案（手写 JSON）也走这里，没有绕过口。
  const settings = patch.settings ?? {};
  for (const key of Object.keys(settings)) {
    if (!allowedSettings(asset).includes(key)) {
      throw new HarnessError(
        'asset.invalid',
        `补丁给 ${patch.target} 塞了非白名单字段 "${key}"（只能是 ${allowedSettings(asset).join(' / ')}）—— 整份拒`,
      );
    }
  }

  const nextFingerprint = fingerprint(renderFile(asset.path, patch.after, settings));
  const replaced = applySettings(asset, settings);
  const replace = <T extends { name: string; kind: string }>(list: readonly T[]): T[] =>
    list.map((a) =>
      assetKey({ kind: a.kind as 'skill' | 'agent', name: a.name }) === patch.target
        ? ({ ...replaced, body: patch.after, fingerprint: nextFingerprint } as unknown as T)
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
 * 默认只替换正文段。
 *
 * `settings`（已校验的白名单字段）有值时，额外覆盖/追加对应的 frontmatter 行 —— 这是
 * RSI 改「策略」而非「措辞」的落盘点。它来自 `parseProposalBody`，到这里已经过了
 * 白名单校验，renderFile 不重复校验（单一职责：渲染，不判定）。
 *
 * 这里踩过一次坑：早先的实现是 `head + '\n' + body + '\n'`，当原文件在 `---` 之后
 * 有空行时，渲染结果会比磁盘少一个字节 —— 于是 `acceptProposal` 的「验证后是否被改动」
 * 校验把**自己**渲染的差异当成了「有人手改」，采纳被误拒。修法不是放宽容差
 * （那会真的漏掉手改），而是让渲染对原排版透明。settings 覆盖也守同一条：只动值那一行，
 * 其余行（含注释、顺序）逐字保留。
 */
export function renderFile(
  path: string,
  body: string,
  settings?: Readonly<Record<string, string>> | undefined,
  removeKeys?: readonly string[] | undefined,
): string {
  const text = readFileSync(path, 'utf8');
  const fm = parseFrontmatter(text, path);
  const lines = text.split(/\r?\n/);
  let head = lines.slice(0, fm.headerLines);

  if (head.length >= 2 && ((settings && Object.keys(settings).length > 0) || removeKeys)) {
    head = applySettingsToHead(head, settings ?? {}, removeKeys ?? []);
  }
  const tail = lines.slice(fm.headerLines);

  // frontmatter 之后的前导空行原样保留
  const firstContent = tail.findIndex((l) => l.trim() !== '');
  const leading = firstContent === -1 ? [] : tail.slice(0, firstContent);
  // 结尾是否带换行（split 会留下空串）—— 保留原风格，不擅自补
  const hadTrailingNewline = tail.length > 0 && tail[tail.length - 1] === '';

  return [...head, ...leading, body.trim(), ...(hadTrailingNewline ? [''] : [])].join('\n');
}

/**
 * 覆盖 frontmatter 头里的白名单字段：已存在的行只换值（保留缩进与行尾注释的位置），
 * 不存在的字段在 `---` 收尾行之前追加。`removeKeys` 里的字段整行删掉（回滚「原来没写」
 * 的字段时用）。head[0] 与末行 `---` 不动。
 */
function applySettingsToHead(
  head: string[],
  settings: Readonly<Record<string, string>>,
  removeKeys: readonly string[],
): string[] {
  const remove = new Set(removeKeys);
  // 先删（倒序遍历，避免删行后索引错位）
  for (let i = head.length - 2; i >= 1; i--) {
    const line = head[i] ?? '';
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    if (remove.has(line.slice(0, colon).trim())) head.splice(i, 1);
  }
  const close = head.length - 1; // 末行是收尾的 '---'
  const out = [...head];
  const seen = new Set<string>();
  for (let i = 1; i < close; i++) {
    const line = out[i] ?? '';
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (!(key in settings)) continue;
    const comment = stripTrailingComment(line.slice(colon + 1));
    out[i] = `${line.slice(0, colon)}: ${settings[key]}${comment}`;
    seen.add(key);
  }
  const toAppend = Object.entries(settings)
    .filter(([k]) => !seen.has(k))
    .map(([k, v]) => `${k}: ${v}`);
  if (toAppend.length > 0) out.splice(close, 0, ...toAppend);
  return out;
}

/** 保留行尾注释（' #…'），只去掉值部分 —— 与 frontmatter.ts 的注释口径一致 */
function stripTrailingComment(value: string): string {
  const m = /\s+#.*$/.exec(value);
  return m?.[0] ?? '';
}
