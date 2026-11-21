import { AgentApp, type ModelClient, resolveDefaultModel, SystemPrompt } from '@migor/agentia';
import type { AssetSet } from '../assets/types.js';
import { findAsset } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import { effectiveModel } from '../run/app.js';
import { costOf } from '../run/cost.js';
import { manifestFor } from './manifest.js';
import type { FailureMode, LessonEntry, Proposal } from './types.js';

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
}

export interface Proposer {
  propose(ctx: ProposeContext): Promise<Proposal[]>;
  /**
   * 本轮提案器自己花了多少钱（可选：手写的 / 外部提案器没有模型开销）。
   *
   * RSI 的 `--max-cost` 必须把它算进去：这一步也调模型，此前只记基线与候选两遍
   * 评测，预算是系统性偏低的。没读数时给 `undefined` 并把 `costKnown` 置 false。
   */
  readonly costUsd?: number | undefined;
  readonly costKnown?: boolean | undefined;
}

const PROPOSER_SYSTEM = `你是一个 agent 提示词工程师。你的唯一工作：读失败证据，改写**一个** Markdown 资产的正文，让失败消失，同时不破坏它已经做对的事。

硬约束（违反任意一条，你的输出会被直接丢弃）：
1. 只输出**正文全文**。不要输出 frontmatter（--- 之间那段），不要输出 diff，不要输出解释性前后缀。
2. 不许假设有新的工具、新的技能、新的文件可读。你只能改措辞、结构、检查清单、输出格式要求。
3. 不许删掉原文里已有的关键要求。你的改动应该是**增补或收紧**，而不是缩减。
4. 正文必须自包含：它会被单独当作一次子运行的 system prompt 使用，看不到对话历史。

判断依据：如果失败是「该调的工具没调」，就在正文里写清触发条件与调用顺序；如果是「结论不对」，就在正文里固定输出格式与必须覆盖的要点；如果是「太贵/太长」，就收紧步骤数与输出长度。

先想清楚「这条改动为什么能让这条用例从失败变通过」，再动笔。改不出有把握的方案时，输出单个词 NONE。`;

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
  ) {}

  get costUsd(): number | undefined {
    return this.known ? this.spentUsd : undefined;
  }

  get costKnown(): boolean {
    return this.known;
  }

  async propose(ctx: ProposeContext): Promise<Proposal[]> {
    const limit = this.opts.maxModes ?? ctx.maxModes ?? 3;
    const modes = ctx.modes.slice(0, limit);
    const out: Proposal[] = [];
    this.spentUsd = 0;
    this.known = true;
    const model = this.effectiveModel(ctx);
    const lessons = ctx.history ?? [];
    let seq = 0;
    for (const mode of modes) {
      // 单个模式提不出方案（模型输出 NONE 或输出不像正文）**不该让整轮崩掉**：
      // 后面还有别的失败模式等着被修，而一次崩溃会把已经花掉的评测成本一起浪费。
      try {
        const target = this.pickTarget(ctx, mode);
        const after = await this.ask(mode, target.body, ctx, model, lessons);
        if (after === null) continue; // 模型明确说改不出
        this.assertSane(mode, target.body, after, target.key);

        out.push({
          id: `p-${Date.now()}-${seq++}`,
          modeId: mode.id,
          kind: mode.kind,
          rationale: `${mode.signature}（${mode.count} 例：${mode.cases.join(', ')}）；目标 ${target.key}（${target.why}）`,
          // 清单在调模型之后、跑验证之前生成 —— 假设不能由验证结果倒推
          manifest: manifestFor(mode, target.key),
          patch: { target: target.key, before: target.body, after },
          layer: 'L1',
        });
      } catch (e) {
        this.opts.onSkip?.(mode.id, e instanceof Error ? e.message : String(e));
      }
    }
    return out;
  }

  /**
   * 选改谁 —— **按数据选**。
   *
   * 优先取归因给出的 `targets`（「哪些资产被这些失败用例走过」）。只有在没有任何
   * 资产被调用过时才回退到主 agent 的 system：那时候确实没别的可改，但这也说明
   * 失败是「模型压根没用技能」，改主 system 的调用指引正好对路。
   */
  private pickTarget(
    ctx: ProposeContext,
    mode: FailureMode,
  ): { key: string; body: string; why: string } {
    for (const hint of mode.targets) {
      const asset = findAsset(ctx.assets, hint.target);
      if (asset !== undefined) {
        return {
          key: hint.target,
          body: asset.body,
          why: `${hint.cases.length} 条失败用例走过它：${hint.cases.join(', ')}`,
        };
      }
    }
    const agent =
      ctx.agent !== undefined
        ? ctx.assets.agents.find((a) => a.name === ctx.agent)
        : ctx.assets.agents[0];
    if (agent === undefined) {
      throw new HarnessError('asset.missing', '没有任何 agent 资产可改');
    }
    return {
      key: `agent:${agent.name}`,
      body: agent.body,
      why: '没有任何资产被调用过，只能改主 system',
    };
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

  private async ask(
    mode: FailureMode,
    current: string,
    ctx: ProposeContext,
    model: string,
    lessons: readonly LessonEntry[],
  ): Promise<string | null> {
    const app = new AgentApp({
      name: 'harness-proposer',
      system: new SystemPrompt().add('role', PROPOSER_SYSTEM),
      model,
      ...(Object.keys(this.config.pricing).length > 0
        ? { priceOverrides: { ...this.config.pricing } }
        : {}),
      ...(this.config.maxCostUsd !== undefined ? { maxCostUsd: this.config.maxCostUsd } : {}),
    });
    const prompt = renderPrompt(mode, current, lessons);
    const { result } = await app.run([{ role: 'user', content: prompt }], {
      ...(ctx.client !== undefined ? { client: ctx.client } : {}),
    });
    const c = costOf(result.trace);
    if (c === undefined) this.known = false;
    else this.spentUsd += c;
    const text = result.finalText.trim();
    if (text === 'NONE' || text === '') return null;
    return stripFence(text);
  }

  /** 机器能查的合理性检查 —— 省掉一轮「提案本身就坏了」的昂贵评测 */
  private assertSane(mode: FailureMode, before: string, after: string, target: string): void {
    if (after.trim() === '') {
      throw new HarnessError('rsi.no_signal', `提案把 ${target} 改成空正文（模式 ${mode.id}）`);
    }
    if (after.trim() === before.trim()) {
      throw new HarnessError('rsi.no_signal', `提案没有实际改动 ${target}（模式 ${mode.id}）`);
    }
    if (after.length > before.length * 3) {
      throw new HarnessError(
        'rsi.no_signal',
        `提案把 ${target} 扩张到 ${after.length} 字（原文 ${before.length}）—— 超过 3 倍几乎总是模型在复述任务而非改进`,
      );
    }
    if (after.trimStart().startsWith('---')) {
      throw new HarnessError('rsi.no_signal', `提案把 frontmatter 一起输出了（${target}）`);
    }
  }
}

function renderPrompt(mode: FailureMode, current: string, lessons: readonly LessonEntry[]): string {
  const evidence = mode.samples
    .map(
      (s, i) =>
        `### 例 ${i + 1}（用例 ${s.case}，stopReason=${s.stopReason}，${s.iterations} 轮，${s.tokens} token）\n` +
        `断言失败：\n${s.failures.map((f) => `- ${f}`).join('\n')}\n` +
        (s.excerpt === '' ? '' : `实际输出开头：\n"""\n${s.excerpt}\n"""\n`),
    )
    .join('\n');

  return `## 失败模式
类型：${mode.kind}
形态：${mode.signature}
影响：${mode.count} 次失败，涉及用例 ${mode.cases.join(', ')}

## 失败证据
${evidence}
${renderLessons(lessons)}
## 当前正文（你的输出将完整替换它）
"""
${current}
"""

## 你的任务
改写上面这段正文，使这类失败不再发生。直接输出新正文。改不出有把握的方案就输出 NONE。`;
}

/**
 * 「试过但没成立」的历史。
 *
 * 写成**约束而不是参考**：不加这一段时，提案器会把刚被门否掉的改法再提一遍 ——
 * 模型看不到上一轮，它以为自己在第一次尝试。这段话的作用是让它知道自己在一段
 * 有记忆的历史里工作。
 *
 * 刻意不给它「上次的完整正文」：那会把上下文撑大，也会诱导它做「在旧稿上微调」
 * 这类最容易过拟合的改动。只给目标、预测、被否的原因。
 */
function renderLessons(lessons: readonly LessonEntry[]): string {
  if (lessons.length === 0) return '';
  const lines = lessons.map((l) => {
    const why = l.outcome === 'reverted' ? '采纳后又被回滚' : '验证后没兑现预测';
    const prediction = l.prediction === undefined ? '（当时没写预测）' : l.prediction;
    const reason = l.reason === undefined ? '无门结论记录' : l.reason;
    return `- 改 ${l.target}，预测「${prediction}」→ ${why}：${reason}`;
  });
  return `## 已经试过、但没成立的方向
${lines.join('\n')}

这些方向被真实验证否定过。如果你的方案与其中某条本质相同（同一个目标 + 同一种改法），
换个不同的改法；如果你认为上次失败另有原因，不要解释，直接给出**不同**的写法。
`;
}

/** 模型习惯包 ``` 围栏；剥掉它，否则正文里会混进 Markdown 代码块标记 */
function stripFence(text: string): string {
  const m = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(text.trim());
  return (m?.[1] ?? text).trim();
}
