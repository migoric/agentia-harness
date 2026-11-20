import type { ModelClient, Trace } from '@migor/agentia';
import { isSuccessStopReason } from '@migor/agentia';
import type { AgentAsset, AssetSet } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import { buildApp } from './app.js';

/**
 * 跑一次任务 —— harness 里所有东西（评测、RSI 验证、CLI、server）都走这一条路。
 *
 * 只有一条路是刻意的：如果评测走一条、线上走另一条，那评测就证明不了线上什么。
 * 差别全部收进 `RunOptions`（模型客户端、是否落 trace），而**装配与循环完全一致**。
 */
export interface RunOutcome {
  /** 正常收尾的最终文本；非正常收尾时为空串 */
  readonly text: string;
  readonly ok: boolean;
  readonly stopReason: string;
  readonly iterations: number;
  /** 完整调用树（评分、归因、导出都读它） */
  readonly trace: Trace;
  /** input + output + cache 相关 token 的总和 —— 成本的可比代理 */
  readonly tokens: number;
  readonly durationMs: number;
  readonly error: { readonly type: string; readonly message: string } | undefined;
}

export interface RunOptions {
  /** 注入模型客户端（评测用脚本客户端；不传给真实模型调用） */
  readonly client?: ModelClient | undefined;
  readonly signal?: AbortSignal | undefined;
}

export class Runner {
  readonly agent: AgentAsset;
  private readonly built: ReturnType<typeof buildApp>;

  constructor(
    config: HarnessConfig,
    assets: AssetSet,
    agentName?: string,
    /** 是否把 trace 落到 `traces.jsonl`（评测反复跑时关掉） */
    persistTraces = true,
  ) {
    this.built = buildApp({ config, assets, agent: agentName, persistTraces });
    this.agent = this.built.agent;
  }

  async run(task: string, opts: RunOptions = {}): Promise<RunOutcome> {
    const started = Date.now();
    const { result } = await this.built.app.run([{ role: 'user', content: task }], {
      ...(opts.client !== undefined ? { client: opts.client } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    const u = result.trace.totalUsage;
    return {
      text: result.finalText,
      ok: isSuccessStopReason(result.stopReason),
      stopReason: result.stopReason,
      iterations: result.iterations,
      trace: result.trace,
      tokens: u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens,
      durationMs: Date.now() - started,
      error:
        result.error === undefined
          ? undefined
          : { type: result.error.type, message: result.error.message },
    };
  }
}

export function createRunner(
  config: HarnessConfig,
  assets: AssetSet,
  agentName?: string,
  persistTraces = true,
): Runner {
  return new Runner(config, assets, agentName, persistTraces);
}
