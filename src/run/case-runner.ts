import type { RunOutcome } from './runner.js';

/**
 * 评测要的「跑一条用例」的最小接口。
 *
 * 抽它的唯一理由是 `runSuite` 不该把「怎么跑」写死成本地装配：把同一个用例集评在
 * **远程服务**上（`harness eval --remote`）时，断言、报告结构、回归门都该原样复用，
 * 只有「谁来跑」变了。做不到这一点，跨服务评测就必然长成第二套判据 —— 而两套判据
 * 一旦分歧，「评测说坏了、服务说没事」就成了新的排查入口。
 *
 * 刻意窄：只有 `run` 与（可选的）`runTurns`，加上报告需要的两个事实（agent 标识、
 * 生效模型）。本地 `Runner` 天然满足它，不需要适配层。
 */
export interface CaseRunner {
  /** 报告里 `agent` 字段的来源：`name@version` */
  readonly agent: { readonly name: string; readonly version: number };
  /**
   * 实际生效的模型。报告用它判「两轮跑分可比吗」—— 缺席时如实写 `unknown`，
   * 而不是填一个本地配置里的模型名（那会让「远程换了模型」看不出来）。
   */
  readonly model?: string | undefined;
  run(task: string, opts?: { readonly signal?: AbortSignal }): Promise<RunOutcome>;
  /**
   * 多轮。**远程实现不妨提供**：它要么正确地接会话（同一 contextId 连续发），
   * 要么明确拒绝 —— 静默按单轮跑会让多轮用例变成「只测了第一轮」，
   * 而报告里看不出任何异常。
   */
  runTurns?(
    turns: readonly string[],
    opts?: { readonly signal?: AbortSignal },
  ): Promise<RunOutcome>;
}
