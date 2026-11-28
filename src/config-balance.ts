/**
 * 余额对账段（`balance`）。
 *
 * 单独一个文件，与 `config-pricing.ts` 同一个理由：它是一张**外部事实**的映射
 * （账户余额接口的地址与汇率），与「这个工程长什么样」无关，而且有自己的易错点
 * （`perUsd` 是折算率不是余额、币种由账户决定不由配置决定）。
 *
 * 为什么需要这段：价格表是**写死**的单价，而 DeepSeek 这类端点**分时计价**
 * （peak 是 off-peak 的两倍），任何硬编码单价都只能对一半时间。余额差额是真实
 * 扣费，与单价无关 —— 这是未定价模型唯一能拿到可信成本读数的路。
 *
 * 配置形态（全部可选；`"balance": false` 关闭）：
 *
 * ```json
 * "balance": { "url": "https://api.deepseek.com/user/balance", "perUsd": 7.1, "timeoutMs": 3000 }
 * ```
 *
 * 只写 `{ "perUsd": 7.2 }` 也可以：`url` 省略时按 `endpoint.baseURL` 推导。
 */

import { HarnessError } from './errors.js';
import { type Fail, isPlainObject, onlyKeys } from './util/shape.js';

const fail: Fail = (message) => {
  throw new HarnessError('config.invalid', message);
};

/**
 * 缺省折算率（人民币兑美元）。
 *
 * 内置一个值而不是要求必填，是因为**不填就等于功能对人民币账户不可用**：谁也不会为了
 * 「让预算闸能算钱」先去查今天的汇率。7.1 是一个长期的中间价量级，误差落在 5% 以内 ——
 * 对一个「原来完全失效」的闸来说，5% 与 0% 的差别不重要，0% 与 100% 的差别才重要。
 *
 * 它会过期。所以：报告里同时记**原币金额**（`billedCurrency` / `billedAmount`），
 * 审计时看到的是没被汇率污染的数；要用精确值就写 `"perUsd"`。
 */
export const DEFAULT_PER_USD = 7.1;
const DEFAULT_TIMEOUT_MS = 3000;

export interface BalanceSettings {
  /** 余额接口地址；省略时按 `endpoint.baseURL` 推导（见 `run/balance.ts`） */
  readonly url: string | undefined;
  /** 非美元账户的折算率（1 USD 等于多少该币种） */
  readonly perUsd: number;
  readonly timeoutMs: number;
  /**
   * 低于这个美元数就在开跑前警告。
   *
   * 这是一个**与单价无关**的安全网：余额不足时任何估算都是理论值，而「账户里只剩
   * 两块钱」是硬事实。
   */
  readonly warnBelowUsd: number | undefined;
}

const KEYS: readonly string[] = ['url', 'perUsd', 'timeoutMs', 'warnBelowUsd'];

/**
 * 读 `balance` 段。`undefined` / 缺省 = 用全部缺省值（自动推导地址）；
 * `false` = 显式关闭（连推导都不做）。
 */
export function readBalanceConfig(v: unknown): BalanceSettings | undefined {
  if (v === undefined) return defaultSettings();
  if (v === false) return undefined;
  if (!isPlainObject(v)) {
    fail('配置字段 "balance" 应为对象（或 false 关闭）');
  }
  onlyKeys(v, 'balance', KEYS, fail);
  const url = v.url === undefined ? undefined : nonEmptyUrl(v.url);
  return {
    url,
    perUsd: positive(v.perUsd, 'balance.perUsd', DEFAULT_PER_USD),
    timeoutMs: positiveInt(v.timeoutMs, 'balance.timeoutMs', DEFAULT_TIMEOUT_MS),
    warnBelowUsd:
      v.warnBelowUsd === undefined
        ? undefined
        : nonNegative(v.warnBelowUsd, 'balance.warnBelowUsd'),
  };
}

function defaultSettings(): BalanceSettings {
  return {
    url: undefined,
    perUsd: DEFAULT_PER_USD,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    warnBelowUsd: undefined,
  };
}

/**
 * 地址必须是 http(s)。
 *
 * 判这一条不是形式主义：写成 `api.deepseek.com/user/balance`（漏 scheme）时
 * `fetch` 会把它当相对路径，症状是「余额永远读不到」而**没有任何报错** ——
 * 与这个功能要解决的静默失效是同一类问题。
 */
function nonEmptyUrl(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') fail('balance.url 应为非空字符串');
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    fail(
      `balance.url 不是合法 URL（收到 "${v}"，需要完整地址如 https://api.deepseek.com/user/balance）`,
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    fail(`balance.url 只支持 http(s)（收到 ${parsed.protocol}）`);
  }
  return v;
}

function positive(v: unknown, where: string, dflt: number): number {
  if (v === undefined) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    fail(`${where} 应为正数（1 USD 等于多少该币种；缺省 ${dflt}）`);
  }
  return v;
}

function positiveInt(v: unknown, where: string, dflt: number): number {
  const n = positive(v, where, dflt);
  if (!Number.isInteger(n)) fail(`${where} 应为整数毫秒`);
  return n;
}

function nonNegative(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    fail(`${where} 应为非负有限数（$/美元）`);
  }
  return v;
}
