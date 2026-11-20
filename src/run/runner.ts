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
  /**
   * 没有成本读数时**为什么**没有 —— 两种病因的处理完全不同，别混成一句「没读数」：
   * - `unpriced`：模型不在价格表里（改配置的 `pricing` 段）；
   * - `unreported`：端点根本没报 token 计量（改不了配置，得看端点的 usage 行为）。
   */
  readonly costNote: CostNote | undefined;
  readonly durationMs: number;
  readonly error: { readonly type: string; readonly message: string } | undefined;
  /** 本次实际调用过的技能（去重、按首次出现序） */
  readonly skills: readonly string[];
  /** 本次实际委派过的子 agent（去重） */
  readonly subagents: readonly string[];
}

/**
 * 上游「这一回合没报 usage」的事件名（`USAGE_MISSING_EVENT`）。
 *
 * 写字面量而不是 import：agentia 的公共导出面里没有它（与 `tool.input` 同款处境）。
 * 风险同样是「上游改名 ⇒ 静默读不到」，防线也只有同一条：`tests/evals.test.ts` 用
 * **真实调用产生的 trace** 断言这个事件在读不到 usage 时确实出现，改名会立刻红。
 */
const USAGE_MISSING_EVENT = 'usage.missing';

export type CostNote = 'unpriced' | 'unreported';

/**
 * 这一轮里有没有回合「根本没报计量」。
 *
 * 为什么必须单独问一次：模型**在价格表里**时，上游拿「0 token × 单价」算出
 * `costEstimate = 0` —— 与「真的免费」是一个数。不区分的话 `costKnown` 会判成 true，
 * 预算闸与回归门就都静默失效了。这一条只有走真实 HTTP 客户端 + 端点不回 usage
 * 才会暴露，`scriptedClient` 因为压根不带 usage 字段，走的是另一条（本来就 undefined）的路径。
 */
function usageReported(trace: Trace): boolean {
  for (const span of trace.spans) {
    for (const e of span.events) {
      if (e.name === USAGE_MISSING_EVENT) return false;
    }
  }
  return true;
}

export interface RunOptions {
  /** 注入模型客户端（评测用脚本客户端；不传给真实模型调用） */
  readonly client?: ModelClient | undefined;
  readonly signal?: AbortSignal | undefined;
}

export class Runner {
  readonly agent: AgentAsset;
  /** 生效的模型名 —— `harness run` 用它判断「这个模型有没有定价」 */
  readonly model: string;
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
    this.model = this.built.model;
    this.skillNames = new Set(assets.skills.map((s) => s.name));
  }

  async run(task: string, opts: RunOptions = {}): Promise<RunOutcome> {
    const started = Date.now();
    const { result } = await this.built.app.run([{ role: 'user', content: task }], {
      ...(opts.client !== undefined ? { client: opts.client } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    const u = result.trace.totalUsage;
    const reported = usageReported(result.trace);
    const costNote: CostNote | undefined = reported
      ? u.costEstimate === undefined
        ? 'unpriced'
        : undefined
      : 'unreported';
    const hits = capabilityHits(result.trace, this.skillNames);
    return {
      text: result.finalText,
      ok: isSuccessStopReason(result.stopReason),
      stopReason: result.stopReason,
      iterations: result.iterations,
      trace: result.trace,
      tokens: u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens,
      // 端点没报计量时 `costEstimate` 是 **0** 而不是 undefined（上游按「0 token × 单价」算），
      // 直接透传会让预算闸以为这一轮免费 —— 所以先问「到底报没报读数」
      costUsd: costNote === undefined ? u.costEstimate : undefined,
      costNote,
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
