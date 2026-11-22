import { readFileSync } from 'node:fs';

/**
 * 外部 JSON 的**形状判定**（不是 schema 库，只判「能立刻证伪」的那几条）。
 *
 * 为什么单独一件：同一套判定在**四个不可信输入口**各写了一遍 —— `harness.json`
 * （config.ts）、`harness.lock.json`（assets/lockfile.ts）、手写提案（rsi/manual.ts）、
 * 提案清单（rsi/manifest.ts）。重复的不是几行代码，而是**同一条判据的四种说法**：
 * `typeof v === 'object' && v !== null && !Array.isArray(v)` 在本仓出现过十余次，
 * 「遍历键、不认识的抛」三份，`应是非空字符串` 两份。判据分叉的后果是具体的：
 * 同一个畸形输入在一个入口响亮、在另一个入口被放过，症状是「有时报、有时静默」。
 *
 * ⚠️ 本件**不 import `HarnessError`**：`tests/architecture.test.ts` 规定 util/ 只许依赖
 * util/（util 被所有层共用，反过来依赖谁都会成环）。所以「错怎么抛」由调用方给
 * （`Fail`）—— 错误码仍归各业务模块决定（`config.invalid` 与 `lock.mismatch` 是不同的事实，
 * 不该被一个工具函数统一掉）。
 *
 * 口径（刻意的宽严边界）：
 * - **普通对象** = 非 null、非数组的 object。类实例也算（`JSON.parse` 只产出普通对象，
 *   而调用方在测试里会传对象字面量/类实例）—— 这里不判原型，多判一层只会误伤。
 * - **未知键一律拒**：拼错的字段静默被忽略时，症状是「数字不对 / 预测没了」，
 *   而那是人最容易往别处想的症状。
 */

export type Fail = (message: string, cause?: unknown) => never;

/** 普通对象（非 null / 非数组）。JSON 解析与手写字面量的共同形态 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 断言是普通对象；`label` 是给人看的定位（`配置字段 "endpoint"` / `<path>.patch`） */
export function objectAt(v: unknown, label: string, fail: Fail): Record<string, unknown> {
  if (!isPlainObject(v)) fail(`${label} 应是对象`);
  return v;
}

/**
 * 只认 `allowed` 里的键，其余一律拒。
 *
 * 只有**一种**说法（2026-11-22 统一）：此前 config.ts 说「配置字段 X 不认识 k」、
 * rsi 说「X: 不认识的字段 k」—— 同一件事两种措辞，而测试分别盯着两种，于是
 * 「统一文案」反而要先改测试。留一种：`<定位>: 不认识的字段 "k"（只认 …）`。
 */
export function onlyKeys(obj: object, where: string, allowed: readonly string[], fail: Fail): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) {
      fail(`${where}: 不认识的字段 "${k}"（只认 ${allowed.join(' / ')}）`);
    }
  }
}

/** 非空字符串（trim 后非空）：空串在这里没有正当读法，而它常被当成「没填」静默放过 */
export function requiredText(v: unknown, label: string, fail: Fail): string {
  if (typeof v !== 'string' || v.trim() === '') fail(`${label} 应是非空字符串`);
  return v;
}

/**
 * 读一个 JSON 文件并断言**顶层是普通对象**（三种失败各自可读：读不到 / 不是 JSON /
 * 顶层不是对象）。锁文件与配置都要这三步，而它们的错误码不同 ⇒ 码由 `fail` 带。
 */
export function readJsonObject(path: string, fail: Fail): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    fail(`读不到 ${path}`, e);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    fail(`${path} 不是合法 JSON`, e);
  }
  if (!isPlainObject(parsed)) fail(`${path} 顶层必须是对象`);
  return parsed;
}
