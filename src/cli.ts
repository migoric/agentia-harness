#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadEnvFile } from '@migor/agentia';
import { discoverAssets } from './assets/discover.js';
import {
  buildLock,
  describeDrift,
  diffLock,
  driftIsEmpty,
  readLock,
  writeLock,
} from './assets/lockfile.js';
import { loadConfig } from './config.js';
import { describeError, HarnessError, isHarnessError } from './errors.js';
import { runSuite } from './evals/run.js';
import { readJournal, revertLast } from './rsi/accept.js';
import { runCycle } from './rsi/loop.js';
import { LlmProposer } from './rsi/propose.js';
import { createRunner } from './run/runner.js';
import { startServer } from './server/serve.js';

/**
 * CLI —— 五个命令，每个对应 RSI 闭环的一段。
 *
 * 退出码是接口的一部分（CI 与脚本要靠它判断）：
 * `0` = 正常，`1` = 断言/门未过，`2` = 用法或配置错误。
 */
const HELP = `harness —— 基于 agentia 的 Agent harness 工程基座

用法：harness <命令> [参数]

  init [目录]         生成一个可跑的最小工程（缺省当前目录）
  run <任务>          跑一次任务，打印结果与 traceId
  eval                跑评测集；有失败用例则退出码 1
  lock                按当前资产重写 harness.lock.json
  lock --check        校验资产与锁是否一致（CI 用），不一致退出码 1
  rsi                 跑一轮 RSI：采集→归因→提案→验证→采纳
  rsi --dry-run       只验证不落盘（人审模式）
  rsi revert          回滚最近一次采纳
  rsi status          看采纳历史
  serve               起 HTTP 服务（POST /run、GET /health）

通用参数：
  --root <目录>       工程根（缺省 cwd）
  --agent <名字>      指定 agents/ 里的哪个（有多个时必需）
  --json              机器可读输出
`;

interface Args {
  readonly _: string[];
  readonly flags: Readonly<Record<string, string | true>>;
}

function parseArgs(argv: readonly string[]): Args {
  const rest: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (!a.startsWith('--')) {
      rest.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { _: rest, flags };
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const root = resolve(typeof args.flags.root === 'string' ? args.flags.root : process.cwd());

  if (cmd === undefined || cmd === 'help' || cmd === '--help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === 'init') {
    return init(root);
  }

  // .env 从工程根读：真实环境变量优先（override=false 是 loadEnvFile 的缺省）
  loadEnvFile({ path: join(root, '.env') });
  const config = loadConfig(root);
  const agent = typeof args.flags.agent === 'string' ? args.flags.agent : undefined;

  switch (cmd) {
    case 'run': {
      const task = args._.join(' ').trim();
      if (task === '') throw new HarnessError('run.failed', 'run 需要任务描述：harness run "..."');
      const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
      const runner = createRunner(config, assets, agent);
      const out = await runner.run(task);
      if (args.flags.json === true) {
        out_json({
          text: out.text,
          ok: out.ok,
          stopReason: out.stopReason,
          tokens: out.tokens,
          iterations: out.iterations,
          durationMs: out.durationMs,
          traceId: out.trace.traceId,
          error: out.error ?? null,
        });
      } else {
        process.stdout.write(`${out.text}\n`);
        process.stdout.write(
          `\n[${out.stopReason}] ${out.tokens} token · ${out.iterations} 轮 · ${out.durationMs}ms · trace ${out.trace.traceId}\n`,
        );
      }
      return out.ok ? 0 : 1;
    }

    case 'eval': {
      const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
      const only =
        typeof args.flags.only === 'string'
          ? args.flags.only.split(',').map((s) => s.trim())
          : undefined;
      const report = await runSuite({
        config,
        assets,
        ...(agent !== undefined ? { agent } : {}),
        ...(only !== undefined ? { only } : {}),
      });
      if (args.flags.json === true) {
        out_json(report);
      } else {
        for (const c of report.cases) {
          const mark = c.passed ? 'PASS' : 'FAIL';
          process.stdout.write(`${mark}  ${c.name}  (${c.tokens} token, ${c.iterations} 轮)\n`);
          for (const f of c.failures) process.stdout.write(`      - ${f}\n`);
        }
        process.stdout.write(
          `\n${report.passed}/${report.total} 通过（${(report.passRate * 100).toFixed(1)}%）· ${report.tokens} token · 资产 ${report.assetFingerprint}\n`,
        );
      }
      return report.passed === report.total ? 0 : 1;
    }

    case 'lock': {
      const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
      const lock = readLock(config.lockPath);
      if (args.flags.check === true) {
        const drift = diffLock(lock, assets);
        process.stdout.write(`${describeDrift(drift)}\n`);
        return driftIsEmpty(drift) ? 0 : 1;
      }
      writeLock(config.lockPath, buildLock(assets));
      process.stdout.write(
        `已写入 ${config.lockPath}（${Object.keys(buildLock(assets).assets).length} 个资产）\n`,
      );
      return 0;
    }

    case 'rsi': {
      if (args._[0] === 'revert') {
        const r = revertLast(config);
        process.stdout.write(`已回滚 ${r.entry.proposalId}：${r.entry.target}\n`);
        return 0;
      }
      if (args._[0] === 'status') {
        const entries = readJournal(config);
        if (entries.length === 0) {
          process.stdout.write('还没有任何采纳记录\n');
          return 0;
        }
        for (const e of entries) {
          const when = new Date(e.at).toISOString().replace('T', ' ').slice(0, 19);
          process.stdout.write(
            `${when}  ${e.status.padEnd(8)}  ${e.proposalId}  ${e.target}\n            ${e.reason}\n`,
          );
        }
        return 0;
      }

      const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
      const maxModes = numFlag(args.flags['max-modes']);
      const maxVerify = numFlag(args.flags['max-verify']);
      const report = await runCycle({
        config,
        assets,
        ...(agent !== undefined ? { agent } : {}),
        proposer: new LlmProposer(config, maxModes !== undefined ? { maxModes } : {}),
        ...(maxVerify !== undefined ? { maxVerify } : {}),
        ...(args.flags['dry-run'] === true ? { dryRun: true } : {}),
      });

      if (args.flags.json === true) {
        out_json(report);
      } else {
        if (report.modes.length === 0) {
          process.stdout.write('没有失败样本，无需改进\n');
          return 0;
        }
        process.stdout.write(`失败模式 ${report.modes.length} 个：\n`);
        for (const m of report.modes) {
          process.stdout.write(
            `  [${m.kind}] ${m.signature}  ×${m.count}（${m.cases.join(', ')}）\n`,
          );
        }
        process.stdout.write(
          `\n提出 ${report.proposals.length} 个提案，验证 ${report.verified.length} 个：\n`,
        );
        for (const v of report.verified) {
          const mark = v.gate.ok ? 'PASS' : 'BLOCK';
          process.stdout.write(
            `  ${mark}  ${v.proposal.id} → ${v.proposal.patch.target}：${v.gate.reason}\n`,
          );
        }
        if (report.accepted.length > 0) {
          process.stdout.write(
            `\n采纳 ${report.accepted.length} 个${args.flags['dry-run'] === true ? '（dry-run，未落盘）' : ''}：${report.accepted.map((p) => p.id).join(', ')}\n`,
          );
        }
        for (const r of report.rejected) {
          process.stdout.write(`  拒绝 ${r.proposal.id}：${r.reason}\n`);
        }
      }
      return report.accepted.length > 0 ? 0 : 1;
    }

    case 'serve': {
      const port = numFlag(args.flags.port) ?? 8787;
      const assets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
      const running = await startServer({
        config,
        assets,
        port,
        ...(agent !== undefined ? { agent } : {}),
      });
      process.stdout.write(
        `harness 在 http://127.0.0.1:${running.port} 上（POST /run，GET /health）\n`,
      );
      // 常驻：等 SIGINT
      await new Promise<void>((resolvePromise) => {
        process.once('SIGINT', () => resolvePromise());
        process.once('SIGTERM', () => resolvePromise());
      });
      await running.close();
      return 0;
    }

    default:
      process.stderr.write(`未知命令: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

/** `harness init` —— 生成一个立刻能跑（至少能 eval 报错得体）的最小工程 */
function init(root: string): number {
  const files: Record<string, string> = {
    'harness.config.json': `${JSON.stringify({ appName: 'my-agent' }, null, 2)}\n`,
    'agents/main.md': `---
name: main
version: 1
description: 主 agent —— 把任务拆开，交给合适的技能
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
      process.stdout.write(`跳过已存在: ${rel}\n`);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, 'utf8');
    process.stdout.write(`写入: ${rel}\n`);
  }
  process.stdout.write(
    '\n下一步：\n  1. 配好模型凭据（.env）\n  2. harness eval\n  3. harness run "你的任务"\n',
  );
  return 0;
}

function numFlag(v: string | true | undefined): number | undefined {
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function out_json(v: unknown): void {
  process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`错误: ${describeError(e)}\n`);
    process.exitCode = isHarnessError(e) && e.code.startsWith('asset') ? 2 : 1;
  },
);
