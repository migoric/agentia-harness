/**
 * stage 钩子的接线：**撤台无论如何都执行**。
 *
 * 这条不变量比它看起来重要：远程 RSI 的候选是写到服务读的文件里的，漏一次撤台就等于
 * 让服务停在一个没被验证过的提示词上，而报告里一切正常。所以这里专门测「跑评测抛错」
 * 这条路径 —— 正常路径反而容易发现（下一次预检就报漂移）。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { discoverAssets } from '../src/assets/discover.js';
import { loadConfig } from '../src/config.js';
import type { EvalReport } from '../src/evals/types.js';
import { withStage } from '../src/rsi/stage.js';
import type { Proposal } from '../src/rsi/types.js';
import { verifyProposal } from '../src/rsi/verify.js';
import type { CaseRunner } from '../src/run/case-runner.js';
import type { RunOutcome } from '../src/run/runner.js';

const BODY = '你是摘要器。把材料压成三条要点。';

function project(): { dir: string; body: string } {
  const dir = mkdtempSync(join(tmpdir(), 'stage-hook-'));
  mkdirSync(join(dir, 'agents'), { recursive: true });
  // 至少一条用例：`runSuite` 先读用例集，没有的话根本走不到 runner
  mkdirSync(join(dir, 'evals'), { recursive: true });
  writeFileSync(
    join(dir, 'evals', 'one.md'),
    '---\nname: one\nexpect_ok: true\nexpect_max_tokens: 20000\n---\n\n压成三条要点。\n',
  );
  writeFileSync(
    join(dir, 'agents', 'main.md'),
    `---\nname: main\ndescription: 摘要器\n---\n${BODY}\n`,
  );
  return { dir, body: BODY };
}

function proposalOf(after: string): Proposal {
  return {
    id: 'p-stage',
    modeId: 'm',
    kind: 'wrong_answer',
    rationale: 'r',
    patch: { target: 'agent:main', before: BODY, after },
    layer: 'L1',
  };
}

describe('withStage', () => {
  it('没有钩子时直接跑（本地路径不该有任何额外动作）', async () => {
    let called = 0;
    const out = await withStage(undefined, {} as never, async () => {
      called += 1;
      return 'ok';
    });
    assert.equal(out, 'ok');
    assert.equal(called, 1);
  });

  it('成功路径也撤台', async () => {
    const order: string[] = [];
    const out = await withStage(
      async () => async () => {
        order.push('restore');
      },
      {} as never,
      async () => {
        order.push('run');
        return 42;
      },
    );
    assert.equal(out, 42);
    assert.deepEqual(order, ['run', 'restore']);
  });

  it('跑的时候抛错，撤台照样执行，原错误照旧抛出', async () => {
    const order: string[] = [];
    await assert.rejects(
      () =>
        withStage(
          async () => async () => {
            order.push('restore');
          },
          {} as never,
          async () => {
            order.push('run');
            throw new Error('评测炸了');
          },
        ),
      /评测炸了/,
    );
    assert.deepEqual(order, ['run', 'restore']);
  });
});

describe('verifyProposal 的 stage 接线', () => {
  it('候选搬上台（拿到的是打过补丁的资产）→ 跑 → 撤台', async () => {
    const { dir } = project();
    const config = loadConfig(dir);
    // `discoverAssets` 收的是目录对，不是 root —— 与 CLI 的 `assetsOf` 同款
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    let staged: string | undefined;
    let restored = 0;

    // runner 抛错不会被 runSuite 冒泡（那是「某条用例失败」），所以这里只验
    // 正常路径的顺序；「跑的时候炸了也撤台」由 `withStage` 的单测覆盖 ——
    // 那条不变量住在 `withStage` 里，不该指望两个调用方各自记得
    const runner: CaseRunner = {
      model: 'stub',
      agent: assets.agents[0],
      async run(): Promise<RunOutcome> {
        throw new Error('runner 炸了');
      },
    } as unknown as CaseRunner;

    const outcome = await verifyProposal({
      config,
      assets,
      baseline: { total: 0, passed: 0, cases: [] } as unknown as EvalReport,
      proposal: proposalOf('你是摘要器。先给结论，再列三条要点。'),
      runner,
      stage: async ({ patched }) => {
        staged = patched.agents[0]?.body;
        return async () => {
          restored += 1;
        };
      },
    });

    assert.match(String(staged), /先给结论/, 'stage 收到的必须是**打过补丁**的资产');
    assert.equal(restored, 1, '跑完必须撤台');
    assert.equal(outcome.candidate.total, 1, '候选跑的是同一套用例');
    assert.equal(outcome.candidate.passed, 0, 'runner 炸了 ⇒ 那条用例算失败，但整轮不炸');
  });
});
