import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * harness 自己的版本号 —— 报告里「这份报告是哪个版本跑的」。
 *
 * 从 `package.json` 读，**不写常量**：写常量就要在每次发版时记得改它，忘了的后果是
 * 两份不同版本跑出来的报告互相声称「同一个 harness」，于是行为变化被归给资产。
 * 这正是 `assetFingerprint` 已经在防的那类错 —— 只是换了个维度。
 *
 * 路径相对本模块（`src/version.ts` 与 `dist/version.js` 都在包根下一层），两种运行
 * 方式都指向包根的 `package.json`。读不到时返回 `undefined` 而不是抛：一个版本号
 * 拼不出来，不该让整个评测跑不起来 —— 门会把「不知道」如实报出来。
 */
let cached: string | undefined | null = null;

export function harnessVersion(): string | undefined {
  if (cached !== null) return cached;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, '..', 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    cached = typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    cached = undefined;
  }
  return cached;
}
