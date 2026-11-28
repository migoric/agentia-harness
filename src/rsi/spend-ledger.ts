import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorkspacePaths } from '../config.js';
import { atomicWrite } from './journal.js';

/**
 * 预算窗口 —— 把 `--watch --max-cost` 的账**落到盘上**，让它在重启后仍然连续。
 *
 * 修复的是一个具体的、会真花钱的缺口：`--watch` 的累计花费此前只活在内存里
 * （`rsi-watch.ts` 的 `priorCost`）。进程被 OOM kill、容器重启、机器重启之后，
 * 预算从 0 重新开始 —— 于是一个写死 `--max-cost 2` 的 worker，一夜之间被重启
 * 五次就能花掉 10 美元，而每一次「这一轮的花费都在上限内」。
 *
 * 三个口径：
 *
 * 1. **窗口，不是永久账本**。`--max-cost 2` 的语义是「这段时间最多 2 美元」，
 *    永久累计会让 worker 跑几天之后永远停在那里。默认 24 小时滚动窗口：
 *    窗口起点是第一次记账的时刻，超过 24h 就开新窗口。
 * 2. **改上限不等于重置**。把 `--max-cost` 从 5 改成 50 不该让已经花掉的 4 美元
 *    消失（那是个免费的重置后门）；从 50 改成 5 时，累计值立刻生效 —— 那正是
 *    用户想要的「收紧」。所以窗口里不存上限，上限只在判定时用。
 * 3. **坏文件不能变成免费**。解析失败时不静默归零（那等于送一次预算），而是把坏
 *    文件改名留存、开新窗口，并把这件事**说出来**（`note`）。预算账不是审计依据，
 *    但它坏掉的后果是超支，所以要留下痕迹。
 *
 * 刻意**不**做的：把 `rsi`（一次性）也算进同一窗口。它的上限语义是「这一次运行」，
 * 而且一次运行本来就跨不进第二个进程 —— 把它并进窗口会让「今天跑两次 `rsi
 * --max-cost 1`」变成第二次直接被拒，与参数名相去甚远。
 */
export interface SpendWindow {
  readonly schema: 1;
  /** 窗口起点（毫秒时间戳）—— 第一次记账的时刻，不是文件创建时刻 */
  readonly startedAt: number;
  readonly usd: number;
  readonly tokens: number;
  /** 记过几次账（轮次），供 `rsi doctor` 说明这个数是怎么来的 */
  readonly runs: number;
}

export const DEFAULT_WINDOW_MS = 24 * 60 * 60_000;

export function spendWindowPath(p: WorkspacePaths): string {
  return join(p.workspaceDir, 'rsi', 'spend.json');
}

export interface WindowRead {
  readonly window: SpendWindow;
  /** 需要让人知道的事（坏文件、窗口刚重置）—— 没有就是 `undefined` */
  readonly note?: string | undefined;
}

export function emptyWindow(now: number): SpendWindow {
  return { schema: 1, startedAt: now, usd: 0, tokens: 0, runs: 0 };
}

/** 读当前窗口；过期或不存在时返回一个**未落盘**的新窗口 */
export function readSpendWindow(
  p: WorkspacePaths,
  opts: { windowMs?: number; now?: number } = {},
): WindowRead {
  const path = spendWindowPath(p);
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  if (!existsSync(path)) return { window: emptyWindow(now) };

  let parsed: SpendWindow;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SpendWindow>;
    if (
      raw.schema !== 1 ||
      typeof raw.startedAt !== 'number' ||
      typeof raw.usd !== 'number' ||
      typeof raw.tokens !== 'number'
    ) {
      throw new Error('缺少 schema/startedAt/usd/tokens');
    }
    parsed = {
      schema: 1,
      startedAt: raw.startedAt,
      usd: Number.isFinite(raw.usd) && raw.usd >= 0 ? raw.usd : 0,
      tokens: Number.isFinite(raw.tokens) && raw.tokens >= 0 ? raw.tokens : 0,
      runs: typeof raw.runs === 'number' ? raw.runs : 0,
    };
  } catch (err) {
    // 坏文件改名留存，再开一个新窗口：静默归零等于把「上一窗口花了多少」也一起
    // 抹掉，而那个数恰恰是这类故障里唯一还能查的东西
    const keep = `${path}.corrupt-${now}`;
    try {
      atomicWrite(keep, readFileSync(path, 'utf8'));
    } catch {
      // 连备份都写不了（磁盘满/权限）：仍然继续，但下面那句 note 会说出来
    }
    return {
      window: emptyWindow(now),
      note:
        `预算窗口文件读不出来（${err instanceof Error ? err.message : String(err)}）—— ` +
        `已开新窗口，旧文件留存为 ${keep}。本窗口的 --max-cost 从 0 起算。`,
    };
  }

  if (now - parsed.startedAt >= windowMs) {
    return {
      window: emptyWindow(now),
      note:
        `预算窗口已过期（自 ${new Date(parsed.startedAt).toISOString()} 起超过 ` +
        `${Math.round(windowMs / 3_600_000)} 小时，累计 ${parsed.usd.toFixed(4)} USD）—— 新窗口从 0 起算`,
    };
  }
  return { window: parsed };
}

/** 记一笔（窗口起点保持不变）；返回落盘后的窗口 */
export function addSpend(
  p: WorkspacePaths,
  delta: { usd?: number | undefined; tokens?: number | undefined },
  opts: { windowMs?: number; now?: number } = {},
): SpendWindow {
  const now = opts.now ?? Date.now();
  const current = readSpendWindow(p, { ...opts, now }).window;
  const next: SpendWindow = {
    schema: 1,
    startedAt: current.startedAt,
    // 负增量不采纳：成本读数的坏值不该让预算往「永远不超」的方向倒
    usd: current.usd + Math.max(0, delta.usd ?? 0),
    tokens: current.tokens + Math.max(0, delta.tokens ?? 0),
    runs: current.runs + 1,
  };
  const path = spendWindowPath(p);
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
