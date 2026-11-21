import { type EvalReport, summarize } from './types.js';

/**
 * 把一份完整报告拆成两个视图 —— train 用来**选**改动，holdout 用来**验**改动。
 *
 * 拆的是 `CaseResult`，不是重新跑一遍：两个视图共享同一批运行结果、同一个资产指纹，
 * 因此 train 门与 holdout 门的唯一差别就是用例集合，数字可直接对比。
 *
 * 缺席的 `split` 一律当 train。这不只是兼容老报告：调用方手写 `CaseResult`（测试、
 * 外部评测器）时不必知道分组这个概念，也不会因此把用例错误地划进留出集。
 */
export interface SplitViews {
  readonly train: EvalReport;
  readonly holdout: EvalReport | undefined;
  readonly trainCases: readonly string[];
  readonly holdoutCases: readonly string[];
}

export function splitReport(report: EvalReport): SplitViews {
  const train = report.cases.filter((c) => c.split !== 'holdout');
  const holdout = report.cases.filter((c) => c.split === 'holdout');
  const view = (cases: EvalReport['cases']): EvalReport =>
    summarize(cases, report.assetFingerprint, report.agent);
  return {
    train: view(train),
    holdout: holdout.length === 0 ? undefined : view(holdout),
    trainCases: train.map((c) => c.name),
    holdoutCases: holdout.map((c) => c.name),
  };
}

/**
 * 留出集的门必须用**默认阈值**。
 *
 * train 的门阈值可以被调用方放宽（`--max-cost-growth` 等），那是调参的一部分；
 * 留出集是最后一道诚实检查，若它也跟着放宽，「泛化验证」就只是换个名字的 train 门。
 * 这个常量存在的意义是让调用方没法顺手把同一个 GateOptions 传进去。
 */
export const HOLDOUT_GATE_OPTIONS = Object.freeze({});
