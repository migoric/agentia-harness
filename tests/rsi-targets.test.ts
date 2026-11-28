/**
 * 候选目标表 + 备用目标 + 超限重试。
 *
 * 三件事绑在一起测，因为它们是一整条因果链：归因给出「谁碰过这条用例」→ 候选表
 * 把主 agent 放在最后 → 首选被门否决后换下一个目标重提一次案。任何一环断掉，
 * 真机上看到的现象都一样：**一轮跑完，什么都没采纳，而病根在没被考虑过的那个文件上**。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scriptedClient, type Trace } from '@migor/agentia';
import { discoverAssets } from '../src/assets/discover.ts';
import { loadConfig } from '../src/config.ts';
import type { EvalReport } from '../src/evals/types.ts';
import { attribute } from '../src/rsi/attribute.ts';
import { audienceFrom } from '../src/rsi/audience.ts';
import { runCycle } from '../src/rsi/loop.ts';
import { LlmProposer, maxAfterChars, type Proposer } from '../src/rsi/propose.ts';
import { targetCandidates } from '../src/rsi/targets.ts';
import type { FailureMode, FailureSample, Proposal } from '../src/rsi/types.ts';
import type { CaseRunner } from '../src/run/case-runner.ts';
import type { RunOutcome } from '../src/run/runner.ts';

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

const TRACE = {
  traceId: 't-1',
  startedAt: 0,
  endedAt: 1,
  spans: [],
  totalUsage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
} as unknown as Trace;

/** 一个带技能的最小工程：技能是「该改哪儿」的第一个候选 */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-targets-'));
  const w = (rel: string, text: string): void => {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text, 'utf8');
  };
  w('agents/main.md', '---\nname: main\nversion: 1\ndescription: 主 agent\n---\n你是执行者。\n');
  w('skills/s/SKILL.md', '---\nname: s\ndescription: 口径查询\n---\n你查口径。\n');
  w('evals/e1.md', '---\nname: e1\nexpect_contains: 结论\n---\n判断这段文字是否合格\n');
  return root;
}

function sample(
  c: string,
  skills: string[],
  routedTo: string | undefined,
  failures = ['正文缺少 "结论"'],
): FailureSample {
  return {
    case: c,
    failures,
    stopReason: 'end_turn',
    tokens: 10,
    iterations: 1,
    excerpt: '输出',
    skills,
    subagents: [],
    ...(routedTo === undefined ? {} : { routedTo }),
  };
}

describe('targetCandidates —— 顺序就是「先试影响面小的」', () => {
  function fixture(): {
    assets: ReturnType<typeof discoverAssets>;
    mode: FailureMode;
  } {
    const config = loadConfig(project());
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const mode = attribute([sample('e1', ['s'], 'main'), sample('e2', ['s'], 'main')])[0];
    assert.ok(mode !== undefined);
    return { assets, mode };
  }

  it('技能在前、主 agent 在最后（主的覆盖面是全部，按数量排它永远第一）', () => {
    const { assets, mode } = fixture();
    const keys = targetCandidates({ mode, assets }).map((c) => c.key);
    assert.deepEqual(keys, ['skill:s', 'agent:main']);
    const root = targetCandidates({ mode, assets }).at(-1);
    assert.equal(root?.root, true);
    assert.match(root?.why ?? '', /影响面比技能大/);
  });

  it('主 agent 由 routedTo 决定，而不是「工程里的第一个 agent」', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-targets-a-'));
    const w = (rel: string, text: string): void => {
      const p = join(root, rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, text, 'utf8');
    };
    // 名字顺序上 alpha 在 zulu 前面，但 zulu 才是作答的那个
    w('agents/alpha.md', '---\nname: alpha\ndescription: 甲\n---\n甲。\n');
    w('agents/zulu.md', '---\nname: zulu\ndescription: 乙\n---\n乙。\n');
    w('evals/e1.md', '---\nname: e1\nexpect_contains: 结论\n---\n任务\n');
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const mode = attribute([sample('e1', [], 'zulu')])[0];
    assert.ok(mode !== undefined);

    const keys = targetCandidates({ mode, assets }).map((c) => c.key);
    assert.deepEqual(keys, ['agent:zulu'], '没有技能时主 agent 是唯一候选，且必须是作答的那个');

    // 平票时取先出现的（样本顺序 = 用例顺序，稳定，不会因对象键序抖动）
    const mixed = attribute([
      sample('e1', [], 'zulu'),
      sample('e2', [], 'alpha'),
      sample('e3', [], 'zulu'),
    ])[0];
    assert.ok(mixed !== undefined);
    assert.deepEqual(
      targetCandidates({ mode: mixed, assets }).map((c) => c.key),
      ['agent:zulu'],
    );
  });

  it('--agent 压过统计：人指定的就是指定的', () => {
    const { assets, mode } = fixture();
    const keys = targetCandidates({ mode, assets, agent: 'main' }).map((c) => c.key);
    assert.deepEqual(keys, ['skill:s', 'agent:main']);
    assert.match(
      targetCandidates({ mode, assets, agent: 'main' }).at(-1)?.why ?? '',
      /--agent 指定/,
    );
  });
});

describe('LlmProposer —— 排除已试目标就往下走', () => {
  it('avoidTargets 里有技能时改写主 agent', async () => {
    const config = loadConfig(project());
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const mode = attribute([sample('e1', ['s'], 'main')])[0];
    assert.ok(mode !== undefined);

    const { proposals } = await new LlmProposer(config).propose({
      modes: [mode],
      assets,
      config,
      avoidTargets: ['skill:s'],
      client: scriptedClient([endTurn('你是执行者。输出必须以「结论：」开头。')]),
    });
    assert.equal(proposals[0]?.patch.target, 'agent:main');
    assert.match(proposals[0]?.rationale ?? '', /没有任何资产被调用过|影响面比技能大/);
  });

  it('所有候选都被排除时报清楚，而不是产出一个重复提案', async () => {
    const config = loadConfig(project());
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const mode = attribute([sample('e1', ['s'], 'main')])[0];
    assert.ok(mode !== undefined);
    const skips: string[] = [];
    const out = await new LlmProposer(config, { onSkip: (_i, r) => skips.push(r) }).propose({
      modes: [mode],
      assets,
      config,
      avoidTargets: ['skill:s', 'agent:main'],
      client: scriptedClient([endTurn('不该被调用')]),
    });
    assert.equal(out.proposals.length, 0);
    assert.match(skips[0] ?? '', /可改的目标都已试过/);
  });
});

describe('超限给一次压缩机会（上限不变，只是让失败可恢复）', () => {
  const SHORT = '你是查口径的。读工单描述，返回一条最贴合的适用口径。';

  function limitProject(): string {
    const root = mkdtempSync(join(tmpdir(), 'harness-tighten-'));
    const w = (rel: string, text: string): void => {
      const p = join(root, rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, text, 'utf8');
    };
    w('agents/main.md', '---\nname: main\ndescription: 主\n---\n你是执行者。\n');
    w('skills/s/SKILL.md', `---\nname: s\ndescription: 口径\n---\n${SHORT}\n`);
    w('evals/e1.md', '---\nname: e1\nexpect_contains: 结论\n---\n任务\n');
    return root;
  }

  it('第一稿超长 ⇒ 再问一次；第二稿达标就留下', async () => {
    const config = loadConfig(limitProject());
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const mode = attribute([sample('e1', ['s'], 'main')])[0];
    assert.ok(mode !== undefined);
    const over = `你是查口径的。${'把工单原文抄一遍。'.repeat(60)}`;
    assert.ok(over.length > maxAfterChars(SHORT), `第一稿应当超限，实际 ${over.length}`);

    const prompts: string[] = [];
    const client = scriptedClient([
      (params: unknown) => {
        prompts.push(JSON.stringify(params));
        return endTurn(over);
      },
      (params: unknown) => {
        prompts.push(JSON.stringify(params));
        return endTurn(
          '你是查口径的。读工单描述，返回一条最贴合的适用口径；没有就回「无适用口径」。',
        );
      },
    ]);
    const out = await new LlmProposer(config).propose({ modes: [mode], assets, config, client });
    assert.equal(out.proposals.length, 1, '第二稿应被留下，而不是整条丢弃');
    assert.equal(prompts.length, 2, '超限后应当再问一次');
    assert.match(prompts[1] ?? '', /超过上限/, '第二次要说清超了多少');
    assert.match(prompts[1] ?? '', /不要靠删约束来达标/, '不然模型会把输出格式删掉');
  });

  it('第二稿还超限 ⇒ 才丢弃，理由照旧带上限值', async () => {
    const config = loadConfig(limitProject());
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const mode = attribute([sample('e1', ['s'], 'main')])[0];
    assert.ok(mode !== undefined);
    const over = `你是查口径的。${'把工单原文抄一遍。'.repeat(60)}`;
    const skips: string[] = [];
    const out = await new LlmProposer(config, { onSkip: (_i, r) => skips.push(r) }).propose({
      modes: [mode],
      assets,
      config,
      client: scriptedClient([endTurn(over), endTurn(over)]),
    });
    assert.equal(out.proposals.length, 0);
    assert.match(skips[0] ?? '', /上限 \d+/);
  });
});

describe('audienceFrom —— 回归门的前置告知', () => {
  function rep(
    cases: {
      name: string;
      passed: boolean;
      skills?: string[];
      subagents?: string[];
      routedTo?: string;
    }[],
  ): EvalReport {
    return {
      cases: cases.map((c) => ({
        name: c.name,
        task: c.name,
        passed: c.passed,
        failures: c.passed ? [] : ['断言失败'],
        tokens: 1,
        costUsd: 0.01,
        iterations: 1,
        durationMs: 1,
        stopReason: 'end_turn',
        excerpt: '',
        skills: c.skills ?? [],
        subagents: c.subagents ?? [],
        ...(c.routedTo === undefined ? {} : { routedTo: c.routedTo }),
      })),
      // 其余字段本函数不读
    } as unknown as EvalReport;
  }

  it('技能目标 ⇒ 调用过它的用例，按通过/失败分开', () => {
    const of = audienceFrom(
      rep([
        { name: 'a', passed: true, skills: ['q'], routedTo: 'main' },
        { name: 'b', passed: false, skills: ['q'], routedTo: 'main' },
        { name: 'c', passed: true, skills: [], routedTo: 'main' },
      ]),
    );
    assert.deepEqual(of('skill:q'), { passing: ['a'], failing: ['b'] });
    assert.equal(of('skill:nobody'), undefined, '没人用过就不要给出一节空话');
  });

  it('agent 目标 ⇒ 派给过它的用例', () => {
    const of = audienceFrom(
      rep([
        { name: 'a', passed: true, routedTo: 'main' },
        { name: 'b', passed: false, subagents: ['helper'], routedTo: 'main' },
      ]),
    );
    assert.deepEqual(of('agent:main'), { passing: ['a'], failing: ['b'] });
    assert.deepEqual(of('agent:helper'), { passing: [], failing: ['b'] });
  });

  it('老报告没有 routedTo ⇒ agent 目标按「全部用例都用它」算（而不是没人用）', () => {
    const of = audienceFrom(
      rep([
        { name: 'a', passed: true },
        { name: 'b', passed: false },
      ]),
    );
    assert.deepEqual(of('agent:main'), { passing: ['a'], failing: ['b'] });
    assert.equal(of('skill:q'), undefined, '技能命中是有的就照实算，不猜');
  });
});

describe('提示词里有「还服务哪些用例」这一节', () => {
  it('写出通过/失败两批，并把「任一条变失败就整条否决」说清', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const mode = attribute([sample('e1', ['s'], 'main')])[0];
    assert.ok(mode !== undefined);

    const prompts: string[] = [];
    const client = scriptedClient([
      (params: unknown) => {
        prompts.push(JSON.stringify(params));
        return endTurn('你查口径。回答要更详细，并且必须给出结论。');
      },
    ]);
    await new LlmProposer(config).propose({
      modes: [mode],
      assets,
      config,
      client,
      audience: () => ({ passing: ['e2', 'e3'], failing: ['e1'] }),
    });

    const prompt = prompts[0] ?? '';
    assert.match(prompt, /这份正文现在还服务哪些用例/);
    assert.match(prompt, /当前\*\*通过\*\*：e2, e3/);
    assert.match(prompt, /任何一条从通过变失败都会直接否决整条提案/);
    assert.match(prompt, /当前\*\*失败\*\*（这次要修的）：e1/);
  });

  it('不给 audience 时整节不出现（不知道就说不知道）', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const mode = attribute([sample('e1', ['s'], 'main')])[0];
    assert.ok(mode !== undefined);
    const prompts: string[] = [];
    const client = scriptedClient([
      (params: unknown) => {
        prompts.push(JSON.stringify(params));
        return endTurn('你查口径。回答要更详细，并且必须给出结论。');
      },
    ]);
    await new LlmProposer(config).propose({ modes: [mode], assets, config, client });
    assert.doesNotMatch(prompts[0] ?? '', /这份正文现在还服务哪些用例/);
  });
});

describe('runCycle —— 首选被否之后换目标再试一次', () => {
  /** 按调用次序决定观测：0/1 失败，2 通过。文本必须**不含**断言要的那个词 */
  function stagedRunner(texts: string[]): CaseRunner {
    let i = 0;
    return {
      model: 'stub',
      agent: { name: 'main', version: '1' },
      async run(): Promise<RunOutcome> {
        const text = texts[Math.min(i, texts.length - 1)] ?? '';
        const first = i === 0;
        i += 1;
        return {
          text,
          ok: true,
          stopReason: 'end_turn',
          iterations: 1,
          trace: TRACE,
          tokens: 5,
          costUsd: undefined,
          costNote: 'unreported',
          durationMs: 1,
          // 只有基线那次带技能命中（候选跑不改写归因的输入）
          skills: first ? ['s'] : [],
          subagents: [],
          agent: 'main',
        } as unknown as RunOutcome;
      },
    } as unknown as CaseRunner;
  }

  function stubProposer(pick: (attempt: number) => Proposal): Proposer & { calls: string[][] } {
    const calls: string[][] = [];
    return {
      calls,
      async propose(ctx) {
        calls.push([...(ctx.avoidTargets ?? [])]);
        return { proposals: [pick(calls.length)], cost: { usd: 0, known: true } };
      },
    };
  }

  it('改技能无效 ⇒ 换主 agent 再提一次，且这次被采纳', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const skill = assets.skills[0];
    const agent = assets.agents[0];
    assert.ok(skill !== undefined && agent !== undefined);

    const proposer = stubProposer((n) =>
      n === 1
        ? {
            id: 'p-1',
            modeId: 'm',
            kind: 'wrong_answer',
            rationale: '先试技能',
            layer: 'L1',
            patch: { target: 'skill:s', before: skill.body, after: '你查口径。回答要更详细。' },
          }
        : {
            id: 'p-2',
            modeId: 'm',
            kind: 'wrong_answer',
            rationale: '换主 agent',
            layer: 'L1',
            patch: {
              target: 'agent:main',
              before: agent.body,
              after: '你是执行者。输出必须以「结论：」开头。',
            },
          },
    );

    const report = await runCycle({
      config,
      assets,
      runner: stagedRunner(['这个还不错', '这个还不错', '结论：合格']),
      proposer,
    });

    assert.equal(proposer.calls.length, 2, '应发生一次备用尝试');
    assert.deepEqual(proposer.calls[1], ['skill:s'], '备用尝试必须排除已试过的目标');
    assert.equal(report.alternate?.target, 'agent:main');
    assert.deepEqual(report.alternate?.avoided, ['skill:s']);
    assert.equal(report.proposals.length, 2, '两条提案都要留在记录里');
    assert.equal(report.accepted.length, 1, '换目标之后那条应被采纳');
    assert.equal(report.accepted[0]?.patch.target, 'agent:main');
    // 记录里要能解释「为什么这一轮有两条提案」
    assert.equal(report.alternate?.modeId, report.modes[0]?.id);
  });

  it('首选就通过 ⇒ 不做备用尝试（不多花一次模型调用）', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const agent = assets.agents[0];
    assert.ok(agent !== undefined);
    const proposer = stubProposer(() => ({
      id: 'p-1',
      modeId: 'm',
      kind: 'wrong_answer',
      rationale: '一次就成',
      layer: 'L1',
      patch: {
        target: 'agent:main',
        before: agent.body,
        after: '你是执行者。输出必须以「结论：」开头。',
      },
    }));

    const report = await runCycle({
      config,
      assets,
      runner: stagedRunner(['这个还不错', '结论：合格']),
      proposer,
    });
    assert.equal(proposer.calls.length, 1);
    assert.equal(report.alternate, undefined);
    assert.equal(report.accepted.length, 1);
  });

  it('简化轮不做备用尝试（那一轮只接受净简化，换目标等于换个地方变胖）', async () => {
    const root = project();
    const config = loadConfig(root);
    // 第一轮：真采纳一条**变大**的改动 ⇒ 简化配额被消耗一格
    const first = await runCycle({
      config,
      assets: discoverAssets({ skills: config.skillsDir, agents: config.agentsDir }),
      runner: stagedRunner(['这个还不错', '结论：合格']),
      proposer: stubProposer(() => ({
        id: 'p-grow',
        modeId: 'm',
        kind: 'wrong_answer',
        rationale: '加格式要求',
        layer: 'L1',
        patch: {
          target: 'agent:main',
          before: '你是执行者。',
          after: '你是执行者。输出必须以「结论：」开头，并在末尾给出判定依据。',
        },
      })),
    });
    assert.equal(first.accepted.length, 1, '第一轮要真的采纳，配额才会被消耗');

    // 第二轮：又出现一条失败 ⇒ 这一轮被配额强制成简化轮
    writeFileSync(
      join(root, 'evals/e2.md'),
      '---\nname: e2\nexpect_contains: 判定\n---\n再判一次\n',
      'utf8',
    );
    const proposer = stubProposer(() => ({
      id: 'p-2',
      modeId: 'm',
      kind: 'wrong_answer',
      rationale: '还在变大',
      layer: 'L1',
      patch: {
        target: 'agent:main',
        before: discoverAssets({ skills: config.skillsDir, agents: config.agentsDir }).agents[0]
          ?.body as string,
        after: `${discoverAssets({ skills: config.skillsDir, agents: config.agentsDir }).agents[0]?.body ?? ''}再补一段说明。`,
      },
    }));
    const second = await runCycle({
      config,
      assets: discoverAssets({ skills: config.skillsDir, agents: config.agentsDir }),
      runner: stagedRunner(['这个还不错']),
      proposer,
      shrinkPolicy: { every: 1, minReduction: 0.2 },
    });

    assert.equal(second.shrink?.required, true, '配额该到期了');
    assert.equal(proposer.calls.length, 1, '简化轮不该再换目标提一次');
    assert.equal(second.alternate, undefined);
  });
});
