import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { discoverAssets } from '../src/assets/discover.ts';
import { loadConfig } from '../src/config.ts';
import { LlmProposer } from '../src/rsi/propose.ts';
import { createRunner } from '../src/run/runner.ts';

/**
 * endpoint 段的落地纪律：agentia 的默认 client 每次 run 现造、只读环境变量，
 * 所以「配置里的 endpoint 生效」只能靠 `applyEndpointEnv` 把值搬到
 * `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`。
 *
 * 这组用例钉的是**库入口**（不走 CLI 的调用方）：`createRunner` 与 `LlmProposer`
 * 都必须幂等落地一次。漏掉的后果不是报错，是「主 agent 走得通、子循环 401」的
 * 分裂故障 —— 配置里写了 endpoint 段却静默不生效。
 */

const BASE = 'ANTHROPIC_BASE_URL';
const KEY = 'ANTHROPIC_API_KEY';
const ALT_KEY = 'DEEPSEEK_API_KEY';

/** 保存/恢复本文件会碰的环境变量（缺了恢复，同文件后面的用例读到的是脏环境） */
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = { [BASE]: process.env[BASE], [KEY]: process.env[KEY], [ALT_KEY]: process.env[ALT_KEY] };
  delete process.env[BASE];
  delete process.env[KEY];
  process.env[ALT_KEY] = 'sk-test-key';
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function project(): {
  config: ReturnType<typeof loadConfig>;
  assets: ReturnType<typeof discoverAssets>;
} {
  const root = mkdtempSync(join(tmpdir(), 'harness-endpoint-'));
  mkdirSync(join(root, 'agents'), { recursive: true });
  writeFileSync(
    join(root, 'agents', 'main.md'),
    '---\nname: main\nversion: 1\ndescription: 主 agent\n---\n你是执行者。\n',
    'utf8',
  );
  const base = loadConfig(root);
  // 配置里声明了 endpoint 段 —— 库用法下它必须生效，而不是只有 CLI 认它
  const config = { ...base, baseURL: 'http://127.0.0.1:9', apiKeyEnv: ALT_KEY };
  const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
  return { config, assets };
}

describe('endpoint 段在库入口生效（不只 CLI）', () => {
  it('createRunner 把 endpoint 段落进环境变量（不注入 client 的默认路径靠它）', () => {
    const { config, assets } = project();
    createRunner(config, assets);
    assert.equal(process.env[BASE], 'http://127.0.0.1:9', 'baseURL 必须落到 ANTHROPIC_BASE_URL');
    assert.equal(
      process.env[KEY],
      'sk-test-key',
      'apiKeyEnv 指向的 key 必须落到 ANTHROPIC_API_KEY',
    );
  });

  it('不覆盖已有的真实环境变量（命令行 / CI 的显式设置永远赢）', () => {
    process.env[BASE] = 'http://real.example';
    const { config, assets } = project();
    createRunner(config, assets);
    assert.equal(process.env[BASE], 'http://real.example', '已存在的环境变量不许被配置覆盖');
  });

  it('LlmProposer 构造时同样落地（它自建 AgentApp，默认 client 只读环境变量）', () => {
    const { config } = project();
    new LlmProposer(config);
    assert.equal(process.env[BASE], 'http://127.0.0.1:9');
    assert.equal(process.env[KEY], 'sk-test-key');
  });
});
