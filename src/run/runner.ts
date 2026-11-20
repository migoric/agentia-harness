import type { ModelClient, Trace } from '@migor/agentia';
import { isSuccessStopReason } from '@migor/agentia';
import type { AgentAsset, AssetSet } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import { buildApp } from './app.js';
import { capabilityHits } from './trace-read.js';

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
  /**
   * 本次运行的美元成本（来自 `trace.totalUsage.costEstimate`）；`undefined` = 无读数。
   *
   * 不用 `0` 表示「没读数」：agentia 对**不在价格表内**的模型给 `undefined`，
   * 而那与「脚本客户端真没花钱」是两件事。回归门要靠这个区分决定用成本还是
   * token 判「没变好还更贵」—— 把两者混成一个 0，预算判据就静默失效了。
   */
  readonly costUsd: number | undefined;
  readonly durationMs: number;
  readonly error: { readonly type: string; readonly message: string } | undefined;
  /** 本次实际调用过的技能（去重、按首次出现序） */
  readonly skills: readonly string[];
  /** 本次实际委派过的子 agent（去重） */
  readonly subagents: readonly string[];
}

export interface RunOptions {
  /** 注入模型客户端（评测用脚本客户端；不传给真实模型调用） */
  readonly client?: ModelClient | undefined;
  readonly signal?: AbortSignal | undefined;
}

export class Runner {
  readonly agent: AgentAsset;
  private readonly built: ReturnType<typeof buildApp>;
  private readonly skillNames: ReadonlySet<string>;

  constructor(
    config: HarnessConfig,
    assets: AssetSet,
    agentName?: string,
    /** 是否把 trace 落到 `traces.jsonl`（评测反复跑时关掉） */
    persistTraces = true,
  ) {
    this.built = buildApp({ config, assets, agent: agentName, persistTraces });
    this.agent = this.built.agent;
    this.skillNames = new Set(assets.skills.map((s) => s.name));
  }

  async run(task: string, opts: RunOptions = {}): Promise<RunOutcome> {
    const started = Date.now();
    const { result } = await this.built.app.run([{ role: 'user', content: task }], {
      ...(opts.client !== undefined ? { client: opts.client } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    const u = result.trace.totalUsage;
    const hits = capabilityHits(result.trace, this.skillNames);
    return {
      text: result.finalText,
      ok: isSuccessStopReason(result.stopReason),
      stopReason: result.stopReason,
      iterations: result.iterations,
      trace: result.trace,
      tokens: u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens,
      costUsd: u.costEstimate ?? undefined,
      durationMs: Date.now() - started,
      error:
        result.error === undefined
          ? undefined
          : { type: result.error.type, message: result.error.message },
      skills: [...new Set(hits.skills)],
      subagents: [...new Set(hits.subagents)],
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
