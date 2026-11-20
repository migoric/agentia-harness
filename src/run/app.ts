import { AgentApp, jsonlTraceSink, SystemPrompt, type TraceSink } from '@migor/agentia';
import type { AgentAsset, AssetSet } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import { buildTools } from './tools.js';

/**
 * 装配：资产集 → 一个可跑的 `AgentApp`。
 *
 * 装配是**纯的**（同样的资产集装配出同样的 app），这让评测与 RSI 验证可以放心
 * 反复装配 —— 不会因为「这次装配多挂了什么」而让两次跑分不可比。
 *
 * 归因字段是本文件存在的主要理由之一：每一条 run 都带上
 * `harness.assets`（全体资产指纹）与 `harness.agent`（`name@version`），
 * 于是「昨天通过率掉了」可以**先看资产是否变了**，而不是先怀疑模型。
 */
export interface BuiltApp {
  readonly app: AgentApp;
  readonly agent: AgentAsset;
}

export interface BuildAppOptions {
  readonly config: HarnessConfig;
  readonly assets: AssetSet;
  /** 指定用哪个 agent 资产；不指定时要求恰好只有一个 */
  readonly agent?: string | undefined;
  /** 额外 sink（评测时用来拿内存里的 trace） */
  readonly extraSinks?: readonly TraceSink[] | undefined;
  /** 是否落 JSONL（评测反复跑时关掉，避免把 traces 撑爆） */
  readonly persistTraces?: boolean | undefined;
}

export function buildApp(opts: BuildAppOptions): BuiltApp {
  const agent = pickAgent(opts.assets, opts.agent);
  const system = new SystemPrompt({ version: agent.version }).add('role', agent.body);

  const sinks: TraceSink[] = [];
  if (opts.persistTraces !== false) {
    sinks.push(jsonlTraceSink({ path: opts.config.tracesPath }));
  }
  sinks.push(...(opts.extraSinks ?? []));

  const model = opts.config.model ?? agent.model;
  const maxIterations = opts.config.maxIterations ?? agent.maxIterations;
  const maxCostUsd = opts.config.maxCostUsd ?? agent.maxCostUsd;

  const app = new AgentApp({
    name: opts.config.appName,
    system,
    tools: buildTools(agent, opts.assets),
    labels: {
      'harness.assets': opts.assets.fingerprint,
      'harness.agent': `${agent.name}@${agent.version}`,
      'harness.agent.fingerprint': agent.fingerprint,
    },
    traceContent: 'full',
    ...(model !== undefined ? { model } : {}),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    sinks,
  });

  return { app, agent };
}

function pickAgent(assets: AssetSet, wanted: string | undefined): AgentAsset {
  if (wanted !== undefined) {
    const hit = assets.agents.find((a) => a.name === wanted);
    if (hit === undefined) {
      const available =
        assets.agents
          .map((a) => a.name)
          .sort()
          .join(', ') || '无';
      throw new HarnessError(
        'asset.missing',
        `找不到 agent 资产 "${wanted}"（可用: ${available}）—— 一个工程至少要有一个 agents/*.md`,
      );
    }
    return hit;
  }
  const only = assets.agents[0];
  if (only === undefined) {
    throw new HarnessError(
      'asset.missing',
      '没有任何 agent 资产 —— 请在 agents/ 下放一个 .md（frontmatter 需 description，正文即 system）',
    );
  }
  if (assets.agents.length > 1) {
    const names = assets.agents
      .map((a) => a.name)
      .sort()
      .join(', ');
    throw new HarnessError(
      'asset.invalid',
      `有 ${assets.agents.length} 个 agent 资产（${names}），必须用 --agent 指定其中一个`,
    );
  }
  return only;
}
