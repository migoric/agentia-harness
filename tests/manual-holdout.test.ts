import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scriptedClient } from '@migor/agentia';
import { discoverAssets } from '../src/assets/discover.ts';
import { acceptFrom } from '../src/cli/commands/rsi.ts';
import { loadConfig } from '../src/config.ts';
import { readJournal } from '../src/rsi/accept.ts';

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

function setup(): { root: string; agentPath: string; proposalPath: string; before: string } {
  const root = mkdtempSync(join(tmpdir(), 'harness-manual-holdout-'));
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
  const config = loadConfig(root);
  const agent = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir }).agents[0];
  assert.ok(agent !== undefined);
  const proposalPath = join(root, 'proposal.json');
  writeFileSync(
    proposalPath,
    JSON.stringify({
      id: 'p-manual-holdout',
      modeId: 'm',
      kind: 'wrong_answer',
      rationale: '手写提案也要过留出集',
      manifest: {
        evidence: ['case:a-train'],
        hypothesis: '格式不稳',
        prediction: 'a-train 应转为通过',
        risk: '可能影响摘要任务',
      },
      layer: 'L1',
      patch: {
        target: 'agent:main',
        before: agent.body,
        after: '你是执行者。回答必须以「结论：必需」开头。',
      },
    }),
  );
  return { root, agentPath: agent.path, proposalPath, before: agent.body };
}

/** 基线 2 条 + 候选 train 1 条 + 候选 holdout 1 条 */
function client(holdoutRegresses: boolean) {
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

describe('rsi accept --from 的留出集路径', () => {
  it('留出集退步时退出码 1、源文件与 journal 都不动', async () => {
    const { root, agentPath, proposalPath } = setup();
    const original = readFileSync(agentPath, 'utf8');
    const ctx = {
      root,
      config: loadConfig(root),
      flags: { from: proposalPath } as const,
      agent: undefined,
    };
    const code = await acceptFrom(ctx, client(true));
    assert.equal(code, 1);
    assert.equal(readFileSync(agentPath, 'utf8'), original);
    assert.equal(readJournal(loadConfig(root)).length, 0);
  });

  it('留出集通过才落盘，清单随手写提案进 journal', async () => {
    const { root, agentPath, proposalPath } = setup();
    const ctx = {
      root,
      config: loadConfig(root),
      flags: { from: proposalPath } as const,
      agent: undefined,
    };
    const code = await acceptFrom(ctx, client(false));
    assert.equal(code, 0);
    assert.match(readFileSync(agentPath, 'utf8'), /结论：必需/);
    const entries = readJournal(loadConfig(root));
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.manifest?.prediction, 'a-train 应转为通过');
  });
});
