/**
 * Harness —— 资产模型。
 *
 * 「资产」= 决定 agent 行为、但**不是代码**的东西。首版两类：
 *
 * - `skill`：一个 Markdown 文件，正文就是子循环的 system prompt。模型看到的是它的
 *   `description`（作为工具描述），调用时把 `task` 交给这段正文驱动的一次受限子运行。
 * - `agent`：一个 Markdown 文件，正文是主 agent 的 system。`tools` 决定它能看到哪些能力。
 *
 * 判据（为什么这两类而不是更多）：RSI 首版只改**文本**，所以资产的边界就是「改了它
 * 行为会变、但不需要编译、也不需要跑测试」的那部分。要改 TS 就属 L2，不在首版范围。
 *
 * **名字空间是共享的**：技能与 agent 都会变成模型工具表里的一项，所以 `name` 必须在
 * 两类之间也唯一。分别唯一是不够的 —— 两个同名工具会让模型随机选，而这类错最难查
 * （评测结果会随采样抖动，看起来像「提示词不稳定」）。
 */
export type AssetKind = 'skill' | 'agent';

export interface AssetBase {
  readonly name: string;
  /** 资产版本号（字符串，比较用相等不用大小） */
  readonly version: string;
  readonly description: string;
  /** md 正文 */
  readonly body: string;
  /** 正文 + frontmatter 全文件指纹 */
  readonly fingerprint: string;
  /** 源文件绝对路径（报错与提案定位都用它） */
  readonly path: string;
  readonly model: string | undefined;
  readonly tools: readonly string[];
  /**
   * frontmatter 里是否**写了** `tools`。
   *
   * 存在的理由只有一个：区分「没写」与「写了空数组」。技能侧不看它（不写 = 没有子
   * 工具）；agent 侧看它 —— 不写 = 挂**全部**技能（缺省应当是安全的：安静地少挂技能
   * 是最难查的一类故障），写了就是精确清单，`tools: []` 表示一个都不挂。
   */
  readonly toolsDeclared: boolean;
  readonly maxIterations: number | undefined;
}

export interface SkillAsset extends AssetBase {
  readonly kind: 'skill';
}

export interface AgentAsset extends AssetBase {
  readonly kind: 'agent';
  readonly maxCostUsd: number | undefined;
  /**
   * 可委派的子 agent（同一 `agents/` 内的其它 agent 名）—— 每个变成一个 subagent 工具。
   *
   * 为什么是「名字」而不是内联正文：委派的意义是**独立上下文 + 独立评测**。内联会把
   * 两个 agent 的提示词焊死在一个文件里，RSI 改一个就动了另一个的基线。
   */
  readonly subagents: readonly string[];
}

export type Asset = SkillAsset | AgentAsset;

export interface AssetSet {
  readonly skills: readonly SkillAsset[];
  readonly agents: readonly AgentAsset[];
  /** 全体资产指纹（按 `kind:name` 排序后拼接再 hash）—— 一次 run 挂这一个就够归因 */
  readonly fingerprint: string;
}

/** lock/manifest 里的键：`skill:repo-triage` */
export function assetKey(a: { kind: AssetKind; name: string }): string {
  return `${a.kind}:${a.name}`;
}

export function findAsset(set: AssetSet, key: string): Asset | undefined {
  return [...set.skills, ...set.agents].find((a) => assetKey(a) === key);
}
