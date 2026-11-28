import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scriptedClient } from '@migor/agentia';
import { discoverAssets } from '../src/assets/discover.ts';
import { readLock } from '../src/assets/lockfile.ts';
import { loadConfig } from '../src/config.ts';
import { runSuite } from '../src/evals/run.ts';
import { acceptManually, acceptProposal, readJournal, revertLast } from '../src/rsi/accept.ts';
import { attribute, classify } from '../src/rsi/attribute.ts';
import { runCycle } from '../src/rsi/loop.ts';
import { LlmProposer } from '../src/rsi/propose.ts';
import { lastAccepted } from '../src/rsi/regress.ts';
import type { FailureMode, FailureSample, Proposal } from '../src/rsi/types.ts';
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

function sample(
  failures: string[],
  stopReason = 'end_turn',
  c = 'e1',
  skills: string[] = [],
  subagents: string[] = [],
): FailureSample {
  return {
    case: c,
    failures,
    stopReason,
    tokens: 10,
    iterations: 2,
    excerpt: '输出',
    skills,
    subagents,
  };
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

    const { entry } = acceptProposal(config, assets, outcome);
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

    // 指定错误 id 时拒绝 —— 防止期间插入了新采纳而误退
    assert.throws(() => revertLast(config, 'p-someone-else'), /最近一条可回滚的采纳是 p-good/);

    // 指定正确 id 才回滚，逐字恢复原文件
    const r = revertLast(config, 'p-good');
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

describe('已回滚的采纳不算数 —— append-only journal 的读法', () => {
  /**
   * journal 不回改原 accepted 行，只追加回滚记录。「最近一条采纳」必须读成
   * 「最近一条**仍生效**的采纳」（liveAccepted），否则二次回滚会撞上指纹校验，
   * 把「已经回过了」报成「有人手改过资产」—— 这两个病的修法完全不同。
   */
  function manualProposal(id: string, before: string, after: string): Proposal {
    return {
      id,
      modeId: 'm',
      kind: 'wrong_answer',
      rationale: 't',
      layer: 'L1',
      patch: { target: 'agent:main', before, after },
    };
  }

  it('二次回滚退的是上上条；全退完后报错区分「没有了」与「已经回过」', () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const agent = assets.agents[0];
    assert.ok(agent !== undefined);
    const original = readFileSync(agent.path, 'utf8');

    acceptManually(config, assets, manualProposal('p-1', agent.body, '第一版改动。'), '理由一');
    const afterFirst = readFileSync(agent.path, 'utf8');
    // p-2 的 before 必须是 p-1 落盘后的正文 —— 重新发现一遍拿真值
    const assets2 = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const body2 = assets2.agents[0]?.body;
    assert.ok(body2 !== undefined);
    acceptManually(config, assets2, manualProposal('p-2', body2, '第二版改动。'), '理由二');

    assert.equal(lastAccepted(config).proposalId, 'p-2');

    // 第一次回滚退 p-2；此后基准必须落到仍生效的 p-1，而不是已作废的 p-2
    revertLast(config);
    assert.equal(readFileSync(agent.path, 'utf8'), afterFirst);
    assert.equal(lastAccepted(config).proposalId, 'p-1');

    // 第二次回滚退 p-1（修复前这里会撞指纹校验，报「采纳之后资产又被改过」）
    revertLast(config);
    assert.equal(readFileSync(agent.path, 'utf8'), original);

    // 全退完：不带 id 与带已退过的 id 是两种报错，后者得说真话
    assert.throws(() => revertLast(config), /没有可回滚的采纳记录/);
    assert.throws(() => revertLast(config, 'p-1'), /已经被回滚过/);
    assert.throws(() => lastAccepted(config), /没有任何采纳记录/);
  });

  it('指定已回滚的 id 时，即使还有别的生效采纳也报「已经回过」', () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const agent = assets.agents[0];
    assert.ok(agent !== undefined);

    acceptManually(config, assets, manualProposal('p-1', agent.body, '第一版改动。'), '理由一');
    const assets2 = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const body2 = assets2.agents[0]?.body;
    assert.ok(body2 !== undefined);
    acceptManually(config, assets2, manualProposal('p-2', body2, '第二版改动。'), '理由二');

    revertLast(config, 'p-2');
    // p-1 仍生效，但指定 p-2 不能说成「最近一条是 p-1」—— 它是已经回过了
    assert.throws(() => revertLast(config, 'p-2'), /p-2 已经被回滚过/);
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

  it('预算超限就收工：连提案都不提（提案那一步也要花钱）', async () => {
    const root = project();
    writeFileSync(
      join(root, 'harness.config.json'),
      JSON.stringify({ model: 'claude-opus-5' }),
      'utf8',
    );
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });

    const report = await runCycle({
      config,
      assets,
      client: scriptedClient([endTurn('结论：合格')]),
      maxCostUsd: 1e-9,
      proposer: {
        propose: () => {
          throw new Error('预算已经超了，不该再调模型提方案');
        },
      },
    });

    assert.equal(report.costKnown, true);
    assert.ok(report.costUsd > 1e-9, `基线就该花钱，实际 $${report.costUsd}`);
    assert.equal(report.budget?.stopped, true);
    assert.equal(report.proposals.length, 0);
    assert.equal(report.modes.length, 0);
  });

  it('模型没定价时美元闸读不出数 ⇒ 判 blind 停下（不再静默放行）', async () => {
    const root = project();
    writeFileSync(
      join(root, 'harness.config.json'),
      JSON.stringify({ model: 'not-a-priced-model' }),
      'utf8',
    );
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });

    const report = await runCycle({
      config,
      assets,
      client: scriptedClient([endTurn('结论：合格')]),
      maxCostUsd: 0,
      proposer: { propose: async () => ({ proposals: [], cost: { usd: undefined, known: true } }) },
    });

    assert.equal(report.costKnown, false);
    // 旧行为是「不可信 ⇒ 判没超」，于是 --max-cost 一分钱也拦不住（静默失效）。
    // 现在：既没有可信美元读数、也没有 token 兜底 ⇒ 停下，并把原因写清楚。
    assert.equal(report.budget?.stopped, true, '闸瞎了必须停，不能判「没超」');
    assert.equal(report.budget?.stoppedBy, 'blind');
    assert.equal(report.budget?.usdBlind, true);
    assert.equal(report.costUsd, 0);
  });

  it('allowedTargets 拒绝的提案不验证、不花评测钱，理由写进记录', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });

    const report = await runCycle({
      config,
      assets,
      // 基线答非所问 ⇒ 有失败样本，才会走到提案
      client: scriptedClient([endTurn('不合格答案')]),
      proposer: {
        propose: async () => ({
          proposals: [
            {
              id: 'p-skill',
              modeId: 'm',
              kind: 'wrong_answer',
              rationale: '改技能正文',
              layer: 'L1',
              patch: { target: 'skill:review', before: '旧的', after: '新的' },
            },
          ],
          cost: { usd: 0, known: true },
        }),
      },
      // 远端只把 agent 提示词外置了：skill 目标没有文件可写
      allowedTargets: (t) => t === 'agent:main',
    });

    assert.equal(report.verified.length, 0, '没有文件映射的目标不能去验证（验了也是假的）');
    assert.equal(report.proposals.length, 1);
    const rejected = report.rejected.find((r) => r.proposal.id === 'p-skill');
    assert.ok(rejected !== undefined);
    assert.match(rejected.reason, /remote\.prompts/);
    assert.match(rejected.reason, /remote\.prompts|远端没有对应文件/);
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
          const proposals: Proposal[] = [
            {
              id: 'p-dry',
              modeId: ctx.modes[0]?.id ?? 'm',
              kind: 'wrong_answer',
              rationale: 't',
              layer: 'L1',
              patch: { target: 'agent:main', before: agent.body, after: '必须以「结论：」开头。' },
            },
          ];
          return { proposals, cost: { usd: undefined, known: true } };
        },
      },
    });

    assert.equal(call, 1);
    assert.equal(report.verified.length, 1);
    assert.equal(report.accepted.length, 1, 'dry-run 应记为「会采纳」');
    // 关键：盘上没变
    assert.equal(readFileSync(agent.path, 'utf8'), original);
    assert.equal(existsSync(config.lockPath), false, 'dry-run 不该写锁');

    // 但**记录必须落盘**：dry-run 也要能复盘「当时打算采纳什么」
    assert.equal(report.path, join(config.workspaceDir, 'rsi', 'cycles', `${report.cycleId}.json`));
    const saved = JSON.parse(readFileSync(report.path, 'utf8')) as {
      cycleId: string;
      dryRun: boolean;
      accepted: unknown[];
      modes: unknown[];
    };
    assert.equal(saved.cycleId, report.cycleId);
    assert.equal(saved.dryRun, true);
    assert.equal(saved.accepted.length, 1);
    assert.ok(saved.modes.length > 0, '记录里要有失败模式，否则事后无法解释为什么提这个案');
  });
});

describe('targets —— 提案改谁要有数据依据', () => {
  it('按走过它的失败用例数排序，平手时技能优先于 agent', () => {
    const modes = attribute([
      sample(['正文缺少 "结论"'], 'end_turn', 'e1', ['review']),
      sample(['正文缺少 "结论"'], 'end_turn', 'e2', ['review']),
      sample(['正文缺少 "结论"'], 'end_turn', 'e3', ['review', 'other'], ['writer']),
    ]);
    const mode = modes[0];
    assert.ok(mode !== undefined);
    assert.deepEqual(
      mode.targets.map((t) => t.target),
      ['skill:review', 'skill:other', 'agent:writer'],
    );
    assert.deepEqual(mode.targets[0]?.cases, ['e1', 'e2', 'e3']);
  });

  it('没有任何资产被调用时 targets 为空（提案才会回退到主 system）', () => {
    const mode = attribute([sample(['正文缺少 "结论"'])])[0];
    assert.ok(mode !== undefined);
    assert.deepEqual(mode.targets, []);
  });
});

describe('LlmProposer —— 按数据选目标、坏提案不拖垮整轮', () => {
  function skillProject(): string {
    const root = mkdtempSync(join(tmpdir(), 'harness-propose-'));
    const w = (rel: string, text: string): void => {
      const p = join(root, rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, text, 'utf8');
    };
    w('agents/main.md', '---\nname: main\ndescription: 主\n---\n你是执行者。\n');
    w('skills/review/SKILL.md', '---\nname: review\ndescription: 审稿\n---\n你审稿，只给结论。\n');
    return root;
  }

  function modeWith(target: string): FailureMode {
    return {
      id: 'm1',
      kind: 'wrong_answer',
      signature: '正文缺少内容',
      count: 1,
      cases: ['e1'],
      samples: [],
      targets: [{ target, cases: ['e1'] }],
    };
  }

  it('targets 指向技能时改技能正文，而不是第一个 agent', async () => {
    const root = skillProject();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const proposer = new LlmProposer(config);
    const { proposals } = await proposer.propose({
      modes: [modeWith('skill:review')],
      assets,
      config,
      client: scriptedClient([endTurn('你审稿。输出必须以「结论：」开头。')]),
    });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]?.patch.target, 'skill:review');
    assert.match(String(proposals[0]?.rationale), /1 条失败用例走过它/);
  });

  it('某条提案本身不合法 ⇒ 跳过并回执，其它模式照常产出', async () => {
    const root = skillProject();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const skips: string[] = [];
    const proposer = new LlmProposer(config, { onSkip: (id, why) => skips.push(`${id}|${why}`) });
    const noisy: FailureMode = { ...modeWith('agent:main'), id: 'm-noisy' };
    const good: FailureMode = { ...modeWith('skill:review'), id: 'm-good' };

    const { proposals } = await proposer.propose({
      modes: [noisy, good],
      assets,
      config,
      // 第一条是 30 倍膨胀（assertSane 会拒），第二条正常
      client: scriptedClient([endTurn('啰'.repeat(3000)), endTurn('你审稿。先给结论，再给依据。')]),
    });

    assert.equal(proposals.length, 1, '坏提案被跳过，好提案还在');
    assert.equal(proposals[0]?.modeId, 'm-good');
    assert.equal(skips.length, 1);
    assert.match(String(skips[0]), /^m-noisy\|/);
  });

  it('模型说 NONE ⇒ 不产出提案（也不记为失败）', async () => {
    const root = skillProject();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const skips: string[] = [];
    const proposer = new LlmProposer(config, { onSkip: (id) => skips.push(id) });
    const { proposals } = await proposer.propose({
      modes: [modeWith('skill:review')],
      assets,
      config,
      client: scriptedClient([endTurn('NONE')]),
    });
    assert.deepEqual(proposals, []);
    assert.deepEqual(skips, [], 'NONE 是合法结论，不是错误');
  });

  it('已经取消 ⇒ 一次模型调用都不发', async () => {
    const root = skillProject();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const abort = new AbortController();
    abort.abort();
    let calls = 0;

    const { proposals } = await new LlmProposer(config).propose({
      modes: [modeWith('skill:review')],
      assets,
      config,
      signal: abort.signal,
      client: scriptedClient([
        () => {
          calls++;
          return endTurn('你审稿。输出必须以「结论：」开头。');
        },
      ]),
    });

    assert.equal(calls, 0, '取消之后不该再开模型调用（每个模式一次，等于继续烧钱）');
    assert.deepEqual(proposals, []);
  });

  it('第一个模式跑到一半被取消 ⇒ 第二个模式不再发请求', async () => {
    const root = skillProject();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const abort = new AbortController();
    const first: FailureMode = { ...modeWith('skill:review'), id: 'm-1' };
    const second: FailureMode = { ...modeWith('agent:main'), id: 'm-2' };
    let calls = 0;

    await new LlmProposer(config).propose({
      modes: [first, second],
      assets,
      config,
      signal: abort.signal,
      client: scriptedClient([
        () => {
          calls++;
          abort.abort(); // 模拟用户在第一次调用期间按了 Ctrl-C
          return endTurn('你审稿。输出必须以「结论：」开头。');
        },
      ]),
    });

    assert.equal(calls, 1, `取消后不该继续提第二个模式，实际调用 ${calls} 次`);
  });
});

describe('提案器的模型与成本口径', () => {
  function projectWithModel(): {
    root: string;
    config: ReturnType<typeof loadConfig>;
    assets: ReturnType<typeof discoverAssets>;
  } {
    const root = mkdtempSync(join(tmpdir(), 'harness-propose-model-'));
    const w = (rel: string, text: string): void => {
      const p = join(root, rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, text, 'utf8');
    };
    w('agents/main.md', '---\nname: main\ndescription: 主\n---\n你是执行者。\n');
    w('skills/review/SKILL.md', '---\nname: review\ndescription: 审稿\n---\n你审稿，只给结论。\n');
    w(
      'harness.config.json',
      JSON.stringify({
        model: 'deepseek-flash',
        pricing: { 'deepseek-flash': { in: 0.15, out: 0.6 } },
      }),
    );
    const config = loadConfig(root);
    return {
      root,
      config,
      assets: discoverAssets({ skills: config.skillsDir, agents: config.agentsDir }),
    };
  }

  const MODE: FailureMode = {
    id: 'm1',
    kind: 'wrong_answer',
    signature: '正文缺少内容',
    count: 1,
    cases: ['e1'],
    samples: [],
    targets: [{ target: 'skill:review', cases: ['e1'] }],
  };

  it('提案器用工程生效模型，并按配置价格表记账', async () => {
    const { config, assets } = projectWithModel();
    const seen: string[] = [];
    const proposer = new LlmProposer(config);
    const { proposals, cost } = await proposer.propose({
      modes: [MODE],
      assets,
      config,
      client: scriptedClient([
        (params: unknown) => {
          seen.push((params as { model: string }).model);
          return endTurn('你审稿。输出必须以「结论：」开头。');
        },
      ]),
    });

    assert.equal(proposals.length, 1);
    assert.deepEqual(seen, ['deepseek-flash'], '提案器此前偷偷用 claude-opus-5');
    assert.ok((cost.usd ?? 0) > 0, '提案本身的花费要跟产出一起返回');
    assert.equal(cost.known, true);
  });

  it('模型没定价 ⇒ 提案花费标成「未知」而不是 0', async () => {
    const { config, assets } = projectWithModel();
    const unpriced = { ...config, pricing: {}, model: 'mystery-model' } as typeof config;
    const proposer = new LlmProposer(unpriced);
    const { cost } = await proposer.propose({
      modes: [MODE],
      assets,
      config: unpriced,
      client: scriptedClient([endTurn('你审稿。输出必须以「结论：」开头。')]),
    });
    assert.equal(cost.usd, undefined, '没读数就该是 undefined，不是 0');
    assert.equal(cost.known, false);
  });

  it('RSI 预算把提案花费算进去（此前只记基线与候选）', async () => {
    const root = project();
    writeFileSync(
      join(root, 'harness.config.json'),
      JSON.stringify({ model: 'claude-opus-5' }),
      'utf8',
    );
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const agent = assets.agents[0];
    assert.ok(agent !== undefined);

    const report = await runCycle({
      config,
      assets,
      client: scriptedClient([endTurn('不合格')]),
      maxCostUsd: 0.1,
      proposer: {
        propose: async (ctx) => ({
          proposals: [
            {
              id: 'p-cost',
              modeId: ctx.modes[0]?.id ?? 'm',
              kind: 'wrong_answer',
              rationale: 't',
              layer: 'L1',
              patch: { target: 'agent:main', before: agent.body, after: '必须以「结论：」开头。' },
            },
          ],
          cost: { usd: 0.5, known: true },
        }),
      },
    });

    assert.ok(report.costUsd >= 0.5, `提案的 $0.5 必须进账，实际 $${report.costUsd}`);
    assert.equal(report.budget?.stopped, true);
    assert.equal(report.accepted.length, 0);
  });
});

describe('轮次记录落盘', () => {
  it('cycle JSON 是完整可读的，且不留 .rsi-tmp 半截文件', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const report = await runCycle({
      config,
      assets,
      client: scriptedClient([endTurn('结论：合格')]),
      proposer: { propose: async () => ({ proposals: [], cost: { usd: undefined, known: true } }) },
    });

    const parsed = JSON.parse(readFileSync(report.path, 'utf8')) as { cycleId: string };
    assert.equal(parsed.cycleId, report.cycleId);
    const dir = join(root, '.workspace', 'rsi', 'cycles');
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.endsWith('.rsi-tmp')),
      [],
      '原子写成功后临时文件必须已 rename 掉',
    );
  });
});
