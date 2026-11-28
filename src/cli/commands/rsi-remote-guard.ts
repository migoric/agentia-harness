import { HarnessError } from '../../errors.js';
import { strFlag } from '../args.js';
import type { CliContext } from '../context.js';

/**
 * `rsi --remote` 为什么不能有 —— 这不是「还没做」，是**结构上无效**。
 *
 * RSI 的一轮是「改资产 → 用改过的资产重跑 → 比较」。`verifyProposal` 把补丁打进
 * 内存里的 `AssetSet`，再交给 `runSuite({ assets: patched })` —— 补丁的**唯一**生效
 * 路径就是「这同一份资产被拿去跑」。换成远程 runner 之后，`assets` 参数对远程毫无
 * 作用：对方的提示词是它自己的（`service.json` 的 agent 在 `src/agents/*.ts` 里
 * `build()` 出 `system`，随后被烤进镜像）。
 *
 * 于是候选跑与基线跑测的是**同一份东西**，差别只剩模型自己的随机性。两种情况都坏：
 * - 通常：`passRateDelta = 0`、`fixedCases = []` ⇒ 每个提案都被拒，RSI 空转烧钱；
 * - 偶尔：某条用例因噪声翻绿 ⇒ 被当成「修好了」写进磁盘，而那个改动**从没被验证过**。
 *   这是最坏的形状：RSI 退化成提示词随机搜索，账本里还留着看起来很正规的记录。
 *
 * 真要打通，前提在 service 侧而不是这里：让 agent 的提示词来自**文件**（而不是代码
 * 里的 `system`），并与 harness 的资产目录共用同一个卷、改完能触发重载。那之后
 * `rsi --remote` 才有意义，届时这个函数改成「检查 `--remote` 指向的服务是否声明了
 * 资产目录」即可，不要直接删掉。
 */
export function rejectRemote(ctx: CliContext): void {
  if (strFlag(ctx.flags, 'remote') === undefined) return;
  throw new HarnessError(
    'config.invalid',
    [
      '`rsi` 不能用 --remote：RSI 的一轮是「改资产 → 用改过的资产重跑 → 比较」，',
      '而远程服务的提示词属于它自己，改本地文件对它的行为零影响。',
      '那样跑出来的候选与基线测的是同一份东西：通常每个提案都被判「没改善」（空转烧钱），',
      '偶尔某条用例因噪声翻绿被当成「修好了」写进磁盘——而那个改动从没被真正验证。',
      '',
      '想测远程服务用 `harness eval --remote <url>`（它只测、不改资产，语义是对的）。',
      '',
      'service 侧的前提已经具备（提示词来自文件 + prompts 挂卷 + /admin/reload 原子换表，',
      '2026-11-28）。剩下的是 harness 侧的两阶段提交：候选必须先写盘才可能被远程看见，',
      '于是需要 pending 记录、拒绝时还原、以及「写盘后被杀」的崩溃回收。',
      '见 docs/rsi.md「为什么 rsi 还没有 --remote」。',
    ].join('\n'),
  );
}
