import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { discoverAssets } from '../src/assets/discover.ts';
import { loadConfig } from '../src/config.ts';
import { HarnessError } from '../src/errors.ts';
import { assertBudgetEnforceable } from '../src/rsi/budget-guard.ts';

/**
 * 开跑前的预算体检。
 *
 * 守的是一个**没人会发现的失效**：模型不在价格表里 ⇒ `costUsd` 不可信 ⇒ 美元闸
 * 读不出数。旧实现让闸在这种情况下直接判「没超」，于是 `--max-cost 5` 跑了一夜、
 * 花掉几十美元，报告里唯一的信号只是「没有 $ 号」。
 *
 * 体检的立场是：**你声明了要闸，就必须真的有闸**；做不到就当场拒绝，并给出三条出路。
 */

function project(model: string): {
  config: ReturnType<typeof loadConfig>;
  assets: ReturnType<typeof discoverAssets>;
} {
  const root = mkdtempSync(join(tmpdir(), 'harness-guard-'));
  const w = (rel: string, text: string): void => {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text, 'utf8');
  };
  w('agents/main.md', '---\nname: main\nversion: 1\ndescription: 主 agent\n---\n你是执行者。\n');
  w('harness.config.json', JSON.stringify({ model }));
  const config = loadConfig(root);
  return { config, assets: discoverAssets({ skills: config.skillsDir, agents: config.agentsDir }) };
}

describe('assertBudgetEnforceable', () => {
  it('没设 --max-cost ⇒ 不管（没承诺闸就不会假装有闸）', () => {
    const { config, assets } = project('not-a-priced-model');
    assert.equal(assertBudgetEnforceable({ config, assets }), undefined);
  });

  it('给了 --max-tokens ⇒ 放行（token 数不查价格表，永远是可信的兜底）', () => {
    const { config, assets } = project('not-a-priced-model');
    const note = assertBudgetEnforceable({ config, assets, maxCostUsd: 5, maxTokens: 1_000_000 });
    assert.equal(note, undefined);
  });

  it('未定价模型 + 只有 --max-cost ⇒ 当场拒绝，且文案给出三条出路', () => {
    const { config, assets } = project('not-a-priced-model');
    assert.throws(
      () => assertBudgetEnforceable({ config, assets, maxCostUsd: 5 }),
      (e: unknown) => {
        assert.ok(e instanceof HarnessError);
        assert.equal(e.code, 'config.invalid');
        assert.match(e.message, /pricing/);
        assert.match(e.message, /--max-tokens/);
        assert.match(e.message, /不设 --max-cost/);
        return true;
      },
    );
  });

  it('已定价模型 ⇒ 放行（闸能读到数，不需要兜底）', () => {
    // claude-* 在 agentia 的内置价格表里
    const { config, assets } = project('claude-opus-5');
    assert.equal(assertBudgetEnforceable({ config, assets, maxCostUsd: 5 }), undefined);
  });

  it('远程模式无法预判 ⇒ 不硬拦，只提示「基线跑完才会发现」', () => {
    const { config, assets } = project('not-a-priced-model');
    const note = assertBudgetEnforceable({
      config,
      assets,
      maxCostUsd: 5,
      remote: true,
    });
    assert.ok(note !== undefined, '要提示，不能静默');
    assert.match(note, /基线/);
    assert.match(note, /--max-tokens/);
  });
});
