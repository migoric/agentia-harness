/**
 * 远程舞台：写盘 / 重载 / 还原 / 崩溃回收。
 *
 * 这些断言对应的是**唯一一次可以让远程停在错误状态**的机会。所以每条都写清「不这样会怎样」：
 * 少一次重载 = 服务还跑着候选；少一次还原 = 未验证的提示词留在盘上；pending 没清 =
 * 下次启动把已完成的轮次当成崩溃来回收。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { AssetSet } from '../src/assets/types.js';
import { loadConfig, type RemoteConfig } from '../src/config.js';
import { readPending } from '../src/rsi/pending.js';
import { bodyDigest, RemoteStager } from '../src/rsi/remote.js';
import type { Proposal } from '../src/rsi/types.js';

function project(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'remote-stage-'));
  mkdirSync(join(dir, 'agents'), { recursive: true });
  mkdirSync(join(dir, 'workspace'), { recursive: true });
  const file = join(dir, 'svc-prompts', 'main.md');
  mkdirSync(join(dir, 'svc-prompts'), { recursive: true });
  writeFileSync(file, '---\nname: main\ndescription: 远端那份\n---\n旧正文。\n');
  return { dir, file };
}

function remoteOf(file: string): RemoteConfig {
  return {
    url: 'http://svc',
    tokenEnv: 'HARNESS_REMOTE_TOKEN',
    prompts: { 'agent:main': file },
    allowStaging: true,
    reloadPath: '/admin/reload',
    promptsPath: '/admin/prompts',
  };
}

/** 假服务：digest 取文件当前内容，重载次数可断言 */
function fakeRemote(file: string): {
  impl: (url: string, init?: RequestInit) => Promise<Response>;
  reloads: number;
  failReloadAfter?: number;
} {
  const state = {
    reloads: 0,
    failReloadAfter: undefined as number | undefined,
    impl: async (url: string, init?: RequestInit): Promise<Response> => {
      if ((init?.method ?? 'GET') === 'GET') {
        const digest = bodyDigest(readFileSync(file, 'utf8').split(/^---$/m).slice(2).join('---'));
        return new Response(JSON.stringify({ agents: [{ agent: 'main', prompt: { digest } }] }), {
          status: 200,
        });
      }
      state.reloads += 1;
      if (state.failReloadAfter !== undefined && state.reloads > state.failReloadAfter) {
        return new Response(JSON.stringify({ error: '文件坏了' }), { status: 400 });
      }
      return new Response(JSON.stringify({ ok: true, changed: [], unchanged: [] }), {
        status: 200,
      });
    },
  };
  return {
    get impl() {
      return state.impl;
    },
    get reloads() {
      return state.reloads;
    },
    get failReloadAfter() {
      return state.failReloadAfter;
    },
    set failReloadAfter(v: number | undefined) {
      state.failReloadAfter = v;
    },
  } as never;
}

function assetsWith(body: string): AssetSet {
  const asset = {
    kind: 'agent' as const,
    name: 'main',
    version: '1',
    description: 'x',
    body,
    fingerprint: 'f',
    path: '/tmp/whatever/agents/main.md',
    model: undefined,
    tools: [],
    toolsDeclared: false,
    maxIterations: undefined,
    maxCostUsd: undefined,
    subagents: [],
  };
  return { skills: [], agents: [asset], fingerprint: 'set' } as unknown as AssetSet;
}

function proposalOf(before: string, after: string): Proposal {
  return {
    id: 'p-test',
    modeId: 'm',
    kind: 'wrong_answer',
    rationale: 'r',
    patch: { target: 'agent:main', before, after },
    layer: 'L1',
  };
}

describe('远程舞台', () => {
  it('stage 写正文但保留目标文件的 frontmatter；restore 写回并各重载一次', async () => {
    const { dir, file } = project();
    const fake = fakeRemote(file);
    const stager = new RemoteStager({
      config: loadConfig(dir),
      remote: remoteOf(file),
      fetchImpl: fake.impl,
      env: { HARNESS_REMOTE_TOKEN: 'k' },
    });

    const { restore, before, after } = await stager.stage(
      proposalOf('旧正文。', '新正文。'),
      assetsWith('新正文。'),
    );
    assert.notEqual(before, after);

    const onDisk = readFileSync(file, 'utf8');
    assert.match(onDisk, /新正文/, '候选必须真的写到远端那份文件上');
    assert.match(onDisk, /description: 远端那份/, 'frontmatter 不能被抹掉（那会顺手删元数据）');
    assert.equal(fake.reloads, 1, '写完必须重载，否则服务还跑旧提示词');
    assert.ok(readPending(loadConfig(dir)) !== undefined, 'stage 期间必须有 pending 记录');

    await restore();
    assert.match(readFileSync(file, 'utf8'), /旧正文/, 'restore 必须把内容写回去');
    assert.equal(fake.reloads, 2, '写回之后也要重载 —— 只写文件不重载等于没还原');
    assert.equal(readPending(loadConfig(dir)), undefined, '还原完成后记录要清掉');
  });

  it('写盘后重载失败、但还原时重载成功 ⇒ 文件还原 + pending 清掉，原错误照旧抛出', async () => {
    const { dir, file } = project();
    const fake = fakeRemote(file);
    fake.failReloadAfter = 0; // 只有第一次（候选那次）失败
    let calls = 0;
    const flaky = async (url: string, init?: RequestInit): Promise<Response> => {
      if ((init?.method ?? 'GET') === 'GET') return fake.impl(url, init);
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: '文件坏了' }), { status: 400 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const stager = new RemoteStager({
      config: loadConfig(dir),
      remote: remoteOf(file),
      fetchImpl: flaky,
      env: { HARNESS_REMOTE_TOKEN: 'k' },
    });

    await assert.rejects(
      () => stager.stage(proposalOf('旧正文。', '新正文。'), assetsWith('新正文。')),
      /返回 400/,
    );
    assert.match(readFileSync(file, 'utf8'), /旧正文/, '重载失败时文件也必须还原');
    assert.equal(readPending(loadConfig(dir)), undefined, '还原+重载都成了，记录就该清');
  });

  it('重载一直失败 ⇒ 文件还原但**记录保留**（远端状态未确认，下次补重载）', async () => {
    const { dir, file } = project();
    const stager = new RemoteStager({
      config: loadConfig(dir),
      remote: remoteOf(file),
      fetchImpl: async () => new Response(JSON.stringify({ error: '起不来了' }), { status: 400 }),
      env: { HARNESS_REMOTE_TOKEN: 'k' },
    });

    await assert.rejects(
      () => stager.stage(proposalOf('旧正文。', '新正文。'), assetsWith('新正文。')),
      /返回 400/,
    );
    assert.match(readFileSync(file, 'utf8'), /旧正文/, '文件已还原');
    assert.ok(
      readPending(loadConfig(dir)) !== undefined,
      '重载从未成功 ⇒ 远端可能还跑着候选，记录必须留着让下次启动补一次',
    );
  });

  it('还原时重载失败 ⇒ 记录**保留**（下次启动会再试），且报错说清远端状态', async () => {
    const { dir, file } = project();
    const fake = fakeRemote(file);
    const stager = new RemoteStager({
      config: loadConfig(dir),
      remote: remoteOf(file),
      fetchImpl: fake.impl,
      env: { HARNESS_REMOTE_TOKEN: 'k' },
    });
    const { restore } = await stager.stage(
      proposalOf('旧正文。', '新正文。'),
      assetsWith('新正文。'),
    );
    fake.failReloadAfter = 1; // 第二次（还原时）失败
    await assert.rejects(() => restore(), /返回 400/);
    assert.match(readFileSync(file, 'utf8'), /旧正文/, '文件已还原');
    assert.ok(
      readPending(loadConfig(dir)) !== undefined,
      '重载没成功，记录不能清 —— 否则下次不知道要补重载',
    );
  });

  it('recoverPending 把崩溃留下的候选还原，并在无残留时安静返回 undefined', async () => {
    const { dir, file } = project();
    const fake = fakeRemote(file);
    const stager = new RemoteStager({
      config: loadConfig(dir),
      remote: remoteOf(file),
      fetchImpl: fake.impl,
      env: { HARNESS_REMOTE_TOKEN: 'k' },
    });
    assert.equal(await stager.recoverPending(), undefined, '没有待回收时不该报错也不该乱动');

    // 模拟「写完就崩」：stage 之后不 restore，进程没了
    await stager.stage(proposalOf('旧正文。', '崩溃前的候选。'), assetsWith('崩溃前的候选。'));
    assert.match(readFileSync(file, 'utf8'), /崩溃前的候选/);

    const again = new RemoteStager({
      config: loadConfig(dir),
      remote: remoteOf(file),
      fetchImpl: fake.impl,
      env: { HARNESS_REMOTE_TOKEN: 'k' },
    });
    const msg = await again.recoverPending();
    assert.match(String(msg), /回收了一个未完成验证的远程改动/);
    assert.match(readFileSync(file, 'utf8'), /旧正文/, '下次启动必须把未验证的候选还原');
    assert.equal(readPending(loadConfig(dir)), undefined);
  });

  it('预检：本地与远端不一致就报出来，一致才算过', async () => {
    const { dir, file } = project();
    const fake = fakeRemote(file);
    const stager = new RemoteStager({
      config: loadConfig(dir),
      remote: remoteOf(file),
      fetchImpl: fake.impl,
      env: { HARNESS_REMOTE_TOKEN: 'k' },
    });
    assert.equal((await stager.preflight()).ok, true, '假服务的 digest 取自同一份文件，应当一致');

    // 远端说的 digest 与本地文件对不上 ⇒ 基线不是当前资产跑出来的
    const drift = new RemoteStager({
      config: loadConfig(dir),
      remote: remoteOf(file),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ agents: [{ agent: 'main', prompt: { digest: 'deadbeef0000' } }] }),
          {
            status: 200,
          },
        ),
      env: { HARNESS_REMOTE_TOKEN: 'k' },
    });
    const pre = await drift.preflight();
    assert.equal(pre.ok, false);
    assert.equal(pre.rows[0]?.remote, 'deadbeef0000');
    assert.equal(pre.rows[0]?.target, 'agent:main');
  });
});
