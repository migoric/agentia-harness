import { assertEndpointKey, ensureEndpointEnv } from '../run/endpoint.js';
import type { CliContext } from './context.js';

/**
 * 「这条命令要调模型，先把凭据这条腿站稳」。
 *
 * 为什么不是 `cli.ts` 里一次判完就抛：凭据闸曾经排在所有命令逻辑之前，于是
 *
 *     harness rsi --rounds 0        → 报「缺少模型凭据」而不是「--rounds 必须是正整数」
 *     harness eval（工程里没用例）  → 报「缺少模型凭据」而不是「没有评测集」
 *
 * 两种都是「用环境问题掩盖了用法问题」。先配 key、再发现参数还是错的，是一次
 * 真实的排查动作被浪费掉。所以闸挪到命令内部，**每个命令把它放在自己的校验之后、
 * 第一次调模型之前**。
 *
 * `needsModel` 仍由 `cli.ts` 判定（它知道子命令与 `--remote`），这里只负责执行 ——
 * 单个真值来源，不会出现「命令以为自己不需要凭据」的漂移。
 */
export function requireModel(ctx: CliContext): void {
  if (!ctx.needsModel) return;
  ensureEndpointEnv(ctx.config);
  assertEndpointKey(ctx.config);
}
