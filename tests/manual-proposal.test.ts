import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { readProposal, writeProposal } from '../src/rsi/manual.ts';
import { runCli } from './support/cli.ts';

const BEFORE = '你是执行者。';
const AFTER = '你是执行者。输出必须以「结论：」开头。';

function valid(): {
  id: string;
  modeId: string;
  kind: string;
  rationale: string;
  layer: string;
  patch: { target: string; before: string; after: string };
} {
  return {
    id: 'p-manual-001',
    modeId: 'wrong_answer:abc',
    kind: 'wrong_answer',
    rationale: '线上失败集中在结论缺失',
    layer: 'L1',
    patch: { target: 'agent:main', before: BEFORE, after: AFTER },
  };
}

function project(raw: Record<string, unknown>): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'manual-proposal-'));
  const w = (rel: string, text: string): void => {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text, 'utf8');
  };
  w('agents/main.md', `---\ndescription: 主\n---\n${BEFORE}\n`);
  w('evals/e.md', '---\nname: e\nexpect_ok: true\n---\n跑一下\n');
  w('harness.config.json', '{}');
  const file = join(root, 'proposal.json');
  writeFileSync(file, JSON.stringify(raw), 'utf8');
  return { root, file };
}

function assertInvalid(raw: Record<string, unknown>, pattern: RegExp): void {
  const { file } = project(raw);
  assert.throws(
    () => readProposal(file),
    (e: unknown) => {
      const err = e as { code?: string; message?: string };
      assert.equal(err.code, 'config.invalid');
      assert.match(err.message ?? '', pattern);
      return true;
    },
  );
}

describe('手写提案的严格校验', () => {
  it('合法提案读进来就是 Proposal（字段逐个保留）', () => {
    const { file } = project(valid());
    const p = readProposal(file);
    assert.equal(p.id, 'p-manual-001');
    assert.equal(p.kind, 'wrong_answer');
    assert.deepEqual(p.patch, { target: 'agent:main', before: BEFORE, after: AFTER });
  });

  it('拼错字段拒绝（否则 modeId / rationale 会静默丢）', () => {
    assertInvalid({ ...valid(), rationle: 'x' }, /不认识的字段 "rationle"/);
    assertInvalid(
      { ...valid(), patch: { ...valid().patch, befor: BEFORE } },
      /不认识的字段 "befor"/,
    );
  });

  it('id 要能当文件名：路径逃逸与奇怪字符都拒绝', () => {
    assertInvalid({ ...valid(), id: '../../etc/passwd' }, /id 只能含/);
    assertInvalid({ ...valid(), id: '' }, /非空字符串/);
  });

  it('kind / target / layer 的取值都在白名单里', () => {
    assertInvalid({ ...valid(), kind: 'whatever' }, /不是已知失败类型/);
    assertInvalid({ ...valid(), patch: { ...valid().patch, target: '../../main' } }, /skill:名字/);
    assertInvalid({ ...valid(), layer: 'L2' }, /layer 只能是 "L1"/);
  });

  it('正文必须是非空字符串，after 不能把资产清空', () => {
    assertInvalid({ ...valid(), patch: { ...valid().patch, before: 42 } }, /before\/after/);
    assertInvalid({ ...valid(), patch: { ...valid().patch, after: '  ' } }, /after 不能为空/);
  });

  it('落盘到工作区，且再次读回逐字相等', () => {
    const { root, file } = project(valid());
    const config = loadConfig(root);
    const path = writeProposal(config, readProposal(file));
    assert.ok(path.endsWith('p-manual-001.json'));
    assert.ok(existsSync(path));
    assert.deepEqual(readProposal(path), readProposal(file));
  });
});

describe('rsi propose --from（CLI，不调模型）', () => {
  const BARE = {
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_BASE_URL: undefined,
    DEEPSEEK_API_KEY: undefined,
  };

  it('没有 key 也能登记手写提案', () => {
    const { root } = project(valid());
    const r = runCli(['rsi', 'propose', '--from', 'proposal.json'], root, BARE);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /已登记手写提案 p-manual-001/);
    const config = loadConfig(root);
    assert.ok(existsSync(join(config.workspaceDir, 'rsi', 'proposals', 'p-manual-001.json')));
  });

  it('缺 --from / 提案非法：退出码 2', () => {
    const { root } = project(valid());
    const missing = runCli(['rsi', 'propose'], root, BARE);
    assert.equal(missing.code, 2, missing.out);
    assert.match(missing.out, /需要 --from/);

    const { root: badRoot } = project({ ...valid(), kind: 'bogus' });
    const bad = runCli(['rsi', 'propose', '--from', 'proposal.json'], badRoot, BARE);
    assert.equal(bad.code, 2, bad.out);
    assert.match(bad.out, /不是已知失败类型/);
  });

  it('rsi accept 没有 --from 也拒绝（不会退化成 LLM 提案）', () => {
    const { root } = project(valid());
    // 给个占位 key 过凭据门，才能验到 --from 这一层
    const r = runCli(['rsi', 'accept'], root, { ...BARE, ANTHROPIC_API_KEY: 'fake-key' });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /需要 --from/);
  });
});
