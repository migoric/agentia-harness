import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { scriptedClient } from '@migor/agentia';
import { discoverAssets } from '../src/assets/discover.ts';
import { loadConfig } from '../src/config.ts';
import { HarnessError } from '../src/errors.ts';
import { buildPolicyFields, isPolicyField, policyFieldKeys } from '../src/run/policy-fields.ts';
import { createRunner } from '../src/run/runner.ts';

const dirs: string[] = [];
function workspace(): string {
  const d = mkdtempSync(join(tmpdir(), 'harness-policy-'));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('声明式策略字段：转译', () => {
  it('contextBudgetTokens → contextPolicy（budgetTokens 生效）', () => {
    const f = buildPolicyFields({ contextBudgetTokens: '12000' }, 't.md');
    assert.ok(f.contextPolicy, '策略对象已生成');
    assert.equal(f.contextPolicy.budgetTokens, 12000);
    assert.equal(f.retry, undefined);
  });

  it('retryMaxAttempts → retry.maxAttempts', () => {
    const f = buildPolicyFields({ retryMaxAttempts: '5' }, 't.md');
    assert.deepEqual(f.retry, { maxAttempts: 5 });
    assert.equal(f.contextPolicy, undefined);
  });

  it('两个都给 → 两个策略都生成', () => {
    const f = buildPolicyFields({ contextBudgetTokens: '8000', retryMaxAttempts: '2' }, 't.md');
    assert.equal(f.contextPolicy?.budgetTokens, 8000);
    assert.deepEqual(f.retry, { maxAttempts: 2 });
  });

  it('空输入 → 空结果（不用转译，agentia 用自己的缺省）', () => {
    assert.deepEqual(buildPolicyFields({}, 't.md'), {});
  });

  it('坏值（0 / 负数 / 小数 / 非数）→ 响亮抛错', () => {
    for (const bad of ['0', '-3', '1.5', 'abc']) {
      assert.throws(
        () => buildPolicyFields({ contextBudgetTokens: bad }, 't.md'),
        (e: unknown) => e instanceof HarnessError && /正整数/.test(e.message),
        `${bad} 应被拒`,
      );
    }
  });

  it('字段归属：只有这两个是声明式策略字段', () => {
    assert.deepEqual([...policyFieldKeys()], ['contextBudgetTokens', 'retryMaxAttempts']);
    assert.equal(isPolicyField('contextBudgetTokens'), true);
    assert.equal(isPolicyField('maxIterations'), false, 'maxIterations 是数值旋钮，不在这里');
    assert.equal(isPolicyField('stopWhen'), false, 'agentia 没有这个运行时旋钮');
  });
});

describe('声明式策略字段：资产发现抽取', () => {
  it('discoverAssets 从 frontmatter 抽出 policyFields 原始值', () => {
    const root = workspace();
    writeFileSync(
      join(root, 'main.md'),
      '---\nname: main\ndescription: d\ncontextBudgetTokens: 9000\nretryMaxAttempts: 4\n---\n正文\n',
      'utf8',
    );
    mkdirSync(join(root, 'nope'), { recursive: true });
    const set = discoverAssets({ skills: join(root, 'nope'), agents: root });
    const agent = set.agents[0]!;
    assert.deepEqual(agent.policyFields, {
      contextBudgetTokens: '9000',
      retryMaxAttempts: '4',
    });
  });

  it('没写策略字段 → policyFields 为空对象（不是 undefined）', () => {
    const root = workspace();
    writeFileSync(join(root, 'main.md'), '---\nname: main\ndescription: d\n---\n正文\n', 'utf8');
    mkdirSync(join(root, 'nope'), { recursive: true });
    const set = discoverAssets({ skills: join(root, 'nope'), agents: root });
    assert.deepEqual(set.agents[0]!.policyFields, {});
  });
});

describe('声明式策略字段：端到端装配', () => {
  const USAGE = {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  const endTurn = (text: string) => ({
    id: 'm',
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    usage: USAGE,
    content: [{ type: 'text', text }],
  });

  function project(policyHeader: string): {
    root: string;
    config: ReturnType<typeof loadConfig>;
    assets: ReturnType<typeof discoverAssets>;
  } {
    const root = workspace();
    writeFileSync(join(root, 'harness.config.json'), JSON.stringify({ model: 'claude-opus-5' }));
    mkdirSync(join(root, 'agents'), { recursive: true });
    mkdirSync(join(root, 'skills'), { recursive: true });
    writeFileSync(
      join(root, 'agents', 'main.md'),
      `---\nname: main\ndescription: d\n${policyHeader}---\n你是执行者。\n`,
    );
    const config = loadConfig(root);
    return {
      root,
      config,
      assets: discoverAssets({ skills: config.skillsDir, agents: config.agentsDir }),
    };
  }

  it('合法策略字段的资产能装配成 AgentApp 并跑通（策略对象被接受）', async () => {
    const { config, assets } = project('contextBudgetTokens: 50000\nretryMaxAttempts: 2\n');
    const runner = createRunner(config, assets, undefined, false);
    const out = await runner.run('压一下', { client: scriptedClient([endTurn('结论：好')]) });
    assert.equal(out.text, '结论：好');
  });

  it('坏策略值在装配时被消费并响亮抛错（证明 buildApp 没有静默忽略 policyFields）', () => {
    const { config, assets } = project('contextBudgetTokens: abc\n');
    // createRunner 构造时就装配 AgentApp（runner.ts:143），坏策略值在这里就抛 ——
    // 若 buildApp 静默忽略 policyFields，这里不会抛，本用例就红。
    assert.throws(
      () => createRunner(config, assets, undefined, false),
      (e: unknown) =>
        e instanceof HarnessError && e.code === 'asset.invalid' && /正整数/.test(e.message),
      'buildApp 真的把 policyFields 转译成了策略对象，坏值无处可藏',
    );
  });
});
