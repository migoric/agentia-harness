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
  // 环境事实必须一起带过去。此前 `view()` 不传 env，于是 train / holdout 视图丢了
  // `model` —— 门在视图上比对时，`sameModel` 退化成「不知道」，而那本来是可确认的。
  //
  // **`caseFingerprint` 刻意不带**：它是按「一整批用例」算的哈希，而视图只是子集。
  // 带过去会让基线（全量指纹）与候选（只跑 train 得到的子集指纹）永远不相等，
  // 于是每轮验证都被判成 `case_set_changed` —— 那不是「判定标准变了」，是拿两把
  // 不同刻度的尺子量同一件事。
  const env = envOf(report);
  const view = (cases: EvalReport['cases']): EvalReport =>
    summarize(cases, report.assetFingerprint, report.agent, env);
  return {
    train: view(train),
    holdout: holdout.length === 0 ? undefined : view(holdout),
    trainCases: train.map((c) => c.name),
    holdoutCases: holdout.map((c) => c.name),
  };
}

/** 报告里的环境事实（视图必须带着它们，否则门会把「同一个东西」判成不可比） */
function envOf(report: EvalReport): Parameters<typeof summarize>[3] {
  return {
    ...(report.model !== undefined ? { model: report.model } : {}),
    ...(report.harnessVersion !== undefined ? { harnessVersion: report.harnessVersion } : {}),
    ...(report.finishedAt !== undefined ? { finishedAt: report.finishedAt } : {}),
  };
}

/**
 * 取这份报告里**指定用例**的子视图。
 *
 * 分批留出要用它：候选只跑被选中的那一批，基线却还是整份留出集。直接拿整份基线
 * 去比，门会先报 `case_set_changed`（「仅基线有 h2」）—— 那不是判定标准变了，
 * 是两边比的不是同一批。**基线必须跟着批次一起收窄**。
 *
 * 与 `splitReport` 同口径：不带 `caseFingerprint`（子集的指纹与整批不同），
 * 环境事实原样带过去。
 */
export function subsetReport(report: EvalReport, cases: readonly string[]): EvalReport {
  const want = new Set(cases);
  return summarize(
    report.cases.filter((c) => want.has(c.name)),
    report.assetFingerprint,
    report.agent,
    envOf(report),
  );
}

/**
 * 留出集的门必须用**默认阈值**。
 *
 * train 的门阈值可以被调用方放宽（`--max-cost-growth` 等），那是调参的一部分；
 * 留出集是最后一道诚实检查，若它也跟着放宽，「泛化验证」就只是换个名字的 train 门。
 * 这个常量存在的意义是让调用方没法顺手把同一个 GateOptions 传进去。
 */
export const HOLDOUT_GATE_OPTIONS = Object.freeze({});
