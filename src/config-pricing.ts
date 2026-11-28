/**
 * 价格表段（`pricing`）。
 *
 * 单独一个文件：它是一张**外部事实**的映射（厂商定价），与「这个工程长什么样」无关，
 * 而且它有自己的一套易错点（缓存是乘数不是绝对价）。放在 `config.ts` 里时，
 * 光是注释就占了四十行。
 */

import { HarnessError } from './errors.js';
import { type Fail, isPlainObject, onlyKeys } from './util/shape.js';

/**
 * 一条单价（对齐 agentia 的 `ModelPricing`，但**不 import** 它：配置文件层不认识
 * 运行时）。字段含义逐条对齐，差一个都算配置错——
 *
 * - `in` / `out`：$/1M token，**绝对价**；
 * - `cacheRead` / `cacheWrite`：相对 `in` 的**乘数**（不是绝对价！），缺省 0.1 / 1.25。
 *   这条最容易配错：DeepSeek 缓存命中 $0.044/1M、未命中输入 $0.30/1M ⇒ 乘数是
 *   `0.147`，不是 `0.044`。
 *
 * **填高档价（peak），不要填你此刻在付的价。** 分时计价的端点（DeepSeek 的高峰时段
 * 是 2 倍）里，填低档价等于让闸在高峰期静默超支；填高档价只让闸提前一点点停。
 * 价格表的用途是给预算闸一个**上界**，不是记账 —— 记账归 `balance`（余额差额）。
 */
const fail: Fail = (message) => {
  throw new HarnessError('config.invalid', message);
};

export interface ModelPrice {
  readonly in: number;
  readonly out: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

const PRICE_KEYS: readonly string[] = ['in', 'out', 'cacheRead', 'cacheWrite'];

export function readPricing(v: unknown): Readonly<Record<string, ModelPrice>> {
  if (v === undefined) return {};
  if (!isPlainObject(v)) fail('配置字段 "pricing" 应为 { 模型名: { in, out } } 对象');
  const out: Record<string, ModelPrice> = {};
  for (const [model, raw] of Object.entries(v)) {
    const where = `pricing["${model}"]`;
    if (model.trim() === '') {
      throw new HarnessError('config.invalid', '配置字段 "pricing" 里有空模型名');
    }
    if (!isPlainObject(raw)) fail(`${where} 应为 { in, out } 对象`);
    onlyKeys(raw, where, PRICE_KEYS, fail);
    const e = raw;
    out[model] = {
      in: priceOf(e.in, where, 'in'),
      out: priceOf(e.out, where, 'out'),
      ...(e.cacheRead === undefined ? {} : { cacheRead: priceOf(e.cacheRead, where, 'cacheRead') }),
      ...(e.cacheWrite === undefined
        ? {}
        : { cacheWrite: priceOf(e.cacheWrite, where, 'cacheWrite') }),
    };
  }
  return out;
}

function priceOf(v: unknown, where: string, key: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    const detail =
      key === 'cacheRead' || key === 'cacheWrite'
        ? '（cacheRead / cacheWrite 是相对 in 的**乘数**，不是绝对价）'
        : '（$/1M token）';
    throw new HarnessError('config.invalid', `${where}.${key} 应为非负有限数${detail}`);
  }
  return v;
}
