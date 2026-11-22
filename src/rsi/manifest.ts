import { HarnessError } from '../errors.js';
import { type Fail, objectAt, onlyKeys, requiredText } from '../util/shape.js';
import type { ChangeManifest, FailureMode } from './types.js';

/** 清单是外部手写提案的一部分 ⇒ 与提案同一个码（config.invalid，退出码 2） */
const fail: Fail = (message, cause) => {
  throw new HarnessError('config.invalid', message, cause);
};

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
  const m = objectAt(raw, source, fail);
  onlyKeys(m, source, MANIFEST_KEYS, fail);
  if (!Array.isArray(m.evidence) || !m.evidence.every((x) => typeof x === 'string' && x !== '')) {
    fail(`${source}.evidence 应是非空字符串数组`);
  }
  return {
    evidence: m.evidence,
    hypothesis: requiredText(m.hypothesis, `${source}.hypothesis`, fail),
    prediction: requiredText(m.prediction, `${source}.prediction`, fail),
    risk: requiredText(m.risk, `${source}.risk`, fail),
  };
}
