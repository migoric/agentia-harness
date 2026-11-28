import { type CaseTrend, caseTrends, historyPath, readHistory } from '../../evals/history.js';
import { boolFlag, numFlag } from '../args.js';
import type { CliContext } from '../context.js';
import { json, say, warn } from '../output.js';

/**
 * `harness history` —— 每条用例的时间维度。
 *
 * 为什么需要一条命令：`report` 回答「这次比上次好不好」，`trace` 回答「这次怎么跑的」，
 * 而决定要不要相信一次结论的问题在第三个方向 —— **这条用例以前是怎么表现的**。
 * 没有它，一次 `case_regression` 只能靠人回忆「好像上周也挂过」。
 *
 * `--check` 是给 CI 用的：有抖动用例就退出码 1。它不是「测试失败」，是「你的判定集
 * 里有不可信的成员」—— 那种用例当判据时，一次坏运气就能否掉一个好改动。
 */
export function historyCommand(ctx: CliContext): number {
  const tail = numFlag(ctx.flags, 'tail');
  const { runs, skipped } = readHistory(ctx.config, {
    ...(tail !== undefined ? { tail } : {}),
  });
  if (skipped > 0) {
    // 坏行不拦主流程，但必须出声：静默跳过会让「这条用例历史上只有 2 次」看起来像
    // 「它只跑过 2 次」，而真相是有几行读不出来了
    warn(`${historyPath(ctx.config)} 里有 ${skipped} 行读不出来，已跳过（不影响主流程）`);
  }
  const trends = caseTrends(runs);
  const flaky = trends.filter((t) => t.flaky);

  if (boolFlag(ctx.flags, 'json')) {
    json({ runs: runs.length, skipped, cases: trends });
  } else {
    say(renderTrends(trends, runs.length, historyPath(ctx.config)));
  }
  return boolFlag(ctx.flags, 'check') && flaky.length > 0 ? 1 : 0;
}

function renderTrends(trends: readonly CaseTrend[], runCount: number, file: string): string {
  if (runCount === 0) {
    return (
      `还没有历史（${file} 不存在）。每次 \`harness eval\` 都会往里记一笔；\n` +
      '攒到 2 次以上，同样的资产下既过又挂的用例才会被标成抖动。'
    );
  }
  const head = ['用例', '次数', '通过', '最近', '平均 token', '平均成本', ''];
  const rows = trends.map((t) => [
    t.name,
    String(t.runs),
    `${(t.passRate * 100).toFixed(0)}%`,
    t.recent,
    String(t.avgTokens),
    t.avgCostUsd === undefined ? '-' : `$${t.avgCostUsd.toFixed(5)}`,
    // 抖动标记放在最后一列而不是替换通过率：通过率仍然是事实，只是不能单独当判据
    t.flaky ? '抖动' : '',
  ]);
  const widths = head.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((c, i) => pad(c, widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  const out = [line(head), line(widths.map((w) => '-'.repeat(w)))];
  for (const [i, row] of rows.entries()) {
    out.push(line(row));
    const why = trends[i]?.why;
    // 依据写在下一行而不是行内：它是一句事实（「同样条件下 3 过 2 挂」），
    // 塞进表格会把表撑得没法读，而人最需要的正是这句能复核的话
    if (why !== undefined) out.push(`     └ ${why}`);
  }
  const flakyCount = trends.filter((t) => t.flaky).length;
  const infra = trends.reduce((n, t) => Math.max(n, t.infraRuns), 0);
  out.push(
    `\n${trends.length} 条用例 / ${runCount} 次运行` +
      (flakyCount === 0
        ? ' · 没有抖动'
        : ` · ${flakyCount} 条抖动（这些用例当判据时，一次坏运气就能否掉一个好改动）`) +
      // 「为什么这条没被判成抖动」也要有答案：401 / 超时那些轮被排除在外，
      // 但它们仍然出现在次数与 `E` 里 —— 不解释就成了一个看不懂的读数
      (infra === 0 ? '' : `\n注：有 ${infra} 轮是运行失败（error / 超时，记为 E），不参与抖动判定`),
  );
  return out.join('\n');
}

/** 等宽对齐。不引入表格库：两列宽度的 padEnd 就够了，而依赖是要还的 */
function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * 终端里的显示宽度。中文字符占两格，用 `String.length` 对齐会让整张表歪掉 ——
 * 而「表歪了」的观感是「这工具没人认真做」，比数字错还伤信任。
 *
 * 只覆盖 CJK 与全角标点这几段：这张表里的非 ASCII 就是用例名与「抖动」两个字，
 * 上一套完整的 East Asian Width 表没有收益。
 */
function displayWidth(text: string): number {
  let n = 0;
  for (const ch of text) {
    n += WIDE.test(ch) ? 2 : 1;
  }
  return n;
}

const WIDE =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;
