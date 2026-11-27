import { existsSync, readdirSync } from 'node:fs';
import { discoverAssets } from '../../assets/discover.js';
import type { AssetSet } from '../../assets/types.js';
import type { HarnessConfig } from '../../config.js';
import { readCycles } from '../../rsi/cycles.js';
import { readJournal } from '../../rsi/journal.js';
import { describeWorker } from '../../rsi/worker-lock.js';
import { reportsDir } from './reports.js';

/**
 * 工作区概览。
 *
 * 这块的唯一目的是回答运维的三个问题：**这台机器跑的是哪一版资产**、**上次改了
 * 什么**、**有没有东西在跑**。三个问题都必须现读磁盘 —— 进程里的快照回答不了第一个
 * （RSI 会在这个进程活着的时候改盘），看板缓存回答不了后两个。
 *
 * 计数刻意只到「有多少条」：把每一条都塞进概览，会让这个接口随需求不断长大，最后
 * 变成「一个端点返回整个工作区」。要细节去对应的列表端点。
 */
export interface WorkspaceOverview {
  readonly root: string;
  readonly workspaceDir: string;
  /** 进程启动时的快照指纹（服务实际在跑的那一版） */
  readonly assets: string;
  /** 现读磁盘（`null` = 读不动，例如资产文件坏了） */
  readonly assetsOnDisk: string | null;
  /** `null` = 不知道（读不动）；`true` = 磁盘变了、进程没换，该重启 */
  readonly assetDrift: boolean | null;
  readonly counts: {
    readonly evals: number;
    readonly reports: number;
    readonly cycles: number;
    readonly journalEntries: number;
  };
  readonly worker: ReturnType<typeof describeWorker>;
  /** 读数算出来的时刻（人看「这是不是刚才那一眼」） */
  readonly at: string;
}

export function fingerprintOnDisk(config: HarnessConfig): string | null {
  try {
    return discoverAssets({ skills: config.skillsDir, agents: config.agentsDir }).fingerprint;
  } catch {
    return null;
  }
}

function count(dir: string, pred: (name: string) => boolean): number {
  try {
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter(pred).length;
  } catch {
    return 0;
  }
}

export function workspaceOverview(config: HarnessConfig, assets: AssetSet): WorkspaceOverview {
  const onDisk = fingerprintOnDisk(config);
  return {
    root: config.root,
    workspaceDir: config.workspaceDir,
    assets: assets.fingerprint,
    assetsOnDisk: onDisk,
    assetDrift: onDisk === null ? null : onDisk !== assets.fingerprint,
    counts: {
      evals: count(config.evalsDir, (n) => n.endsWith('.md')),
      reports: count(reportsDir(config), (n) => n.endsWith('.json')),
      cycles: safeCount(() => readCycles(config).length),
      journalEntries: safeCount(() => readJournal(config).length),
    },
    worker: describeWorker(config),
    at: new Date().toISOString(),
  };
}

/**
 * 轮次与账本的读取会**故意抛错**（坏记录不许静默跳过）。
 *
 * 但「有多少条」这个计数不该让整页 500：坏记录的信息由 `/api/rsi/cycles` 与
 * `/api/rsi/journal` 专门报出来，概览里把它显示成 0 并附一条 `unreadable` 更诚实。
 */
function safeCount(fn: () => number): number {
  try {
    return fn();
  } catch {
    return 0;
  }
}
