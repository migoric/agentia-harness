import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspacePaths } from '../../config.js';
import { reportSchemaVersion } from '../../evals/report.js';

/**
 * 读评测报告（`.workspace/reports/*.json`）。
 *
 * 为什么是「扫一个约定目录」而不是「记住上次 `--save` 写哪儿了」：看板是给**人**看的，
 * 人不会为了看图去维护一份清单。约定一个目录、让 `eval --save` 往里写，是这个工具
 * 里唯一不需要额外状态的做法。找不到目录就是空列表 —— 空不是错，`mkdir` 才是
 * （只读面不许写工作区，判据 15）。
 *
 * 三条读侧纪律：
 *
 * 1. **坏文件不炸整页**。一份手改坏的 JSON 不该让「最近有哪些报告」都看不见。
 *    坏的那份进 `invalid` 并带上原因，好的一份照常列出 —— 这也是看板与 CLI 的区别：
 *    CLI 面对坏输入可以退出码 1，看板必须还能用。
 * 2. **不缓存**。看板的价值在于「现在是什么样」，缓存只会让人对着旧数字下结论。
 *    这些目录规模是几十份级别，每次全读的代价可以忽略。
 * 3. **只读**。整条调用链上没有一次 write/mkdir（`existsSync` 不算）。
 */
export function reportsDir(p: WorkspacePaths): string {
  return join(p.workspaceDir, 'reports');
}

export interface ReportSummary {
  readonly name: string;
  readonly mtime: string;
  readonly sizeBytes: number;
  /** 报告结构版本（老报告按 1 读，见 `reportSchemaVersion`） */
  readonly schemaVersion: number;
  readonly total: number;
  readonly passed: number;
  readonly passRate: number;
  readonly tokens: number;
  readonly costUsd: number;
  readonly costKnown: boolean;
  readonly routeAccuracy?: number;
  readonly routeCases?: number;
  readonly agent?: string;
  readonly model?: string;
  readonly finishedAt?: string;
  readonly assetFingerprint?: string;
}

export interface ReportList {
  readonly dir: string;
  readonly reports: readonly ReportSummary[];
  /** 读不动的文件与原因（不隐藏：坏报告本身就是需要被看见的信息） */
  readonly invalid: readonly { name: string; reason: string }[];
}

/** 文件名白名单。**不接受任何路径分隔符**，`..` 与绝对路径都在这里被挡掉 */
const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

export function isSafeReportName(name: string): boolean {
  return NAME_OK.test(name) && !name.includes('..');
}

/** 列目录。目录不存在 ⇒ 空列表（第一次跑 eval 之前的正常状态） */
export function listReports(p: WorkspacePaths): ReportList {
  const dir = reportsDir(p);
  if (!existsSync(dir)) return { dir, reports: [], invalid: [] };
  const reports: ReportSummary[] = [];
  const invalid: { name: string; reason: string }[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      const summary = summarize(full, name, st.mtime.toISOString(), st.size);
      if (summary === null) {
        invalid.push({ name, reason: '不像一份评测报告（缺 total / cases）' });
        continue;
      }
      reports.push(summary);
    } catch (e) {
      invalid.push({ name, reason: e instanceof Error ? e.message : '读取失败' });
    }
  }
  // 新的在前：看板第一眼该看到最近一次
  reports.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return { dir, reports, invalid };
}

/** 单份摘要；形状不对 ⇒ null（调用方决定这算「坏文件」还是「不存在」） */
function summarize(
  full: string,
  name: string,
  mtime: string,
  sizeBytes: number,
): ReportSummary | null {
  const raw = parseReport(full, sizeBytes);
  if (raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.total !== 'number' || !Array.isArray(o.cases)) return null;
  return {
    name,
    mtime,
    sizeBytes,
    schemaVersion: reportSchemaVersion(o),
    total: o.total,
    passed: typeof o.passed === 'number' ? o.passed : 0,
    passRate: typeof o.passRate === 'number' ? o.passRate : 0,
    tokens: typeof o.tokens === 'number' ? o.tokens : 0,
    costUsd: typeof o.costUsd === 'number' ? o.costUsd : 0,
    costKnown: o.costKnown === true,
    ...(typeof o.routeAccuracy === 'number' ? { routeAccuracy: o.routeAccuracy } : {}),
    ...(typeof o.routeCases === 'number' ? { routeCases: o.routeCases } : {}),
    ...(typeof o.agent === 'string' ? { agent: o.agent } : {}),
    ...(typeof o.model === 'string' ? { model: o.model } : {}),
    ...(typeof o.finishedAt === 'string' ? { finishedAt: o.finishedAt } : {}),
    ...(typeof o.assetFingerprint === 'string' ? { assetFingerprint: o.assetFingerprint } : {}),
  };
}

/** 8MB 上限：超过它按「报告过大」拒绝，而不是把它读进内存再 OOM */
const MAX_REPORT_BYTES = 8 * 1024 * 1024;

export function parseReport(full: string, sizeBytes: number): unknown | null {
  if (sizeBytes > MAX_REPORT_BYTES) return null;
  try {
    return JSON.parse(readFileSync(full, 'utf8'));
  } catch {
    return null;
  }
}

export interface LoadedReport {
  readonly name: string;
  readonly mtime: string;
  readonly sizeBytes: number;
  /** 原样返回：报告是**证据**，看板不许替它「美化」或补字段 */
  readonly raw: unknown;
}

/**
 * 读单份。三种失败分开返回，让调用方能给准话：
 * - `bad_name` ⇒ 400（路径穿越/非法字符，是请求的问题）
 * - `too_large` ⇒ 413（是报告的问题，但调用方可以改成分页取）
 * - `not_found` ⇒ 404
 */
export type ReportLoad =
  | { readonly ok: true; readonly report: LoadedReport }
  | { readonly ok: false; readonly why: 'bad_name' | 'too_large' | 'not_found' | 'bad_json' };

export function loadReport(p: WorkspacePaths, name: string): ReportLoad {
  if (!isSafeReportName(name)) return { ok: false, why: 'bad_name' };
  const full = join(reportsDir(p), name);
  if (!existsSync(full)) return { ok: false, why: 'not_found' };
  const st = statSync(full);
  if (st.size > MAX_REPORT_BYTES) return { ok: false, why: 'too_large' };
  try {
    const raw: unknown = JSON.parse(readFileSync(full, 'utf8'));
    return { ok: true, report: { name, mtime: st.mtime.toISOString(), sizeBytes: st.size, raw } };
  } catch {
    return { ok: false, why: 'bad_json' };
  }
}
