import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HarnessError } from '../../errors.js';
import { harvestCase } from '../../evals/harvest.js';
import { loadEvalCases } from '../../evals/load.js';
import type { EvalReport } from '../../evals/types.js';
import { boolFlag, strFlag } from '../args.js';
import { assetsOf, type CliContext } from '../context.js';
import { json, say } from '../output.js';
import { findTrace } from '../traces.js';

/**
 * `harness harvest <traceId>` —— 把一条失败 trace 回流成回归用例。
 *
 * 两个刻意的限制：
 * - **任务原文必须外来**：trace 里没有它。要么 `--task`，要么 `--from-report`（从
 *   `eval --save` 的报告按 traceId 反查）。两者都给或都不给都拒绝。
 * - **不覆盖**：用例文件已存在就报错。回流是「加一条」，不是静默改掉人写过的断言。
 */
export function harvestCommand(ctx: CliContext, prefix: string | undefined): number {
  if (prefix === undefined || prefix === '') {
    throw new HarnessError('config.invalid', 'harvest 需要一个 traceId（可用前缀）');
  }
  const inline = strFlag(ctx.flags, 'task');
  const reportPath = strFlag(ctx.flags, 'from-report');
  if (inline !== undefined && reportPath !== undefined) {
    throw new HarnessError(
      'config.invalid',
      'harvest 只接受一种任务来源：--task 或 --from-report（同时给会分不清以哪个为准）',
    );
  }

  const trace = findTrace(ctx.config, prefix, { unique: true });
  const task =
    inline ??
    (reportPath === undefined ? undefined : taskFromReport(ctx, reportPath, trace.traceId));
  if (task === undefined) {
    throw new HarnessError(
      'config.invalid',
      'trace 里没有任务原文：请用 --task "..." 指定，或用 --from-report <eval报告.json> 反查',
    );
  }

  const made = harvestCase(trace, task, {
    skillNames: new Set(assetsOf(ctx).skills.map((s) => s.name)),
  });
  const dir = ctx.config.evalsDir;
  mkdirSync(dir, { recursive: true });
  // 文件名不冲突不代表用例不冲突：一目录一用例的布局里，name 来自 frontmatter。
  // 写进子目录的 CASE.md 若已占用这个名字，本次能写成功，但下次 eval 一加载就重名报错。
  const clash = loadEvalCases(dir).find((c) => c.name === made.name);
  if (clash !== undefined) {
    throw new HarnessError(
      'eval.invalid',
      `用例名 "${made.name}" 已被 ${clash.path} 占用 —— 拒绝生成同名用例`,
    );
  }
  const path = join(dir, `${made.name}.md`);
  try {
    writeFileSync(path, made.text, { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    throw new HarnessError('eval.invalid', `${path} 已存在 —— 拒绝覆盖已有用例`, e);
  }

  if (boolFlag(ctx.flags, 'json')) json({ path, name: made.name, summary: made.summary });
  else
    say(`生成 ${path}\n  ${made.summary}\n  请补上结果类断言（expect_contains / expect_matches）`);
  return 0;
}

function taskFromReport(ctx: CliContext, path: string, traceId: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(ctx.root, path), 'utf8'));
  } catch (e) {
    throw new HarnessError('eval.invalid', `读不到或不是合法 JSON 的报告：${path}`, e);
  }
  // JSON.parse('null') / '[]' 都合法但不是报告；不挡住会变成原生 TypeError（退出码 1）
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HarnessError('eval.invalid', `${path} 的报告应是 JSON 对象`);
  }
  const report = parsed as Partial<EvalReport>;
  if (!Array.isArray(report.cases)) {
    throw new HarnessError('eval.invalid', `${path} 不像一份评测报告（缺 cases）`);
  }
  const hit = report.cases.find((c) => c?.traceId === traceId);
  if (hit === undefined) {
    throw new HarnessError(
      'eval.invalid',
      `${path} 里没有 traceId=${traceId} 的用例 —— 这份报告不是那次 trace 对应的 eval`,
    );
  }
  if (typeof hit.task !== 'string' || hit.task.trim() === '') {
    throw new HarnessError('eval.invalid', `${path} 里那条用例没有可用的 task 原文`);
  }
  return hit.task;
}
