import type { EvalReport } from './types.js';

/**
 * 「这次下降是真的吗」—— 唯一一处给 `gate` 的否决权加统计前提的地方。
 *
 * 单拆一个模块的理由不是行数：它是**纯函数 + 纯统计**，与「谁该被否决」是两件事。
 * 混在 `gate.ts` 里时它只能经由门被间接测到（要造两份完整报告才验证得到一个 z 值），
 * 而那正是最容易写错、又最难发现的一块。
 */

/**
 * 通过率下降**是否显著** —— 两比例的单侧 z 检验（α=0.05，z 临界值 -1.645）。
 *
 * 为什么需要这一步：没有它，`--repeat` 白跑。一次 3 采样的 3/3 → 2/3 会被读成
 * 「下降 33pt」而硬否决，而它完全可能是同一分布的两次抽样。
 *
 * 三个刻意的边界：
 *
 * 1. **两边采样数必须相同且 > 1**，否则返回 `undefined`（退回旧的按点估计判）。
 *    采样数不同意味着两边调优不一致 —— 那不是统计问题，是实验设计问题，
 *    拿它算 z 值只会给一个「看起来严谨」的错数。
 * 2. **只在用例集相同时算**（`shared === null`）。集合不同时点估计本身已经是
 *    交集口径，再叠一层检验会得出「交集上不显著 ⇒ 放行」，而真正的信息是
 *    「评测集变了」，那由 `case_set_changed` 单独负责。
 * 3. **`se === 0` 判显著**：两边都 100% 通过时 se 会算出 0（浮点下可能是极小值），
 *    此时任何下降都是真实的（同样的次数、同样的样本，少过了一次）。
 */
export function significance(
  baseline: EvalReport,
  candidate: EvalReport,
  shared: readonly string[] | null,
):
  | {
      readonly significant: boolean;
      readonly z: number;
      readonly samples: number;
      readonly baseRate: string;
      readonly candRate: string;
    }
  | undefined {
  if (shared !== null) return undefined;
  const bs = baseline.samples;
  const cs = candidate.samples;
  if (bs === undefined || cs === undefined || bs < 2 || bs !== cs) return undefined;

  const b = countSamples(baseline);
  const c = countSamples(candidate);
  if (b === undefined || c === undefined) return undefined;

  // 合并比例：H0 之下两边是同一个 p，用合并估计算标准误（而不是各自算再加）
  const pool = (b.passed + c.passed) / (b.total + c.total);
  const se = Math.sqrt(pool * (1 - pool) * (1 / b.total + 1 / c.total));
  const diff = c.passed / c.total - b.passed / b.total;
  const z = se === 0 ? (diff < 0 ? Number.NEGATIVE_INFINITY : 0) : diff / se;

  return {
    significant: z < -1.645,
    z,
    samples: bs,
    baseRate: `${b.passed}/${b.total}`,
    candRate: `${c.passed}/${c.total}`,
  };
}

/** 一份报告的样本级统计；缺少 `samples`（老报告）时返回 undefined */
function countSamples(
  r: EvalReport,
): { readonly passed: number; readonly total: number } | undefined {
  if (r.samples === undefined) return undefined;
  let passed = 0;
  let total = 0;
  for (const c of r.cases) {
    total += c.samples ?? 1;
    passed += c.passedSamples ?? (c.passed ? 1 : 0);
  }
  return total > 0 ? { passed, total } : undefined;
}
