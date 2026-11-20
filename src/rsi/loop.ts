import type { ModelClient } from '@migor/agentia';
import type { AssetSet } from '../assets/types.js';
import type { HarnessConfig } from '../config.js';
import type { GateOptions } from '../evals/gate.js';
import { runSuite } from '../evals/run.js';
import { acceptProposal } from './accept.js';
import { attribute, collectFailures } from './attribute.js';
import type { Proposer } from './propose.js';
import type { CycleReport, Proposal, VerifyOutcome } from './types.js';
import { verifyProposal } from './verify.js';

/**
 * 一轮 RSI —— 五步编排。
 *
 * 一条**刻意写死**的规则：**一轮最多采纳一个提案**。
 *
 * 理由不是保守，是可归因性：同时采纳三个改动，评测从 70% 涨到 85%，没人知道是
 * 哪一个（或哪个组合）起的作用。下一轮再坏回去时，你也无法定位。单变量是唯一
 * 能让「采纳记录」变成可信知识的做法 —— 而可信知识正是 RSI 唯一有价值的产出。
 *
 * 代价是慢：一次只能试一个。这个代价是值的，因为 RSI 最贵的不是算力，是
 * **人重新信任一套自己看不懂的提示词**。
 */
export interface CycleOptions {
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
}

export async function runCycle(opts: CycleOptions): Promise<CycleReport> {
  const baseline = await runSuite({
    config: opts.config,
    assets: opts.assets,
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.client !== undefined ? { client: opts.client } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });

  const samples = collectFailures(baseline);
  if (samples.length === 0) {
    return { modes: [], proposals: [], verified: [], accepted: [], rejected: [], baseline };
  }

  const modes = attribute(samples);
  const proposals = await opts.proposer.propose({
    modes,
    assets: opts.assets,
    config: opts.config,
    ...(opts.client !== undefined ? { client: opts.client } : {}),
  });

  const maxVerify = opts.maxVerify ?? 3;
  const verified: VerifyOutcome[] = [];
  const accepted: Proposal[] = [];
  const rejected: { proposal: Proposal; reason: string }[] = [];
  let committed = false;

  for (const proposal of proposals.slice(0, maxVerify)) {
    if (committed) {
      rejected.push({ proposal, reason: '本轮已采纳另一个提案（单变量原则），下一轮再试' });
      continue;
    }
    let outcome: VerifyOutcome;
    try {
      outcome = await verifyProposal({
        config: opts.config,
        assets: opts.assets,
        baseline,
        proposal,
        ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
        ...(opts.client !== undefined ? { client: opts.client } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(opts.gateOptions !== undefined ? { gateOptions: opts.gateOptions } : {}),
      });
    } catch (e) {
      // 验证本身失败（补丁过期、装配错）不该让整轮崩掉：记下来，下一个提案继续
      rejected.push({
        proposal,
        reason: `验证失败: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    verified.push(outcome);

    if (!outcome.gate.ok) {
      rejected.push({ proposal, reason: outcome.gate.reason });
      continue;
    }
    if (outcome.gate.fixedCases.length === 0 && outcome.gate.passRateDelta === 0) {
      // 门放行但没有任何用例变好：这只是「没变坏」，不值得落盘（会污染 git 历史）
      rejected.push({ proposal, reason: '没有任何用例变好（仅"没变差"，不值得改动资产）' });
      continue;
    }
    if (opts.dryRun === true) {
      accepted.push(proposal);
      committed = true;
      continue;
    }
    acceptProposal(opts.config, opts.assets, outcome);
    accepted.push(proposal);
    committed = true;
  }

  for (const proposal of proposals.slice(maxVerify)) {
    rejected.push({ proposal, reason: `超过本轮验证上限（${maxVerify}），下一轮再试` });
  }

  return { modes, proposals, verified, accepted, rejected, baseline };
}
