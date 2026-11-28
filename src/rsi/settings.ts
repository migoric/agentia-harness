/**
 * frontmatter 白名单 —— RSI 从「改措辞」跨到「改策略」的唯一入口。
 *
 * 提案默认只能改正文（`---` 头由 harness 维护）。这里放开一小撮**运行时真会读**
 * 的字段：改了它们，`buildApp` 装配出的 AgentApp 行为会变，评测测得出、门判得了，
 * 所以「改策略」能闭合成一轮可审计的进化。
 *
 * 白名单以「解析得到 → 装配进 AgentApp → agentia 真的执行」为入选标准。
 * 不在此表的字段（name / version / description / tools / model / subagents …）
 * 一旦出现在提案的 frontmatter 头里，**整份提案直接拒**（不是忽略、不是只改白名单）——
 * 「同一提案里既有白名单又有非白名单 ⇒ 整份拒」是硬纪律：悄悄接受一半会让
 * 提案者以为另一半也生效了，而审计记录里根本没它。
 *
 * 三态纪律：`undefined` = 没提供（保持磁盘现值）；有值 = 明确覆盖。
 */
import type { Asset } from '../assets/types.js';
import { HarnessError } from '../errors.js';
import { parseFrontmatter } from '../util/frontmatter.js';

/**
 * 白名单字段 → 校验器。新增字段必须同时满足「harness 解析 + buildApp 装配 + agentia 执行」。
 * `contextBudgetTokens` / `retryMaxAttempts` 是策略字段，由 policy-fields.ts 转成
 * agentia 策略对象（buildApp 消费），其余两个直接进 AgentApp 构造参数。
 */
const VALIDATORS: Readonly<Record<string, (v: string, source: string) => void>> = {
  maxIterations: (v, source) => positiveInt(v, source, 'maxIterations'),
  maxCostUsd: (v, source) => positiveNum(v, source, 'maxCostUsd'),
  contextBudgetTokens: (v, source) => positiveInt(v, source, 'contextBudgetTokens'),
  retryMaxAttempts: (v, source) => positiveInt(v, source, 'retryMaxAttempts'),
};

/**
 * 某类资产允许改的白名单字段。`maxCostUsd` 只有 agent 有（skill 资产模型上没有），
 * 给 skill 提案塞 maxCostUsd 属于「字段不属于这个资产」，同样整份拒。
 */
export function allowedSettings(asset: Asset): readonly string[] {
  return asset.kind === 'agent'
    ? ['maxIterations', 'maxCostUsd', 'contextBudgetTokens', 'retryMaxAttempts']
    : ['maxIterations', 'contextBudgetTokens', 'retryMaxAttempts'];
}

/** 提案里的 frontmatter 覆盖（键都在白名单内、值都已校验） */
export type Settings = Readonly<Record<string, string>>;

/**
 * 解析提案输出里的可选 frontmatter 头。
 *
 * 输入是提案的完整 `after`：
 * - 若以 `---` 开头，解析这段头 + 其后的正文；头里的键必须**全部**在白名单内且通过校验，
 *   否则整份拒（含「混入了非白名单字段」）。返回 `{ frontmatter, body, declared: true }`。
 * - 若不以 `---` 开头，就是纯正文（旧行为），返回 `{ frontmatter: {}, body, declared: false }`。
 *
 * 只在**提案边界**调用一次：renderFile 消费的是已经校验过的 Settings，不重复解析。
 */
export function parseProposalBody(
  after: string,
  asset: Asset,
  source: string,
): { readonly settings: Settings; readonly body: string; readonly declared: boolean } {
  if (!after.trimStart().startsWith('---')) {
    return { settings: {}, body: after, declared: false };
  }
  const fm = parseFrontmatter(after, source);
  const allowed = new Set(allowedSettings(asset));
  const settings: Record<string, string> = {};
  for (const [key, raw] of Object.entries(fm.data)) {
    if (!allowed.has(key)) {
      throw new HarnessError(
        'asset.invalid',
        `${source}: 提案的 frontmatter 含非白名单字段 "${key}" —— ` +
          `只允许改 ${[...allowed].join(' / ')}；整份提案已拒（不会只改白名单那一半）`,
      );
    }
    if (typeof raw !== 'string') {
      throw new HarnessError('asset.invalid', `${source}: 白名单字段 "${key}" 必须是标量`);
    }
    VALIDATORS[key]?.(raw, source);
    settings[key] = raw;
  }
  if (Object.keys(settings).length === 0) {
    throw new HarnessError(
      'asset.invalid',
      `${source}: 提案输出了 frontmatter 头却没有任何白名单字段（空头没有意义）`,
    );
  }
  return { settings, body: fm.body, declared: true };
}

/** 把已校验的 Settings 应用到资产：返回改了运行时字段的新资产（正文不变） */
export function applySettings(asset: Asset, settings: Settings): Asset {
  if (Object.keys(settings).length === 0) return asset;
  const next = { ...asset } as Record<string, unknown>;
  if (settings.maxIterations !== undefined) next.maxIterations = Number(settings.maxIterations);
  if (asset.kind === 'agent' && settings.maxCostUsd !== undefined) {
    next.maxCostUsd = Number(settings.maxCostUsd);
  }
  // 声明式策略字段更新到原始值表，buildApp 据此重转策略对象（验证时用的是内存 patched 资产）
  const policyKeys = ['contextBudgetTokens', 'retryMaxAttempts'];
  const updated = { ...asset.policyFields };
  let changed = false;
  for (const k of policyKeys) {
    if (settings[k] !== undefined) {
      updated[k] = settings[k]!;
      changed = true;
    }
  }
  if (changed) next.policyFields = updated;
  return next as unknown as Asset;
}

function positiveInt(v: string, source: string, key: string): void {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HarnessError('asset.invalid', `${source}: ${key} 应为正整数，收到 "${v}"`);
  }
}

function positiveNum(v: string, source: string, key: string): void {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new HarnessError('asset.invalid', `${source}: ${key} 应为正数，收到 "${v}"`);
  }
}
