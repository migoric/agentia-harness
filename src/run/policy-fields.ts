/**
 * 声明式策略字段 —— frontmatter 旋钮 → agentia 运行时策略对象。
 *
 * 入选标准（与 settings.ts 一致）：字段必须能被 harness 解析、装配进 AgentApp、
 * agentia 真的执行、评测测得出。因此这里只映射 agentia **已经导出**的运行时旋钮：
 *
 * - `contextBudgetTokens` → `createBudgetPolicy({ budgetTokens })`（上下文预算阈值）
 * - `retryMaxAttempts`    → `retry: { maxAttempts }`（模型请求重试次数）
 *
 * 另两个（`maxIterations` / `maxCostUsd`）在 settings.ts 里，直接进 AgentApp 构造参数。
 *
 * 文档 §3.3 原文点名的 `stopWhen` / `maxDelegate` 在 agentia 运行时**没有对应旋钮**
 * （grep 整个 src 无此字段）——硬造只会得到「改了没生效、评测测不出、门无法验证」的
 * 空壳。按「能被验证」原则不实现它们；等 agentia 真有对应机制再按同一条入选标准加。
 *
 * 这是**纯函数层**：不碰 agentia 的 engine，不改任何行为缺省；只是把字符串配置翻译成
 * agentia 已有的策略对象。缺省（字段没写）⇒ 返回空 ⇒ 装配时不传，
 * agentia 用自己的缺省（与今天逐字一致）。
 */
import { type ContextPolicy, createBudgetPolicy, type RetryOptions } from '@migor/agentia';
import { HarnessError } from '../errors.js';

/** 一条声明式策略字段的解析结果 */
export interface PolicyFields {
  readonly contextPolicy?: ContextPolicy | undefined;
  readonly retry?: RetryOptions | undefined;
}

const KEYS = ['contextBudgetTokens', 'retryMaxAttempts'] as const;
export type PolicyFieldKey = (typeof KEYS)[number];

/** 这几个字段是否属于「声明式策略」（与 settings.ts 的数值旋钮分开） */
export function isPolicyField(key: string): key is PolicyFieldKey {
  return (KEYS as readonly string[]).includes(key);
}

export function policyFieldKeys(): readonly PolicyFieldKey[] {
  return KEYS;
}

/**
 * 把 frontmatter 里的声明式策略字段转成 agentia 策略对象。
 * `raw` 只含已通过白名单的键（见 settings.ts 的 VALIDATORS 扩展）；这里做值校验与转译。
 */
export function buildPolicyFields(
  raw: Readonly<Record<string, string>>,
  source: string,
): PolicyFields {
  const out: { contextPolicy?: ContextPolicy; retry?: RetryOptions } = {};
  const budget = raw.contextBudgetTokens;
  if (budget !== undefined) {
    out.contextPolicy = createBudgetPolicy({
      budgetTokens: positiveInt(budget, source, 'contextBudgetTokens'),
    });
  }
  const attempts = raw.retryMaxAttempts;
  if (attempts !== undefined) {
    out.retry = { maxAttempts: positiveInt(attempts, source, 'retryMaxAttempts') };
  }
  return out;
}

function positiveInt(v: string, source: string, key: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HarnessError('asset.invalid', `${source}: ${key} 应为正整数，收到 "${v}"`);
  }
  return n;
}
