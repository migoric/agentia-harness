import type { FailureKind, FailureMode, LessonEntry } from './types.js';

/**
 * 提案提示词 —— 提案器里「读与写」的那一半。
 *
 * 与 `propose.ts` 分开的理由很实际：那份文件要管模型调用、成本记账、目标选择、
 * 合理性守卫，再加五段提示词就必然撞上单文件行数上限。而提示词是**唯一需要人反复
 * 推敲的东西**（每一条都是在真机上被否过才加上去的），单独一处也更好改。
 */

/** 简化轮指令的形状（与 `ProposeContext.shrink` 结构相同，这里不反向依赖它） */
export interface ShrinkPrompt {
  readonly reason: string;
  readonly minReduction: number;
}

/**
 * 这个资产还被哪些用例用着 —— **回归门的前置告知**。
 *
 * 2026-11-28 真机复现出来的失败模式：连续两轮，提案都改对了目标、修好了目标用例，
 * 却各自弄坏一条**原本通过**的用例（`triage-invoice` / `triage-outage`），被回归门
 * 逐条否决。模型并不知道「这份正文还被其它用例用着」—— 它只看到失败的那一条。
 *
 * 人类做同样的活时会先问「这个提示词现在服务哪些场景」，这里就是把那个问题的答案
 * 直接放进提示词。门不会因此放松（任何一条通过变失败仍然整条否决），只是把判据
 * **提前**告诉它，省掉一轮必然被打回的评测。
 */
export interface Audience {
  /** 当前通过、且会受这次改动影响的用例 */
  readonly passing: readonly string[];
  /** 当前失败、这次改动想修好的用例 */
  readonly failing: readonly string[];
}

/** 怎么从目标反查受众 —— 由编排层提供（它才有 baseline 报告） */
export type AudienceOf = (target: string) => Audience | undefined;

export const PROPOSER_SYSTEM = `你是一个 agent 提示词工程师。你的唯一工作：读失败证据，改写**一个** Markdown 资产的正文，让失败消失，同时不破坏它已经做对的事。

硬约束（违反任意一条，你的输出会被直接丢弃）：
1. 默认只输出**正文全文**。不要输出 diff，不要输出解释性前后缀。
   唯一的例外：当下面有「可改的策略字段」一节、且你确信改它能修好这类失败时，
   可以在正文前加一个 frontmatter 头（用 --- 包裹），**只写**那一节列出的字段。
   写任何其它字段（name / version / description / tools / model / subagents 等）
   会让**整份提案被拒** —— 不会只采纳你写对的那部分。
2. 不许假设有新的工具、新的技能、新的文件可读。你只能改措辞、结构、检查清单、输出格式要求，
   以及上面那一节明确列出的策略字段。
3. 不许删掉原文里已有的关键要求。默认的改动方向是**增补或收紧**，而不是缩减。
   唯一的例外是「简化轮」：那时正文里会明确写出来，按那一节的指令做。
4. 正文必须自包含：它会被单独当作一次子运行的 system prompt 使用，看不到对话历史。

判断依据：如果失败是「该调的工具没调」，就在正文里写清触发条件与调用顺序；如果是「结论不对」，就在正文里固定输出格式与必须覆盖的要点；如果是「太贵/太长」，就收紧步骤数与输出长度。唯独「反复压缩 / 上下文撑爆」这类失败：正文里写「少调几次、压缩输出」只是**软约束**，模型下一次仍可能把长原文塞回去 —— 真正的硬门是运行时预算，所以**优先改那一节提供的上下文预算字段**，正文改动只作为辅助。

先想清楚「这条改动为什么能让这条用例从失败变通过」，再动笔。改不出有把握的方案时，输出单个词 NONE。`;

/**
 * 提案正文的长度上限 —— 守卫与提示词**共用这一个数**。
 *
 * 3 倍是给长正文的：一份 2000 字的提示词被扩到 6000 字，几乎一定是在复述任务。
 * 但短正文按 3 倍卡会把**合理的增补**判死：87 字的摘要器技能要加上「日期格式」「输出
 * 示例」两段就过 300 字，而模型完全是在按指令做事 —— `PROPOSER_SYSTEM` 第 3 条明确
 * 写着「默认的改动方向是增补或收紧」。400 字是给这种情况的底板。
 *
 * 这个数还必须**写进提案提示词**（见 `renderPrompt`）：机器约束不告诉模型，它只能猜，
 * 而猜错的代价是一整轮验证的钱。2026-11-28 用真模型跑 RSI 时实测到：87 字的技能被
 * 扩到 739 字、提案直接被丢，RSI 一轮提出 0 个提案 —— 而 mock 模型永远只追加一句，
 * 所以这条冲突在此之前从未暴露。
 */
export function maxAfterChars(before: string): number {
  return Math.max(before.trim().length * 3, 400);
}

/**
 * 超长之后的第二句 —— 说清「超了多少、上限是多少、别靠删约束达标」。
 *
 * 三件事都必要：不给数字它只会小幅措辞；不说「会被丢弃」它不知道这不是风格建议；
 * 不说「别删约束」它会为了压字数把输出格式删掉 —— 那是把一次超长变成一次回归。
 */
export function tightenPrompt(current: string, prev: string): string {
  const limit = maxAfterChars(current);
  return `你上一稿 ${prev.trim().length} 字，超过上限 ${limit} 字（原文 ${current.trim().length} 字）。

这一稿现在会被**直接丢弃**，连验证都不会跑。请在不改变结论的前提下压到 ${limit} 字以内：
- 合并同义要求、删掉重复的举例与铺垫，保留每一条硬约束（输出格式、必须覆盖的要点、必须调用的工具）；
- **不要靠删约束来达标** —— 那会让原本通过的用例变失败，比超长更糟；
- 直接输出压缩后的正文全文，不要解释、不要道歉、不要重复你说过的话。

目标：不超过 ${limit} 字。`;
}

/** 一个可改的策略字段（由编排层按资产类型给，不在这里硬编码） */
export interface SettingFact {
  readonly key: string;
  /** 当前值；'（未设置）' 表示磁盘上没写 */
  readonly current: string;
  readonly hint: string;
}

export interface PromptFacts {
  readonly mode: FailureMode;
  readonly current: string;
  readonly lessons: readonly LessonEntry[];
  readonly shrink: ShrinkPrompt | undefined;
  /** 缺省 = 不知道这个资产还被谁用着，那一节就不出现（不要编） */
  readonly audience?: Audience | undefined;
  /** 可改的白名单策略字段；缺省/空 = 这一类资产没有可改策略，那一节不出现 */
  readonly settings?: readonly SettingFact[] | undefined;
}

/**
 * 可改的策略字段 —— 让提案器知道「除了措辞，还能改旋钮」。
 *
 * 只列编排层给的字段（它按资产类型与白名单筛过），这里不自己造字段名 —— 造出来的
 * 名字会被 parseProposalBody 整份拒，等于白烧一次调用。给出当前值与用途，它才知道
 * 「现在是多少、往哪个方向拧」。
 */
function renderSettings(settings: readonly SettingFact[] | undefined, kind: FailureKind): string {
  if (settings === undefined || settings.length === 0) return '';
  const lines = settings.map((s) => `- \`${s.key}\`：当前 ${s.current}。${s.hint}`);
  const runtime = kind === 'context_overflow' || kind === 'budget' || kind === 'loop';
  return `
## 可改的策略字段（只有这些能写进 frontmatter）
${lines.join('\n')}
${runtime ? '本轮失败就是运行时行为问题（反复压缩 / 上下文撑爆 / 绕圈 / 成本失控）：正文里写「少调几次」是软约束，挡不住真实增长。**优先改这里**，正文只作辅助。' : '只在失败证据指向运行时行为（反复压缩 / 上下文撑爆 / 绕圈 / 成本失控）时才考虑改这里；结果类失败（结论不对 / 该调的工具没调）仍优先改正文。'}
要改就在正文前加 \`---\` 头，只写上面列出的字段（整数 / 正数按提示写），其余 frontmatter 字段一个都不许出现。

`;
}

export function renderPrompt(facts: PromptFacts): string {
  const { mode, current, lessons, shrink } = facts;
  const evidence = mode.samples
    .map(
      (s, i) =>
        `### 例 ${i + 1}（用例 ${s.case}，stopReason=${s.stopReason}，${s.iterations} 轮，${s.tokens} token` +
        (s.peakContextTokens !== undefined ? `，峰值上下文 ${s.peakContextTokens}` : '') +
        (s.compactions !== undefined ? `，压缩 ${s.compactions} 次` : '') +
        (s.toolCalls !== undefined ? `，工具调用 ${s.toolCalls} 次` : '') +
        `）\n` +
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
${renderAudience(facts.audience)}${renderSettings(facts.settings, mode.kind)}${renderLessons(lessons)}${renderShrink(shrink, current)}
## 当前正文（你的输出将完整替换它）
"""
${current}
"""

## 长度上限
改写后的正文不得超过 ${maxAfterChars(current)} 字（现在是 ${current.trim().length} 字）。
超过会被**直接丢弃**，连验证都不会跑 —— 这是机器判据，不是风格建议。
你只有一次补救机会（超了会再问你一遍，那一稿还超就丢弃），所以第一稿就按上限写。
短正文（几百字以内）允许比原稿长很多，但别把用例的任务描述抄进来。

## 你的任务
${shrink === undefined ? '改写上面这段正文，使这类失败不再发生。直接输出新正文。改不出有把握的方案就输出 NONE。' : '在满足简化轮要求的前提下改写上面这段正文（能顺手修掉这次失败更好，但**变小**是硬要求）。直接输出新正文；这段正文确实没有可删的冗余就输出 NONE。'}`;
}

/**
 * 「这个资产还被哪些用例用着」。
 *
 * 写成**硬约束**而不是背景信息：回归门会在这批用例上逐条比较，任何一条从通过变
 * 失败就整条否决 —— 不说清这一点，模型会把它当成「顺便提一下的上下文」，然后为了
 * 修一条用例把另一条写坏。真机上连续两轮都是这么被否的。
 */
function renderAudience(audience: Audience | undefined): string {
  if (audience === undefined) return '';
  const { passing, failing } = audience;
  if (passing.length === 0 && failing.length === 0) return '';
  const lines: string[] = ['## 这份正文现在还服务哪些用例'];
  if (passing.length > 0) {
    lines.push(
      `当前**通过**：${passing.join(', ')}`,
      '这些用例现在是对的。改写之后它们必须仍然通过 —— 回归门会逐条比较，',
      '**任何一条从通过变失败都会直接否决整条提案**（哪怕目标用例确实修好了）。',
      '所以：改动要收敛到「修这条失败」所需的最小范围，不要顺手重写判断标准、分类口径或输出结构。',
    );
  }
  if (failing.length > 0) {
    lines.push(`当前**失败**（这次要修的）：${failing.join(', ')}`);
  }
  return `${lines.join('\n')}\n\n`;
}

/**
 * 简化轮指令。
 *
 * 为什么要给出具体字数上限：只说「请简化」，模型会做措辞层面的微调（把"应该"改成"须"），
 * 长度几乎不变，而配额判据是硬性的 —— 于是每一轮都产出"看起来简化了、其实没变短"的
 * 提案，全部被拒。给出目标字数，模型才有可能真的合并段落。
 *
 * 也刻意说清「简化 ≠ 删要求」：这一段提示词最容易被删掉的是文件格式与工具约束，
 * 而它们恰恰是回归门与留出集会抓的东西 —— 让人读的时候知道这是有代价的。
 */
export function renderShrink(shrink: ShrinkPrompt | undefined, current: string): string {
  if (shrink === undefined) return '';
  const before = current.trim().length;
  const limit = Math.floor(before * (1 - shrink.minReduction));
  return `
## 本轮是简化轮（优先级高于上面所有「增补」类要求）
${shrink.reason}

这一轮**只接受净简化**：删掉重复的、合并同义的、去掉没起作用的步骤与检查项。
- 不许新增段落、不许新增检查项、不许把同一件事换个说法再讲一遍；
- 改动后正文必须比现在**至少短 ${(shrink.minReduction * 100).toFixed(0)}%**
  （现在 ${before} 字 ⇒ 目标不超过 ${limit} 字）。这是硬门槛，不达标会被直接丢弃；
- 简化不等于删要求：输出格式、必须调用的工具、必须覆盖的要点这些硬约束要保留。
  该删的是复述、堆叠的举例、以及同一件事说两遍。
`;
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
