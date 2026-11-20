import { AgentApp, type ModelClient, SystemPrompt } from '@migor/agentia';
import type { AssetSet } from '../assets/types.js';
import { findAsset } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import type { FailureMode, Proposal } from './types.js';

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
  /** 最多给几个模式提方案（按失败数降序取前 N） */
  readonly maxModes?: number | undefined;
}

export interface Proposer {
  propose(ctx: ProposeContext): Promise<Proposal[]>;
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
  constructor(
    private readonly config: HarnessConfig,
    private readonly opts: { model?: string; maxModes?: number } = {},
  ) {}

  async propose(ctx: ProposeContext): Promise<Proposal[]> {
    const limit = this.opts.maxModes ?? ctx.maxModes ?? 3;
    const modes = ctx.modes.slice(0, limit);
    const out: Proposal[] = [];
    let seq = 0;
    for (const mode of modes) {
      const target = this.pickTarget(ctx.assets, mode);
      if (target === undefined) continue;
      const asset = findAsset(ctx.assets, target);
      if (asset === undefined) continue;

      const after = await this.ask(mode, asset.body, ctx);
      if (after === null) continue; // 模型明确说改不出
      this.assertSane(mode, asset.body, after, target);

      out.push({
        id: `p-${Date.now()}-${seq++}`,
        modeId: mode.id,
        kind: mode.kind,
        rationale: `${mode.signature}（${mode.count} 例：${mode.cases.join(', ')}）`,
        patch: { target, before: asset.body, after },
        layer: 'L1',
      });
    }
    return out;
  }

  /**
   * 选改谁。首版只有一条规则：改**第一个 agent** 的正文。
   *
   * 为什么不是「按失败类型选技能」：`EvalReport` 里没有「哪条用例走了哪个技能」的
   * 直接映射，硬猜会改错文件（而改错文件时评测反而可能通过 —— 更糟）。
   * 等 trace 回流能给出技能命中统计之后，这里再按数据选。
   */
  private pickTarget(assets: AssetSet, _mode: FailureMode): string | undefined {
    const agent = assets.agents[0];
    return agent === undefined ? undefined : `agent:${agent.name}`;
  }

  private async ask(
    mode: FailureMode,
    current: string,
    ctx: ProposeContext,
  ): Promise<string | null> {
    const app = new AgentApp({
      name: 'harness-proposer',
      system: new SystemPrompt().add('role', PROPOSER_SYSTEM),
      ...(this.opts.model !== undefined ? { model: this.opts.model } : {}),
      ...(this.config.maxCostUsd !== undefined ? { maxCostUsd: this.config.maxCostUsd } : {}),
    });
    const prompt = renderPrompt(mode, current);
    const { result } = await app.run([{ role: 'user', content: prompt }], {
      ...(ctx.client !== undefined ? { client: ctx.client } : {}),
    });
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

function renderPrompt(mode: FailureMode, current: string): string {
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

## 当前正文（你的输出将完整替换它）
"""
${current}
"""

## 你的任务
改写上面这段正文，使这类失败不再发生。直接输出新正文。改不出有把握的方案就输出 NONE。`;
}

/** 模型习惯包 ``` 围栏；剥掉它，否则正文里会混进 Markdown 代码块标记 */
function stripFence(text: string): string {
  const m = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(text.trim());
  return (m?.[1] ?? text).trim();
}
