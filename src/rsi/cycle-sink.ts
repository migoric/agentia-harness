/**
 * 轮次记录的出口 —— 把「收工」这件事收成一个函数。
 *
 * 一条规则值得单独成文件：**先对账、再落盘**。`costUsd` 与 `budget` 都要在对账之后
 * 取值，而 `runCycle` 有四个 `return` —— 每个都自己写一遍顺序，迟早在最早那条
 * 早退路径上写反（基线就超预算的那条最容易被漏掉，因为它跑得最少）。
 *
 * 所以这里收 `() => body` 的**工厂**而不是现成对象：对象里的数字在传入那一刻就
 * 算死了，工厂在对账之后才求值。
 */

import type { HarnessConfig } from '../config.js';
import { writeCycle } from './cycles.js';
import type { Spender } from './spender.js';
import type { CycleReport } from './types.js';

/** 调用方负责的字段；`cycleId` / `path` / `at` / `tokens` 由落盘与账本补 */
export type CycleBody = Omit<CycleReport, 'cycleId' | 'path' | 'at' | 'tokens'>;

export interface CycleSink {
  finish(build: () => CycleBody): Promise<CycleReport>;
}

export function makeSink(config: HarnessConfig, cycleId: string, spending: Spender): CycleSink {
  return {
    async finish(build: () => CycleBody): Promise<CycleReport> {
      // 对账失败不会抛（`reconcile` 读不到就保留估算），所以这里不必 try
      await spending.reconcile();
      const billed = spending.billed();
      return writeCycle(
        config,
        {
          ...build(),
          tokens: spending.spentTokens,
          // 余额明细在这里补，而不是让每个 `build` 自己塞一遍：漏塞的症状是
          // 「报告里没有账单」而记录看起来完全正常 —— 那正是审计要抓的东西
          ...(billed === undefined ? {} : { billed }),
        },
        cycleId,
      );
    },
  };
}
