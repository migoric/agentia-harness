import { readFileSync } from 'node:fs';
import type { Trace } from '@migor/agentia';
import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import { warn } from './output.js';

/**
 * `trace` 与 `harvest` 共用的一份 trace 读取。
 *
 * 放在 cli/ 而不是 evals/：这是「从磁盘文件找一条记录」的宿主逻辑，不是评测语义。
 * 两边若各写一份前缀匹配，「trace 看的是这条、harvest 生成的是另一条」会很难发现。
 */
export function readTraces(config: HarnessConfig, tail?: number): Trace[] {
  let text: string;
  try {
    text = readFileSync(config.tracesPath, 'utf8');
  } catch {
    throw new HarnessError(
      'run.failed',
      `读不到 ${config.tracesPath} —— 还没跑过任何任务（或路径不对）`,
    );
  }
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const slice = tail !== undefined && tail > 0 ? lines.slice(-tail) : lines;
  const out: Trace[] = [];
  let bad = 0;
  for (const line of slice) {
    try {
      out.push(JSON.parse(line) as Trace);
    } catch {
      // 半行（进程被杀）不该让整条命令失败 —— 但也不能装作没看见
      bad++;
    }
  }
  if (bad > 0) warn(`跳过 ${bad} 行无法解析的记录（可能是进程中途被杀写下的半行）`);
  return out;
}

/**
 * 前缀找一条 trace。
 *
 * `trace` 命令容忍多个匹配（取最后一条，人眼看得出是哪条）；`harvest` 会**写文件**，
 * 歧义时必须拒绝 —— 生成一条指向错误任务的回归用例比什么都不做更糟。
 */
export function findTrace(
  config: HarnessConfig,
  prefix: string,
  opts: { tail?: number; unique?: boolean } = {},
): Trace {
  const hits = readTraces(config, opts.tail).filter((t) => t.traceId.startsWith(prefix));
  if (hits.length === 0) {
    throw new HarnessError('run.failed', `${config.tracesPath} 里没有以 "${prefix}" 开头的 trace`);
  }
  if (opts.unique === true && hits.length > 1) {
    throw new HarnessError(
      'run.failed',
      `"${prefix}" 匹配到 ${hits.length} 条 trace —— 请用更长的前缀精确定位（写文件不接受歧义）`,
    );
  }
  return hits[hits.length - 1] as Trace;
}
