#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { loadEnvFile } from '@migor/agentia';
import { parseArgs, strFlag } from './cli/args.js';
import { lockCommand } from './cli/commands/assets.js';
import { reportCommand, traceCommand } from './cli/commands/observe.js';
import { rsiCommand } from './cli/commands/rsi.js';
import { evalCommand, runCommand } from './cli/commands/run.js';
import { serveCommand } from './cli/commands/serve.js';
import type { CliContext } from './cli/context.js';
import { initCommand } from './cli/init.js';
import { say, warn } from './cli/output.js';
import { loadConfig } from './config.js';
import { describeError, isHarnessError } from './errors.js';

/**
 * CLI —— 七个命令，每个对应闭环的一段。
 *
 * 退出码是接口的一部分（CI 与脚本靠它判断）：
 * `0` = 正常，`1` = 断言/门未过，`2` = 用法、配置或资产错误。
 *
 * 最后一条的分类标准：`2` 表示「你把东西配错了，改配置再来」，`1` 表示「东西配对了，
 * 但结果没达标」。脚本据此决定是报错给人看还是重试。
 */
const HELP = `harness —— 基于 agentia 的 Agent harness 工程基座

用法：harness <命令> [参数]

  init [目录]             生成一个可跑的最小工程（缺省当前目录）
  run <任务>              跑一次任务，打印结果、命中技能与 traceId
  eval                    跑评测集；有失败用例则退出码 1
    --save <文件>         把报告写成 JSON（供 report 命令对比）
    --only <a,b>          只跑这些用例
    --timeout <ms>        单条用例超时（超时按失败记）
    --concurrency <n>     并发跑几条（缺省 1：串行，成本最好归因）
    --retries <n>         只对「跑崩了」重试几次（断言失败不重试）
  report <基线.json> <候选.json>
                          两份报告比一次并过回归门；门不过退出码 1
    --max-token-growth <r>  通过率不变时允许的 token 增幅（0.1 = 10%）
  trace <traceId>         打印那次运行的 span 树（可用前缀）
    --tail <n>            只看 traces.jsonl 最后 n 行（大文件用）
    --json                输出原始 trace
  lock                    按当前资产重写 harness.lock.json
  lock --check            校验资产与锁是否一致（CI 用），不一致退出码 1
  rsi                     跑一轮 RSI：采集→归因→提案→验证→采纳
    --dry-run             只验证不落盘（人审模式）
    --max-modes <n>       最多给几个失败模式提方案（缺省 3）
    --max-verify <n>      最多验证几个提案（缺省 3）
  rsi revert              回滚最近一次采纳
  rsi status              看采纳历史
  serve                   起 HTTP 服务（POST /run、GET /health）
    --port <n>            端口（缺省 8787）
    --host <ip>           监听地址（缺省 127.0.0.1）

通用参数：
  --root <目录>           工程根（缺省 cwd）
  --agent <名字>          指定 agents/ 里的哪个（有多个时必需）
  --json                  机器可读输出
`;

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const root = resolve(strFlag(args.flags, 'root') ?? process.cwd());

  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    say(HELP);
    return 0;
  }
  // `init [目录]` 用位置参数（它是「在哪儿创建」，不是「读哪份配置」）
  if (cmd === 'init') {
    return initCommand(resolve(strFlag(args.flags, 'root') ?? args._[0] ?? process.cwd()));
  }

  // .env 从工程根读：真实环境变量优先（override=false 是 loadEnvFile 的缺省）
  loadEnvFile({ path: join(root, '.env') });
  const ctx: CliContext = {
    root,
    config: loadConfig(root),
    flags: args.flags,
    agent: strFlag(args.flags, 'agent'),
  };

  switch (cmd) {
    case 'run':
      return runCommand(ctx, args._.join(' ').trim());
    case 'eval':
      return evalCommand(ctx);
    case 'report':
      return reportCommand(ctx, args._[0], args._[1]);
    case 'trace':
      return traceCommand(ctx, args._[0]);
    case 'lock':
      return lockCommand(ctx);
    case 'rsi':
      return rsiCommand(ctx, args._[0]);
    case 'serve':
      return serveCommand(ctx);
    default:
      warn(`未知命令: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

/** 用法/配置/资产层面的错 → 2；结果不达标的错 → 1 */
function isUsageError(e: unknown): boolean {
  if (!isHarnessError(e)) return false;
  return e.code.startsWith('config') || e.code.startsWith('asset') || e.code === 'eval.invalid';
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    warn(`错误: ${describeError(e)}`);
    process.exitCode = isUsageError(e) ? 2 : 1;
  },
);
