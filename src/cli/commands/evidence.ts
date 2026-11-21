import { HarnessError } from '../../errors.js';
import { buildEvidenceCorpus } from '../../rsi/evidence.js';
import { boolFlag, strFlag } from '../args.js';
import type { CliContext } from '../context.js';
import { json, say, warn } from '../output.js';
import { readReport } from './observe.js';

/**
 * `harness evidence --from-report <报告.json>` —— 把一次评测的证据落成三层语料。
 *
 * 报告必须来自 `eval --save`：`CaseResult` 里带任务原文、断言失败与 traceId，
 * 这三项是原始 trace 无法单独提供的（trace 里没有任务原文）。
 */
export function evidenceCommand(ctx: CliContext): number {
  const path = strFlag(ctx.flags, 'from-report');
  if (path === undefined) {
    throw new HarnessError('config.invalid', 'evidence 需要 --from-report <评测报告.json>');
  }
  const report = readReport(ctx.root, path);
  const corpus = buildEvidenceCorpus(ctx.config, report, {
    ...(strFlag(ctx.flags, 'id') !== undefined ? { id: strFlag(ctx.flags, 'id') } : {}),
  });

  if (boolFlag(ctx.flags, 'json')) json(corpus);
  else {
    say(`证据语料 ${corpus.id} → ${corpus.dir}`);
    say(`  用例 ${corpus.items.length} · 失败模式 ${corpus.modes.length}`);
    say(`  总览 ${corpus.overviewPath} · 索引 ${corpus.indexPath}`);
    if (corpus.traceReadError !== undefined) warn(corpus.traceReadError);
    if (corpus.missingTraces.length > 0) {
      warn(`${corpus.missingTraces.length} 条用例有 traceId 但找不到原始 trace（报告里已列出）`);
    }
  }
  return 0;
}
