import {
  AgentApp,
  type MessageParam,
  type ModelClient,
  resolveDefaultModel,
  SystemPrompt,
} from '@migor/agentia';
import { type Asset, type AssetSet, findAsset } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import { effectiveModel } from '../run/app.js';
import { costOf } from '../run/cost.js';
import { ensureEndpointEnv } from '../run/endpoint.js';
import { manifestFor } from './manifest.js';
import {
  type Audience,
  type AudienceOf,
  maxAfterChars,
  PROPOSER_SYSTEM,
  renderPrompt,
  type SettingFact,
  tightenPrompt,
} from './propose-prompt.js';
import { allowedSettings, parseProposalBody, type Settings } from './settings.js';
import { targetCandidates } from './targets.js';
import type { FailureMode, LessonEntry, Proposal } from './types.js';

/**
 * 提示词与长度上限的实现在 `propose-prompt.ts`。
 *
 * 这里 re-export 是因为它们是**对外契约的一部分**：`maxAfterChars` 是守卫与提示词
 * 共用的那个数（测试要钉住它），`renderShrink` 是简化轮那句指令（测试要断言它真的
 * 进了提示词）。换文件不该让调用方改 import。
 */
export { maxAfterChars, renderShrink } from './propose-prompt.js';

/**
 * 提案 —— RSI 里唯一「需要创造力」的一步，因此也是唯一用 LLM 的一步。
 *
 * 接口在这里，实现可换：`LlmProposer` 是缺省（真让它想怎么改），
 * 测试与人工场景可以塞任意 `Proposer`（例如从 `proposals/*.json` 读人手写的补丁）。
 *
 * 三条约束写进提示词，因为它们是最常见的「模型改坏东西」的三种方式：
 * - 只改正文，不动 frontmatter（名字/工具集变了，评测结果就不可比了）；
 * - 只能在现有能力内改，不许要求新工具（新工具是 L2，首版不做）；
 * - 输出必须是**完整可替换的正文**，不是 diff —— 让模型生成 patch 的失败率远高于
 *   让它重写一遍，而全文替换的正确性可以被机器检查（非空、含原标题、长度合理）。
 */
export interface ProposeContext {
  readonly modes: readonly FailureMode[];
  readonly assets: AssetSet;
  readonly config: HarnessConfig;
  readonly client?: ModelClient | undefined;
  /** 构造者要改的主 agent 名（`targets` 为空时的回退目标） */
  readonly agent?: string | undefined;
  /** 最多给几个模式提方案（按失败数降序取前 N） */
  readonly maxModes?: number | undefined;
  /**
   * 账本里的教训（试过但没成立的方向）。缺省 / 空数组 = 没有历史可参考。
   *
   * 这是「自进化能跨轮」的关键一环：不看历史时，提案器每轮都在重置，会把
   * 上一轮刚被门否掉的改法原样再提一遍，白烧一遍评测钱。
   */
  readonly history?: readonly LessonEntry[] | undefined;
  /**
   * 取消信号。**必须**透传到 `app.run`：提案是 RSI 里唯一调模型的一步，
   * 而它可能连提三个模式（三次调用）。此前 signal 只贯通到评测与验证，
   * 提案这一步断了 —— 于是 Ctrl-C 或预算超限之后，最坏还要再烧三次调用
   * （「说停还在花钱」），恰好打在成本归因最在意的位置。
   */
  readonly signal?: AbortSignal | undefined;
  /**
   * 简化轮指令 —— 由净简化配额触发时传入，缺席 = 不是简化轮。
   *
   * 为什么是「指令」而不是「过滤」：过滤只能拒掉变胖的提案（`runCycle` 确实也这么做，
   * 那一步省的是评测钱），但模型不知道这一轮只许删，它会一次次交出"再补一段"的方案，
   * 然后被一条条拒掉 —— 一整轮下来零产出，人会读成「RSI 坏了」。把意图说进提示词，
   * 才有机会真的拿到一条可用的简化。
   */
  readonly shrink?: { readonly reason: string; readonly minReduction: number } | undefined;
  /**
   * 本轮**已经试过、不要再选**的目标。
   *
   * 由轮次编排在「首选目标被门否决」之后传入，配合 `modes` 只给一个模式，就得到
   * 「换个资产再试一次」。刻意做成排除列表而不是「强制目标」：提案器的目标排序是
   * 数据驱动的，排除法让它继续按数据往下走，而强制法要求调用方先想清楚下一个是谁
   * —— 那份知识已经在 `targets.ts` 里了，不该在调用方再写一遍。
   */
  readonly avoidTargets?: readonly string[] | undefined;
  /**
   * 「这个资产还被哪些用例用着」—— 由编排层提供（它才有 baseline 报告）。
   *
   * 不给时提示词里就不出现那一节：不知道就说不知道，别让模型拿「大概是这些」去
   * 推理 —— 它会据此删掉自己以为没人用的要求，而那句话往往正是回归门要抓的。
   */
  readonly audience?: AudienceOf | undefined;
}

/** 提案这一步的产出与它自己的花费（两个都要，缺一个就得靠「先调再读属性」的时序约定） */
export interface ProposeResult {
  readonly proposals: readonly Proposal[];
  /**
   * 这一步花掉的钱。`usd === undefined` = 没有读数（`known=false`），
   * 不是「免费」—— 调用方据此把整次运行的成本标成不可信。
   */
  readonly cost: { readonly usd: number | undefined; readonly known: boolean };
}

export interface Proposer {
  /**
   * 一次提案调用。
   *
   * 返回 `{ proposals, cost }` 而不是「返回数组 + 事后读 `costUsd` 属性」：
   * 后者是**时序契约**（必须 propose 之后读、且实现必须每次开头重置），只写在
   * 注释里；`rounds.ts` 已经因此被迫每轮重造实例来避免两轮成本并成一条。
   * 成本与产出同一次返回，契约就只剩类型。
   */
  propose(ctx: ProposeContext): Promise<ProposeResult>;
}

export class LlmProposer implements Proposer {
  private spentUsd = 0;
  private known = true;

  constructor(
    private readonly config: HarnessConfig,
    private readonly opts: {
      model?: string;
      maxModes?: number;
      /** 单条模式提不出方案时的回执（CLI 用它打印，而不是静默吞掉） */
      onSkip?: (modeId: string, reason: string) => void;
    } = {},
  ) {
    // 与 createRunner 同款：提案器在没注入 client 时自建 AgentApp（默认 client 只读
    // 环境变量），库用户直接构造它时 endpoint 段必须先生效 —— 幂等，不覆盖已有 env
    ensureEndpointEnv(config);
  }

  async propose(ctx: ProposeContext): Promise<ProposeResult> {
    const limit = this.opts.maxModes ?? ctx.maxModes ?? 3;
    const modes = ctx.modes.slice(0, limit);
    const out: Proposal[] = [];
    this.spentUsd = 0;
    this.known = true;
    const model = this.effectiveModel(ctx);
    const lessons = ctx.history ?? [];
    let seq = 0;
    for (const mode of modes) {
      // 已经取消就别再开下一次模型调用：每个模式一次调用，而「说停还在花钱」
      // 正是这条链最容易漏掉的一处（signal 只在 app.run 里生效，它不能被当成 break）
      if (ctx.signal?.aborted === true) break;
      // 单个模式提不出方案（模型输出 NONE 或输出不像正文）**不该让整轮崩掉**：
      // 后面还有别的失败模式等着被修，而一次崩溃会把已经花掉的评测成本一起浪费。
      try {
        const target = this.pickTarget(ctx, mode);
        const ask = {
          mode,
          current: target.body,
          ctx,
          model,
          lessons,
          audience: ctx.audience?.(target.key),
        };
        let parsed = await this.ask(ask, target.asset);
        if (parsed === null) continue; // 模型明确说改不出
        // 超长不该一次机会都不给。真机实测（2026-11-28）：提示词里已明确写了上限，
        // 模型仍有 2/5 次写到上限的 1.2–1.8 倍 —— 直接丢弃等于白花一次调用，
        // 而它往往只差「把三段合并成一段」。给一次带着具体数字的压缩机会，
        // 机器判据不动（上限还是那个上限），只是让失败可恢复。压缩只针对正文，
        // settings 在第一次就定下来了。
        if (parsed.body.trim().length > maxAfterChars(target.body)) {
          const tighter = await this.ask({ ...ask, prev: parsed.body }, target.asset);
          if (tighter !== null) parsed = { ...parsed, body: tighter.body };
        }
        this.assertSane(mode, target.body, parsed.body, target.key);

        out.push({
          id: `p-${Date.now()}-${seq++}`,
          modeId: mode.id,
          kind: mode.kind,
          rationale: `${mode.signature}（${mode.count} 例：${mode.cases.join(', ')}）；目标 ${target.key}（${target.why}）`,
          // 清单在调模型之后、跑验证之前生成 —— 假设不能由验证结果倒推
          manifest: manifestFor(mode, target.key),
          patch: {
            target: target.key,
            before: target.body,
            after: parsed.body,
            ...(Object.keys(parsed.settings).length > 0 ? { settings: parsed.settings } : {}),
          },
          layer: 'L1',
        });
      } catch (e) {
        this.opts.onSkip?.(mode.id, e instanceof Error ? e.message : String(e));
      }
    }
    return {
      proposals: out,
      cost: { usd: this.known ? this.spentUsd : undefined, known: this.known },
    };
  }

  /**
   * 选改谁 —— **按数据选**，并且可以被排除列表推着往下走。
   *
   * 候选表由 `targets.ts` 给出（技能/子 agent 在前，主 agent 在最后）。这里只做
   * 「取第一个没被排除的」这一步，顺序语义全部留在那一处 —— 两处各排一次序，迟早
   * 会有一处先改而另一处不改。
   */
  private pickTarget(
    ctx: ProposeContext,
    mode: FailureMode,
  ): { key: string; body: string; why: string; asset: Asset } {
    const avoid = new Set(ctx.avoidTargets ?? []);
    const candidates = targetCandidates({
      mode,
      assets: ctx.assets,
      ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
    });
    const hit = candidates.find((c) => !avoid.has(c.key));
    if (hit !== undefined) {
      const asset = findAsset(ctx.assets, hit.key);
      if (asset === undefined) throw new HarnessError('asset.missing', `找不到资产 ${hit.key}`);
      return { key: hit.key, body: hit.body, why: hit.why, asset };
    }
    if (candidates.length === 0) {
      throw new HarnessError('asset.missing', '没有任何 agent 资产可改');
    }
    // 有候选但全在排除列表里：这是调用方的编排问题，不该静默产出一个重复提案
    throw new HarnessError(
      'rsi.no_signal',
      `可改的目标都已试过（${[...avoid].join(', ')}），这个模式没有别的可改`,
    );
  }

  /**
   * 提案器与主 agent 用同一个模型口径。此前它只认构造参数的 `model`，
   * CLI 从来不传 ⇒ 非 Anthropic 工程里提案器偷偷用 `claude-opus-5`，
   * 既打错端点模型名，又按 Opus 单价记账（与技能子循环踩过的是同一个坑）。
   */
  private effectiveModel(ctx: ProposeContext): string {
    if (this.opts.model !== undefined) return this.opts.model;
    const agent =
      ctx.agent !== undefined
        ? ctx.assets.agents.find((a) => a.name === ctx.agent)
        : ctx.assets.agents[0];
    return agent === undefined
      ? (this.config.model ?? resolveDefaultModel())
      : effectiveModel(this.config, agent);
  }

  /**
   * 一次改写请求。
   *
   * `prev` 有值时不是「重来一遍」，而是让模型**看着自己上一稿**改：多一轮对话比
   * 重新发一遍原提示便宜，也更可能真的压缩（它知道要删哪几段，不用重新推理）。
   */
  private async ask(
    req: {
      mode: FailureMode;
      current: string;
      ctx: ProposeContext;
      model: string;
      lessons: readonly LessonEntry[];
      audience?: Audience | undefined;
      prev?: string | undefined;
    },
    asset: Asset,
  ): Promise<{ body: string; settings: Settings } | null> {
    const { mode, current, ctx, model, lessons, prev, audience } = req;
    const app = new AgentApp({
      name: 'harness-proposer',
      system: new SystemPrompt().add('role', PROPOSER_SYSTEM),
      model,
      ...(Object.keys(this.config.pricing).length > 0
        ? { priceOverrides: { ...this.config.pricing } }
        : {}),
      ...(this.config.maxCostUsd !== undefined ? { maxCostUsd: this.config.maxCostUsd } : {}),
    });
    const prompt = renderPrompt({
      mode,
      current,
      lessons,
      shrink: ctx.shrink,
      ...(audience !== undefined ? { audience } : {}),
      settings: settingFacts(asset),
    });
    const messages: MessageParam[] =
      prev === undefined
        ? [{ role: 'user', content: prompt }]
        : [
            { role: 'user', content: prompt },
            { role: 'assistant', content: prev },
            { role: 'user', content: tightenPrompt(current, prev) },
          ];
    const { result } = await app.run(messages, {
      ...(ctx.client !== undefined ? { client: ctx.client } : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    const c = costOf(result.trace);
    if (c === undefined) this.known = false;
    else this.spentUsd += c;
    const text = result.finalText.trim();
    if (text === 'NONE' || text === '') return null;
    // 提案可带白名单 frontmatter 头（改策略）—— 在这里拆出 settings 与正文，
    // 非白名单字段会整份拒。机器校验在 parseProposalBody，提示词约束在 PROPOSER_SYSTEM。
    const parsed = parseProposalBody(
      stripFence(text),
      asset,
      `proposal:${asset.name} (${mode.id})`,
    );
    return { body: parsed.body, settings: parsed.settings };
  }

  /** 机器能查的合理性检查 —— 省掉一轮「提案本身就坏了」的昂贵评测 */
  private assertSane(mode: FailureMode, before: string, after: string, target: string): void {
    if (after.trim() === '') {
      throw new HarnessError('rsi.no_signal', `提案把 ${target} 改成空正文（模式 ${mode.id}）`);
    }
    if (after.trim() === before.trim()) {
      throw new HarnessError('rsi.no_signal', `提案没有实际改动 ${target}（模式 ${mode.id}）`);
    }
    const limit = maxAfterChars(before);
    if (after.trim().length > limit) {
      throw new HarnessError(
        'rsi.no_signal',
        `提案把 ${target} 扩张到 ${after.trim().length} 字（原文 ${before.trim().length}，上限 ${limit}）` +
          ' —— 超出这个量级几乎总是模型在复述任务而非改进',
      );
    }
    if (after.trimStart().startsWith('---')) {
      throw new HarnessError('rsi.no_signal', `提案把 frontmatter 一起输出了（${target}）`);
    }
  }
}

/**
 * 当前资产可改的策略字段（给提案提示词用）。值从资产的解析字段取 —— 与
 * `parseProposalBody` 的白名单同源（allowedSettings），不在这里另列一份字段名。
 *
 * 每个字段必须从**自己的**来源取当前值：maxIterations / maxCostUsd 是 AgentApp 的
 * 顶层参数，contextBudgetTokens / retryMaxAttempts 在 policyFields 里。曾把后两者
 * 落到 maxCostUsd 分支，提示词于是把「当前 0.6 美元」当成上下文预算告诉模型 ——
 * 模型自然不会去改一个看起来已经很小、且名叫美元上限的旋钮。
 */
export function settingFacts(asset: Asset): SettingFact[] {
  return allowedSettings(asset).map((key) => {
    if (key === 'maxIterations') {
      return {
        key,
        current: asset.maxIterations === undefined ? '（未设置）' : String(asset.maxIterations),
        hint: '主循环最大迭代次数，正整数；绕圈/超步数时可考虑下调，让 agent 更早收敛。',
      };
    }
    if (key === 'maxCostUsd') {
      const v = asset.kind === 'agent' ? asset.maxCostUsd : undefined;
      return {
        key,
        current: v === undefined ? '（未设置）' : String(v),
        hint: '整条 run 的美元硬上限，正数；成本失控时可考虑下调。',
      };
    }
    if (key === 'contextBudgetTokens') {
      return {
        key,
        current: asset.policyFields[key] ?? '（未设置）',
        hint: '单轮上下文预算 token 数，正整数；反复压缩 / 上下文撑爆时可考虑下调。',
      };
    }
    return {
      key,
      current: asset.policyFields[key] ?? '（未设置）',
      hint: '失败重试次数上限，正整数；工具偶发失败可上调，绕圈重试可下调。',
    };
  });
}

/** 模型习惯包 ``` 围栏；剥掉它，否则正文里会混进 Markdown 代码块标记 */
function stripFence(text: string): string {
  const m = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(text.trim());
  return (m?.[1] ?? text).trim();
}
