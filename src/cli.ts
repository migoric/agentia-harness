#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { loadEnvFile } from '@migor/agentia';
import { assertKnownFlags, parseArgs, strFlag } from './cli/args.js';
import { lockCommand } from './cli/commands/assets.js';
import { harvestCommand } from './cli/commands/harvest.js';
import { reportCommand, traceCommand } from './cli/commands/observe.js';
import { patchCommand } from './cli/commands/patch.js';
import { rsiCommand } from './cli/commands/rsi.js';
import { evalCommand, runCommand } from './cli/commands/run.js';
import { serveCommand } from './cli/commands/serve.js';
import type { CliContext } from './cli/context.js';
import { initCommand } from './cli/init.js';
import { say, warn } from './cli/output.js';
import { loadConfig } from './config.js';
import { describeError, isHarnessError } from './errors.js';
import { applyEndpointEnv, assertEndpointKey } from './run/endpoint.js';

/**
 * CLI —— 八个命令，每个对应闭环的一段。
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
    --keep-traces         把每次运行的 trace 落盘（默认不落，供失败后回查链路）
  report <基线.json> <候选.json>
                          两份报告比一次并过回归门；门不过退出码 1
    --max-token-growth <r>  通过率不变时允许的 token 增幅（0.1 = 10%）
    --max-cost-growth <r>   成本可比时允许的成本增幅（缺省跟随 token 阈值）
  trace <traceId>         打印那次运行的 span 树（可用前缀）
    --tail <n>            只看 traces.jsonl 最后 n 行（大文件用）
    --json                输出原始 trace
  harvest <traceId>       把一条 trace 回流成 eval/<name>.md 回归用例
    --task <文本>         任务原文（trace 里没存，必须外来）
    --from-report <文件>  或从 eval --save 的报告按 traceId 反查任务原文
  lock                    按当前资产重写 harness.lock.json
  lock --check            校验资产与锁是否一致（CI 用），不一致退出码 1
  rsi                     跑一轮 RSI：采集→归因→提案→验证→采纳
    --dry-run             只验证不落盘（人审模式）
    --max-modes <n>       最多给几个失败模式提方案（缺省 3）
    --max-verify <n>      最多验证几个提案（缺省 3）
    --max-cost <usd>      本轮成本上限（覆盖配置 maxCostUsd）
    --timeout/--concurrency/--retries   见 eval 节
  rsi revert [id]         回滚最近一次采纳（给 id 可防期间插入新采纳）
  rsi status              看采纳历史
  rsi propose --from <json>  登记手写 L1 提案（不调模型）
  rsi accept --from <json>   手写提案也要过完整验证门才能采纳
  patch <diff>             验证一个代码补丁（在 git worktree 沙箱里跑验证命令）
    --yes                 验证通过后落盘（代码补丁必须人工确认）
    --verify "npm test"   覆盖配置里的验证命令
    --timeout <ms>        验证命令超时（缺省 10 分钟）
    --revert              回滚最近一次代码补丁
  serve                   起 HTTP 服务（POST /run、GET /health）
    --port <n>            端口（缺省 8787）
    --host <ip>           监听地址（缺省 127.0.0.1）
    --timeout <ms>        单次 /run 的超时（超时按 504 返回）

通用参数：
  --root <目录>           工程根（缺省 cwd）
  --agent <名字>          指定 agents/ 里的哪个（有多个时必需）
  --json                  机器可读输出
`;

/** 全局 flag —— 每个命令都收；其余按命令白名单给（拼错就退出码 2） */
const GLOBAL_FLAGS = ['root', 'agent', 'json'] as const;
const COMMAND_FLAGS: Readonly<Record<string, readonly string[]>> = {
  init: [],
  run: [],
  eval: ['save', 'only', 'keep-traces', 'timeout', 'concurrency', 'retries'],
  report: ['max-token-growth', 'max-cost-growth'],
  trace: ['tail'],
  harvest: ['task', 'from-report'],
  lock: ['check'],
  rsi: [
    'dry-run',
    'max-modes',
    'max-verify',
    'max-cost',
    'from',
    'timeout',
    'concurrency',
    'retries',
  ],
  patch: ['yes', 'verify', 'timeout', 'revert'],
  serve: ['port', 'host', 'timeout'],
};

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const allowed = cmd === undefined ? undefined : COMMAND_FLAGS[cmd];
  if (cmd !== undefined && allowed !== undefined) {
    assertKnownFlags(args.flags, [...GLOBAL_FLAGS, ...allowed], cmd);
  }
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

  // 端点与凭据只在**真会调模型**的命令上校验：`lock` / `trace` / `report` /
  // `rsi status|revert` 一个模型都不调，没 key 时拦它们只会让人以为工具坏了
  if (needsModel(cmd, args._[0])) {
    applyEndpointEnv(ctx.config);
    assertEndpointKey(ctx.config);
  }

  switch (cmd) {
    case 'run':
      return runCommand(ctx, args._.join(' ').trim());
    case 'eval':
      return evalCommand(ctx);
    case 'report':
      return reportCommand(ctx, args._[0], args._[1]);
    case 'trace':
      return traceCommand(ctx, args._[0]);
    case 'harvest':
      return harvestCommand(ctx, args._[0]);
    case 'lock':
      return lockCommand(ctx);
    case 'rsi':
      return rsiCommand(ctx, args._[0], args._[1]);
    case 'patch':
      return patchCommand(ctx, args._[0]);
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

/**
 * 这条命令会调模型吗？
 *
 * `rsi` 的 `status` / `revert` / `propose` 不调：把「看历史记录、登记手写提案」
 * 也拦在「先配好 key」后面，会让人以为这些操作依赖凭据。
 */
function needsModel(cmd: string, sub: string | undefined): boolean {
  if (cmd === 'run' || cmd === 'eval' || cmd === 'serve') return true;
  // `rsi propose` 只是校验+落盘一份 JSON，不调模型；`accept` 要跑两遍评测
  if (cmd === 'rsi') return sub === undefined || sub === 'accept';
  return false;
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
