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
  readonly maxIterations: number | undefined;
}

export interface SkillAsset extends AssetBase {
  readonly kind: 'skill';
}

export interface AgentAsset extends AssetBase {
  readonly kind: 'agent';
  readonly maxCostUsd: number | undefined;
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
