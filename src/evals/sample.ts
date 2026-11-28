import type { CaseRunner } from '../run/case-runner.js';
import { type OneShotOptions, runOne } from './run-one.js';
import type { CaseResult, EvalCase } from './types.js';

/**
 * 同一条用例**重复采样** N 次，聚成一个 `CaseResult`。
 *
 * 为什么单独一层而不是塞进 `runOne`：两者回答的不是同一个问题。
 * - `runOne` 管「一次运行怎么被超时/重试/多轮/成本处理成一个结果」；
 * - 这里管「N 个结果怎么变成一个读数」。
 *
 * `repeat === 1` 时**原样返回** `runOne` 的结果，一个字段都不加。这不是优化，是
 * 契约：默认路径必须与没有这个特性时逐字节相同 —— 否则「加了个可选功能」会让每一份
 * 历史报告、每一个测试快照都失去可比性。
 */

/**
 * 聚合口径（逐条都有理由，改之前先读一遍）：
 *
 * 1. **`passed` 按过半**（`passedSamples * 2 >= samples`），不是「全过」。
 *    温度不为 0 时要求次次通过，等于把长尾当退步 —— RSI 会拒掉所有正常改动，
 *    然后学到「别动」。判退步的活交给区间（见 `gate`），不给这个布尔加戏。
 * 2. **成本/token 求和**，不是取平均：这 N 次是真花掉的钱，报告要能对得上账。
 *    取平均会让「跑 3 次花了 3 倍钱」从报告里消失，而预算门读的正是这个数。
 * 3. **`durationMs` 求和**：它是这 N 次真实占用的时间。想知道单次多久，除一下即可；
 *    取平均会让「这条用例拖慢了整轮」变得看不出来。
 * 4. **证据字段取「代表样本」**：有失败就取第一条失败的（诊断要看坏的），
 *    全过则取最后一条。`traceId` / `excerpt` / `stopReason` 都是单值字段，
 *    塞不下 N 份，而它们的用途是「回查这一次」，不是「概括 N 次」。
 * 5. **失败原因带计数**（`正文缺少 "X"（2/3 次）`）：一条只偶尔失败的用例与一条
 *    次次失败的用例，修法完全不同，而只写原因会把两者压成一样。
 * 6. **环境事实（`models` / `menuHash` / `promptVersions`）要求 N 次全一致**，
 *    不一致就整体缺席。它们的作用是「这批样本可比吗」，不一致时给一个并集等于
 *    让调用方以为可比 —— 那是假的「知道」，比「不知道」贵。
 */
export async function runSampled(
  runner: CaseRunner,
  c: EvalCase,
  opts: OneShotOptions,
  repeat: number,
): Promise<CaseResult> {
  if (repeat <= 1) return runOne(runner, c, opts);

  const samples: CaseResult[] = [];
  for (let i = 0; i < repeat; i++) {
    // 串行：同一条件的重复测量不该互相争抢资源。并发留给 `--concurrency`（用例级），
    // 两者的乘积会是 `concurrency × repeat`，那才是用户显式要求的并行度。
    //
    // 每次都不传 `signal` 之外的任何状态：`runOne` 内部每次尝试各造一份记忆，
    // 这里不再额外干预 —— 干预一次，「重复采样」就变成了「带残留的重复采样」。
    samples.push(await runOne(runner, c, opts));
  }
  return aggregateSamples(c, samples);
}

/** 把 N 份样本聚成一份。导出是为了单测能直接造样本，不必真跑模型。 */
export function aggregateSamples(c: EvalCase, samples: readonly CaseResult[]): CaseResult {
  const n = samples.length;
  if (n === 0) throw new Error('aggregateSamples 至少要一份样本');
  if (n === 1) {
    const only = samples[0];
    if (only === undefined) throw new Error('unreachable');
    return only;
  }

  const passedSamples = samples.filter((s) => s.passed).length;
  const passed = passedSamples * 2 >= n;
  // 代表样本：失败优先（诊断要看坏的那次），全过则看最后一次
  const rep = samples.find((s) => !s.passed) ?? (samples[n - 1] as CaseResult);

  return {
    name: c.name,
    task: c.task,
    split: c.split,
    ...(c.phase === undefined ? {} : { phase: c.phase }),
    passed,
    samples: n,
    passedSamples,
    failures: mergeFailures(samples, n),
    tokens: samples.reduce((sum, s) => sum + s.tokens, 0),
    // 一边有读数一边没有 ⇒ 整条「成本未知」。求和时把缺席当 0 会让「3 次里 1 次没定价」
    // 变成「便宜了」，而成本门读的正是这个和
    costUsd: samples.every((s) => s.costUsd !== undefined)
      ? samples.reduce((sum, s) => sum + (s.costUsd ?? 0), 0)
      : undefined,
    iterations: samples.reduce((sum, s) => sum + s.iterations, 0),
    durationMs: samples.reduce((sum, s) => sum + s.durationMs, 0),
    stopReason: rep.stopReason,
    excerpt: rep.excerpt,
    ...(rep.traceId === undefined ? {} : { traceId: rep.traceId }),
    // 技能的并集是安全的：它回答「这条用例碰过什么」，多一次采样多碰到一个技能
    // 仍是事实。与环境事实（下面那几个）不是一类 —— 那些要求「全都一样」才有意义
    skills: union(samples.map((s) => s.skills)),
    subagents: union(samples.map((s) => s.subagents)),
    ...(c.route === undefined ? {} : { expectRoute: c.route }),
    ...(rep.routedTo === undefined ? {} : { routedTo: rep.routedTo }),
    ...consistentModels(samples),
    ...consistentScalar(samples, (s) => s.menuHash, 'menuHash'),
    ...consistentScalar(samples, (s) => s.promptVersions, 'promptVersions'),
    ...(rep.turns === undefined ? {} : { turns: rep.turns }),
    ...(rep.failedTurn === undefined ? {} : { failedTurn: rep.failedTurn }),
  };
}

/**
 * 失败原因去重并附计数，按「出现次数降序 + 原文序」排。
 *
 * 排序固定是必须的：报告会被逐字节比对（`observe` 的 diff、测试的深比较），
 * 而 `Set` 的迭代顺序取决于插入顺序 —— 采样顺序一换，报告就"变了"。
 */
function mergeFailures(samples: readonly CaseResult[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const s of samples) {
    // 同一次采样里重复的同一句失败只算一次（`check` 可能对多个字段报同一句）
    for (const f of new Set(s.failures)) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([f, k]) => (k === n ? f : `${f}（${k}/${n} 次）`));
}

/** 并集，保持首次出现序（报告 diff 要稳定） */
function union(lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lists) {
    for (const x of l) {
      if (seen.has(x)) continue;
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

/**
 * 环境事实：N 次采样必须**全部一致**才写出来，否则整体缺席。
 *
 * 不一致时返回空对象（字段缺席），而不是 `[]`：`[]` 是「确认一个都没有」，
 * 缺席才是「不知道」。把不一致读成任何一个具体值，都会让 `sameModel` /
 * `sameCaseSet` 这类判据得出假结论。
 */
function consistentModels(
  samples: readonly CaseResult[],
): Pick<CaseResult, 'models' | 'fallbackUsed'> | Record<string, never> {
  const first = samples[0]?.models;
  if (first === undefined) return {};
  if (!samples.every((s) => sameList(s.models, first))) return {};
  // 集合一致 ⇒ 降级次数可以求和：它是计数，不是事实
  return {
    models: first,
    fallbackUsed: samples.reduce((sum, s) => sum + (s.fallbackUsed ?? 0), 0),
  };
}

function consistentScalar<K extends 'menuHash' | 'promptVersions'>(
  samples: readonly CaseResult[],
  pick: (s: CaseResult) => string | undefined,
  key: K,
): Partial<Record<K, string>> {
  const first = samples[0] === undefined ? undefined : pick(samples[0]);
  if (first === undefined) return {};
  if (!samples.every((s) => pick(s) === first)) return {};
  return { [key]: first } as Partial<Record<K, string>>;
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
