import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type MemoryStore, scriptedClient } from '@migor/agentia';
import { discoverAssets } from '../src/assets/discover.ts';
import { loadConfig } from '../src/config.ts';
import { loadEvalCases } from '../src/evals/load.ts';
import { runSuite } from '../src/evals/run.ts';
import { caseSetFingerprint } from '../src/evals/types.ts';
import { createRunner } from '../src/run/runner.ts';

/**
 * 记忆缝 —— 评测要能声明「这条用例走不走记忆」。
 *
 * 守的是一条具体的失真：记忆一旦参与，「同一条用例两次跑结果不同」就是**设计如此**
 * 而不是抖动。评测不声明它，报告里的通过率再高也证明不了线上；反过来，线上有记忆
 * 而评测没有，回归门会一直在噪。
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

function project(evalBody?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-memory-'));
  const w = (rel: string, text: string): void => {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text, 'utf8');
  };
  w('agents/main.md', '---\ndescription: 主 agent\n---\n你是执行者。\n');
  if (evalBody !== undefined) w('evals/e1.md', evalBody);
  return root;
}

/** 记录调用而不真的存东西 —— 断言的是「缝通没通」，不是 store 实现 */
function recordingStore(calls: string[]): MemoryStore {
  return {
    load: (keys) => {
      calls.push(`load:${keys.join(',')}`);
      return {};
    },
    save: (entries) => {
      calls.push(`save:${Object.keys(entries).sort().join(',')}`);
    },
  };
}

describe('memory_keys —— 用例自己说走不走记忆', () => {
  it('解析成 memoryKeys；不写就是缺席（不是空数组）', () => {
    const root = project(
      '---\nname: with\nexpect_contains: 结论\nmemory_keys: [notes, profile]\n---\n任务\n',
    );
    const root2 = project('---\nname: without\nexpect_contains: 结论\n---\n任务\n');
    assert.deepEqual(loadEvalCases(join(root, 'evals'))[0]?.memoryKeys, ['notes', 'profile']);
    assert.equal(loadEvalCases(join(root2, 'evals'))[0]?.memoryKeys, undefined);
  });

  it('写了空列表 == 没写（同一份指纹）', () => {
    const empty = project('---\nname: c\nexpect_contains: 结论\nmemory_keys: []\n---\n任务\n');
    const absent = project('---\nname: c\nexpect_contains: 结论\n---\n任务\n');
    const fpA = caseSetFingerprint(loadEvalCases(join(empty, 'evals')));
    const fpB = caseSetFingerprint(loadEvalCases(join(absent, 'evals')));
    assert.equal(fpA, fpB);
  });

  it('记忆键进了用例集指纹 —— 改它等于改了判定条件', () => {
    const a = project('---\nname: c\nexpect_contains: 结论\nmemory_keys: [notes]\n---\n任务\n');
    const b = project('---\nname: c\nexpect_contains: 结论\n---\n任务\n');
    assert.notEqual(
      caseSetFingerprint(loadEvalCases(join(a, 'evals'))),
      caseSetFingerprint(loadEvalCases(join(b, 'evals'))),
    );
  });

  it('不认识的字段仍然响亮失败（记忆键不是白名单的例外）', () => {
    const root = project('---\nname: c\nexpect_contains: 结论\nmemory_key: [notes]\n---\n任务\n');
    assert.throws(() => loadEvalCases(join(root, 'evals')), /memory_key/);
  });
});

describe('记忆缝真的通到 app.run', () => {
  it('Runner.run 的 memory 抵达上游（load 被调用，keys 原样）', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const runner = createRunner(config, assets, undefined, false);
    const calls: string[] = [];
    await runner.run('任务', {
      client: scriptedClient([endTurn('结论')]),
      memory: { store: recordingStore(calls), keys: ['notes'] },
    });
    assert.equal(
      calls.some((c) => c === 'load:notes'),
      true,
      `memory 没通到上游 —— 实际调用：${calls.join(' / ')}`,
    );
  });

  it('不传 memory 时上游一次都不读（缺省是裸 agent，不是空 store）', async () => {
    const root = project();
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const runner = createRunner(config, assets, undefined, false);
    const calls: string[] = [];
    await runner.run('任务', { client: scriptedClient([endTurn('结论')]) });
    assert.deepEqual(calls, []);
    assert.equal(runner.agent.name, 'main');
  });

  it('eval 里带 memory_keys 的用例照常跑通', async () => {
    const root = project('---\nname: e1\nexpect_contains: 结论\nmemory_keys: [notes]\n---\n任务\n');
    const config = loadConfig(root);
    const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const report = await runSuite({
      config,
      assets,
      client: scriptedClient([endTurn('结论')]),
    });
    assert.equal(report.passed, 1);
  });
});
