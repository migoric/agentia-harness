/**
 * 提案正文的长度上限（守卫生效 + 提示词里给出同一个数）。
 *
 * 这里钉的是一条真模型实测出来的冲突（2026-11-28）：`PROPOSER_SYSTEM` 第 3 条要求
 * 「默认的改动方向是**增补或收紧**」，而守卫按「原文 3 倍」卡。87 字的技能 ×3 = 261 字，
 * 模型认真增补（加日期格式 + 输出示例）必然超 —— 于是 RSI 一轮**提出 0 个提案**，
 * 而 mock 模型永远只追加一句，这条冲突在真模型之前从未暴露。
 *
 * 两个断言方向：
 * 1. 上限本身是「3 倍，且不少于 400 字」—— 短正文不该被比例判死；
 * 2. 同一个数必须出现在提示词里 —— 机器约束不告诉模型，它只能猜，猜错的代价是一整轮验证。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scriptedClient } from '@migor/agentia';
import { discoverAssets } from '../src/assets/discover.ts';
import { loadConfig } from '../src/config.ts';
import { LlmProposer, maxAfterChars } from '../src/rsi/propose.ts';
import type { FailureMode } from '../src/rsi/types.ts';

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

function project(skillBody: string): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-propose-limit-'));
  const w = (rel: string, text: string): void => {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text, 'utf8');
  };
  w('agents/main.md', '---\nname: main\nversion: 1\ndescription: 主 agent\n---\n你是执行者。\n');
  w('skills/s/SKILL.md', `---\nname: s\ndescription: 摘要器\n---\n${skillBody}\n`);
  w('evals/a.md', '---\nname: a\nexpect_contains: 结论\n---\n任务甲\n');
  return root;
}

const SHORT = '你是摘要器。读输入文字，输出恰好三条要点，每条不超过 30 字。';

const mode: FailureMode = {
  id: 'm1',
  kind: 'wrong_answer',
  signature: '正文缺少日期',
  count: 1,
  cases: ['a'],
  samples: [
    {
      case: 'a',
      failures: ['正文缺少 "截止日期"'],
      stopReason: 'end_turn',
      tokens: 20,
      iterations: 1,
      excerpt: '三条要点，没有日期',
      skills: [],
      subagents: [],
    },
  ],
  targets: [{ target: 'skill:s', cases: ['a'] }],
};

describe('maxAfterChars —— 短正文不该被「3 倍」判死', () => {
  it('短文走 400 字底板，长文按 3 倍', () => {
    assert.ok(SHORT.length < 100, `夹具应是短文，实际 ${SHORT.length}`);
    assert.equal(
      maxAfterChars(SHORT),
      400,
      '几十字的小技能要能长到 400 —— 加日期格式与输出示例就过百',
    );
    const long = 'x'.repeat(1000);
    assert.equal(maxAfterChars(long), 3000, '长文仍按 3 倍：那种扩张几乎一定是复述任务');
  });
});

describe('提示词与守卫用同一个上限', () => {
  it('提示词里明确写出字数上限', async () => {
    const root = project(SHORT);
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const prompts: string[] = [];
    const client = scriptedClient([
      (params: unknown) => {
        prompts.push(JSON.stringify(params));
        return endTurn('你是摘要器。输出三条要点，每条附 YYYY-MM-DD 格式的截止日期。');
      },
    ]);
    await new LlmProposer(config).propose({ modes: [mode], assets, config, client });
    const prompt = prompts[0] ?? '';
    assert.match(prompt, /长度上限/, `提示词应有一节长度约束：${prompt.slice(0, 200)}`);
    assert.match(prompt, /不得超过 400 字/, '上限数要与守卫一致，否则模型白写');
  });

  it('超过上限的提案被丢弃，且理由里带上限值', async () => {
    const root = project(SHORT);
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const skips: string[] = [];
    const client = scriptedClient([endTurn(`你是摘要器。${'要求行。'.repeat(200)}`)]);
    await new LlmProposer(config, {
      onSkip: (_id, reason) => skips.push(reason),
    }).propose({ modes: [mode], assets, config, client });
    assert.equal(skips.length, 1, `应跳过一条：${JSON.stringify(skips)}`);
    assert.match(skips[0] ?? '', /上限 400/);
  });

  it('300 字的合理增补能通过守卫（这正是真模型会写出来的量级）', async () => {
    const root = project(SHORT);
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const body = `你是摘要器。输出恰好三条要点，每条不超过 30 字，并附 YYYY-MM-DD 格式的截止日期。\n${'要求：只保留事实，不做推测，三条之间不重复。'.repeat(10)}`;
    assert.ok(
      body.length > 250 && body.length < 400,
      `夹具长度应落在 250–400，实际 ${body.length}`,
    );
    const client = scriptedClient([endTurn(body)]);
    const out = await new LlmProposer(config).propose({ modes: [mode], assets, config, client });
    assert.equal(out.proposals.length, 1, '这个量级的增补不该被丢');
  });
});
