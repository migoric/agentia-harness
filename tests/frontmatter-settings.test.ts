import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { discoverAssets } from '../src/assets/discover.ts';
import type { AgentAsset, SkillAsset } from '../src/assets/types.ts';
import { HarnessError } from '../src/errors.ts';
import { PROPOSER_SYSTEM, type PromptFacts, renderPrompt } from '../src/rsi/propose-prompt.ts';
import { allowedSettings, applySettings, parseProposalBody } from '../src/rsi/settings.ts';
import type { FailureMode } from '../src/rsi/types.ts';
import { applyPatch, renderFile } from '../src/rsi/verify.ts';

const dirs: string[] = [];
function workspace(): string {
  const d = mkdtempSync(join(tmpdir(), 'harness-settings-'));
  dirs.push(d);
  return d;
}
function write(root: string, rel: string, text: string): string {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return path;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function agent(over: Partial<AgentAsset> = {}): AgentAsset {
  return {
    kind: 'agent',
    name: 'main',
    version: '1',
    description: 'd',
    body: '正文',
    fingerprint: 'f',
    path: '/x/main.md',
    model: undefined,
    tools: [],
    toolsDeclared: false,
    maxIterations: undefined,
    maxCostUsd: undefined,
    subagents: [],
    policyFields: {},
    ...over,
  };
}
function skill(over: Partial<SkillAsset> = {}): SkillAsset {
  return {
    kind: 'skill',
    name: 's',
    version: '1',
    description: 'd',
    body: '正文',
    fingerprint: 'f',
    path: '/x/s.md',
    model: undefined,
    tools: [],
    toolsDeclared: false,
    maxIterations: undefined,
    policyFields: {},
    ...over,
  };
}

describe('frontmatter 白名单：parseProposalBody', () => {
  it('纯正文（无头）→ declared=false，settings 空', () => {
    const p = parseProposalBody('新正文', agent(), 't');
    assert.equal(p.declared, false);
    assert.deepEqual(p.settings, {});
    assert.equal(p.body, '新正文');
  });

  it('带白名单头 → 拆出 settings 与正文，值已校验', () => {
    const p = parseProposalBody(
      '---\nmaxIterations: 9\nmaxCostUsd: 0.5\n---\n新正文',
      agent(),
      't',
    );
    assert.equal(p.declared, true);
    assert.deepEqual(p.settings, { maxIterations: '9', maxCostUsd: '0.5' });
    assert.equal(p.body.trim(), '新正文');
  });

  it('非白名单字段 → 整份拒（不是忽略、不是只改白名单那一半）', () => {
    assert.throws(
      () => parseProposalBody('---\nmaxIterations: 9\nname: evil\n---\n新正文', agent(), 't'),
      (e: unknown) =>
        e instanceof HarnessError && e.code === 'asset.invalid' && /非白名单/.test(e.message),
    );
    assert.throws(
      () => parseProposalBody('---\ntools: [a]\n---\n新正文', agent(), 't'),
      (e: unknown) => e instanceof HarnessError && /非白名单/.test(e.message),
    );
  });

  it('字段不属于该资产类型 → 整份拒（skill 没有 maxCostUsd）', () => {
    assert.equal(allowedSettings(skill()).includes('maxCostUsd'), false);
    assert.throws(
      () => parseProposalBody('---\nmaxCostUsd: 1\n---\n新正文', skill(), 't'),
      (e: unknown) => e instanceof HarnessError && /非白名单/.test(e.message),
    );
  });

  it('值非法 → 整份拒（maxIterations 必须正整数）', () => {
    assert.throws(
      () => parseProposalBody('---\nmaxIterations: -3\n---\n新正文', agent(), 't'),
      (e: unknown) => e instanceof HarnessError && /正整数/.test(e.message),
    );
    assert.throws(
      () => parseProposalBody('---\nmaxIterations: [3]\n---\n新正文', agent(), 't'),
      (e: unknown) => e instanceof HarnessError && /标量/.test(e.message),
    );
  });

  it('空头（没有白名单字段）→ 拒', () => {
    assert.throws(
      () => parseProposalBody('---\n# 只有注释\n---\n新正文', agent(), 't'),
      (e: unknown) => e instanceof HarnessError && /空头/.test(e.message),
    );
  });
});

describe('frontmatter 白名单：renderFile', () => {
  const FILE = '---\nname: main # 名字\nmaxIterations: 3\nversion: 7\n---\n\n原正文\n';

  it('无 settings → 逐字保留 frontmatter，只换正文（旧行为不变）', () => {
    const root = workspace();
    const p = write(root, 'main.md', FILE);
    assert.equal(
      renderFile(p, '新正文'),
      '---\nname: main # 名字\nmaxIterations: 3\nversion: 7\n---\n\n新正文\n',
    );
  });

  it('覆盖已有字段：只换值，保留行尾注释与其它行的顺序', () => {
    const root = workspace();
    const p = write(root, 'main.md', FILE);
    const out = renderFile(p, '新正文', { maxIterations: '12' });
    assert.match(out, /maxIterations: 12/);
    assert.match(out, /name: main # 名字/, '注释与其它字段保留');
    assert.match(out, /version: 7/);
    assert.doesNotMatch(out, /maxIterations: 3/);
  });

  it('追加新字段：在收尾 --- 之前插入', () => {
    const root = workspace();
    const p = write(root, 'main.md', FILE);
    const out = renderFile(p, '正文', { maxCostUsd: '0.8' });
    assert.match(out, /maxCostUsd: 0\.8\n---/);
  });

  it('removeKeys 删行（回滚「原来没写」的字段）', () => {
    const root = workspace();
    const p = write(root, 'main.md', FILE);
    const out = renderFile(p, '正文', {}, ['maxIterations']);
    assert.doesNotMatch(out, /maxIterations/);
    assert.match(out, /name: main # 名字/);
    assert.match(out, /version: 7/);
  });
});

describe('frontmatter 白名单：applyPatch 与应用到资产', () => {
  it('settings 应用到运行时字段，指纹按渲染后的真实文件算', () => {
    const root = workspace();
    const p = write(root, 'main.md', '---\nname: main\ndescription: d\n---\n原正文\n');
    const set = discoverAssets({ skills: join(root, 'nope'), agents: root });
    const before = set.agents[0]!;
    const patched = applyPatch(set, {
      target: 'agent:main',
      before: '原正文',
      after: '新正文',
      settings: { maxIterations: '7', maxCostUsd: '1.5' },
    });
    const after = patched.agents[0]!;
    assert.equal(after.maxIterations, 7);
    assert.equal(after.maxCostUsd, 1.5);
    assert.equal(after.body, '新正文');
    assert.notEqual(after.fingerprint, before.fingerprint);
  });

  it('非白名单字段即使形状对也整份拒（applyPatch 是统一判据）', () => {
    const root = workspace();
    write(root, 'main.md', '---\nname: main\ndescription: d\n---\n原正文\n');
    const set = discoverAssets({ skills: join(root, 'nope'), agents: root });
    assert.throws(
      () =>
        applyPatch(set, {
          target: 'agent:main',
          before: '原正文',
          after: '新正文',
          settings: { name: 'evil' },
        }),
      (e: unknown) => e instanceof HarnessError && /非白名单/.test(e.message),
    );
  });

  it('applySettings 不改正文、不动其它字段', () => {
    const a = agent({ maxIterations: 3, body: '正文' });
    const out = applySettings(a, { maxIterations: '9' }) as AgentAsset;
    assert.equal(out.maxIterations, 9);
    assert.equal(out.body, '正文');
    assert.equal(out.name, 'main');
  });
});

describe('frontmatter 白名单：提案提示词', () => {
  const mode: FailureMode = {
    id: 'wrong_answer:x',
    kind: 'wrong_answer',
    signature: '正文缺少内容',
    count: 1,
    cases: ['e1'],
    samples: [
      {
        case: 'e1',
        failures: ['正文缺少 "结论"'],
        stopReason: 'end_turn',
        tokens: 50,
        iterations: 12,
        excerpt: '',
        skills: [],
        subagents: [],
        peakContextTokens: 4000,
        compactions: 2,
        toolCalls: 3,
      },
    ],
    targets: [],
  };
  const base: PromptFacts = { mode, current: '正文', lessons: [], shrink: undefined };

  it('系统提示词写明可改策略字段，且点名非白名单字段会被整份拒', () => {
    assert.match(PROPOSER_SYSTEM, /可改的策略字段/);
    assert.match(PROPOSER_SYSTEM, /整份提案被拒/);
    assert.match(PROPOSER_SYSTEM, /name \/ version \/ description/);
  });

  it('renderPrompt 带「可改的策略字段」一节，含当前值与用途', () => {
    const prompt = renderPrompt({
      ...base,
      settings: [
        { key: 'maxIterations', current: '（未设置）', hint: '最大迭代次数' },
        { key: 'maxCostUsd', current: '2', hint: '美元上限' },
      ],
    });
    assert.match(prompt, /可改的策略字段（只有这些能写进 frontmatter）/);
    assert.match(prompt, /`maxIterations`：当前 （未设置）/);
    assert.match(prompt, /`maxCostUsd`：当前 2/);
  });

  it('无 settings 时不出现那一节（skill 等无策略字段的资产不会被诱导写头）', () => {
    assert.doesNotMatch(renderPrompt(base), /可改的策略字段/);
  });

  it('失败证据带四维读数（峰值上下文 / 压缩 / 工具调用）', () => {
    const prompt = renderPrompt(base);
    assert.match(prompt, /峰值上下文 4000/);
    assert.match(prompt, /压缩 2 次/);
    assert.match(prompt, /工具调用 3 次/);
  });

  it('运行时类失败优先拧策略旋钮，结果类失败仍优先改正文', () => {
    const settings = [{ key: 'contextBudgetTokens', current: '（未设置）', hint: '上下文预算' }];
    const runtime = renderPrompt({
      ...base,
      mode: { ...mode, kind: 'context_overflow' },
      settings,
    });
    const outcome = renderPrompt({ ...base, settings });
    assert.match(runtime, /本轮失败就是运行时行为问题/);
    assert.match(runtime, /优先改这里/);
    assert.doesNotMatch(outcome, /本轮失败就是运行时行为问题/);
    assert.match(outcome, /结果类失败（结论不对 \/ 该调的工具没调）仍优先改正文/);
  });
});
