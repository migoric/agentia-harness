import { type ModelClient, mapWithConcurrency } from '@migor/agentia';
import type { AssetSet } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import { effectiveModel } from '../run/app.js';
import type { CaseRunner } from '../run/case-runner.js';
import { createRunner } from '../run/runner.js';
import { harnessVersion } from '../version.js';
import { loadEvalCases } from './load.js';
import { summarize } from './report.js';
import { runOne } from './run-one.js';
import { caseSetFingerprint, type EvalReport } from './types.js';

// 工具事件提取的唯一实现搬到了 tool-events.ts（序列 / 次数 / 参数共用一份扫描）。
// 保留从本模块再导出：index.ts 与既有测试一直从这里取 toolSequence。
export { toolInvocations, toolSequence } from './tool-events.js';

/**
 * 跑评测集。
 *
 * 三个刻意的纪律：
 *
 * 1. **不落 trace**（`persistTraces: false`）。评测会跑几十上百次，落盘会把
 *    `traces.jsonl` 变成垃圾场；要留证据就跑 `--keep-traces`，由调用方显式要。
 * 2. **失败即记，不中断**。一条用例挂了不代表后面的没意义 —— RSI 要的是完整的
 *    失败分布，而不是「第一条就停」。
 * 3. **只有「跑崩了」才重试**。断言不通过是**结果**，重试它就等于用采样次数掩盖
 *    问题 —— 那样 RSI 会学到「多试几次就过了」，而不是「这条提示词要改」。
 */
/**
 * 评测的调优旋钮 —— `runSuite` 与 `verifyProposal` 共用同一份形状。
 *
 * 抽出来是为了**不要两条口径**：RSI 的验证若比基线跑得更宽松（比如超时更长、
 * 重试更多），门比较的就不是同一个东西，采纳记录会变成噪声。
 */
export interface SuiteTuning {
  /** 单条用例超时（毫秒）。超时按失败记，不中断整轮 */
  readonly timeoutMs?: number | undefined;
  /**
   * 同时在飞的用例数（缺省 1）。
   *
   * 缺省串行的理由不是保守：并发会让「一轮花了多少钱」与「哪个用例贵」这两件事
   * 互相污染 —— 而 RSI 的成本归因全靠这个。要快就显式开，并接受归因变粗。
   */
  readonly concurrency?: number | undefined;
  /** 只对「run 抛出」重试的次数（缺省 0） */
  readonly retries?: number | undefined;
}

/**
 * 只把**给了值**的调优键往下传（显式 `undefined` 与「不传」不同，这里保持同一口径）。
 *
 * 放在这里而不是各调用点各写一份：调优键一旦增加（比如将来的 thinking 预算），
 * 漏传一处就会让「基线与候选用了不同的调优」—— 那正是回归门最怕的不可比，
 * 而它不会报错，只会让结论偏向"变好"。
 */
export function pickTuning(o: SuiteTuning): SuiteTuning {
  return {
    ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
    ...(o.concurrency !== undefined ? { concurrency: o.concurrency } : {}),
    ...(o.retries !== undefined ? { retries: o.retries } : {}),
  };
}

export interface RunSuiteOptions extends SuiteTuning {
  readonly config: HarnessConfig;
  readonly assets: AssetSet;
  readonly agent?: string | undefined;
  /**
   * 换一个「跑用例」的实现（远程服务）。
   *
   * 给了它就跳过本地装配 —— 断言、报告、回归门全部复用，只有「谁来跑」变了。
   * 这是跨服务评测**不长出第二套判据**的唯一做法。
   */
  readonly runner?: CaseRunner | undefined;
  /** 注入模型客户端（测试与重放用）；不传走真实模型 */
  readonly client?: ModelClient | undefined;
  /**
   * 是否把每次评测运行的 trace 落盘（缺省不落）。
   *
   * 缺省不落是纪律：评测会跑几十上百次，落盘会把 `traces.jsonl` 变成垃圾场。
   * 需要回查某条失败用例的链路时显式开，报告里的 `traceId` 才有用。
   */
  readonly keepTraces?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  /** 只跑这些用例（按名） */
  readonly only?: readonly string[] | undefined;
}

export async function runSuite(opts: RunSuiteOptions): Promise<EvalReport> {
  const all = loadEvalCases(opts.config.evalsDir);
  if (all.length === 0) {
    throw new HarnessError(
      'eval.invalid',
      `${opts.config.evalsDir} 下没有用例 —— 没有评测集，RSI 的任何改动都无法被验证`,
    );
  }
  const cases =
    opts.only === undefined ? all : all.filter((c) => opts.only?.includes(c.name) ?? false);
  if (cases.length === 0) {
    throw new HarnessError('eval.invalid', `--only 没有匹配到任何用例: ${opts.only?.join(', ')}`);
  }

  // `as CaseRunner` 不是偷懒：本地 `Runner` 的 `model` 是非可选 `string`，而接口里
  // 是可选的（远程可能报不出来）。exactOptionalPropertyTypes 下这个方向需要显式窄化，
  // 反方向才是危险的那个（可选 → 必填），而这里恰好是安全方向。
  const runner: CaseRunner =
    opts.runner ??
    (createRunner(
      opts.config,
      opts.assets,
      opts.agent,
      opts.keepTraces === true,
    ) as unknown as CaseRunner);
  const limit = Math.max(1, opts.concurrency ?? 1);
  // 有界并发 + 保序直接用上游实现（agentia 公共面导出，边界处理更细）——
  // 结果顺序决定两次跑分的 diff 是不是噪声；本地曾有过一份逐行等价的实现，
  // 那种「改一处漏一处」的重复比复用的耦合贵得多
  const results = await mapWithConcurrency(cases, limit, (c) => runOne(runner, c, opts));
  return summarize(
    results,
    opts.assets.fingerprint,
    `${runner.agent.name}@${runner.agent.version}`,
    {
      // 可比性靠这几个事实判断，缺一条就会把「换了模型 / 改了断言 / 升级了 harness」
      // 读成 agent 的进退步（见 gate.ts 的 case_set_changed 与 model 提示）
      // 远程 runner 报什么模型就写什么；它没报就是 unknown ——
      // 绝不能填本地配置里的模型名（那会让「远程换了模型」在报告里看不出来）
      model:
        opts.runner !== undefined
          ? (opts.runner.model ?? 'unknown')
          : effectiveModel(opts.config, runner.agent as never),
      harnessVersion: harnessVersion(),
      finishedAt: new Date().toISOString(),
      caseFingerprint: caseSetFingerprint(cases),
    },
  );
}

/**
 * 断言引擎在 `evals/check.ts`、单用例执行在 `evals/run-one.ts`
 * （判定标准 / 执行语义 / 整轮编排是三种变化原因，此前挤在一个文件里）。
 *
 * `check` 从这里继续导出：`index.ts` 与既有测试一直从 `run.js` 取它，
 * 为一次内部拆分制造 breaking change 不值当。
 */
export { check } from './check.js';
export { type OneShotOptions, runOne } from './run-one.js';
