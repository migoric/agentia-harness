import { discoverAssets } from '../assets/discover.js';
import type { AssetSet } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import type { Flags } from './args.js';

/**
 * 命令之间共享的上下文。
 *
 * 资产**每次命令重新发现**，不做进程内缓存：RSI 会在一次会话里改写磁盘（采纳），
 * 缓存一份就等于让后续命令看着旧文件干活，而那种偏差看起来会像「采纳没生效」。
 */
export interface CliContext {
  readonly root: string;
  readonly config: HarnessConfig;
  readonly flags: Flags;
  /** `--agent`；只在工程里有多个 agent 时需要 */
  readonly agent: string | undefined;
  /**
   * 这条命令会不会在本地调模型 —— 也就是**需不需要凭据**。
   *
   * 由 `cli.ts` 统一判定（它知道子命令与 `--remote`），但**检查动作由命令自己做**：
   * 凭据闸必须排在「命令自己的用法校验」之后，否则 `--rounds 0` 会先被告知「缺 key」，
   * 人配完 key 才发现参数还是错的。见 `cli/require-model.ts`。
   */
  readonly needsModel: boolean;
}

export function assetsOf(ctx: CliContext): AssetSet {
  return discoverAssets({ skills: ctx.config.skillsDir, agents: ctx.config.agentsDir });
}
