import { HarnessError } from '../errors.js';
import type { ChangeManifest, FailureMode } from './types.js';

// 定义搬到了 types.ts（断 types ↔ manifest 的类型级环）。这里 re-export：
// `src/index.ts` 与既有调用一直从本模块取它。
export type { ChangeManifest };

const MANIFEST_KEYS = ['evidence', 'hypothesis', 'prediction', 'risk'] as const;

/** 从归因结果生成清单 —— 不调模型，避免「假设」本身是概率性的 */
export function manifestFor(mode: FailureMode, target: string): ChangeManifest {
  const refs = new Set<string>([`mode:${mode.id}`, ...mode.cases.map((c) => `case:${c}`)]);
  for (const s of mode.samples) {
    if (s.traceId !== undefined) refs.add(`trace:${s.traceId}`);
  }
  const cases = mode.cases.slice(0, 5).join(', ');
  return {
    evidence: [...refs].sort(),
    hypothesis: `${mode.kind}：${mode.signature}（${mode.count} 条失败）`,
    prediction: `改 ${target} 后，${mode.cases.length} 条用例（${cases}${mode.cases.length > 5 ? '…' : ''}）应从失败转为通过`,
    risk: `同一资产也被其它用例使用，可能引入回归；由 train 回归门与留出集验证兜底`,
  };
}

/** 外部手写提案带的清单是不可信输入：拼错字段会造成「以为有预测，实际没有」 */
export function validateManifest(raw: unknown, source: string): ChangeManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HarnessError('config.invalid', `${source} 应是对象`);
  }
  const m = raw as Record<string, unknown>;
  for (const k of Object.keys(m)) {
    if (!MANIFEST_KEYS.includes(k as (typeof MANIFEST_KEYS)[number])) {
      throw new HarnessError(
        'config.invalid',
        `${source}: 不认识的字段 "${k}"（只认 ${MANIFEST_KEYS.join(' / ')}）`,
      );
    }
  }
  if (!Array.isArray(m.evidence) || !m.evidence.every((x) => typeof x === 'string' && x !== '')) {
    throw new HarnessError('config.invalid', `${source}.evidence 应是非空字符串数组`);
  }
  return {
    evidence: m.evidence as string[],
    hypothesis: requiredText(m.hypothesis, `${source}.hypothesis`),
    prediction: requiredText(m.prediction, `${source}.prediction`),
    risk: requiredText(m.risk, `${source}.risk`),
  };
}

function requiredText(v: unknown, label: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new HarnessError('config.invalid', `${label} 应是非空字符串`);
  }
  return v;
}
