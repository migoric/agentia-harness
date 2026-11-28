import type { AssetSet } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import { effectiveModel } from '../run/app.js';
import { balanceUrlOf } from '../run/balance.js';
import { unpricedHint } from '../run/endpoint.js';

export interface BudgetGuardInput {
  readonly config: HarnessConfig;
  readonly assets: AssetSet;
  readonly agent?: string | undefined;
  readonly maxCostUsd?: number | undefined;
  readonly maxTokens?: number | undefined;
  /**
   * 远程模式：跑在**服务上**，模型由对方决定，本地预检拿不到准确的名字。
   *
   * 此时不做硬拦（误伤一个配好了 pricing 的工程比放过更糟），只提示一句：
   * 真的未定价时，基线跑完那一刻就会按 `blind` 停下 —— 代价是一次基线。
   */
  readonly remote?: boolean | undefined;
}

/**
 * 开跑前的预算闸体检：**设了 `--max-cost` 就必须真的有闸**。
 *
 * 这条检查存在的原因是一次真实的静默失效：DeepSeek 之类的模型不在价格表里，
 * `costUsd` 于是不可信，而旧实现让美元闸在不可信时直接判「没超」——
 * 用户带着 `--max-cost 5` 跑完，花了多少完全不受控，报告里也不报错，
 * 只是少了个 `$` 号。
 *
 * 几条出路（按推荐顺序写进报错文案）：
 * 1. 配 `pricing`：最直接，但**只在同一计价时段内准**（分时计价的端点 peak 是
 *    off-peak 的两倍，一份配置只能对一半时间）；
 * 2. 余额对账：真实扣费，与单价无关 —— DeepSeek 端点自动开，其它网关配 `balance.url`。
 *    这是未定价模型的正解，所以它在**下面会被单独判一次**：能对账就不算盲区、直接放行；
 * 3. 换 `--max-tokens`（不查价格表，永远可信，代价是不太直观）；
 * 4. 干脆别设 `--max-cost`（不承诺闸，也就不会假装有闸）。
 *
 * 返回一句提示（远程模式无法预判时），或者抛错（本地已确认闸会瞎）。
 */
export function assertBudgetEnforceable(input: BudgetGuardInput): string | undefined {
  const { config, assets, maxCostUsd, maxTokens } = input;
  // 没设美元上限 = 没承诺闸；设了 token 闸 = 有兜底。两种情况都不必检查
  if (maxCostUsd === undefined || maxTokens !== undefined) return undefined;

  if (input.remote === true) {
    return (
      '远程模式下模型由服务决定，本地无法确认是否已定价 —— ' +
      '若远端模型不在价格表里，基线跑完就会按「闸读不出成本」停下（只浪费一次基线）。' +
      '想一次跑通：本地 pricing 里写上远端模型的单价，或者加 --max-tokens 兜底。\n' +
      '  （余额对账对远程不适用：那笔钱计在服务方的账户上，本地 key 读不到。）'
    );
  }

  const agent = pickAgent(assets, input.agent);
  // 找不到 agent（多个候选未指定）时交给下游报错 —— 这里猜一个模型名去拦，
  // 拦错一次就足以让人把这条检查当成噪声
  if (agent === undefined) return undefined;
  const model = effectiveModel(config, agent);
  const hint = unpricedHint(config, model);
  if (hint === undefined) return undefined;

  /**
   * 未定价，但**端点读得到余额** —— 这时闸不是瞎的，硬拦就错了。
   *
   * 这是这套机制最重要的一处判断：单价缺失只意味着「估算不可用」，不意味着
   * 「账单不可知」。跑前余额 − 跑后余额与单价无关，而 DeepSeek 这类端点的单价
   * 本身还分时段，估算从来就没准过。所以从「拦住不让跑」降级成「说清楚口径」。
   *
   * 仍要提示粒度的差别：对账发生在**阶段边界**，不是每次模型调用之前。
   */
  if (balanceUrlOf(config) !== undefined) {
    return (
      `模型 "${model}" 不在价格表里 —— 估算不可用，但这个端点支持余额查询：` +
      '本轮按**真实扣费**对账（每个阶段结束后读一次余额差额），`--max-cost` 仍然生效。' +
      '粒度是阶段边界，不是单次调用；余额接口本身挂掉时会退回 blind 停机。'
    );
  }

  throw new HarnessError(
    'config.invalid',
    `${hint}\n` +
      '也就是说：你设了 --max-cost，但这个闸此刻读不出成本，一分钱也拦不住。几条出路：\n' +
      '  1. 配单价：harness.config.json 的 "pricing" 段写上该模型的 in/out\n' +
      '     （注意分时计价的端点单价随时段变，估算只在同一时段内准）；\n' +
      '  2. 改用余额对账：端点是 DeepSeek 时本仓会自动开，其它网关写 "balance": { "url": … }\n' +
      '     —— 真实扣费，与单价无关，粒度是阶段；\n' +
      '  3. 换 token 闸：--max-tokens <n>（token 数不查价格表，永远可信）；\n' +
      '  4. 不设 --max-cost —— 但不设就等于承认没有闸，别留着它以为有保护。',
  );
}

function pickAgent(assets: AssetSet, wanted: string | undefined) {
  if (wanted !== undefined) return assets.agents.find((a) => a.name === wanted);
  return assets.agents.length === 1 ? assets.agents[0] : undefined;
}
