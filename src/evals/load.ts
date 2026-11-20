import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessError } from '../errors.js';
import { list, parseFrontmatter, scalar } from '../util/frontmatter.js';
import type { EvalCase, EvalExpect, ToolArgExpect } from './types.js';

/** 用例 frontmatter 白名单：多写一个断言键就静默少一道门，比配置拼错更难发现 */
const CASE_KEYS: readonly string[] = [
  'name',
  'expect_contains',
  'expect_not_contains',
  'expect_tools',
  'expect_tool_counts',
  'expect_tool_args',
  'expect_skills',
  'expect_matches',
  'expect_ok',
  'expect_max_tokens',
  'expect_max_iterations',
];

/**
 * 加载 `evals/` —— 一个文件一个用例，Markdown。
 *
 * ```md
 * ---
 * name: triage-basic
 * expect_tools: [repo_triage]
 * expect_contains: 严重
 * expect_max_tokens: 20000
 * ---
 * 这个仓库的 issue #12 该交给谁？
 * ```
 *
 * 用 Markdown 而不是 JSON：RSI 的提案会**生成**用例（从线上失败 trace 回流），
 * md 让 diff 可读、也让人能直接改一个字重跑。正文就是 task。
 */
export function loadEvalCases(dir: string): EvalCase[] {
  if (!existsSync(dir)) return [];
  const files = collect(join(dir));
  const cases = files.map(parseCase);
  const seen = new Map<string, string>();
  for (const c of cases) {
    const prev = seen.get(c.name);
    if (prev !== undefined) {
      throw new HarnessError('eval.invalid', `用例重名 "${c.name}"：${prev} 与 ${c.path}`);
    }
    seen.set(c.name, c.path);
  }
  return cases.sort((a, b) => a.name.localeCompare(b.name));
}

/** 一目录一用例，或直接 `<name>.md`（与资产同一套布局口径） */
function collect(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      const entry = join(full, 'CASE.md');
      if (existsSync(entry)) out.push(entry);
      continue;
    }
    if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

function parseCase(path: string): EvalCase {
  const fm = parseFrontmatter(readFileSync(path, 'utf8'), path);
  for (const key of Object.keys(fm.data)) {
    if (!CASE_KEYS.includes(key)) {
      throw new HarnessError(
        'eval.invalid',
        `${path}: 不认识的用例字段 "${key}"（只认 ${CASE_KEYS.join(' / ')}）—— 拼错的断言会被静默丢掉`,
      );
    }
  }
  const name = scalar(fm, 'name', path) ?? path.replace(/.*\//, '').replace(/\.md$/, '');
  const task = fm.body.trim();
  if (task === '') {
    throw new HarnessError('eval.invalid', `${path}: 正文必须是任务描述（不能为空）`);
  }

  const contains = list(fm, 'expect_contains');
  const notContains = list(fm, 'expect_not_contains');
  const tools = list(fm, 'expect_tools');
  const toolCountsRaw = list(fm, 'expect_tool_counts');
  const toolArgsRaw = list(fm, 'expect_tool_args');
  const skills = list(fm, 'expect_skills');
  const matches = scalar(fm, 'expect_matches', path);
  const ok = scalar(fm, 'expect_ok', path);
  const maxTokens = scalar(fm, 'expect_max_tokens', path);
  const maxIterations = scalar(fm, 'expect_max_iterations', path);

  if (ok !== undefined && ok !== 'true' && ok !== 'false') {
    throw new HarnessError('eval.invalid', `${path}: expect_ok 只能是 true/false`);
  }
  const maxTokensNum = positive(maxTokens, `${path}: expect_max_tokens`);
  const maxIterationsNum = positive(maxIterations, `${path}: expect_max_iterations`);
  const toolCounts = parseCounts(toolCountsRaw, path);
  const toolArgs = parseArgs(toolArgsRaw, path);

  // 同一串既要求出现又要求不出现 ⇒ 这条用例永远失败，是写错了而不是「严格」
  for (const s of contains) {
    if (notContains.includes(s)) {
      throw new HarnessError(
        'eval.invalid',
        `${path}: "${s}" 同时出现在 expect_contains 与 expect_not_contains`,
      );
    }
  }

  // 正则在加载期编译：`check()` 里才 new RegExp 的话，坏正则会让**用例跑到一半**
  // 抛异常，而不是在评测开始前以 eval.invalid（退出码 2）响亮失败。
  if (matches !== undefined) {
    try {
      new RegExp(matches);
    } catch (e) {
      throw new HarnessError('eval.invalid', `${path}: expect_matches 不是合法正则: ${matches}`, e);
    }
  }

  const expect: EvalExpect = {
    ...(contains.length > 0 ? { contains } : {}),
    ...(notContains.length > 0 ? { notContains } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(Object.keys(toolCounts).length > 0 ? { toolCounts } : {}),
    ...(toolArgs.length > 0 ? { toolArgs } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(matches !== undefined ? { matches } : {}),
    ...(ok !== undefined ? { ok: ok === 'true' } : {}),
    ...(maxTokensNum !== undefined ? { maxTokens: maxTokensNum } : {}),
    ...(maxIterationsNum !== undefined ? { maxIterations: maxIterationsNum } : {}),
  };
  if (Object.keys(expect).length === 0) {
    throw new HarnessError(
      'eval.invalid',
      `${path}: 没有任何断言 —— 一条永远通过的用例对 RSI 是负资产（它会掩盖回归）`,
    );
  }

  return { name, task, expect, path };
}

function positive(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new HarnessError('eval.invalid', `${label} 应为正数（收到 "${raw}"）`);
  }
  return n;
}

/** `expect_tool_counts: [read:2, grep:1]` —— 只切第一个冒号，工具名本身不含冒号 */
function parseCounts(raw: readonly string[], path: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of raw) {
    const colon = item.indexOf(':');
    const tool = (colon < 0 ? item : item.slice(0, colon)).trim();
    const count = colon < 0 ? '' : item.slice(colon + 1).trim();
    if (tool === '' || !/^\d+$/.test(count) || Number(count) <= 0) {
      throw new HarnessError(
        'eval.invalid',
        `${path}: expect_tool_counts 的 "${item}" 格式不对，应为 "工具名:正整数"`,
      );
    }
    if (out[tool] !== undefined) {
      throw new HarnessError(
        'eval.invalid',
        `${path}: expect_tool_counts 重复声明 "${tool}" —— 要么写成一个数，要么是写错了`,
      );
    }
    out[tool] = Number(count);
  }
  return out;
}

/** `expect_tool_args: [read:foo.c]` —— 子串里可以有冒号，但 frontmatter 行内数组不含逗号 */
function parseArgs(raw: readonly string[], path: string): ToolArgExpect[] {
  const out: ToolArgExpect[] = [];
  for (const item of raw) {
    const colon = item.indexOf(':');
    const tool = (colon < 0 ? item : item.slice(0, colon)).trim();
    const substring = colon < 0 ? '' : item.slice(colon + 1).trim();
    if (tool === '' || substring === '') {
      throw new HarnessError(
        'eval.invalid',
        `${path}: expect_tool_args 的 "${item}" 格式不对，应为 "工具名:入参子串"`,
      );
    }
    out.push({ tool, substring });
  }
  return out;
}
