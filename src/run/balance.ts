/**
 * 余额盘 —— 「这次到底扣了多少钱」的**唯一可信来源**。
 *
 * ## 为什么是余额，而不是单价
 *
 * 本仓原先把「未定价模型」当成一个配置问题：去 `pricing` 里补单价就好了。这个判断
 * 有一半是错的 —— DeepSeek 一类端点是**分时计价**（peak 时段单价是 off-peak 的两倍，
 * 时段按时区与星期几切）。同一份配置在同一天的不同时刻，误差可以到 100%。于是：
 *
 * - 单价写高了 ⇒ 闸提前停，白扔一次基线；
 * - 单价写低了 ⇒ 闸形同虚设，与没写一模一样。
 *
 * 而 `GET /user/balance` 给的是**真实扣费**：跑前记一个数、跑后再记一个数，差就是
 * 账单。它不需要知道单价、不需要知道时段、不需要知道缓存命中率。
 *
 * 代价（必须说在前面，别让读数看起来比实际更硬）：
 *
 * 1. **粒度是阶段，不是调用**：余额只能在一个阶段跑完之后读，所以 `--max-cost`
 *    从一个「完全失效的闸」变成一个「每个阶段结束都能对账的闸」，仍不是「每次
 *    模型调用前都能拦住」；
 * 2. **同 key 的其它消费会被算进来**：差额偏大。方向是安全的（宁多算），但两个人
 *    共用一个 key 时读数会互相污染；
 * 3. **结算可能滞后**：扣费一般实时，极端情况下最后几笔会晚一点入账，于是差额
 *    偏小 —— 这是这个方案唯一的偏不安全方向，所以它的用法是「对账」而不是「唯一
 *    判据」，token 闸仍然保留。
 *
 * ## 为什么自动识别而不是必填
 *
 * 一个「要手动配地址才生效」的兜底，等于没有兜底：真正需要它的人（模型没定价）
 * 恰好是没配过任何东西的人。所以地址按 `endpoint.baseURL` 推导，配了 URL 才覆盖。
 */

import type { HarnessConfig } from '../config.js';
import { DEFAULT_PER_USD } from '../config-balance.js';

export interface BalanceEntry {
  readonly currency: string;
  readonly total: number;
  readonly granted: number;
  readonly toppedUp: number;
}

export interface BalanceSnapshot {
  /** 读取时刻（毫秒） */
  readonly at: number;
  readonly url: string;
  /** 账户是否还能调用（`is_available`） */
  readonly available: boolean;
  readonly entries: readonly BalanceEntry[];
}

export type BalanceProbe =
  | { readonly ok: true; readonly snapshot: BalanceSnapshot }
  | { readonly ok: false; readonly reason: string };

/**
 * 能探余额的端点 —— 目前只有 DeepSeek 实现了这个接口。
 *
 * 判 host 而不是判 `provider` 字段：配置里没有 provider 这个概念（换模型只是换
 * baseURL），再加一个维度会让「到底连的是谁」多一处可能不一致的说法。
 */
const DEEPSEEK_HOST = 'api.deepseek.com';
const BALANCE_PATH = '/user/balance';

/**
 * 余额接口地址；`undefined` = 这个端点不支持（或配置显式关掉了）。
 *
 * 显式配了 `balance.url` 就无条件用：自建代理、网关后面的 DeepSeek 都能靠它接上，
 * 而猜是猜不出代理地址的。
 */
export function balanceUrlOf(config: HarnessConfig): string | undefined {
  const settings = config.balance;
  if (settings === undefined) return undefined;
  if (settings.url !== undefined) return settings.url;

  // 与客户端同源：`ANTHROPIC_BASE_URL` 优先（`ensureEndpointEnv` 就是这么落的），
  // 否则配置里的 baseURL。两处都不看的话，「诊断说没有余额接口」而「请求明明发得
  // 出去」就会像这次一样难查。
  const raw = process.env.ANTHROPIC_BASE_URL ?? config.baseURL;
  if (raw === undefined || raw.trim() === '') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  // 只比 host：baseURL 常见写法有 `/anthropic`、`/v1`、结尾带不带斜杠三种，
  // 这几种都指向同一个账户。
  if (parsed.hostname !== DEEPSEEK_HOST) return undefined;
  return `${parsed.origin}${BALANCE_PATH}`;
}

/** 取 key，顺序与模型客户端一致（`run/endpoint.ts` 的 `keySource`） */
function apiKeyOf(config: HarnessConfig): string | undefined {
  const a = process.env.ANTHROPIC_API_KEY;
  if (a !== undefined && a.trim() !== '') return a;
  const b = process.env[config.apiKeyEnv];
  if (b !== undefined && b.trim() !== '') return b;
  return undefined;
}

export interface ReadBalanceOptions {
  /** 覆盖 `balance.timeoutMs` */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal | undefined;
  /** 测试注入；缺省用全局 `fetch` */
  readonly fetchImpl?: typeof fetch | undefined;
}

/**
 * 读一次余额。
 *
 * **失败一律返回 `ok: false` 而不是抛错**：余额盘是一个**增益**，不是依赖 —— 它挂掉的
 * 后果应该是「回到原来的估算」，不该是「跑不了评测」。这条与 `assertEndpointKey`
 * 那种硬拦刻意不同：那边缺的是跑下去的必需品，这边缺的只是一个更准的读数。
 */
export async function readBalance(
  config: HarnessConfig,
  opts: ReadBalanceOptions = {},
): Promise<BalanceProbe> {
  const url = balanceUrlOf(config);
  if (url === undefined) {
    return {
      ok: false,
      reason:
        '端点不支持余额查询（不是 DeepSeek，也没有配 balance.url）—— ' +
        '要启用就写 "balance": { "url": "https://api.deepseek.com/user/balance" }',
    };
  }
  const key = apiKeyOf(config);
  if (key === undefined) {
    return { ok: false, reason: `没有可用的 API key（${config.apiKeyEnv} 为空）` };
  }

  const timeoutMs = opts.timeoutMs ?? config.balance?.timeoutMs ?? 3000;
  const doFetch = opts.fetchImpl ?? fetch;
  // 两条超时都挂上：`AbortSignal.timeout` 管「请求挂着不返回」，外部 signal 管
  // 「用户 Ctrl-C」—— 只挂后者的症状是 Ctrl-C 之后余额盘还要拖三秒才退出。
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal === undefined ? timeout : AbortSignal.any([opts.signal, timeout]);

  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal,
    });
  } catch (e) {
    return { ok: false, reason: describeFetchError(e, timeoutMs) };
  }

  if (!res.ok) {
    return { ok: false, reason: `余额接口返回 HTTP ${res.status}${await snippet(res)}` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: '余额接口返回的不是 JSON' };
  }
  return parseBalance(body, url);
}

/**
 * 形状校验 —— 只判「能立刻证伪」的那几条（与 `util/shape.ts` 同一口径）。
 *
 * 余额读错一个数量级的后果是闸按一个假数字判超限，比读不到更糟，所以数字字段
 * 一律走 `Number()` 后判有限：接口给的是字符串（`"2.94"`），漏掉这一步会得到
 * `NaN`，而 `NaN` 参与比较**永远为 false** —— 静默失效的经典形态。
 */
function parseBalance(body: unknown, url: string): BalanceProbe {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, reason: '余额接口返回的不是对象' };
  }
  const b = body as Record<string, unknown>;
  const raws = b.balance_infos;
  if (!Array.isArray(raws)) {
    return { ok: false, reason: '余额接口返回里没有 balance_infos 数组' };
  }
  const entries: BalanceEntry[] = [];
  for (const raw of raws) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Record<string, unknown>;
    const currency = typeof e.currency === 'string' ? e.currency : undefined;
    const total = num(e.total_balance);
    if (currency === undefined || total === undefined) continue;
    entries.push({
      currency,
      total,
      granted: num(e.granted_balance) ?? 0,
      toppedUp: num(e.topped_up_balance) ?? 0,
    });
  }
  if (entries.length === 0) {
    return { ok: false, reason: '余额接口返回的 balance_infos 里没有可解析的币种条目' };
  }
  return {
    ok: true,
    snapshot: {
      at: Date.now(),
      url,
      // 缺这个字段时按「可调用」处理：拿不到额度状态不该阻止开跑，余额数量本身
      // 已经是判据了
      available: b.is_available === undefined ? true : b.is_available === true,
      entries,
    },
  };
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

async function snippet(res: Response): Promise<string> {
  try {
    const text = (await res.text()).slice(0, 160).replace(/\s+/g, ' ');
    return text === '' ? '' : `：${text}`;
  } catch {
    return '';
  }
}

function describeFetchError(e: unknown, timeoutMs: number): string {
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    return `余额接口 ${timeoutMs}ms 内没有响应`;
  }
  // 只说原因类别，不回显 URL 里的任何查询串（有人把 token 拼在地址上）
  return `余额接口请求失败：${e instanceof Error ? e.message : String(e)}`;
}

/** 一次扣费观测：原币金额 + 折算后的美元 */
export interface Billed {
  /** 账户币种（`CNY` / `USD`） */
  readonly currency: string;
  /** 原币金额（差额） */
  readonly amount: number;
  /** 折算成美元后的金额（`--max-cost` 的单位） */
  readonly usd: number;
  /** 折算率；币种是 USD 时缺席 */
  readonly perUsd?: number;
}

/**
 * 两次余额快照之间扣了多少钱。
 *
 * 三条口径：
 *
 * 1. **币种取交集，优先 USD**：账户同时有 USD 与 CNY 余额时，单看一个会漏掉另一半
 *    的扣费；但把两种币相加需要一个汇率，而汇率恰恰是我们不想引入的中间量 —— 所以
 *    只取一个币种，并让调用方看到 `currency`，知道自己在看哪本账。
 * 2. **差额为负按 0 算**：余额上升只可能是充值（或退款），那不是「负花费」。
 *    返回负数会让预算闸的 `spent` 往下掉，闸就永远不超了。
 * 3. **USD 账户不折算**：`perUsd` 只对非美元币种生效，免得「USD 账户被 7.1 除一次」
 *    这种 7 倍误差 —— 那是这一个模块能犯的最大的错。
 */
export function billedSince(
  before: BalanceSnapshot,
  after: BalanceSnapshot,
  perUsd: number = DEFAULT_PER_USD,
): Billed | undefined {
  const pair = pickCurrency(before, after);
  if (pair === undefined) return undefined;
  const [currency, prev, next] = pair;
  // 两位小数的十进制数相减会带出浮点尾巴（10 − 8.9 = 1.0999999999999996），
  // 而这个数会原样进报告与 CLI 回执。收到微美元足够：真实扣费的最小单位远大于它
  const amount = round6(Math.max(0, prev - next));
  if (currency === 'USD') return { currency, amount, usd: amount };
  return { currency, amount, usd: round6(amount / perUsd), perUsd };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function pickCurrency(
  before: BalanceSnapshot,
  after: BalanceSnapshot,
): [string, number, number] | undefined {
  const nextOf = new Map(after.entries.map((e) => [e.currency, e.total]));
  const shared = before.entries.filter((e) => nextOf.has(e.currency));
  if (shared.length === 0) return undefined;
  const money = (c: string) => (c === 'USD' ? 0 : c === 'CNY' ? 1 : 2);
  const sorted = [...shared].sort((a, b) => money(a.currency) - money(b.currency));
  const pick = sorted[0];
  if (pick === undefined) return undefined;
  return [pick.currency, pick.total, nextOf.get(pick.currency) ?? pick.total];
}
