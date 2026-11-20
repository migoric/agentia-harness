import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scriptedClient } from '@migor/agentia';
import { discoverAssets } from '../src/assets/discover.ts';
import { loadConfig } from '../src/config.ts';
import { createRunner } from '../src/run/runner.ts';
import { buildTools } from '../src/run/tools.ts';

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

function toolUse(name: string, input: unknown) {
  return {
    id: 'm',
    model: 'claude-opus-5',
    stop_reason: 'tool_use',
    usage: USAGE,
    content: [
      { type: 'tool_use', id: `tu_${name}_${Math.random().toString(36).slice(2, 7)}`, name, input },
    ],
  };
}

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-multi-'));
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text, 'utf8');
  }
  return root;
}

const MAIN = `---
name: main
version: 1
description: 主编排
subagents: [reviewer]
---

你是主编排者。需要审稿时委派给 reviewer。
`;

const REVIEWER = `---
name: reviewer
version: 1
description: 审稿
tools: [summary]
---

你是审稿人。需要摘要时调用 summary。
`;

const SUMMARY = `---
name: summary
description: 摘要
---

你是摘要器。
`;

function assetsOf(root: string) {
  const config = loadConfig(root);
  return { config, assets: discoverAssets({ skills: config.skillsDir, agents: config.agentsDir }) };
}

describe('多 agent 装配', () => {
  it('subagents 变成 subagent 类工具，技能仍是 skill 类', () => {
    const root = project({
      'agents/main.md': MAIN,
      'agents/reviewer.md': REVIEWER,
      'skills/summary/SKILL.md': SUMMARY,
    });
    const { assets } = assetsOf(root);
    const main = assets.agents.find((a) => a.name === 'main');
    assert.ok(main !== undefined);

    const tools = buildTools(main, assets);
    const byName = new Map(tools.map((t) => [t.name, t]));
    // main 没声明 tools ⇒ 全部技能都在；reviewer 是显式委派
    assert.deepEqual([...byName.keys()].sort(), ['reviewer', 'summary']);
    assert.equal(byName.get('reviewer')?.capability, 'subagent');
    assert.equal(byName.get('summary')?.capability, 'skill');
  });

  it('未声明 tools 的 agent 拿到全部技能；声明了就只拿清单里的', () => {
    const root = project({
      'agents/main.md': '---\nname: main\ndescription: 主\ntools: [a]\n---\n正文\n',
      'skills/a/SKILL.md': '---\nname: a\ndescription: A\n---\nA\n',
      'skills/b/SKILL.md': '---\nname: b\ndescription: B\n---\nB\n',
    });
    const { assets } = assetsOf(root);
    const main = assets.agents[0];
    assert.ok(main !== undefined);
    assert.deepEqual(
      buildTools(main, assets).map((t) => t.name),
      ['a'],
      '声明了清单就严格按清单',
    );

    const root2 = project({
      'agents/main.md': '---\nname: main\ndescription: 主\n---\n正文\n',
      'skills/a/SKILL.md': '---\nname: a\ndescription: A\n---\nA\n',
      'skills/b/SKILL.md': '---\nname: b\ndescription: B\n---\nB\n',
    });
    const second = assetsOf(root2);
    const main2 = second.assets.agents[0];
    assert.ok(main2 !== undefined);
    assert.deepEqual(
      buildTools(main2, second.assets)
        .map((t) => t.name)
        .sort(),
      ['a', 'b'],
      '未声明 = 全部（缺省必须安全）',
    );
  });

  it('agent 委派成环 ⇒ 装配期就报错并指名路径', () => {
    const root = project({
      'agents/a.md': '---\nname: a\ndescription: A\nsubagents: [b]\n---\nA\n',
      'agents/b.md': '---\nname: b\ndescription: B\nsubagents: [a]\n---\nB\n',
    });
    const { assets } = assetsOf(root);
    const a = assets.agents.find((x) => x.name === 'a');
    assert.ok(a !== undefined);
    assert.throws(() => buildTools(a, assets), /agent 委派成环: a → b → a/);
  });

  it('委派不存在的 agent ⇒ 报错列出可用名字', () => {
    const root = project({
      'agents/a.md': '---\nname: a\ndescription: A\nsubagents: [ghost]\n---\nA\n',
    });
    const { assets } = assetsOf(root);
    const a = assets.agents[0];
    assert.ok(a !== undefined);
    assert.throws(() => buildTools(a, assets), /委派了不存在的 agent "ghost"/);
  });

  it('技能与 agent 重名 ⇒ 资产发现期就拒绝（共用工具名空间）', () => {
    const root = project({
      'agents/reviewer.md': '---\nname: reviewer\ndescription: A\n---\nA\n',
      'skills/reviewer/SKILL.md': '---\nname: reviewer\ndescription: S\n---\nS\n',
    });
    assert.throws(() => assetsOf(root), /工具名重名 "reviewer"/);
  });
});

describe('委派的 trace 归因', () => {
  it('真实的 主编排 → 审稿 → 摘要 三层委派，技能与 agent 命中都能读出来', async () => {
    const root = project({
      'agents/main.md': MAIN,
      'agents/reviewer.md': REVIEWER,
      'skills/summary/SKILL.md': SUMMARY,
      'evals/.keep': '',
    });
    const { config, assets } = assetsOf(root);
    const runner = createRunner(config, assets, 'main', false);
    const client = scriptedClient([
      toolUse('reviewer', { task: '审这段文字' }), // main 第 1 轮
      toolUse('summary', { task: '压成三条' }), // reviewer 第 1 轮
      endTurn('三条要点'), // summary
      endTurn('审稿结论：可以'), // reviewer 第 2 轮
      endTurn('最终：可以'), // main 第 2 轮
    ]);

    const out = await runner.run('审一下这段文字', { client });
    assert.match(out.text, /最终/);
    // 命中是从真实 trace 的 capability span 读出来的，不是我们自己记的账
    assert.deepEqual(out.subagents, ['reviewer']);
    assert.deepEqual(out.skills, ['summary']);
  });
});

describe('子循环继承生效模型', () => {
  const CONFIG = JSON.stringify({
    model: 'deepseek-flash',
    pricing: { 'deepseek-flash': { in: 0.15, out: 0.6 } },
  });

  it('技能与子 agent 都用主配置的模型，成本也按它的单价记', async () => {
    const root = project({
      'harness.config.json': CONFIG,
      'agents/main.md': MAIN,
      'agents/reviewer.md': REVIEWER,
      'skills/summary/SKILL.md': SUMMARY,
      'evals/.keep': '',
    });
    const { config, assets } = assetsOf(root);
    const runner = createRunner(config, assets, 'main', false);
    const client = scriptedClient([
      toolUse('reviewer', { task: '审这段文字' }),
      toolUse('summary', { task: '压成三条' }),
      endTurn('三条要点'),
      endTurn('审稿结论：可以'),
      endTurn('最终：可以'),
    ]);

    const out = await runner.run('审一下这段文字', { client });
    const turns = out.trace.spans.filter((s) => s.kind === 'llm.turn');
    assert.equal(turns.length, 5, out.trace.spans.map((s) => s.kind).join(','));
    assert.deepEqual(
      [...new Set(turns.map((s) => s.name))],
      ['deepseek-flash'],
      '上游 capability loop 只继承 client、不继承 model —— 装配层不补，这里就会出现 claude-opus-5',
    );
    // 10 in / 5 out × $0.15/$0.60 每 1M = 每轮 $0.0000045，五轮 $0.0000225。
    // 按 opus 单价（$5/$25）则是 $0.000875，相差近 40 倍
    assert.ok(
      (out.trace.totalUsage.costEstimate ?? Number.POSITIVE_INFINITY) < 0.0001,
      `成本应按 deepseek-flash 单价记，实际 ${String(out.trace.totalUsage.costEstimate)}`,
    );
  });

  it('资产自己声明的 model 仍然优先于工程兜底', async () => {
    const root = project({
      'harness.config.json': CONFIG,
      'agents/main.md': '---\nname: main\ndescription: 主\ntools: [s]\n---\n正文\n',
      'skills/s/SKILL.md': '---\nname: s\ndescription: S\nmodel: claude-haiku-4-5\n---\n摘要\n',
      'evals/.keep': '',
    });
    const { config, assets } = assetsOf(root);
    const runner = createRunner(config, assets, undefined, false);
    const out = await runner.run('压一下', {
      client: scriptedClient([
        toolUse('s', { task: '压一下' }),
        endTurn('三条要点'),
        endTurn('结论'),
      ]),
    });

    const turns = out.trace.spans.filter((s) => s.kind === 'llm.turn');
    const sub = turns.find((s) => s.name === 'claude-haiku-4-5');
    assert.ok(sub, `技能应保留自己的模型，实际各回合是 ${turns.map((s) => s.name).join(', ')}`);
    assert.ok(
      turns.some((s) => s.name === 'deepseek-flash'),
      '主 agent 仍用工程生效模型',
    );
  });
});
