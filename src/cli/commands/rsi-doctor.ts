import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspacePaths } from '../../config.js';
import { describeError } from '../../errors.js';
import { loadEvalCases } from '../../evals/load.js';
import { readAcceptIntent } from '../../rsi/commit.js';
import { readJournal } from '../../rsi/journal.js';
import { cyclesDir } from '../../rsi/paths.js';
import { readPending } from '../../rsi/pending.js';
import { readSpendWindow } from '../../rsi/spend-ledger.js';
import { describeWorker } from '../../rsi/worker-lock.js';
import { boolFlag } from '../args.js';
import { assetsOf, type CliContext } from '../context.js';
import { json, say, warn } from '../output.js';

/**
 * `rsi doctor` —— 「现在能不能安全开跑、为什么不能」。
 *
 * 存在的理由是一次真实排查：`rsi` 启动即失败，报的是 `rsi.gate_blocked`，人先去看
 * 进程（没有）、再看网络（正常）、最后才发现是三天前一次 SIGKILL 留下的锁 +
 * 一个没回收的远程候选。三样东西散在三个文件里，而没有任何一条命令把它们放在一起。
 *
 * 这个命令只做**体检**，不修任何东西（除了不需要修的部分）：修复动作各有各的前提，
 * 混进一个「自动修」的入口，迟早会在人不知情的时候改动历史记录。
 *
 * 输出分两类：**信息**（锁在跑、窗口已花多少）与**阻塞项**（journal 坏、候选没回收）。
 * 有阻塞项时退出码 1 —— 这样 cron / 脚本可以先跑一次 doctor 再决定要不要开跑。
 */
export interface DoctorLine {
  readonly item: string;
  readonly detail: string;
  /** 需要人处理（或至少要知道）的问题 */
  readonly problem: boolean;
}

export function doctor(ctx: CliContext): number {
  const lines: DoctorLine[] = [
    lockLine(ctx.config),
    intentLine(ctx.config),
    pendingLine(ctx.config),
    journalLine(ctx.config),
    cyclesLine(ctx.config),
    holdoutLine(ctx.config),
    budgetLine(ctx.config),
    assetsLine(ctx),
  ];

  if (boolFlag(ctx.flags, 'json')) {
    json({ ok: lines.every((l) => !l.problem), lines });
    return lines.some((l) => l.problem) ? 1 : 0;
  }

  say('rsi 体检：');
  for (const line of lines) {
    const mark = line.problem ? '⚠' : '·';
    say(`  ${mark} ${line.item.padEnd(4)} ${line.detail}`);
  }
  const problems = lines.filter((l) => l.problem).length;
  say(
    problems === 0
      ? '\n没有发现问题，可以开跑。'
      : `\n有 ${problems} 项需要处理（上面带 ⚠ 的行）。`,
  );
  return problems === 0 ? 0 : 1;
}

function lockLine(p: WorkspacePaths): DoctorLine {
  const w = describeWorker(p);
  if (!w.running) {
    // 「有锁文件但判死」与「没有锁文件」不是一回事：前者是上次被 SIGKILL 的痕迹，
    // 下一次开跑会把它改名留存并接手。说成「空闲」会让人以为盘上是干净的
    return w.lock === null
      ? { item: '锁', detail: '空闲', problem: false }
      : {
          item: '锁',
          detail: `陈旧锁（pid ${w.lock.pid}，${w.reason}）—— 下次开跑会自动回收`,
          problem: false,
        };
  }
  const command = w.lock?.command ?? '未知命令';
  return {
    item: '锁',
    detail: `${command} 持有（pid ${w.lock?.pid}@${w.lock?.host}，${w.reason}）—— 此时开跑会被拒绝`,
    problem: false,
  };
}

/**
 * 采纳中间态（`accept-intent.json`）。
 *
 * 有它不一定是问题：下一次任何写入口（`rsi` / `accept` / `revert`）都会按磁盘正文
 * 自动补齐或清理。但如果**没有任何写入口会跑**，它就那么留着 —— 所以要说出来。
 */
function intentLine(p: WorkspacePaths): DoctorLine {
  let intent: ReturnType<typeof readAcceptIntent>;
  try {
    intent = readAcceptIntent(p);
  } catch (e) {
    // 坏掉的意图记录会让**每次**开跑都失败，这正是最需要 doctor 说出来的形态
    return {
      item: '采纳',
      detail: `${describeError(e)} —— 需要人工确认资产内容后删掉那条记录`,
      problem: true,
    };
  }
  if (intent === undefined) return { item: '采纳', detail: '没有中断的中间态', problem: false };
  return {
    item: '采纳',
    detail:
      `上一次采纳没有走完（${intent.proposalId} → ${intent.target}）—— ` +
      '下次开跑会按磁盘正文自动补齐或清理',
    problem: false,
  };
}

function pendingLine(p: WorkspacePaths): DoctorLine {
  try {
    const stage = readPending(p);
    if (stage === undefined) return { item: '远程', detail: '没有未回收的候选', problem: false };
    return {
      item: '远程',
      detail:
        `候选还留在 ${stage.file}（提案 ${stage.proposalId}，备份 ${stage.backup}）—— ` +
        '下次 `rsi --remote` 会先回收它；在回收之前远端可能仍在用未验证的提示词',
      problem: true,
    };
  } catch (e) {
    return { item: '远程', detail: `${describeError(e)} —— 需要人工确认`, problem: true };
  }
}

function journalLine(p: WorkspacePaths): DoctorLine {
  const path = join(p.workspaceDir, 'rsi', 'journal.jsonl');
  let bytes: number;
  try {
    bytes = statSync(path).size;
  } catch {
    return { item: '账本', detail: '还没有采纳记录', problem: false };
  }
  /**
   * 真读一遍，而不是只看文件在不在。
   *
   * 这是唯一能发现「末行半截」的检查，而那个状态会让 accept / regress / ledger
   * 全部失效 —— 它不该等到人下一次采纳时才被发现。doctor 不贵，值得读完。
   */
  try {
    const entries = readJournal(p);
    const last = entries[entries.length - 1];
    const when =
      last === undefined
        ? '（空）'
        : new Date(last.at).toISOString().slice(0, 16).replace('T', ' ');
    return {
      item: '账本',
      detail: `${entries.length} 条，末条 ${when}，末行完整（${(bytes / 1024).toFixed(1)} KB）`,
      problem: false,
    };
  } catch (e) {
    return {
      item: '账本',
      detail: `${describeError(e)}\n     → 跑 \`harness rsi journal --repair\`（会留备份）`,
      problem: true,
    };
  }
}

function cyclesLine(p: WorkspacePaths): DoctorLine {
  const dir = cyclesDir(p);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return { item: '轮次', detail: '还没有轮次记录', problem: false };
  }
  const bytes = files.reduce((sum, f) => {
    try {
      return sum + statSync(join(dir, f)).size;
    } catch {
      return sum;
    }
  }, 0);
  const mb = bytes / 1024 / 1024;
  return {
    item: '轮次',
    detail: `${files.length} 份记录，共 ${mb.toFixed(1)} MB${mb > 200 ? '（建议归档：见 docs/operations.md）' : ''}`,
    problem: false,
  };
}

function holdoutLine(p: WorkspacePaths): DoctorLine {
  try {
    const cases = loadEvalCases(p.evalsDir).filter((c) => c.split === 'holdout');
    if (cases.length === 0) return { item: '留出', detail: '没有留出集用例', problem: false };
    const phases = new Set(cases.map((c) => c.phase ?? 1));
    return {
      item: '留出',
      detail: `${cases.length} 条，${phases.size} 批`,
      problem: false,
    };
  } catch (e) {
    // 用例读不出来不该让 doctor 挂 —— 但它确实会让 RSI 跑不起来，所以标成问题
    return { item: '留出', detail: `${describeError(e)}（RSI 会因此读不到用例）`, problem: true };
  }
}

function budgetLine(p: WorkspacePaths): DoctorLine {
  const { window: w, note } = readSpendWindow(p);
  if (w.runs === 0) return { item: '预算', detail: '本窗口还没有花费记录', problem: false };
  const since = new Date(w.startedAt).toISOString().slice(0, 16).replace('T', ' ');
  return {
    item: '预算',
    detail:
      `本窗口（自 ${since}）已花 ${w.usd.toFixed(4)} USD / ${w.tokens} token，${w.runs} 轮` +
      (note === undefined ? '' : `\n     ${note}`),
    problem: false,
  };
}

function assetsLine(ctx: CliContext): DoctorLine {
  try {
    const a = assetsOf(ctx);
    return {
      item: '资产',
      detail: `${a.skills.length} 个技能 / ${a.agents.length} 个 agent（${a.fingerprint}）`,
      problem: false,
    };
  } catch (e) {
    warn(describeError(e));
    return { item: '资产', detail: '读不出来（见上面的错误）', problem: true };
  }
}
