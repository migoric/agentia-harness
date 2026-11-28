#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { loadEnvFile } from '@migor/agentia';
import { assertKnownFlags, parseArgs, strFlag } from './cli/args.js';
import { lockCommand } from './cli/commands/assets.js';
import { balanceCommand } from './cli/commands/balance.js';
import { evidenceCommand } from './cli/commands/evidence.js';
import { harvestCommand } from './cli/commands/harvest.js';
import { historyCommand } from './cli/commands/history.js';
import { diffCommand, reportCommand, traceCommand } from './cli/commands/observe.js';
import { patchCommand } from './cli/commands/patch.js';
import { rsiCommand } from './cli/commands/rsi.js';
import { evalCommand, runCommand } from './cli/commands/run.js';
import { serveCommand } from './cli/commands/serve.js';
import type { CliContext } from './cli/context.js';
import { initCommand } from './cli/init.js';
import { say, warn } from './cli/output.js';
import { loadConfig } from './config.js';
import { describeError, isHarnessError } from './errors.js';
import { assertEndpointKey, ensureEndpointEnv } from './run/endpoint.js';

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
    --repeat <n>          每条用例重复采样 n 次（缺省 1）；用来把噪声和真实变化分开
    --keep-traces         把每次运行的 trace 落盘（默认不落，供失败后回查链路）
  report <基线.json> <候选.json>
                          两份报告比一次并过回归门；门不过退出码 1
    --max-token-growth <r>  通过率不变时允许的 token 增幅（0.1 = 10%）
    --max-cost-growth <r>   成本可比时允许的成本增幅（缺省跟随 token 阈值）
    --allow-case-set-change 用例集不同时不拒绝，只比对同名用例（缺省拒绝：分母变了）
  trace <traceId>         打印那次运行的 span 树（可用前缀）
    --tail <n>            只看 traces.jsonl 最后 n 行（大文件用）
    --json                输出原始 trace
  diff <traceA> <traceB>  两份 trace 差在哪（结构配对：谁多了一步、哪个字段变了）
    --tail <n>            只看 traces.jsonl 最后 n 行
    --json                输出结构化差异（TraceDiff）
  harvest <traceId>       把一条 trace 回流成 eval/<name>.md 回归用例
    --task <文本>         任务原文（trace 里没存，必须外来）
    --from-report <文件>  或从 eval --save 的报告按 traceId 反查任务原文
  evidence                把一份评测报告导出成三层证据语料（overview/detail/raw）
    --from-report <文件>  eval --save 生成的报告（带任务原文与 traceId）
    --id <名字>           语料 id（缺省按时间生成；已存在则拒绝覆盖）
  lock                    按当前资产重写 harness.lock.json
  lock --check            校验资产与锁是否一致（CI 用），不一致退出码 1
  balance                 查账户余额（DeepSeek 的 /user/balance）；RSI 的未定价模型靠它对账
    --json                机器可读输出
  history                 用例级历史：每条用例跑过几次、最近怎么走的、有没有抖动
    --tail <n>            只看最近 n 次运行（缺省全部；抖动判定固定看最近 20 次）
    --check               有抖动用例就退出码 1（CI 用：判定集里不该有不可信的成员）
    --json                机器可读输出
  rsi                     跑一轮 RSI：采集→归因→提案→验证→采纳
    --rounds <n>          连续跑 n 轮（每轮最多采纳一个；预算跨轮共享）
    --dry-run             只验证不落盘（人审模式；不能与 --rounds 同用）
    --max-modes <n>       最多给几个失败模式提方案（缺省 3）
    --max-verify <n>      最多验证几个提案（缺省 3）
    --max-cost <usd>      整次运行的成本上限（--rounds 下跨轮共享；覆盖配置 maxCostUsd）
    --max-tokens <n>      整次运行的 token 上限（模型没定价时美元闸读不出数，靠它兜底）
    --shrink-every <n>    连续 n 条改动没让资产变小，就强制下一轮只接受净简化提案（缺省 5）
    --watch               常驻推进：一轮一改、串行、有节流与停手条件（D9：写权限只在进程里）
    --every <s>           轮与轮之间的间隔秒数（缺省 900）
    --max-rounds <n>      最多跑几轮
    --until <时间>        到这个时刻就停（ISO 或 2026-11-29T08:00）
    --timeout/--concurrency/--retries/--repeat   见 eval 节
  rsi revert [id]         回滚最近一次采纳（给 id 可防期间插入新采纳）
  rsi status              看采纳历史
  rsi ledger              决策账本：当初的预测 vs 实际验证结果（--json 机器可读）
  rsi regress             采纳之后那些用例还通过吗；有回归退出码 1
  rsi journal [--repair]  看账本；--repair 截掉「追加写到一半」的末行（会先备份）
    --revert              检测到回归就自动回滚（仍过指纹校验）
  rsi propose --from <json>  登记手写 L1 提案（不调模型）
  rsi accept --from <json>   手写提案也要过完整验证门才能采纳
  patch <diff>             验证一个代码补丁（在 git worktree 沙箱里跑验证命令）
    --eval                用评测集当验证门（跑沙箱里这棵树的 harness eval，摘要进 journal）
    --yes                 验证通过后落盘（代码补丁必须人工确认）
    --verify "npm test"   覆盖配置里的验证命令
    --timeout <ms>        验证命令超时（缺省 10 分钟）
    --revert              回滚最近一次代码补丁
  serve                   起 HTTP 服务（POST /v1/run、GET /health、只读看板 / 与 /api/*）
    --port <n>            端口（缺省 8787）
    --host <ip>           监听地址（缺省 127.0.0.1；对外监听需配 server.apiKeyEnv）
    --timeout <ms>        单次 /v1/run 的超时（超时按 504 返回）

通用参数：
  --help / -h             打印这份用法（任何命令后面都行，如 harness rsi --help）
  --root <目录>           工程根（缺省 cwd）
  --agent <名字>          指定 agents/ 里的哪个（有多个时必需）
  --json                  机器可读输出
`;

/** 全局 flag —— 每个命令都收；其余按命令白名单给（拼错就退出码 2） */
const GLOBAL_FLAGS = ['root', 'agent', 'json'] as const;
const COMMAND_FLAGS: Readonly<Record<string, readonly string[]>> = {
  init: [],
  run: [],
  eval: [
    'save',
    'only',
    'keep-traces',
    'timeout',
    'concurrency',
    'retries',
    'repeat',
    'no-history',
    'remote',
    'token-env',
  ],
  report: ['max-token-growth', 'max-cost-growth', 'allow-case-set-change', 'no-history'],
  trace: ['tail'],
  diff: ['tail'],
  harvest: ['task', 'from-report'],
  evidence: ['from-report', 'id'],
  lock: ['check'],
  // 余额查询不发模型调用，但**要 key**：缺 key 时由命令自己报（它能说得更准，
  // 比如「端点支持但 .env 里没有 DEEPSEEK_API_KEY」），不走统一的凭据闸
  balance: [],
  history: ['tail', 'check'],
  rsi: [
    'dry-run',
    'max-modes',
    'max-verify',
    'max-cost',
    'max-tokens',
    'rounds',
    'shrink-every',
    'revert',
    'from',
    'timeout',
    'concurrency',
    'retries',
    'repeat',
    'repair',
    'watch',
    'every',
    'max-rounds',
    'until',
    // 远程验证：候选会写到服务读的那个文件里（`remote` 段给映射，`allowStaging` 签字）
    'remote',
    // 预检发现「本地与远端不一致」时，显式用本地覆盖远端
    'sync-remote',
  ],
  patch: ['yes', 'verify', 'eval', 'timeout', 'revert'],
  serve: ['port', 'host', 'timeout'],
};

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  // `--help` / `-h` 是**所有**命令的全局请求：`harness rsi --help` 是最自然的写法，
  // 而它以前会报「rsi 没有子命令 "--help"」—— 在「我想看用法」的时候给人一条用法错误，
  // 是最刺人的一种。
  //
  // 扫原始 argv 而不是解析后的 flags：`--help revert` 会被 `parseArgs` 读成
  // `flags.help = 'revert'`（它把后一个词当成值），那之后就再也看不出「有人想求助」了。
  if (rest.includes('--help') || rest.includes('-h')) {
    say(HELP);
    return 0;
  }
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
  // 带 `--remote` 的命令**要么把活交给服务**（eval），**要么被明确拒绝**（rsi，见
  // `rsiCommand` 的 `rejectRemote`）—— 两种都不需要本地模型凭据。
  //
  // 这个判定必须排在凭据闸**之前**：否则 `rsi --remote` 的用户先看到「缺少模型凭据」，
  // 于是去配 key，配完才被告知「这个组合不支持」。错误的提示不只是没用，它会消耗
  // 一次真实的排查动作。
  const delegatedRemote = args.flags.remote !== undefined;
  if (needsModel(cmd, args._[0]) && !delegatedRemote) {
    ensureEndpointEnv(ctx.config);
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
    case 'diff':
      return diffCommand(ctx, args._[0], args._[1]);
    case 'harvest':
      return harvestCommand(ctx, args._[0]);
    case 'evidence':
      return evidenceCommand(ctx);
    case 'lock':
      return lockCommand(ctx);
    case 'balance':
      return balanceCommand(ctx);
    case 'history':
      return historyCommand(ctx);
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
  return (
    e.code.startsWith('config') ||
    e.code.startsWith('asset') ||
    e.code === 'eval.invalid' ||
    // 「没基准可监测」是没准备好，不是「检测到回归」（后者 1）
    e.code === 'rsi.no_baseline'
  );
}

/**
 * 这条命令会调模型吗？
 *
 * `rsi` 的 `status` / `revert` / `propose` 不调：把「看历史记录、登记手写提案」
 * 也拦在「先配好 key」后面，会让人以为这些操作依赖凭据。
 */
function needsModel(cmd: string, sub: string | undefined): boolean {
  if (cmd === 'run' || cmd === 'eval' || cmd === 'serve') return true;
  // `rsi propose` 只是校验+落盘一份 JSON，不调模型。
  // `accept` 要跑两遍评测；`regress` 要重跑当前全集 —— 漏掉它就会在缺凭据时
  // 把一排 stopReason=error 当成「用例退步」，`--revert` 还会回滚一条正常采纳
  if (cmd === 'rsi') return sub === undefined || sub === 'accept' || sub === 'regress';
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
