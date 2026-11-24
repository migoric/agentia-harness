import { randomUUID } from 'node:crypto';
import {
  InMemorySessionStore,
  isSuccessStopReason,
  type ModelClient,
  type SessionStore,
  type Trace,
} from '@migor/agentia';
import type { AgentAsset, AssetSet } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import { buildApp } from './app.js';
import { costOf, usageReported } from './cost.js';
import { ensureEndpointEnv } from './endpoint.js';
import { modelUsage } from './model-read.js';
import { mergeTraces } from './trace-merge.js';
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
  /**
   * 本次**实际尝试过**的模型（去重、按首次出现序）。
   *
   * 与 `Runner.model`（生效模型）不是一件事：那个是「配了哪个」，这个是「真用了哪些」。
   * 配了 fallback 链时两者在降级发生后就会分叉，而报告的可比性判据要读的正是后者。
   *
   * 可选是因为 `RunOutcome` 也能被外部构造（测试夹具、自定义 Runner）：那种 outcome
   * 没跑过模型，写 `[]` 会让「没记」与「确实一个回合都没跑」变成同一件事。
   */
  readonly models?: readonly string[] | undefined;
  /**
   * 本次发生了几次模型降级（`llm.fallback` 事件数）。缺席语义同 `models`。
   *
   * 0 有两种读法，且都是真的：没配 fallback 链；或者配了但一次没触发。
   * 想区分它们要读根属性 `config.fallbacks`（`modelUsage().declared`）。
   */
  readonly fallbacks?: number | undefined;
  /**
   * 这条用例**计划**跑几轮（单轮缺席）。中途失败中止时它仍是原计划轮数 ——
   * 报告要回答的是「这是不是一条多轮用例」，而「跑到第几轮崩的」由 `failedTurn` 说。
   */
  readonly turns?: number | undefined;
  /** 第一处非正常收尾的轮次（1-based）。全部正常时缺席 */
  readonly failedTurn?: number | undefined;
}

export type CostNote = 'unpriced' | 'unreported';

export interface RunOptions {
  /** 注入模型客户端（评测用脚本客户端；不传给真实模型调用） */
  readonly client?: ModelClient | undefined;
  readonly signal?: AbortSignal | undefined;
  /**
   * 会话接线（只有 `runTurns` 内部会传）。
   *
   * 传它才接历史：agentia 的 `app.run` 明确不消费 `sessionId`（那是给异步宿主的
   * 可序列化引用），只认 `{ store, id }`，且**只在 run 成功收尾时**把消息追加回
   * store —— 失败轮不留历史，这一点直接决定了 `runTurns` 的中止策略。
   */
  readonly session?: { readonly store: SessionStore; readonly id: string } | undefined;
  /**
   * 每跑完一轮就回调一次（**只有 `runTurns` 会调**）。
   *
   * 存在的唯一理由是多轮超时：`Promise.race` 输掉之后整段 `runTurns` 的结果就没了，
   * 但已经跑完的那几轮真花过 token。把它们留在手上，报告才能说「第 3 轮超时，
   * 前两轮花了多少」—— 而不是把多轮用例的成本一律记成 0。
   */
  readonly onTurn?: ((outcome: RunOutcome) => void) | undefined;
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
      ...(opts.session !== undefined ? { session: opts.session } : {}),
    });
    const hits = capabilityHits(result.trace, this.skillNames);
    const mu = modelUsage(result.trace);
    return {
      text: result.finalText,
      ok: isSuccessStopReason(result.stopReason),
      stopReason: result.stopReason,
      iterations: result.iterations,
      trace: result.trace,
      tokens: tokensOf(result.trace),
      // 端点没报计量时 `costEstimate` 是 **0** 而不是 undefined（上游按「0 token × 单价」算），
      // 直接透传会让预算闸以为这一轮免费 —— 所以先问「到底报没报读数」
      costUsd: costOf(result.trace),
      costNote: costNoteOf(result.trace),
      durationMs: Date.now() - started,
      error:
        result.error === undefined
          ? undefined
          : { type: result.error.type, message: result.error.message },
      skills: [...new Set(hits.skills)],
      subagents: [...new Set(hits.subagents)],
      models: mu.models,
      fallbacks: mu.fallbacks,
    };
  }

  /**
   * 跑一段多轮会话。
   *
   * 每轮是一次独立 `app.run`，靠 agentia 的 `InMemorySessionStore` 接历史：第 2 轮起
   * 上游会把已有消息拼在本轮 user 消息**之前**，所以这里每轮只投本轮那一句。
   *
   * 一条刻意的规矩：**中间轮失败就中止**，不再往下跑。
   * 上游只在 `succeeded` 时把消息追加回会话 —— 中间轮崩了，历史里就缺了这一轮，
   * 后面几轮是在一段**真实会话里不会出现**的上下文上作答。那种结果既不能当失败
   * 证据（病根在前面），也不能当通过（它测的不是用户会遇到的事）。
   *
   * 合并后的 trace / 文本 / 成本口径见 `trace-merge.ts` 与本函数的返回说明。
   */
  async runTurns(turns: readonly string[], opts: RunOptions = {}): Promise<RunOutcome> {
    const started = Date.now();
    if (turns.length === 0) throw new Error('runTurns 至少需要一轮');
    // 加载期已经拦过空轮次，但这是**库 API**：绕过 eval 直接调它时也得拦。
    // 发一条空消息在真实会话里不存在，测出来的结论也就无从修起。
    const blank = turns.findIndex((t) => t.trim() === '');
    if (blank !== -1) throw new Error(`runTurns 第 ${blank + 1} 轮是空的`);
    const session = { store: new InMemorySessionStore(), id: `harness-${randomUUID()}` };

    const parts: RunOutcome[] = [];
    let threwAt: number | undefined;
    let thrown: RunOutcome['error'];
    for (const [i, task] of turns.entries()) {
      let part: RunOutcome;
      try {
        part = await this.run(task, { ...opts, session });
      } catch (e) {
        // 单轮抛异常**不放弃整段会话**：前面几轮真花掉的 token 必须留在账上
        // （成本未知不是免费），而且报告要能说清「跑崩在第几轮」。
        // 整段一起抛出去，调用方只会看到 tokens=0、没有轮次 —— 等于把证据烧了。
        threwAt = i;
        thrown = {
          type: e instanceof Error ? e.name : 'Error',
          message: e instanceof Error ? e.message : String(e),
        };
        break;
      }
      parts.push(part);
      opts.onTurn?.(part);
      if (!part.ok && i < turns.length - 1) break;
    }

    const first = parts[0];
    const last = parts[parts.length - 1];
    // 一轮都没跑完（首轮就抛）时没有 trace 可合并 —— 造一条空 trace 而不是让整个
    // 用例变成「run 抛出」：那条路会丢掉 `turns`，报告就看不出这是多轮用例
    const merged = first === undefined ? emptyTrace() : mergeTraces(parts.map((p) => p.trace));
    const hits = capabilityHits(merged, this.skillNames);
    // 模型集合从**合并后**的 trace 读：多轮里第 2 轮降级了，整段会话就跨了两个模型
    const mu = modelUsage(merged);
    // 失败轮次：优先取「跑完了但收尾不正常的」那一轮；一轮都没跑完时取抛异常的那一轮
    const badPart = parts.findIndex((p) => !p.ok);
    const failedIndex = badPart === -1 ? (threwAt ?? -1) : badPart;
    const failed = failedIndex === -1 ? undefined : parts[failedIndex];
    return {
      text: last?.text ?? '',
      ok: failedIndex === -1,
      stopReason:
        failed?.stopReason ?? (failedIndex === -1 ? (last?.stopReason ?? 'end_turn') : 'threw'),
      iterations: parts.reduce((sum, p) => sum + p.iterations, 0),
      trace: merged,
      tokens: tokensOf(merged),
      costUsd: costOf(merged),
      costNote: costNoteOf(merged),
      durationMs: Date.now() - started,
      error: thrown ?? parts.find((p) => p.error !== undefined)?.error,
      skills: [...new Set(hits.skills)],
      subagents: [...new Set(hits.subagents)],
      models: mu.models,
      fallbacks: mu.fallbacks,
      turns: turns.length,
      ...(failedIndex === -1 ? {} : { failedTurn: failedIndex + 1 }),
    };
  }
}

/** 一轮都没跑成时的占位 trace：没有 span、没有用量 —— 下游断言与成本口径照常工作 */
function emptyTrace(): Trace {
  const id = randomUUID();
  return {
    traceId: id,
    rootSpanId: id,
    spans: [],
    status: 'error',
    totalUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  };
}

function tokensOf(trace: Trace): number {
  const u = trace.totalUsage;
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

/** 没有成本读数的两种病因（见 `RunOutcome.costNote`）—— run 与 runTurns 共用一份判定 */
function costNoteOf(trace: Trace): CostNote | undefined {
  if (!usageReported(trace)) return 'unreported';
  return trace.totalUsage.costEstimate === undefined ? 'unpriced' : undefined;
}

export function createRunner(
  config: HarnessConfig,
  assets: AssetSet,
  agentName?: string,
  persistTraces = true,
): Runner {
  // 库入口也要落地 endpoint 段：直接调 createRunner / runCycle 的库用户不走 CLI，
  // 配置里的 baseURL / apiKeyEnv 此前**静默不生效** —— 症状是「主 agent 走得通、
  // 子循环 401」的分裂故障（子循环各自现造默认 client，只读环境变量）。
  // 这里幂等（不覆盖已有环境变量），CLI 已经落过时这次调用什么都不做。
  ensureEndpointEnv(config);
  return new Runner(config, assets, agentName, persistTraces);
}
