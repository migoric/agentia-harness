import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorkspacePaths } from '../config.js';
import type { CaseResult, EvalReport } from './types.js';

/**
 * 用例级历史账本 —— 评测台与「跑一次脚本」的分界线。
 *
 * 报告是**孤立文件**：两份报告能回答「这次比上次好不好」，回答不了「这条用例本来就是
 * 抖的还是这次真坏了」。而没有后者，`gate` 的每一次否决都可能是在给噪声发奖。
 *
 * 落盘形态是 JSONL（一次运行一行），不是「一个用例一行」：
 * - 一次运行是一个原子事件，半行写坏不会污染其余运行；
 * - 读的时候按运行聚合才有意义（「同样的条件」的边界就是一次运行）；
 * - 追加是 O(1)，几千行之后仍然只是 `readFileSync` 的量级。
 */
export const HISTORY_SCHEMA = 1;

/**
 * 默认只看最近 20 次运行。
 *
 * 不设上限的话，三个月前的抖动会让一条用例**永远**被当成不可信 —— 而那之后我们
 * 可能已经换过模型、换过用例断言（`key` 变了会被自然排除），但状态没变的老用例
 * 仍会背着一个过期标签。窗口是「最近的它」而不是「历史上的它」。
 */
export const TREND_WINDOW = 20;

/**
 * 只需要工作区路径，不需要整份配置 —— 窄化成 `Pick` 让测试不必造一个完整工程。
 * 这不是为测试开的口子：`appendRun` / `readHistory` 真的只用到这一个字段。
 */
type Paths = Pick<WorkspacePaths, 'workspaceDir'>;

export function historyPath(config: Paths): string {
  return join(config.workspaceDir, 'evals', 'history.jsonl');
}

/** 一次运行里的一条用例结果。字段刻意与 `CaseResult` 同名，读的时候不用查映射表 */
export interface HistoryCase {
  readonly name: string;
  readonly passed: boolean;
  readonly samples: number;
  readonly passedSamples: number;
  readonly tokens: number;
  readonly costUsd?: number | undefined;
  readonly durationMs: number;
  readonly stopReason?: string | undefined;
}

export interface HistoryRun {
  readonly at: string;
  readonly agent: string;
  /** 资产指纹 —— 抖动判定的分组键之一 */
  readonly assets: string;
  /**
   * 用例集指纹 —— 分组键的另一半。
   *
   * 只按资产分组是不够的：把 `expect_contains: 三条` 收紧成 `三条要点`，资产一个字节
   * 没动，通过与否当然会变。那不是抖动，是判定标准变了，必须与抖动分开。
   */
  readonly cases: string | undefined;
  /** 每条用例的采样次数（`--repeat`）；缺席 = 各条不一致或老记录 */
  readonly samples?: number | undefined;
  readonly model?: string | undefined;
  readonly harness?: string | undefined;
  /** 产生这条记录的 `eval --save` 文件（相对工程根），供回查 */
  readonly report?: string | undefined;
  readonly outcomes: readonly HistoryCase[];
}

/** 追加一次运行。返回写入的路径（调用方要能告诉人「记到哪了」） */
export function appendRun(
  config: Paths,
  report: EvalReport,
  opts: { readonly report?: string | undefined } = {},
): string {
  const file = historyPath(config);
  mkdirSync(dirname(file), { recursive: true });
  const run = {
    schema: HISTORY_SCHEMA,
    at: report.finishedAt ?? new Date().toISOString(),
    agent: report.agent,
    assets: report.assetFingerprint,
    ...(report.caseFingerprint !== undefined ? { cases: report.caseFingerprint } : {}),
    ...(report.samples !== undefined ? { samples: report.samples } : {}),
    ...(report.model !== undefined ? { model: report.model } : {}),
    ...(report.harnessVersion !== undefined ? { harness: report.harnessVersion } : {}),
    ...(opts.report !== undefined ? { report: opts.report } : {}),
    outcomes: report.cases.map(outcomeOf),
  };
  // 一行一条，末尾换行：这样两次追加天然分行，不需要在读侧处理「最后一行没换行」
  appendFileSync(file, `${JSON.stringify(run)}\n`, 'utf8');
  return file;
}

function outcomeOf(c: CaseResult): HistoryCase {
  const samples = Math.max(1, c.samples ?? 1);
  const passedSamples = clamp(c.passedSamples ?? (c.passed ? 1 : 0), 0, samples);
  return {
    name: c.name,
    passed: c.passed,
    samples,
    passedSamples,
    tokens: c.tokens,
    ...(c.costUsd !== undefined ? { costUsd: c.costUsd } : {}),
    durationMs: c.durationMs,
    ...(c.stopReason !== '' ? { stopReason: c.stopReason } : {}),
  };
}

/**
 * 读账本。坏行**计数跳过**，不抛错。
 *
 * 与 `readCycles` 的「坏记录拒绝跳过」相反，理由不同：轮次记录是**账本**（决策史，
 * 少一条就少一条证据，预测兑现率的分母会静默变小）；而这里只是**辅助记忆**，
 * 它的用途是「帮人判断这条用例可不可信」。为了一行坏数据让 `harness report` 直接
 * 失败，等于用一个可选功能挡住唯一的主流程 —— 但也不能一声不响，所以把 `skipped`
 * 交回去，由调用方决定说不说。
 */
export function readHistory(
  config: Paths,
  opts: { readonly tail?: number | undefined } = {},
): { readonly runs: readonly HistoryRun[]; readonly skipped: number } {
  const file = historyPath(config);
  if (!existsSync(file)) return { runs: [], skipped: 0 };
  const runs: HistoryRun[] = [];
  let skipped = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const parsed = parseRun(line);
    if (parsed === undefined) skipped += 1;
    else runs.push(parsed);
  }
  const tail = opts.tail;
  return { runs: tail === undefined ? runs : runs.slice(-Math.max(0, tail)), skipped };
}

function parseRun(line: string): HistoryRun | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.at !== 'string' || !Array.isArray(o.outcomes)) return undefined;
  const outcomes: HistoryCase[] = [];
  for (const item of o.outcomes) {
    const c = parseCase(item);
    // 一条坏 outcome 不影响整行：它可能就是「某次运行里这条用例没跑」，而其余用例
    // 的历史仍然有价值。缺 name 的条目无法归属，直接丢
    if (c !== undefined) outcomes.push(c);
  }
  if (outcomes.length === 0) return undefined;
  return {
    at: o.at,
    agent: typeof o.agent === 'string' ? o.agent : '?',
    assets: typeof o.assets === 'string' ? o.assets : '?',
    cases: typeof o.cases === 'string' ? o.cases : undefined,
    ...(typeof o.samples === 'number' ? { samples: o.samples } : {}),
    ...(typeof o.model === 'string' ? { model: o.model } : {}),
    ...(typeof o.harness === 'string' ? { harness: o.harness } : {}),
    ...(typeof o.report === 'string' ? { report: o.report } : {}),
    outcomes,
  };
}

function parseCase(item: unknown): HistoryCase | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const c = item as Record<string, unknown>;
  if (typeof c.name !== 'string' || c.name === '') return undefined;
  const samples = Math.max(1, num(c.samples) ?? 1);
  const passedSamples = clamp(num(c.passedSamples) ?? (c.passed === true ? 1 : 0), 0, samples);
  return {
    name: c.name,
    passed: c.passed === true,
    samples,
    passedSamples,
    tokens: num(c.tokens) ?? 0,
    ...(num(c.costUsd) !== undefined ? { costUsd: num(c.costUsd) } : {}),
    durationMs: num(c.durationMs) ?? 0,
    ...(typeof c.stopReason === 'string' ? { stopReason: c.stopReason } : {}),
  };
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/**
 * 「这一轮根本没跑成」的 stopReason。
 *
 * 这三个都表示**运行环境**出了问题：`error` 是上游返回错误（401、5xx），`threw` 是客户端
 * 抛异常，`timeout` 是超时。它们不携带任何关于「这条用例稳不稳」的信息 —— 把它们算进
 * 抖动判定，等于让一次断网给用例判了 20 轮「不可信」。
 *
 * 反过来，`end_turn` / `max_iterations` 这类**正常收尾但没过断言**的结果是有效证据，
 * 不能排除：那次失败恰恰是「用例自己不稳」或「资产真的变差了」。
 */
const INFRA_STOP = new Set(['error', 'threw', 'timeout']);

export interface CaseTrend {
  readonly name: string;
  /** 窗口内出现的运行次数 */
  readonly runs: number;
  readonly samples: number;
  readonly passedSamples: number;
  readonly passRate: number;
  /**
   * 抖动。判定依据是**同条件矛盾**，不是「通过率不等于 100%」：
   * 一次真实的修复会让历史通过率停在中段，而那恰恰是「可靠」的证据（改一次就稳住了）。
   */
  readonly flaky: boolean;
  /** 抖动的依据（`flaky` 为 true 时必有）。它要能被人复核，所以写事实不写结论 */
  readonly why?: string | undefined;
  /**
   * 窗口内**基础设施失败**的次数（401 / 5xx / 超时），这些运行不参与抖动判定。
   *
   * 单独交出来是为了让「这条用例为什么没被标成抖动」也有答案：一次断网之后
   * `recent` 里会出现 `E`，而总数与通过率都还摆在那里。
   */
  readonly infraRuns: number;
  /** 最近几次的结局，`P` / `F` / `·`（同一次运行内既有通过也有失败）/ `E`（没跑成） */
  readonly recent: string;
  readonly avgTokens: number;
  readonly avgCostUsd?: number | undefined;
  readonly lastAt?: string | undefined;
}

interface Occurrence {
  readonly key: string;
  readonly fullPass: boolean;
  readonly fullFail: boolean;
  /**
   * 这一轮是**基础设施失败**（`error` / `threw` / `timeout`），不是用例的结论。
   *
   * 存在理由是一次真机误判：用错 key 跑了一轮 nightly，三条用例全是 `stopReason=error`，
   * 于是它们的账本里出现「同样条件下既过又挂」—— 三条用例就此被标成抖动、失去否决权。
   * 而那次失败说明的是**key 错了**，与用例稳不稳毫无关系。
   *
   * 这类运行既不参与抖动判定，也不算进「最近」的 P/F 序列（画成 `E`）。
   */
  readonly infra: boolean;
  readonly at: string;
  readonly tokens: number;
  readonly costUsd?: number | undefined;
}

/**
 * per-case 趋势。按窗口取最近 N 次**出现过该用例**的运行。
 *
 * 为什么按「出现过」而不是按总运行数倒数：`--only` 跑一部分用例是常态，按总运行数
 * 算会让一条用例只有 3 次记录却因为「最近 20 次运行里有 17 次没跑它」而被稀释。
 */
export function caseTrends(
  runs: readonly HistoryRun[],
  opts: { readonly window?: number | undefined } = {},
): CaseTrend[] {
  const window = Math.max(2, opts.window ?? TREND_WINDOW);
  const byName = new Map<string, Occurrence[]>();
  for (const run of runs) {
    const key = `${run.assets}|${run.cases ?? '?'}`;
    for (const c of run.outcomes) {
      const list = byName.get(c.name) ?? [];
      list.push({
        key,
        fullPass: c.passedSamples >= c.samples,
        fullFail: c.passedSamples === 0,
        infra: c.stopReason !== undefined && INFRA_STOP.has(c.stopReason),
        at: run.at,
        tokens: c.tokens,
        ...(c.costUsd !== undefined ? { costUsd: c.costUsd } : {}),
      });
      byName.set(c.name, list);
    }
  }
  return [...byName.entries()]
    .map(([name, all]) => trendOf(name, all.slice(-window)))
    .sort((a, b) => Number(b.flaky) - Number(a.flaky) || a.name.localeCompare(b.name));
}

function trendOf(name: string, occ: readonly Occurrence[]): CaseTrend {
  const samples = occ.length;
  const passes = occ.filter((o) => o.fullPass).length;
  const priced = occ.filter((o) => o.costUsd !== undefined);
  const infraRuns = occ.filter((o) => o.infra).length;
  // 抖动只看**跑成了**的那些轮：一次 401 / 断网不该给用例判 20 轮「不可信」
  const usable = occ.filter((o) => !o.infra);
  // 同条件矛盾：同一个 key（资产 + 用例集）下既见过全过也见过全挂
  const outcomesByKey = new Map<string, { p: number; f: number }>();
  for (const o of usable) {
    const cell = outcomesByKey.get(o.key) ?? { p: 0, f: 0 };
    if (o.fullPass) cell.p += 1;
    if (o.fullFail) cell.f += 1;
    outcomesByKey.set(o.key, cell);
  }
  const contradiction = [...outcomesByKey.entries()].find(([, v]) => v.p > 0 && v.f > 0);
  const mixedInRun = usable.filter((o) => !o.fullPass && !o.fullFail).length;
  const why =
    mixedInRun > 0
      ? `有一次运行内部就既有通过也有失败（${mixedInRun} 次）—— 同一条提示词两次跑结果不同`
      : contradiction !== undefined
        ? `同样资产与同样用例集下跑过 ${contradiction[1].p + contradiction[1].f} 次：` +
          `${contradiction[1].p} 次全过、${contradiction[1].f} 次全挂`
        : undefined;
  const last = occ.at(-1);
  return {
    name,
    runs: samples,
    samples,
    passedSamples: passes,
    passRate: samples === 0 ? 0 : passes / samples,
    flaky: why !== undefined,
    ...(why !== undefined ? { why } : {}),
    infraRuns,
    recent: occ
      .slice(-8)
      .map((o) => (o.infra ? 'E' : o.fullPass ? 'P' : o.fullFail ? 'F' : '·'))
      .join(''),
    avgTokens: samples === 0 ? 0 : Math.round(occ.reduce((s, o) => s + o.tokens, 0) / samples),
    ...(priced.length === 0
      ? {}
      : { avgCostUsd: priced.reduce((s, o) => s + (o.costUsd ?? 0), 0) / priced.length }),
    ...(last === undefined ? {} : { lastAt: last.at }),
  };
}

/**
 * 「不可信用例」集合 —— `gate` 用它决定一条回归能不能当判据。
 *
 * 只把 `flaky` 交出去，不交 `passRate < 1`：后者会把「上周修好、这周一直稳」的用例
 * 也算成不可信，结果是闭环永远不敢动那条用例。抖动是**同条件矛盾**，不是历史平均。
 */
export function flakyCases(
  config: Paths,
  opts: { readonly window?: number | undefined } = {},
): ReadonlySet<string> {
  const { runs } = readHistory(config, { tail: opts.window ?? TREND_WINDOW });
  return new Set(
    caseTrends(runs, opts)
      .filter((t) => t.flaky)
      .map((t) => t.name),
  );
}
