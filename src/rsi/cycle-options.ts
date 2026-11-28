/**
 * 一轮 RSI 的入参。
 *
 * 从 `loop.ts` 拆出来的理由只有一个：那个文件编排了五步、还要写清每步的失败语义，
 * 400 行守卫已经顶到头；而选项**只描述输入的形状**，不参与编排，整块搬走零风险。
 */

import type { ModelClient } from '@migor/agentia';
import type { AssetSet } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import type { GateOptions } from '../evals/gate.js';
import type { SuiteTuning } from '../evals/run.js';
import type { CaseRunner } from '../run/case-runner.js';
import type { Proposer } from './propose.js';
import type { ShrinkPolicy } from './shrink.js';
import type { StageHook } from './types.js';

export interface CycleOptions extends SuiteTuning {
  readonly config: HarnessConfig;
  readonly assets: AssetSet;
  readonly agent?: string | undefined;
  readonly client?: ModelClient | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly proposer: Proposer;
  readonly gateOptions?: GateOptions | undefined;
  /** 只验证不落盘（人审模式） */
  readonly dryRun?: boolean | undefined;
  /** 最多验证几个提案（超过的不跑评测，省成本） */
  readonly maxVerify?: number | undefined;
  /**
   * 成本上限（美元）。超了就提前收工并如实记进记录。
   *
   * 口径是**整次运行**，不是本轮：`--rounds` 连跑时上限只在整段运行上生效
   * （`priorSpentUsd` 把前几轮的花费累加进来）。每轮各自重置的话，
   * `--rounds 5 --max-cost 1` 会花掉 5 美元 —— 而配置里写的是一个数。
   *
   * 与 `maxVerify` 是两个维度：那个限制**次数**，这个限制**钱**。设了上限后，
   * 第一遍基线跑完就可能已经超了 —— 此时连提案都不必提，那一步也烧钱。
   */
  readonly maxCostUsd?: number | undefined;
  /**
   * token 上限（`--max-tokens`）。美元闸在读不出成本时是瞎的，这是那个死角里的兜底。
   *
   * 为什么需要它：`maxCostUsd` 只在成本**可信**时生效（模型不在价格表里 ⇒ 读数不可信），
   * 于是「给 DeepSeek 设 `--max-cost`」曾经什么也拦不住。token 数不查价格表，
   * 永远可信。口径同样是整次运行（`priorTokens` 累加）。
   *
   * 只设美元闸、又读不出成本 ⇒ 直接判 `blind` 停下（见 `budget.ts`），不允许静默放行。
   */
  readonly maxTokens?: number | undefined;
  /**
   * 本轮之前已经花掉的钱（`--rounds` 连续跑时由调用方累加）。
   *
   * 只影响预算闸与 `budget.spentUsd` 的口径；本轮 `costUsd` 仍然只算这一轮 ——
   * 把「这次花了多少」与「一共花了多少」混成一个数，看记录的人就无法判断
   * 「第 3 轮是不是特别贵」。
   */
  readonly priorSpentUsd?: number | undefined;
  /** 本轮之前已经用掉的 token（与 `priorSpentUsd` 同一条口径） */
  readonly priorTokens?: number | undefined;
  /**
   * 采纳成功后把**新的资产集**交回调用方。
   *
   * 为什么不从 `CycleReport` 里带出来：报告要 JSON 落盘，`AssetSet` 是内存对象
   * （含每个资产的正文字节）。也不让调用方重新 `discoverAssets` 一遍：那等于让
   * 调用方替实现兜底，而且多一轮磁盘扫描。回调是最小接口。
   */
  readonly onAcceptedAssets?: ((assets: AssetSet) => void | Promise<void>) | undefined;
  /**
   * 净简化配额的阈值。缺省：每 5 条改动 / 累计成本涨 50% 就要求一轮只许删与合并。
   *
   * 放在选项里而不是配置里，理由是它属于**调度**而不是工程事实：同一套资产，
   * CI 里想更激进（every: 2）时不必改仓库里的文件。缺省值就是推荐值。
   */
  readonly shrinkPolicy?: ShrinkPolicy | undefined;
  /**
   * 远程 stage 钩子（本地不传）。给了它就把候选写到远端服务读的文件里再跑。
   *
   * 与 `runner` 必须成对出现：只给 stage 不给 runner，等于把候选搬上台却仍然跑本地；
   * 只给 runner 不给 stage，等于远程跑的是**旧提示词**（那正是这条路以前结构性无效的原因）。
   * 两者的配对由 CLI 保证，这里不做二次校验 —— 但注释写清楚，免得有人只接一半。
   */
  readonly stage?: StageHook | undefined;
  readonly runner?: CaseRunner | undefined;
  /**
   * 这个目标能不能被「真正验证」—— 不传 = 都能（本地跑）。
   *
   * 远程模式传「`remote.prompts` 里有映射」：服务只有一份活提示词，改一个没有文件映射的
   * 目标等于**验证一份远端不会读的提示词**，通过率再好看也是假的。拒绝要发生在花钱之前，
   * 所以它是一道提案过滤器，而不是 stage 阶段的报错（那时评测已经跑完了）。
   */
  readonly allowedTargets?: ((target: string) => boolean) | undefined;
}
