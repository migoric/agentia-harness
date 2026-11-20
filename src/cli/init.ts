import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { discoverAssets } from '../assets/discover.js';
import { buildLock, writeLock } from '../assets/lockfile.js';
import { loadConfig } from '../config.js';
import { say } from './output.js';

/**
 * `harness init` —— 生成一个立刻能跑的最小工程。
 *
 * 三个原则：
 * - **不覆盖**已有文件（只跳过并说明），因为 `init` 可能在已有工程里被误跑；
 * - **锁文件一次到位**：生成完立刻 `lock`，这样 `lock --check` 一开始就是绿的，
 *   CI 接上去不会莫名其妙红；
 * - 模板里显式写 `tools`，让「不写 = 全部」这条缺省规则不被模板掩盖 —— 示例该教人
 *   写清楚，而不是依赖缺省。
 */
export function initCommand(root: string): number {
  const files: Record<string, string> = {
    'harness.config.json': `${JSON.stringify({ appName: 'my-agent' }, null, 2)}\n`,
    'agents/main.md': `---
name: main
version: 1
description: 主 agent —— 把任务拆开，交给合适的技能
tools: [example]
maxIterations: 8
---

你是一个严谨的执行者。收到任务后：

1. 先判断要不要调用技能；能调用就把上下文写全再调。
2. 技能返回后，核对它是否真的回答了任务，不要直接把原文当结论。
3. 最后给出结论：先一句话结论，再列关键依据。

不确定的事就说不知道，不要编造。
`,
    'skills/example/SKILL.md': `---
name: example
version: 1
description: 示例技能 —— 把一段文字压缩成三条要点
maxIterations: 4
---

你是摘要器。读输入文字，输出恰好三条要点，每条不超过 30 字。

要求：
- 只保留事实，不做推测；
- 每条以动词或名词开头，不要「这」「那」开头；
- 三条之间不重复。
`,
    'evals/example.md': `---
name: example
expect_contains: 要点
expect_max_tokens: 20000
---

把下面这段话压成三条要点：

本项目是一个基于类型化契约的 agent 运行时，提供 trace、审批、断点续跑与
多后端持久化。它刻意不内置编排图与向量库，把「怎么组织流程」留给调用方。
目前支持 fs / redis / sqlite / postgres 四种任务存储，并有一份不断增长的
决策日志记录每个取舍的理由。
`,
    '.gitignore': `node_modules/\ndist/\n.workspace/\n.env\n`,
  };

  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    if (existsSync(path)) {
      say(`跳过已存在: ${rel}`);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, 'utf8');
    say(`写入: ${rel}`);
  }

  // 锁一次到位：新工程的 `lock --check` 立刻就是绿的
  const config = loadConfig(root);
  const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
  const lock = buildLock(assets);
  writeLock(config.lockPath, lock);
  say(`写入: harness.lock.json（${Object.keys(lock.assets).length} 个资产）`);

  say('\n下一步：\n  1. 配好模型凭据（.env）\n  2. harness eval\n  3. harness run "你的任务"');
  return 0;
}
