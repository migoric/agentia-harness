import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scriptedClient } from '@migor/agentia';
import { discoverAssets } from '../src/assets/discover.ts';
import { readLock } from '../src/assets/lockfile.ts';
import { loadConfig } from '../src/config.ts';
import { runSuite } from '../src/evals/run.ts';
import { acceptProposal, readJournal, revertLast } from '../src/rsi/accept.ts';
import { attribute, classify } from '../src/rsi/attribute.ts';
import { runCycle } from '../src/rsi/loop.ts';
import type { FailureSample, Proposal } from '../src/rsi/types.ts';
import { applyPatch, renderFile, verifyProposal } from '../src/rsi/verify.ts';

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

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-rsi-'));
  const w = (rel: string, text: string): void => {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text, 'utf8');
  };
  w(
    'agents/main.md',
    '---\nname: main\nversion: 1\ndescription: 主 agent\n---\n你是执行者。给出判定。\n',
  );
  w('evals/e1.md', '---\nname: e1\nexpect_contains: 结论\n---\n判断这段文字是否合格\n');
  return root;
}

function sample(failures: string[], stopReason = 'end_turn', c = 'e1'): FailureSample {
  return { case: c, failures, stopReason, tokens: 10, iterations: 2, excerpt: '输出' };
}

describe('归因', () => {
  it('classify 按失败形态分 kind（规则式，可单测）', () => {
    assert.equal(classify(sample(['正文缺少 "结论"'])).kind, 'wrong_answer');
    assert.equal(classify(sample(['工具序列不符：期望 a → b，实际 b'])).kind, 'tool_misuse');
    assert.equal(classify(sample(['token 超预算：30000 > 20000'])).kind, 'budget');
    assert.equal(classify(sample([], 'max_iterations')).kind, 'loop');
    assert.equal(classify(sample([], 'max_tokens')).kind, 'stop_abnormal');
    assert.equal(classify(sample(['run 抛出: boom'])).kind, 'tool_error');
  });

  it('同类失败聚成一个模式，具体值被归一化', () => {
    const modes = attribute([
      sample(['正文缺少 "结论"']),
      sample(['正文缺少 "P1"']),
      sample(['工具序列不符：期望 a，实际 b']),
    ]);
    assert.equal(modes.length, 2);
    const wrong = modes.find((m) => m.kind === 'wrong_answer');
    assert.equal(wrong?.count, 2, '两条「正文缺少」应聚成一个模式');
    assert.deepEqual(wrong?.cases, ['e1']);
  });

  it('按失败数降序：先修影响面大的', () => {
    const modes = attribute([
      ...Array.from({ length: 3 }, () => sample(['正文缺少 "x"'])),
      sample(['token 超预算：1 > 0'], 'end_turn', 'e2'),
    ]);
    assert.equal(modes[0]?.kind, 'wrong_answer');
    assert.equal(modes[0]?.count, 3);
  });

  it('collectFailures 只取失败的用例', () => {
    const modes = attribute([sample(['正文缺少 "x"'])]);
    assert.equal(modes.length, 1);
    // 空样本不产出模式
    assert.deepEqual(attribute([]), []);
  });
});

describe('applyPatch —— 内存改写', () => {
  it('改正文会同时改资产指纹与全体指纹', () => {
    const root = project();
    const set = discoverAssets({
      skills: join(root, 'skills'),
      agents: join(root, 'agents'),
    });
    const agent = set.agents[0];
    assert.ok(agent !== undefined);

    const next = applyPatch(set, {
      target: 'agent:main',
      before: agent.body,
      after: '你是执行者。判定必须以「结论：」开头。',
    });

    assert.notEqual(next.agents[0]?.body, agent.body);
    assert.notEqual(next.agents[0]?.fingerprint, agent.fingerprint);
    assert.notEqual(next.fingerprint, set.fingerprint);
    // 原对象没被改（不可变）
    assert.equal(set.agents[0]?.body, agent.body);
  });

  it('before 与当前正文不符时拒绝（乐观锁，防止覆盖别人的改动）', () => {
    const root = project();
    const set = discoverAssets({ skills: join(root, 'skills'), agents: join(root, 'agents') });
    assert.throws(
      () => applyPatch(set, { target: 'agent:main', before: '旧的正文', after: '新的' }),
      /基础版本已过期/,
    );
  });

  it('拒绝把正文改成空', () => {
    const root = project();
    const set = discoverAssets({ skills: join(root, 'skills'), agents: join(root, 'agents') });
    const body = set.agents[0]?.body ?? '';
    assert.throws(
      () => applyPatch(set, { target: 'agent:main', before: body, after: '   ' }),
      /空正文/,
    );
  });

  it('renderFile 逐字保留 frontmatter，只换正文', () => {
    const root = project();
    const path = join(root, 'agents/main.md');
    const out = renderFile(path, '新正文');
    assert.match(out, /^---\nname: main\nversion: 1\ndescription: 主 agent\n---\n/);
    assert.match(out, /新正文\n$/);
    assert.doesNotMatch(out, /你是执行者/);
  });

  it('renderFile 对「frontmatter 后有空行」的排版透明（曾少渲染一个空行，害采纳被误拒）', () => {
    const root = project();
    const path = join(root, 'agents/pad.md');
    const original = '---\nname: pad\ndescription: 带空行\n---\n\n原正文\n';
    writeFileSync(path, original, 'utf8');

    // 用当前正文渲染回来，必须与原文件**逐字相同**
    assert.equal(renderFile(path, '原正文'), original);

    // 换正文时，那个空行要留着
    assert.equal(
      renderFile(path, '新正文'),
      '---\nname: pad\ndescription: 带空行\n---\n\n新正文\n',
    );
  });
});

describe('闭环：验证 → 采纳 → 回滚', () => {
  it('改坏时的补丁被门否决，源文件不动', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const agent = assets.agents[0];
    assert.ok(agent !== undefined);

    // 基线：输出含「结论」→ 通过
    const baseline = await runSuite({
      config,
      assets,
      client: scriptedClient([endTurn('结论：合格')]),
    });
    assert.equal(baseline.passed, 1);

    // 候选：改坏了，输出不含「结论」
    const proposal: Proposal = {
      id: 'p-bad',
      modeId: 'm',
      kind: 'wrong_answer',
      rationale: '测试',
      layer: 'L1',
      patch: { target: 'agent:main', before: agent.body, after: '随便发挥。' },
    };
    const before = readFileSync(agent.path, 'utf8');
    const outcome = await verifyProposal({
      config,
      assets,
      baseline,
      proposal,
      client: scriptedClient([endTurn('合格')]),
    });

    assert.equal(outcome.gate.ok, false);
    assert.equal(outcome.gate.code, 'case_regression');
    // 验证阶段零副作用
    assert.equal(readFileSync(agent.path, 'utf8'), before);
  });

  it('改对时通过门；采纳写盘 + 更新锁；回滚逐字恢复', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const agent = assets.agents[0];
    assert.ok(agent !== undefined);
    const original = readFileSync(agent.path, 'utf8');

    // 基线：失败
    const baseline = await runSuite({
      config,
      assets,
      client: scriptedClient([endTurn('这个还不错')]),
    });
    assert.equal(baseline.passed, 0);

    // 候选：正文里加入强制格式，输出就带「结论：」了
    const proposal: Proposal = {
      id: 'p-good',
      modeId: 'm',
      kind: 'wrong_answer',
      rationale: '要求固定输出格式',
      layer: 'L1',
      patch: {
        target: 'agent:main',
        before: agent.body,
        after: '你是执行者。任何回答都必须以「结论：」开头。',
      },
    };
    const outcome = await verifyProposal({
      config,
      assets,
      baseline,
      proposal,
      client: scriptedClient([endTurn('结论：合格')]),
    });

    assert.equal(outcome.gate.ok, true, `门应放行，实际：${outcome.gate.reason}`);
    assert.deepEqual(outcome.gate.fixedCases, ['e1']);

    const entry = acceptProposal(config, assets, outcome);
    assert.equal(entry.status, 'accepted');

    // 文件真的改了，frontmatter 还在
    const after = readFileSync(agent.path, 'utf8');
    assert.match(after, /结论：」开头/);
    assert.match(after, /^---\nname: main/);

    // 锁同步更新到新指纹
    const lock = readLock(config.lockPath);
    const relocked = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    assert.equal(lock.assets['agent:main']?.fingerprint, relocked.agents[0]?.fingerprint);

    // journal 有一条
    assert.equal(readJournal(config).length, 1);

    // 回滚逐字恢复原文件
    const r = revertLast(config);
    assert.equal(r.entry.status, 'rejected');
    assert.equal(readFileSync(agent.path, 'utf8'), original);
  });

  it('采纳后有人手改过，回滚拒绝（不抹掉别人的改动）', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const agent = assets.agents[0];
    assert.ok(agent !== undefined);

    const baseline = await runSuite({
      config,
      assets,
      client: scriptedClient([endTurn('不合格')]),
    });
    const proposal: Proposal = {
      id: 'p-2',
      modeId: 'm',
      kind: 'wrong_answer',
      rationale: 't',
      layer: 'L1',
      patch: { target: 'agent:main', before: agent.body, after: '必须以「结论：」开头。' },
    };
    const outcome = await verifyProposal({
      config,
      assets,
      baseline,
      proposal,
      client: scriptedClient([endTurn('结论：好')]),
    });
    acceptProposal(config, assets, outcome);

    // 人手再改一次
    writeFileSync(agent.path, `${readFileSync(agent.path, 'utf8')}\n手改的一行\n`, 'utf8');

    assert.throws(() => revertLast(config), /采纳之后资产又被改过/);
  });
});

describe('runCycle —— 五步编排', () => {
  it('没有失败时不提案（避免无意义改动）', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });

    const report = await runCycle({
      config,
      assets,
      client: scriptedClient([endTurn('结论：合格')]),
      // 不该被调到；真调到了就抛
      proposer: {
        propose: () => {
          throw new Error('没有失败样本时不该提案');
        },
      },
    });
    assert.equal(report.modes.length, 0);
    assert.equal(report.proposals.length, 0);
    assert.equal(report.accepted.length, 0);
  });

  it('dry-run 只验证不落盘', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const agent = assets.agents[0];
    assert.ok(agent !== undefined);
    const original = readFileSync(agent.path, 'utf8');

    let call = 0;
    // 第一次 run 是 baseline（失败），之后是候选（成功）
    const client = scriptedClient([endTurn('不合格'), endTurn('结论：合格')]);
    const report = await runCycle({
      config,
      assets,
      client,
      dryRun: true,
      proposer: {
        propose: async (ctx) => {
          call++;
          assert.ok(ctx.modes.length > 0);
          return [
            {
              id: 'p-dry',
              modeId: ctx.modes[0]?.id ?? 'm',
              kind: 'wrong_answer',
              rationale: 't',
              layer: 'L1',
              patch: { target: 'agent:main', before: agent.body, after: '必须以「结论：」开头。' },
            },
          ];
        },
      },
    });

    assert.equal(call, 1);
    assert.equal(report.verified.length, 1);
    assert.equal(report.accepted.length, 1, 'dry-run 应记为「会采纳」');
    // 关键：盘上没变
    assert.equal(readFileSync(agent.path, 'utf8'), original);
    assert.equal(existsSync(config.lockPath), false, 'dry-run 不该写锁');
  });
});
