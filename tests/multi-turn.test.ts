import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scriptedClient } from '@migor/agentia';
import { discoverAssets } from '../src/assets/discover.ts';
import { loadConfig } from '../src/config.ts';
import { loadEvalCases } from '../src/evals/load.ts';
import { runSuite } from '../src/evals/run.ts';
import { createRunner } from '../src/run/runner.ts';
import { mergeTraces } from '../src/run/trace-merge.ts';
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

function stopWith(reason: string) {
  return {
    id: 'm',
    model: 'claude-opus-5',
    stop_reason: reason,
    usage: USAGE,
    content: [{ type: 'text', text: '半截输出' }],
  };
}

/** 最小工程：一个 agent + 多轮用例 */
function project(caseBody: string): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-multiturn-'));
  const w = (rel: string, text: string): void => {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text, 'utf8');
  };
  w('agents/main.md', '---\nname: main\nversion: 1\ndescription: 主 agent\n---\n你是执行者。\n');
  w('evals/x.md', caseBody);
  return root;
}

function setup(root: string) {
  const config = loadConfig(root);
  const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
  return { config, assets };
}

const TWO_TURNS =
  '---\nname: multi\nexpect_contains: bar.c\n---\n先看 foo.c\n<!-- turn -->\n不对，我要 bar.c\n';

describe('多轮评测', () => {
  it('第 2 轮接上前一轮历史，断言只看最后一轮输出', async () => {
    const root = project(TWO_TURNS);
    const { config, assets } = setup(root);
    const requests: unknown[] = [];
    const step = (params: unknown) => {
      requests.push(params);
      const text = JSON.stringify(params);
      // 第 1 轮请求里没有上一轮内容；第 2 轮必须带上前一轮的 user 与 assistant
      if (text.includes('bar.c')) return endTurn('bar.c 在这里');
      return endTurn('先给你 foo.c');
    };
    const report = await runSuite({
      config,
      assets,
      client: scriptedClient(Array.from({ length: 4 }, () => step)),
    });

    assert.equal(requests.length, 2, '两轮各一次模型调用');
    const second = JSON.stringify(requests[1]);
    assert.ok(second.includes('先看 foo.c'), '第 2 轮必须带上第 1 轮的 user 消息');
    assert.ok(second.includes('先给你 foo.c'), '第 2 轮必须带上第 1 轮的 assistant 回复');

    const c = report.cases[0];
    assert.equal(c?.passed, true, JSON.stringify(c?.failures));
    assert.equal(c?.turns, 2);
    assert.equal(c?.tokens, 30, '两轮 token 必须累加（每轮 10+5）');
    assert.equal(c?.failedTurn, undefined);
  });

  it('中间轮非正常收尾就中止：后续轮不执行，报告指出第几轮', async () => {
    const caseBody =
      '---\nname: multi\nexpect_contains: 完成\n---\n第一步\n<!-- turn -->\n第二步\n<!-- turn -->\n第三步\n';
    const root = project(caseBody);
    const { config, assets } = setup(root);
    let calls = 0;
    const step = () => {
      calls++;
      // 第 1 轮正常；第 2 轮撞 max_tokens；第 3 轮不该被调用
      return calls === 2 ? stopWith('max_tokens') : endTurn('完成');
    };
    const report = await runSuite({
      config,
      assets,
      client: scriptedClient(Array.from({ length: 5 }, () => step)),
    });

    assert.equal(calls, 2, '第 2 轮失败后不许再跑第 3 轮');
    const c = report.cases[0];
    assert.equal(c?.passed, false);
    assert.equal(c?.turns, 3, 'turns 记的是用例计划轮数');
    assert.equal(c?.failedTurn, 2);
    assert.ok(
      c?.failures.some((f) => f.includes('第 2 轮非正常收尾')),
      JSON.stringify(c?.failures),
    );
  });

  it('空轮次在加载期就拒绝（不能让用例跑到一半才炸）', () => {
    const root = project('---\nname: multi\nexpect_ok: true\n---\n先看 foo.c\n<!-- turn -->\n');
    assert.throws(() => loadEvalCases(loadConfig(root).evalsDir), /第 2 段轮次是空的/);
  });

  it('最后一轮失败不触发「中途中止」，但 failedTurn 仍指向它', async () => {
    const caseBody =
      '---\nname: multi\nexpect_contains: 完成\n---\n第一步\n<!-- turn -->\n第二步\n<!-- turn -->\n第三步\n';
    const root = project(caseBody);
    const { config, assets } = setup(root);
    let calls = 0;
    const report = await runSuite({
      config,
      assets,
      client: scriptedClient([
        () => {
          calls++;
          return endTurn('完成');
        },
        () => {
          calls++;
          return endTurn('完成');
        },
        () => {
          calls++;
          return stopWith('max_tokens');
        },
      ]),
    });
    assert.equal(calls, 3, '最后一轮失败时没有「后续轮次」可中止');
    const c = report.cases[0];
    assert.equal(c?.turns, 3);
    assert.equal(c?.failedTurn, 3);
    // 末轮失败，断言仍然只看末轮输出 —— 于是 expect_contains 也会挂
    assert.equal(c?.passed, false);
  });

  it('expect_ok: false 在多轮里表示「整段会话应当非正常收尾」', async () => {
    const caseBody = '---\nname: multi\nexpect_ok: false\n---\n第一步\n<!-- turn -->\n第二步\n';
    const root = project(caseBody);
    const { config, assets } = setup(root);
    const report = await runSuite({
      config,
      assets,
      client: scriptedClient([() => endTurn('甲'), () => stopWith('max_tokens')]),
    });
    assert.equal(report.cases[0]?.passed, true, JSON.stringify(report.cases[0]?.failures));
    assert.equal(report.cases[0]?.failedTurn, 2);
  });

  it('--retries 重放整段会话：只算成功那次尝试的成本', async () => {
    const root = project(TWO_TURNS);
    const { config, assets } = setup(root);
    const seen: string[] = [];
    let first = true;
    // 抛错的步骤在重试时会被**重放**（scriptedClient 的游标只在成功后前进），
    // 所以「第一次失败」必须做成有状态的步骤，而不是排在前面的一格
    const flaky = () => {
      seen.push('turn1');
      if (first) {
        first = false;
        throw new Error('模型层炸了');
      }
      return endTurn('先给你 foo.c');
    };
    const report = await runSuite({
      config,
      assets,
      retries: 1,
      client: scriptedClient([
        flaky,
        (params: unknown) => {
          const text = JSON.stringify(params);
          seen.push('turn2');
          return endTurn(text.includes('bar.c') ? 'bar.c 在这里' : '先给你 foo.c');
        },
      ]),
    });
    const c = report.cases[0];
    assert.equal(c?.passed, true, JSON.stringify(c?.failures));
    assert.deepEqual(seen, ['turn1', 'turn1', 'turn2'], '整段会话重放，不是只重跑失败那一轮');
    assert.equal(c?.tokens, 30, '只算成功那次尝试的两轮（每轮 10+5）');
  });

  it('单轮用例仍然不出现 turns 字段（老报告口径不变）', async () => {
    const root = project('---\nname: single\nexpect_contains: 结论\n---\n任务甲\n');
    const { config, assets } = setup(root);
    const report = await runSuite({
      config,
      assets,
      client: scriptedClient([() => endTurn('结论：合格')]),
    });
    assert.equal(report.cases[0]?.turns, undefined);
  });
});

describe('harvest 与多轮', () => {
  it('报告里是多轮用例时拒绝回流（压成单条 task 会测成另一件事）', () => {
    const root = project('---\nname: placeholder\nexpect_ok: true\n---\n占位\n');
    mkdirSync(join(root, '.workspace'), { recursive: true });
    writeFileSync(join(root, 'harness.config.json'), '{}\n', 'utf8');
    writeFileSync(
      join(root, '.workspace', 'traces.jsonl'),
      `${JSON.stringify({
        traceId: 't-mt',
        rootSpanId: 's0',
        spans: [],
        status: 'ok',
        totalUsage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      })}\n`,
      'utf8',
    );
    writeFileSync(
      join(root, '.workspace', 'report.json'),
      JSON.stringify({
        total: 1,
        passed: 1,
        passRate: 1,
        cases: [{ name: 'multi', task: '先看 foo.c', turns: 2, traceId: 't-mt', passed: true }],
      }),
      'utf8',
    );

    const r = runCli(['harvest', 't-mt', '--from-report', '.workspace/report.json'], root);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /多轮/);
  });
});

describe('runTurns 的库层守卫', () => {
  it('空轮次直接拒绝（绕过 eval 直接调库也一样）', async () => {
    const root = project(TWO_TURNS);
    const { config, assets } = setup(root);
    const runner = createRunner(config, assets, undefined, false);
    await assert.rejects(() => runner.runTurns(['任务甲', '   ']), /第 2 轮是空的/);
  });

  it('第 2 轮抛异常：不放弃整段会话，保留第 1 轮账单并指出轮次', async () => {
    const root = project(TWO_TURNS);
    const { config, assets } = setup(root);
    const runner = createRunner(config, assets, undefined, false);
    const real = runner.run.bind(runner);
    let n = 0;
    runner.run = async (task, opts) => {
      n++;
      if (n === 2) throw new Error('客户端炸了');
      return real(task, opts);
    };

    const out = await runner.runTurns(['先看 foo.c', '不对，我要 bar.c'], {
      client: scriptedClient([() => endTurn('完成'), () => endTurn('完成')]),
    });
    assert.equal(out.ok, false);
    assert.equal(out.turns, 2);
    assert.equal(out.failedTurn, 2, '要能说清崩在第几轮');
    assert.equal(out.stopReason, 'threw');
    assert.equal(out.tokens, 15, '第 1 轮真花掉的 token 必须留在账上（成本未知不是免费）');
    assert.match(out.error?.message ?? '', /客户端炸了/);
  });

  it('首轮就抛：仍是「多轮 + 失败」，而不是抛给调用方', async () => {
    const root = project(TWO_TURNS);
    const { config, assets } = setup(root);
    const runner = createRunner(config, assets, undefined, false);
    runner.run = async () => {
      throw new Error('装配失败');
    };

    const out = await runner.runTurns(['甲', '乙']);
    assert.equal(out.ok, false);
    assert.equal(out.turns, 2, '抛异常不能让报告丢掉「这是多轮用例」');
    assert.equal(out.failedTurn, 1);
    assert.equal(out.tokens, 0);
    assert.equal(out.costUsd, undefined, '没有读数就是未知，不能记成 0（免费）');
    assert.equal(out.text, '');
  });
});

describe('多轮超时', () => {
  it('超时也要保住前几轮的 token，并指出卡在第几轮', async () => {
    const caseBody =
      '---\nname: multi\nexpect_contains: 完成\n---\n第一步\n<!-- turn -->\n第二步\n<!-- turn -->\n第三步\n';
    const root = project(caseBody);
    const { config, assets } = setup(root);
    let calls = 0;
    const client = scriptedClient([
      () => {
        calls++;
        return endTurn('完成');
      },
      // 第 2 轮故意拖过超时闸。必须挂一个**真的 timer**：纯 pending 的 promise
      // 不会让事件循环保持活跃，而超时闸的定时器是 unref 的 —— 那样它永远不响
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          setTimeout(() => resolve(endTurn('完成')), 200);
        }),
      () => endTurn('完成'),
    ]);

    const report = await runSuite({ config, assets, client, timeoutMs: 40 });
    assert.equal(calls, 1, '第 2 轮卡住之后不该再调模型');
    const c = report.cases[0];
    assert.equal(c?.passed, false);
    assert.equal(c?.turns, 3);
    assert.equal(c?.failedTurn, 2);
    assert.equal(c?.tokens, 15, '第 1 轮已经花掉的 token 不能因为超时归零');
    assert.ok(
      (c?.failures ?? []).some((f) => f.includes('超时')),
      JSON.stringify(c?.failures),
    );
  });
});

describe('mergeTraces', () => {
  it('账单与 token 累加，工具事件跨轮拼接，任一非 ok 则整体非 ok', () => {
    const trace = (id: string, status: 'ok' | 'error', cost: number) => ({
      traceId: id,
      rootSpanId: `root-${id}`,
      status,
      totalUsage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheCreationTokens: 2,
        costEstimate: cost,
      },
      spans: [
        {
          spanId: `llm-${id}`,
          traceId: id,
          parentSpanId: null,
          kind: 'llm.turn' as const,
          name: 'turn',
          startedAt: 0,
          endedAt: 1,
          status: 'ok' as const,
          events: [
            {
              name: 'tool.input',
              time: id === 'a' ? 1 : 2,
              body: { tool: id === 'a' ? 'search' : 'edit', input: { q: id } },
            },
          ],
          attributes: {},
        },
      ],
    });
    // 第一轮出错、最后一轮正常：整体仍然是坏的一次会话（用户经历的是整段对话）
    const merged = mergeTraces([trace('a', 'error', 0.1), trace('b', 'ok', 0.2)]);
    assert.equal(merged.traceId, 'b', 'traceId 取最后一轮（回查要看最终失败那一轮）');
    assert.equal(merged.status, 'error', '中间轮出错不能被最后一轮的成功掩盖');
    assert.equal(merged.totalUsage.inputTokens, 20);
    assert.equal(merged.totalUsage.cacheReadTokens, 2);
    assert.equal(merged.totalUsage.costEstimate, 0.3);
    assert.equal(merged.spans.length, 2);
  });

  it('空输入直接报错，不返回一条假 trace', () => {
    assert.throws(() => mergeTraces([]), /至少需要一条/);
  });
});
