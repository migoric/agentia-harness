import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scriptedClient } from '@migor/agentia';
import { discoverAssets } from '../src/assets/discover.ts';
import { acceptFrom } from '../src/cli/commands/rsi.ts';
import { regress } from '../src/cli/commands/rsi-inspect.ts';
import { loadConfig } from '../src/config.ts';
import { readJournal } from '../src/rsi/accept.ts';
import { runCycle } from '../src/rsi/loop.ts';
import { LlmProposer } from '../src/rsi/propose.ts';

/**
 * `rsi regress [--revert]` 的退出码与副作用。
 *
 * 这层只能用真实命令函数测（而不是 `rsi` 子进程）：它要一个能脚本化的模型客户端，
 * 而 CLI 进程里没有注入点。退出码仍然照契约断言 —— 0 无回归 / 1 有回归 / 2 动作没做成。
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

const AGENT_HEAD = '---\nname: main\nversion: 1\ndescription: 主 agent\n---\n';
const PATCHED = '你是执行者。结论：开头。';

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-regress-cli-'));
  const w = (rel: string, text: string): void => {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text, 'utf8');
  };
  w('agents/main.md', `${AGENT_HEAD}你是执行者。\n`);
  w('evals/a.md', '---\nname: a\nexpect_contains: 结论\n---\n任务甲\n');
  return root;
}

/** 按 system 内容分派：提案器给补丁，主 agent 按当前正文决定过不过 */
function step(getBroken: () => boolean) {
  return (params: unknown) => {
    const p = params as { system?: string | Array<{ text?: string }> };
    const system =
      typeof p.system === 'string'
        ? p.system
        : (p.system ?? []).map((b) => b.text ?? '').join('\n');
    if (system.includes('提示词工程师')) return endTurn(PATCHED);
    if (getBroken()) return endTurn('不合格');
    return endTurn(system.includes('结论：开头') ? '结论：合格' : '不合格');
  };
}

/** 跑一轮把改动采纳进来，返回采纳后的 agent 正文 */
async function accept(root: string): Promise<string> {
  const config = loadConfig(root);
  const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
  await runCycle({
    config,
    assets,
    client: scriptedClient(Array.from({ length: 6 }, () => step(() => false))),
    proposer: new LlmProposer(config),
  });
  assert.equal(readJournal(config).length, 1, '前置条件：必须先有一条采纳');
  return readFileSync(join(root, 'agents', 'main.md'), 'utf8');
}

function ctxOf(root: string, flags: Record<string, string | true> = {}) {
  return { root, config: loadConfig(root), flags, agent: undefined };
}

describe('rsi regress 的退出码', () => {
  it('没有回归时 0', async () => {
    const root = project();
    await accept(root);
    const code = await regress(
      ctxOf(root),
      scriptedClient(Array.from({ length: 3 }, () => step(() => false))),
    );
    assert.equal(code, 0);
  });

  it('回归时 1，且默认不动资产', async () => {
    const root = project();
    const after = await accept(root);
    const code = await regress(ctxOf(root), scriptedClient([() => endTurn('不合格')]));
    assert.equal(code, 1, '检测到回归是「检查没通过」，不是用法错误');
    assert.equal(
      readFileSync(join(root, 'agents', 'main.md'), 'utf8'),
      after,
      '不加 --revert 不许改资产',
    );
    assert.equal(readJournal(loadConfig(root)).length, 1, '没有回滚记录');
  });
});

describe('rsi regress --revert', () => {
  it('资产没被手改时回滚成功：正文恢复、journal 多一条回滚记录、退出码仍是 1', async () => {
    const root = project();
    const after = await accept(root);
    // 资产一字未动，但模型开始不合格（真实世界里：模型换版本、用例变严）
    const code = await regress(
      ctxOf(root, { revert: true }),
      scriptedClient([() => endTurn('不合格')]),
    );
    assert.equal(code, 1, '回滚成功也不改变「这次检查没通过」的事实');
    const restored = readFileSync(join(root, 'agents', 'main.md'), 'utf8');
    assert.notEqual(restored, after);
    assert.match(restored, /你是执行者。$/m);
    const entries = readJournal(loadConfig(root));
    assert.equal(entries.length, 2);
    assert.equal(entries[1]?.reverted, true);
  });

  it('资产被手改过时拒绝回滚：退出码 2（动作没做成），正文保持现状', async () => {
    const root = project();
    await accept(root);
    // 采纳之后又有人动了资产：自动回滚会连带抹掉那次改动
    const tampered = `${AGENT_HEAD}你是执行者。结论：开头。（手改）\n`;
    writeFileSync(join(root, 'agents', 'main.md'), tampered, 'utf8');

    const code = await regress(
      ctxOf(root, { revert: true }),
      scriptedClient([() => endTurn('不合格')]),
    );
    assert.equal(code, 2);
    assert.equal(readFileSync(join(root, 'agents', 'main.md'), 'utf8'), tampered);
    assert.equal(readJournal(loadConfig(root)).length, 1, '拒绝回滚就不能留回滚记录');
  });

  it('没有回归时 0，且不会因为带了 --revert 就白跑一次回滚', async () => {
    const root = project();
    const after = await accept(root);
    const code = await regress(
      ctxOf(root, { revert: true }),
      scriptedClient(Array.from({ length: 3 }, () => step(() => false))),
    );
    assert.equal(code, 0);
    assert.equal(readFileSync(join(root, 'agents', 'main.md'), 'utf8'), after);
    assert.equal(readJournal(loadConfig(root)).length, 1);
  });
});

describe('手工采纳也能被监测', () => {
  it('rsi accept --from 会落一份轮次记录，regress 因此找得到基准', async () => {
    const root = project();
    const config = loadConfig(root);
    const agent = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir }).agents[0];
    assert.ok(agent !== undefined);
    const proposalPath = join(root, 'proposal.json');
    writeFileSync(
      proposalPath,
      JSON.stringify({
        id: 'p-manual',
        modeId: 'm',
        kind: 'wrong_answer',
        rationale: '手写提案',
        manifest: {
          evidence: ['case:a'],
          hypothesis: '没规定输出格式',
          prediction: 'a 应转为通过',
          risk: '可能变长',
        },
        layer: 'L1',
        patch: { target: 'agent:main', before: agent.body, after: PATCHED },
      }),
      'utf8',
    );

    const accepted = await acceptFrom(
      { root, config, flags: { from: proposalPath }, agent: undefined },
      scriptedClient(Array.from({ length: 3 }, () => step(() => false))),
    );
    assert.equal(accepted, 0);

    // 没有这次落盘，regress 只能报「找不到基准」—— 手工采纳的改动就永远监测不到
    const code = await regress(
      ctxOf(root),
      scriptedClient(Array.from({ length: 3 }, () => step(() => false))),
    );
    assert.equal(code, 0, '采纳后没坏，就该报没有回归');
  });
});
