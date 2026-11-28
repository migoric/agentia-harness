/**
 * 报告里的模型事实 —— `sameModel` 判据与那句附注的唯一数据来源。
 *
 * 从 `gate.ts` 拆出来的理由：这一段是**读报告、写一句人话**，与「哪条判据成立」
 * 无关。混在一起时它只能经由完整的两份报告被测到（造两份报告才验得到一个字符串），
 * 而它恰恰是最容易写成「看起来说了、其实没说」的地方。
 */
import type { EvalReport } from './types.js';

/** 报告里的模型集合；老报告没有 `models` 时用单值 `model` 造一个一元素集合 */
export function modelSetOf(r: EvalReport): readonly string[] | undefined {
  if (r.models !== undefined && r.models.length > 0) return r.models;
  return r.model === undefined ? undefined : [r.model];
}

function modelLabel(r: EvalReport): string {
  const set = modelSetOf(r);
  return set === undefined ? '未记录' : set.join(', ');
}

/**
 * 模型事实的附注 —— 两类事都会让「通过率变化」不再可读成「改动效果」：
 *
 * - **集合不同**：跨模型对比本身是合法实验（「换个便宜模型还过不过」），但成本与
 *   token 的阈值是按同一个模型的噪声水平定的；
 * - **发生过降级**：降级轮与未降级轮不是同一个基准。混在一起算通过率，等于拿两种
 *   分布当一种 —— 而这恰恰是 fallback 链最容易制造出来的假象。
 *
 * 两条都不否决（否决权只给回归与成本），但都必须说出来。
 */
export function modelNoteOf(
  baseline: EvalReport,
  candidate: EvalReport,
  sameModel: boolean | undefined,
): string | undefined {
  const notes: string[] = [];
  if (sameModel === false) {
    notes.push(`模型集合不同（基线 ${modelLabel(baseline)}；候选 ${modelLabel(candidate)}）`);
  }
  const fbB = baseline.fallbackUsed;
  const fbC = candidate.fallbackUsed;
  if ((fbB ?? 0) > 0 || (fbC ?? 0) > 0) {
    notes.push(
      `发生过模型降级（基线 ${fbB ?? '未记录'} 次、候选 ${fbC ?? '未记录'} 次）—— 降级轮与未降级轮不是同一个基准`,
    );
  }
  return notes.length === 0 ? undefined : notes.join('；');
}
