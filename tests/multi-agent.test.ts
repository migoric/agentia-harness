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
