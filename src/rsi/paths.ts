import { join } from 'node:path';
import type { HarnessConfig } from '../config.js';

/**
 * RSI 的落盘路径。
 *
 * 单独一文件是**为了断环**：`ledger` 要读 cycles 目录，而 `loop` 要用账本里的教训，
 * 两边互相 import 就成了循环（值导入的环在 ESM 里靠函数提升**看起来**能跑，
 * 但它会让「谁先初始化」变成运气问题）。路径是两者的共同底座，抽出来最省事。
 */
export function cyclesDir(config: HarnessConfig): string {
  return join(config.workspaceDir, 'rsi', 'cycles');
}
