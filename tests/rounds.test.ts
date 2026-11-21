import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scriptedClient } from '@migor/agentia';
import { discoverAssets } from '../src/assets/discover.ts';
import { loadConfig } from '../src/config.ts';
import { lessonsOf } from '../src/rsi/ledger.ts';
import { runCycle } from '../src/rsi/loop.ts';
import { LlmProposer } from '../src/rsi/propose.ts';
import { checkRegression } from '../src/rsi/regress.ts';
import { runRounds } from '../src/rsi/rounds.ts';
import { runCli } from './support/cli.ts';

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

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-rounds-'));
  const w = (rel: string, text: string): void => {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text, 'utf8');
  };
  w('agents/main.md', `${AGENT_HEAD}你是执行者。\n`);
  w('evals/a.md', '---\nname: a\nexpect_contains: 结论\n---\n任务甲\n');
  return root;
}

function setup(root: string) {
  const config = loadConfig(root);
  return { config, assets: discoverAssets({ skills: config.skillsDir, agents: config.agentsDir }) };
}

describe('runRounds —— 连续自进化', () => {
  it('采纳一轮后没有新的失败就停；且第 2 轮基线必须看到采纳后的新正文', async () => {
    const root = project();
    const { config, assets } = setup(root);
    const systems: string[] = [];

    // 按 system 内容分派，而不是按调用序号 —— 序号的写法会让「第 2 轮仍用旧资产」
    // 这个 bug 静默通过（旧实现照样返回「合格」）
    const step = (params: unknown) => {
      const p = params as { system?: string | Array<{ text?: string }>; messages?: unknown };
      const system =
        typeof p.system === 'string'
          ? p.system
          : (p.system ?? []).map((b) => b.text ?? '').join('\n');
      if (system.includes('提示词工程师')) return endTurn('你是执行者。结论：开头。');
      systems.push(system);
      const patched = system.includes('结论：开头');
      return endTurn(patched ? '结论：合格' : '不合格');
    };

    const result = await runRounds({
      config,
      assets,
      rounds: 5,
      client: scriptedClient(Array.from({ length: 6 }, () => step)),
      makeProposer: () => new LlmProposer(config),
    });

    assert.equal(result.acceptedRounds, 1);
    assert.equal(result.stopReason, 'no_failures');
    assert.equal(result.rounds.length, 2, '第二轮基线已经全绿，不该再跑第三轮');
    assert.equal(systems.length, 3, '两次基线 + 一次候选');
    assert.ok(systems[2]?.includes('结论：开头'), '第 2 轮基线必须用采纳后的资产');
  });

  it('priorSpentUsd 让 --max-cost 变成「整次运行」的上限，本轮 costUsd 仍是单轮口径', async () => {
    const root = project();
    const { config, assets } = setup(root);
    const report = await runCycle({
      config,
      assets,
      maxCostUsd: 1,
      priorSpentUsd: 5,
      client: scriptedClient([() => endTurn('不合格')]),
      proposer: new LlmProposer(config),
    });
    assert.equal(report.budget?.stopped, true, '之前花掉的钱要算进来');
    assert.ok((report.budget?.spentUsd ?? 0) >= 5);
    assert.ok(report.costUsd < 1, '本轮自己的花费不能把历史算进去');
  });

  it('跑完才发现超限也记「预算用完」：否则 --rounds 会多跑一整轮基线才发现没钱', async () => {
    const root = project();
    // 定价表自己写，成本才可算：15 token = 15e-6 美元，大响应 = 2000e-6
    writeFileSync(
      join(root, 'harness.config.json'),
      JSON.stringify({ pricing: { 'claude-opus-5': { in: 1, out: 1 } } }),
      'utf8',
    );
    const { config, assets } = setup(root);
    const big = {
      input_tokens: 10,
      output_tokens: 2000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const report = await runCycle({
      config,
      assets,
      // 上限落在「基线 + 提案」与「再加一遍候选」之间：验证能开始，但跑完就超了
      maxCostUsd: 0.0008,
      client: scriptedClient([
        () => endTurn('不合格'),
        () => endTurn('你是执行者。结论：开头。'),
        () => ({ ...endTurn('结论：合格'), usage: big }),
      ]),
      proposer: new LlmProposer(config),
    });

    assert.equal(report.accepted.length, 1, '前置条件：这一轮确实采纳了（不是被预算拦下的）');
    assert.ok(report.costUsd > 0.0008, `成本应已超限，实际 ${report.costUsd}`);
    assert.equal(
      report.budget?.stopped,
      true,
      '跑完才发现超限必须记下来 —— 否则 --rounds 会再开一轮，先跑一遍基线才发现没钱',
    );
  });

  it('没走到提案那一步时 historyConsulted 缺席，而不是写成「看到了 N 条」', async () => {
    const root = project();
    const { config, assets } = setup(root);
    // 先造一条真教训：改了一版没让任何用例变好
    const failing = await runCycle({
      config,
      assets,
      client: scriptedClient([
        () => endTurn('不合格'),
        () => endTurn('你是执行者。（无效改动）'),
        () => endTurn('不合格'),
      ]),
      proposer: new LlmProposer(config),
    });
    assert.equal(failing.accepted.length, 0);
    assert.equal(lessonsOf(config).length, 1, '前置条件：账本里得先有一条教训');

    // 这一轮基线全绿 → 没有失败模式 → 提案器根本没跑
    const clean = await runCycle({
      config,
      assets,
      client: scriptedClient([() => endTurn('结论：合格')]),
      proposer: new LlmProposer(config),
    });
    assert.equal(clean.modes.length, 0);
    assert.equal(
      clean.historyConsulted,
      undefined,
      '没提案就不能说「参考了 N 条历史」—— 缺席 / 0 / N 三态必须分得开',
    );
  });

  it('基线就超预算时同样不写 historyConsulted（提案器根本没跑）', async () => {
    const root = project();
    // 先造一条教训
    const first = setup(root);
    await runCycle({
      config: first.config,
      assets: first.assets,
      client: scriptedClient([
        () => endTurn('不合格'),
        () => endTurn('你是执行者。（无效改动）'),
        () => endTurn('不合格'),
      ]),
      proposer: new LlmProposer(first.config),
    });
    assert.equal(lessonsOf(first.config).length, 1);

    // 定价表写死，基线一遍就超限（15 token = 15e-6 > 1e-6）
    writeFileSync(
      join(root, 'harness.config.json'),
      JSON.stringify({ pricing: { 'claude-opus-5': { in: 1, out: 1 } } }),
      'utf8',
    );
    const second = setup(root);
    const report = await runCycle({
      config: second.config,
      assets: second.assets,
      maxCostUsd: 0.000001,
      client: scriptedClient([() => endTurn('不合格')]),
      proposer: new LlmProposer(second.config),
    });
    assert.equal(report.budget?.stopped, true);
    assert.equal(report.proposals.length, 0, '预算闸在提案之前');
    assert.equal(report.historyConsulted, undefined);
  });

  it('有轮次没定价时 RoundsReport.costKnown 为 false（成本未知不是免费）', async () => {
    const root = project();
    // 模型不在价格表里：token 报得出、钱算不出来
    writeFileSync(
      join(root, 'agents', 'main.md'),
      `---\nname: main\nversion: 1\ndescription: 主 agent\nmodel: mystery-model-1\n---\n你是执行者。\n`,
      'utf8',
    );
    const { config, assets } = setup(root);
    const result = await runRounds({
      config,
      assets,
      rounds: 1,
      client: scriptedClient([() => endTurn('结论：合格')]),
      makeProposer: () => new LlmProposer(config),
    });
    assert.equal(result.rounds[0]?.costKnown, false);
    assert.equal(
      result.costKnown,
      false,
      '各轮都未知时总分不能报「已知」—— CLI 会拿它印一个确切的美元数',
    );
  });

  it('dryRun 配多轮被判为用错（资产不变，后面几轮只是重复）', async () => {
    const root = project();
    const { config, assets } = setup(root);
    await assert.rejects(
      () =>
        runRounds({
          config,
          assets,
          rounds: 3,
          dryRun: true,
          client: scriptedClient([() => endTurn('x')]),
          makeProposer: () => new LlmProposer(config),
        }),
      /dryRun 与多轮不能同时用/,
    );
  });

  it('轮数必须是正整数', async () => {
    const root = project();
    const { config, assets } = setup(root);
    await assert.rejects(
      () =>
        runRounds({
          config,
          assets,
          rounds: 0,
          client: scriptedClient([]),
          makeProposer: () => new LlmProposer(config),
        }),
      /必须是正整数/,
    );
  });
});

describe('rsi --rounds 的用法校验（CLI 层）', () => {
  it('--rounds 0 是用法错误：退出码 2，且在校验标志位时就拦下（不去要凭据）', () => {
    const root = project();
    const r = runCli(['rsi', '--rounds', '0'], root, { ANTHROPIC_API_KEY: undefined });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /--rounds 必须是正整数/);
  });

  it('--rounds 配 --dry-run 也被拦下', () => {
    const root = project();
    const r = runCli(['rsi', '--rounds', '3', '--dry-run'], root, {
      ANTHROPIC_API_KEY: undefined,
    });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /dryRun 与多轮不能同时用/);
  });
});

describe('checkRegression —— 采纳之后有没有被改坏', () => {
  it('指出哪条用例从通过变成失败，并标出资产已被人改过', async () => {
    const root = project();
    const first = setup(root);
    await runCycle({
      config: first.config,
      assets: first.assets,
      client: scriptedClient([
        () => endTurn('不合格'),
        () => endTurn('你是执行者。结论：开头。'),
        () => endTurn('结论：合格'),
      ]),
      proposer: new LlmProposer(first.config),
    });

    // 模拟「后来有人把资产改坏了」：资产指纹与 journal 里记的 assetsAfter 不再一致
    writeFileSync(join(root, 'agents', 'main.md'), `${AGENT_HEAD}你是执行者。（被改坏）\n`, 'utf8');
    const now = setup(root);

    const report = await checkRegression({
      config: now.config,
      assets: now.assets,
      client: scriptedClient([() => endTurn('不合格')]),
    });

    assert.deepEqual(report.expected, ['a'], '采纳时 a 是通过的');
    assert.equal(report.regressed.length, 1);
    assert.equal(report.regressed[0]?.case, 'a');
    assert.ok((report.regressed[0]?.failures.length ?? 0) > 0);
    assert.notEqual(report.assetsNow, report.assetsAtAccept);
  });

  it('只把「采纳时通过、现在挂了」算回归，本来就没过的不算', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-regress-'));
    const w = (rel: string, text: string): void => {
      const p = join(root, rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, text, 'utf8');
    };
    w('agents/main.md', `${AGENT_HEAD}你是执行者。\n`);
    w('evals/a.md', '---\nname: a\nexpect_contains: 结论\n---\n任务甲\n');
    w('evals/b.md', '---\nname: b\nexpect_contains: 永远不会出现\n---\n任务乙\n');
    const first = setup(root);

    // 按内容分派，避免脚本游标与用例执行顺序耦合
    const step = (params: unknown) => {
      const p = params as { system?: string | Array<{ text?: string }>; messages?: unknown };
      const system =
        typeof p.system === 'string'
          ? p.system
          : (p.system ?? []).map((b) => b.text ?? '').join('\n');
      const msg = JSON.stringify(p.messages ?? []);
      if (msg.includes('任务甲'))
        return endTurn(system.includes('结论：开头') ? '结论：合格' : '不合格');
      if (msg.includes('任务乙')) return endTurn('不合格');
      return endTurn('你是执行者。结论：开头。');
    };

    await runCycle({
      config: first.config,
      assets: first.assets,
      client: scriptedClient(Array.from({ length: 8 }, () => step)),
      proposer: new LlmProposer(first.config),
    });

    // 采纳后把资产改坏：a 会重新失败，b 本来就一直失败
    writeFileSync(join(root, 'agents', 'main.md'), `${AGENT_HEAD}你是执行者。（被改坏）\n`, 'utf8');
    const now = setup(root);
    const report = await checkRegression({
      config: now.config,
      assets: now.assets,
      client: scriptedClient(Array.from({ length: 4 }, () => step)),
    });

    assert.deepEqual(
      report.regressed.map((r) => r.case),
      ['a'],
      'b 从来就没通过，不是回归',
    );
  });

  it('没有采纳记录时直接报错，不假装「没有回归」', async () => {
    const root = project();
    const { config, assets } = setup(root);
    await assert.rejects(
      () => checkRegression({ config, assets, client: scriptedClient([]) }),
      /没有任何采纳记录/,
    );
  });

  it('基准取 train 与 holdout 的并集：留出集用例退步也算', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-regress-'));
    const w = (rel: string, text: string): void => {
      const p = join(root, rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, text, 'utf8');
    };
    w('agents/main.md', `${AGENT_HEAD}你是执行者。\n`);
    w('evals/a.md', '---\nname: a\nexpect_contains: 结论\n---\n任务甲\n');
    w('evals/h.md', '---\nname: h\nsplit: holdout\nexpect_contains: 结论\n---\n任务乙\n');
    const first = setup(root);
    const step = (params: unknown) => {
      const p = params as { system?: string | Array<{ text?: string }> };
      const system =
        typeof p.system === 'string'
          ? p.system
          : (p.system ?? []).map((b) => b.text ?? '').join('\n');
      // 提案器与主 agent 共用一个客户端：靠 system 区分身份（序号派发会和执行顺序耦合）
      if (system.includes('提示词工程师')) return endTurn('你是执行者。结论：开头。');
      return endTurn(system.includes('结论：开头') ? '结论：合格' : '不合格');
    };
    await runCycle({
      config: first.config,
      assets: first.assets,
      client: scriptedClient(Array.from({ length: 8 }, () => step)),
      proposer: new LlmProposer(first.config),
    });

    const now = setup(root);
    const report = await checkRegression({
      config: now.config,
      assets: now.assets,
      client: scriptedClient(Array.from({ length: 4 }, () => step)),
    });
    assert.deepEqual(
      [...report.expected].sort(),
      ['a', 'h'],
      '采纳当时通过的是 train + holdout 两份候选报告的并集',
    );
  });

  it('采纳时通过的用例被删掉：算 missingCases，不能因为「找不到失败」就报绿', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-regress-'));
    const w = (rel: string, text: string): void => {
      const p = join(root, rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, text, 'utf8');
    };
    w('agents/main.md', `${AGENT_HEAD}你是执行者。\n`);
    w('evals/a.md', '---\nname: a\nexpect_contains: 结论\n---\n任务甲\n');
    w('evals/b.md', '---\nname: b\nexpect_contains: 结论\n---\n任务乙\n');
    const first = setup(root);
    const step = (params: unknown) => {
      const p = params as { system?: string | Array<{ text?: string }> };
      const system =
        typeof p.system === 'string'
          ? p.system
          : (p.system ?? []).map((b) => b.text ?? '').join('\n');
      if (system.includes('提示词工程师')) return endTurn('你是执行者。结论：开头。');
      return endTurn(system.includes('结论：开头') ? '结论：合格' : '不合格');
    };
    await runCycle({
      config: first.config,
      assets: first.assets,
      client: scriptedClient(Array.from({ length: 8 }, () => step)),
      proposer: new LlmProposer(first.config),
    });
    // 采纳之后有人把 a 删了（改名同理）—— 它对这次采纳仍是「通过过」的用例
    rmSync(join(root, 'evals', 'a.md'));

    const now = setup(root);
    const report = await checkRegression({
      config: now.config,
      assets: now.assets,
      client: scriptedClient(Array.from({ length: 4 }, () => step)),
    });
    assert.deepEqual([...report.expected].sort(), ['a', 'b']);
    assert.deepEqual(report.regressed, [], 'a 不是变红，是不在了');
    assert.deepEqual(report.missingCases, ['a']);
  });

  it('找不到那次采纳的验证记录时报错，不拿 journal 的 after 重跑充数', async () => {
    const root = project();
    const { config, assets } = setup(root);
    // journal 里有采纳，但 cycles 目录是空的（比如记录被删）
    mkdirSync(join(root, '.workspace', 'rsi'), { recursive: true });
    writeFileSync(
      join(root, '.workspace', 'rsi', 'journal.jsonl'),
      `${JSON.stringify({
        at: 1,
        proposalId: 'p-ghost',
        status: 'accepted',
        target: 'agent:main',
        before: '旧',
        after: '新',
        reason: '过了门',
        assetsBefore: 'fp',
        assetsAfter: 'fp2',
        kind: 'asset',
      })}\n`,
      'utf8',
    );
    await assert.rejects(
      () => checkRegression({ config, assets, client: scriptedClient([]) }),
      /找不到 p-ghost 的验证记录/,
    );
  });
});
