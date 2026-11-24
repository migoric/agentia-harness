import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scriptedClient } from '@migor/agentia';
import { discoverAssets } from '../src/assets/discover.ts';
import { loadConfig } from '../src/config.ts';
import { acceptProposal, readJournal, revertLast } from '../src/rsi/accept.ts';
import { readLedger } from '../src/rsi/ledger.ts';
import { runCycle } from '../src/rsi/loop.ts';
import type { Proposal } from '../src/rsi/types.ts';

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

function project(): { root: string; agentPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'harness-holdout-'));
  const w = (rel: string, text: string): void => {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text, 'utf8');
  };
  w('agents/main.md', '---\nname: main\nversion: 1\ndescription: 主 agent\n---\n你是执行者。\n');
  w('evals/a-train.md', '---\nname: a-train\nexpect_contains: 结论\n---\n任务甲：判断合格\n');
  w(
    'evals/b-holdout.md',
    '---\nname: b-holdout\nsplit: holdout\nexpect_contains: 保留\n---\n任务乙：保留摘要\n',
  );
  return { root, agentPath: join(root, 'agents', 'main.md') };
}

/** 按请求内容分派：基线 / 候选 train / 候选 holdout 各走各的分支 */
function client(holdoutRegresses: boolean) {
  // 基线 2 条 + 候选 train 1 条 + 候选 holdout 1 条 = 4 次模型调用。
  // scriptedClient 的函数步骤也是一次性消费的，不能只给一步就指望它复用。
  const step = (params: unknown) => {
    const p = params as { system?: string | Array<{ text?: string }>; messages?: unknown };
    const system =
      typeof p.system === 'string'
        ? p.system
        : (p.system ?? []).map((b) => b.text ?? '').join('\n');
    const message = JSON.stringify(p.messages ?? []);
    const patched = system.includes('结论：必需');
    if (message.includes('任务甲')) return endTurn(patched ? '结论：合格' : '不合格');
    if (message.includes('任务乙')) {
      return endTurn(patched && holdoutRegresses ? '不合格' : '保留摘要');
    }
    throw new Error(`未知任务：${message}`);
  };
  return scriptedClient(Array.from({ length: 4 }, () => step));
}

function cycle(root: string, regress: boolean) {
  const config = loadConfig(root);
  const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
  const agent = assets.agents[0];
  assert.ok(agent !== undefined);
  let seenCases: readonly string[] = [];
  return {
    config,
    assets,
    report: runCycle({
      config,
      assets,
      client: client(regress),
      proposer: {
        propose: async (ctx) => {
          seenCases = ctx.modes.flatMap((m) => m.cases);
          const proposals: Proposal[] = [
            {
              id: 'p-holdout',
              modeId: ctx.modes[0]?.id ?? 'm',
              kind: 'wrong_answer',
              rationale: 'train 失败，收紧输出格式',
              manifest: {
                evidence: ['case:a-train'],
                hypothesis: '输出格式不稳定',
                prediction: 'a-train 应转为通过',
                risk: '可能影响摘要任务',
              },
              layer: 'L1',
              patch: {
                target: 'agent:main',
                before: agent.body,
                after: '你是执行者。回答必须以「结论：必需」开头。',
              },
            } satisfies Proposal,
          ];
          return { proposals, cost: { usd: undefined, known: true } };
        },
      },
    }),
    seenCases: () => seenCases,
  };
}

describe('留出集 —— 候选选出后才验一次', () => {
  it('提案只看 train 失败；留出集退步时拒绝采纳，源文件一字未动', async () => {
    const { root, agentPath } = project();
    const before = readFileSync(agentPath, 'utf8');
    const { report, seenCases } = cycle(root, true);
    const result = await report;

    assert.deepEqual(seenCases(), ['a-train'], 'holdout 用例绝不能进提案输入');
    assert.ok(result.verified[0]?.holdout !== undefined, '候选必须在留出集上验过');
    assert.equal(result.verified[0]?.holdout?.gate.ok, false);
    assert.match(result.verified[0]?.holdout?.gate.reason ?? '', /b-holdout/);
    assert.equal(result.accepted.length, 0);
    assert.equal(readJournal(loadConfig(root)).length, 0);
    assert.equal(readFileSync(agentPath, 'utf8'), before, '拒绝时不能留下半截改动');
    // 被拒的尝试也进账本：train 兑现了但留出集否了，结论必须是 not_realized
    const ledger = readLedger(loadConfig(root));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]?.status, 'rejected');
    assert.equal(ledger[0]?.outcome, 'not_realized');
    assert.match(ledger[0]?.holdoutReason ?? '', /b-holdout/);
  });

  it('留出集通过才采纳；清单随采纳进 journal', async () => {
    const { root, agentPath } = project();
    const { report } = cycle(root, false);
    const result = await report;
    assert.equal(result.verified[0]?.holdout?.gate.ok, true);
    assert.equal(result.accepted.length, 1);
    assert.match(readFileSync(agentPath, 'utf8'), /结论：必需/);
    const entries = readJournal(loadConfig(root));
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.manifest?.prediction, 'a-train 应转为通过');
    assert.deepEqual(entries[0]?.manifest?.evidence, ['case:a-train']);
    const ledger = readLedger(loadConfig(root));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]?.outcome, 'realized');
    assert.equal(ledger[0]?.prediction, 'a-train 应转为通过');
    assert.equal(ledger[0]?.cycleId, result.cycleId);

    // 回滚在账本里是 reverted，不是「又否决了一次提案」
    revertLast(loadConfig(root));
    const afterRevert = readLedger(loadConfig(root));
    assert.deepEqual(
      afterRevert.map((e) => e.outcome),
      ['realized', 'reverted'],
    );
  });

  it('即便调用方绕过 runCycle，带着退步的留出集结果也不能落盘', async () => {
    const { root, agentPath } = project();
    const before = readFileSync(agentPath, 'utf8');
    const { config, assets, report } = cycle(root, true);
    const result = await report;
    const outcome = result.verified[0];
    assert.ok(outcome !== undefined && outcome.holdout !== undefined);
    assert.throws(() => acceptProposal(config, assets, outcome), /留出集未通过/);
    // 把留出集结果整个抹掉也不行：工程配了 holdout 就必须带着验证结果来
    assert.throws(
      () => acceptProposal(config, assets, { ...outcome, holdout: undefined }),
      /没有留出集记录/,
    );
    assert.equal(readFileSync(agentPath, 'utf8'), before);
  });
});
