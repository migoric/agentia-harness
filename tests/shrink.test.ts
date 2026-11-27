import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scriptedClient } from '@migor/agentia';
import { discoverAssets } from '../src/assets/discover.ts';
import { loadConfig } from '../src/config.ts';
import { gate } from '../src/evals/gate.ts';
import { type CaseResult, summarize } from '../src/evals/types.ts';
import type { CycleRecord } from '../src/rsi/cycles.ts';
import { runCycle } from '../src/rsi/loop.ts';
import { type Proposer, renderShrink } from '../src/rsi/propose.ts';
import {
  isShrinkPatch,
  partitionForShrink,
  type ShrinkState,
  shrinkStateOf,
  sizeDelta,
} from '../src/rsi/shrink.ts';
import type { AssetPatch, Proposal, VerifyOutcome } from '../src/rsi/types.ts';
import { isWorthAccepting } from '../src/rsi/verify.ts';

/**
 * 净简化配额 —— 给「成本只涨不跌」的棘轮装刹车。
 *
 * 被守住的四件事：
 * - 触发：连续 N 条改动没变小 / 累计成本涨超阈值 ⇒ 这一轮只许删；
 * - 验收：简化轮的「不变差但更小」算值得（平时明确不算），但必须**确实变小**；
 * - 顺序：变胖的提案在**花钱验证之前**就被挡下；
 * - 复位：一条被采纳的净简化把两个计数一起归零（配额兑现）。
 */

const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function endTurn(text: string) {
  return {
    id: 'm',
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    usage: USAGE,
    content: [{ type: 'text', text }],
  };
}

function res(name: string, passed: boolean): CaseResult {
  return {
    name,
    task: name,
    passed,
    failures: passed ? [] : ['断言失败'],
    tokens: 100,
    costUsd: 0.01,
    iterations: 1,
    durationMs: 1,
    stopReason: 'end_turn',
    excerpt: '',
    skills: [],
    subagents: [],
  };
}

function proposalOf(id: string, patch: AssetPatch): Proposal {
  return { id, modeId: 'm', kind: 'wrong_answer', rationale: 'r', layer: 'L1', patch };
}

/** 造一条历史记录：采纳了哪些提案、各自的门读数是多少 */
function record(
  entries: readonly {
    patch: AssetPatch;
    costDelta?: number | undefined;
    tokenDelta?: number | undefined;
  }[],
  /** false = 采纳了但找不到验证记录（老数据 / 手写记录），用来验「不知道」那档 */
  verified = true,
): CycleRecord {
  const accepted = entries.map((e, i) => proposalOf(`p${i}`, e.patch));
  return {
    path: `/x/${entries.length}.json`,
    schemaVersion: 3,
    cycleId: `c${entries.length}`,
    at: '2026-11-27T00:00:00.000Z',
    timeMs: entries.length,
    dryRun: false,
    verified: verified
      ? entries.map((e, i) => {
          const base = summarize([res('a', true)], 'fp1', 'main@1');
          const cand = summarize([res('a', true)], 'fp2', 'main@1');
          return {
            proposal: proposalOf(`p${i}`, e.patch),
            baseline: base,
            candidate: cand,
            gate: {
              ...gate(base, cand),
              costDelta: e.costDelta,
              tokenDelta: e.tokenDelta ?? e.costDelta ?? 0,
            },
          } satisfies VerifyOutcome;
        })
      : [],
    accepted,
  };
}

const GROW = (n: number): AssetPatch => ({
  target: 'agent:main',
  before: '你是执行者。',
  after: `你是执行者。${'补充说明。'.repeat(n)}`,
});

const SHRINK: AssetPatch = {
  target: 'agent:main',
  before: `你是执行者。${'补充说明。'.repeat(6)}`,
  after: '你是执行者。',
};

describe('净简化 —— 判据', () => {
  it('净减少 5% 才算；只删一个字不算（配额不能被最小化成一枚印章）', () => {
    assert.equal(isShrinkPatch(SHRINK), true);
    assert.equal(isShrinkPatch(GROW(1)), false);
    assert.equal(
      isShrinkPatch({ target: 'agent:main', before: 'a'.repeat(100), after: 'a'.repeat(96) }),
      false,
    );
    assert.equal(
      isShrinkPatch({ target: 'agent:main', before: 'a'.repeat(100), after: 'a'.repeat(95) }),
      true,
    );
    // 空正文是非法补丁（`applyPatch` 自己会拒），不该被当成"最大化简化"
    assert.equal(isShrinkPatch({ target: 'agent:main', before: '', after: '' }), false);
  });

  it('sizeDelta 给出人话口径（负数 = 变短）', () => {
    const d = sizeDelta({ target: 'agent:main', before: 'abcd', after: 'ab' });
    assert.deepEqual(d, { before: 4, after: 2, delta: -2 });
  });
});

describe('净简化 —— 触发条件', () => {
  it('历史为空：不需要简化', () => {
    const s = shrinkStateOf([]);
    assert.equal(s.required, false);
    assert.equal(s.reason, undefined);
    assert.equal(s.sinceShrink, 0);
  });

  it('连续 N 条改动没变小 ⇒ 触发；理由说清是"第几条"', () => {
    const s = shrinkStateOf([record([{ patch: GROW(1) }]), record([{ patch: GROW(2) }])], {
      every: 2,
    });
    assert.equal(s.sinceShrink, 2);
    assert.equal(s.required, true);
    assert.match(s.reason ?? '', /已采纳 2 条改动/);
  });

  it('累计成本涨超阈值也触发（读数缺失时靠条数兜底）', () => {
    const cost = shrinkStateOf(
      [
        record([
          { patch: GROW(1), costDelta: 0.3 },
          { patch: GROW(2), costDelta: 0.25 },
        ]),
      ],
      { every: 99, maxGrowth: 0.5 },
    );
    assert.equal(cost.required, true);
    assert.ok(Math.abs(cost.growth - 0.55) < 1e-9);
    assert.equal(cost.basis, 'cost');

    // 成本不可比（未定价模型）时退回 token —— 与门同一个口径，并把 basis 记下来
    const viaTokens = shrinkStateOf([record([{ patch: GROW(1), tokenDelta: 0.8 }])], {
      every: 99,
      maxGrowth: 0.5,
    });
    assert.equal(viaTokens.required, true);
    assert.equal(viaTokens.basis, 'tokens');

    // 连验证记录都没有（老数据）：增幅算不出来，只能报"不知道"，靠条数兜底
    const noReadings = shrinkStateOf([record([{ patch: GROW(1) }], false)], {
      every: 99,
      maxGrowth: 0.5,
    });
    assert.equal(noReadings.required, false, '没有读数就不该靠"猜的成本"触发');
    assert.equal(noReadings.basis, 'unknown');
    assert.equal(noReadings.sinceShrink, 1, '条数照样数得出来 —— 这就是兜底');
  });

  it('dry-run 的采纳不算数：资产没动过，配额就不该往前推', () => {
    const dry = { ...record([{ patch: GROW(1) }, { patch: GROW(2) }]), dryRun: true };
    const s = shrinkStateOf([dry], { every: 2 });
    assert.equal(s.sinceShrink, 0);
    assert.equal(s.required, false);
  });

  it('一条被采纳的净简化把计数归零（配额兑现）', () => {
    const s = shrinkStateOf(
      [
        record([{ patch: GROW(1) }, { patch: GROW(2) }]),
        record([{ patch: SHRINK }]),
        record([{ patch: GROW(3) }]),
      ],
      { every: 2 },
    );
    assert.equal(s.sinceShrink, 1);
    assert.equal(s.required, false);
  });
});

describe('净简化 —— 提案提示词', () => {
  it('给出可核对的目标字数，并说明"简化 ≠ 删要求"', () => {
    const body = 'a'.repeat(200);
    const text = renderShrink({ reason: '已采纳 3 条改动', minReduction: 0.05 }, body);
    assert.match(text, /已采纳 3 条改动/);
    // 200 × 0.95 = 190：数字算错会让配额变成不可能完成的任务（每条都被拒）
    assert.match(text, /200 字 ⇒ 目标不超过 190 字/);
    assert.match(text, /简化不等于删要求/);
    assert.equal(renderShrink(undefined, body), '', '非简化轮不该多出这一段');
  });
});

describe('净简化 —— 分区与验收', () => {
  const required: ShrinkState = {
    required: true,
    reason: '测试',
    sinceShrink: 3,
    growth: 0,
    basis: 'cost',
  };

  it('简化轮：变胖的提案在验证之前就被挡下，理由带字数变化', () => {
    const { allowed, blocked } = partitionForShrink(
      [proposalOf('grow', GROW(2)), proposalOf('shrink', SHRINK)],
      required,
    );
    assert.deepEqual(
      allowed.map((p) => p.id),
      ['shrink'],
    );
    assert.equal(blocked.length, 1);
    assert.match(blocked[0]?.reason ?? '', /从 \d+ 字改到 \d+ 字.*要求至少少 5%/);
  });

  it('非简化轮：原样放行，调用方不必写分支', () => {
    const { allowed, blocked } = partitionForShrink([proposalOf('grow', GROW(2))], {
      ...required,
      required: false,
      reason: undefined,
    });
    assert.equal(allowed.length, 1);
    assert.equal(blocked.length, 0);
  });

  it('「不变差但更小」只在简化轮算值得，且必须真变小', () => {
    const outcome = (patch: AssetPatch): VerifyOutcome => {
      const base = summarize([res('a', true)], 'fp1', 'main@1');
      const cand = summarize([res('a', true)], 'fp2', 'main@1');
      return {
        proposal: proposalOf('p', patch),
        baseline: base,
        candidate: cand,
        gate: gate(base, cand),
      };
    };
    // 前提：门是放行的（通过率没变、成本没涨）
    assert.equal(outcome(SHRINK).gate.ok, true);
    const shrunk = outcome(SHRINK);
    assert.equal(isWorthAccepting(shrunk), false, '平时：没有用例变好 ⇒ 不值得落盘');
    assert.equal(isWorthAccepting(shrunk, { shrink: true }), true, '简化轮：变小本身就是收益');
    assert.equal(
      isWorthAccepting(outcome(GROW(1)), { shrink: true }),
      false,
      '简化轮不是"什么都不算数"：变胖照样拒',
    );
  });
});

describe('净简化 —— 与 runCycle 的接线', () => {
  it('第 2 轮成为简化轮：变胖提案被挡；第 3 轮只删也照样采纳', async () => {
    const root = project();
    // 第 1 轮：普通轮，一个"加规则"的改动修好了 fix-me
    const first = await cycle(root, 'MARK', false);
    assert.equal(first.accepted.length, 1);
    assert.equal(first.shrink?.required, false);
    assert.equal(first.shrink?.sinceShrink, 0);

    // 第 2 轮：配额到期 ⇒ 变胖提案在验证之前就被挡下（verified 为空 = 没花评测钱）
    const second = await cycle(root, 'EXTRA', true);
    assert.equal(second.shrink?.required, true);
    assert.equal(second.shrink?.sinceShrink, 1);
    assert.equal(second.verified.length, 0, '简化轮不该为一条注定被拒的提案跑评测');
    assert.equal(second.accepted.length, 0);
    assert.match(second.rejected.map((r) => r.reason).join('\n'), /简化轮只接受净简化提案/);

    // 第 3 轮：交出一条真正的删除 —— 没有用例变好也采纳，因为资产确实变小了
    const beforeBody = readFileSync(join(root, 'agents', 'main.md'), 'utf8');
    const third = await cycle(root, 'DELETE', true);
    assert.equal(third.shrink?.required, true);
    assert.equal(third.accepted.length, 1);
    const outcome = third.verified[0];
    assert.equal(outcome?.gate.passRateDelta, 0, '这一轮不是靠修好用例过的门');
    assert.equal(outcome?.gate.fixedCases.length, 0);
    const afterBody = readFileSync(join(root, 'agents', 'main.md'), 'utf8');
    assert.ok(afterBody.length < beforeBody.length, '净简化必须真的更短');
    // 审计线索：journal 必须说得清"这次为什么在没有任何用例变好的情况下被采纳"
    const journal = readFileSync(join(root, '.workspace', 'rsi', 'journal.jsonl'), 'utf8');
    assert.match(journal, /简化轮（距上次净简化已采纳 1 条改动/);
  });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-shrink-'));
  const w = (rel: string, text: string): void => {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text, 'utf8');
  };
  w(
    'agents/main.md',
    '---\nname: main\nversion: 1\ndescription: 主 agent\n---\n' +
      '你是执行者。\n' +
      '规则一：先看清任务再动手。\n' +
      '规则二：禁止猜测，禁止臆测，禁止凭空推断，禁止无依据的结论，禁止含糊其辞。\n',
  );
  w('evals/fix-me.md', '---\nname: fix-me\nexpect_contains: 结论\n---\n任务甲：判断合格\n');
  // 这条永远失败：它的作用是让每一轮都有失败样本（否则 `runCycle` 直接收工，
  // 简化轮根本没机会发生）。配额只在"还在改东西"的时候有意义 —— 也只有那时在变胖。
  w(
    'evals/always-fail.md',
    '---\nname: always-fail\nexpect_contains: 永不出现\n---\n任务乙：随便说说\n',
  );
  return root;
}

/** 三轮共用一套脚本：fix-me 由 `tag` 决定是否通过，always-fail 永远挂 */
async function cycle(root: string, tag: string, shrinkPolicy: boolean) {
  const config = loadConfig(root);
  const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
  const agent = assets.agents[0];
  assert.ok(agent !== undefined);

  const step = (params: unknown) => {
    const p = params as { system?: string | Array<{ text?: string }>; messages?: unknown };
    const system =
      typeof p.system === 'string'
        ? p.system
        : (p.system ?? []).map((b) => b.text ?? '').join('\n');
    const message = JSON.stringify(p.messages ?? []);
    if (message.includes('任务甲'))
      return endTurn(system.includes('MARK') ? '结论：合格' : '不合格');
    return endTurn('随便说说');
  };

  const proposer: Proposer = {
    propose: async (ctx) => {
      const body = agent.body;
      // 按行删（`body` 已经 trim 过，不能假设行尾还有换行）
      const after =
        tag === 'DELETE'
          ? body
              .split('\n')
              .filter((line) => !line.startsWith('规则二：'))
              .join('\n')
          : `${body}\n${tag === 'EXTRA' ? '规则三：回答要更详细，尽量多写背景。' : '规则三：回答必须以「MARK」开头。'}`;
      const proposals: Proposal[] = [
        {
          id: `p-${tag}`,
          modeId: ctx.modes[0]?.id ?? 'm',
          kind: 'wrong_answer',
          rationale: '按这一轮的目标改正文',
          layer: 'L1',
          patch: { target: 'agent:main', before: body, after },
        },
      ];
      return { proposals, cost: { usd: 0.001, known: true } };
    },
  };

  return runCycle({
    config,
    assets,
    client: scriptedClient(Array.from({ length: 10 }, () => step)),
    proposer,
    ...(shrinkPolicy ? { shrinkPolicy: { every: 1 } } : {}),
  });
}
