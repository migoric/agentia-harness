import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessError } from '../errors.js';
import { list, parseFrontmatter, scalar } from '../util/frontmatter.js';
import type { EvalCase, EvalExpect } from './types.js';

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
  const name = scalar(fm, 'name', path) ?? path.replace(/.*\//, '').replace(/\.md$/, '');
  const task = fm.body.trim();
  if (task === '') {
    throw new HarnessError('eval.invalid', `${path}: 正文必须是任务描述（不能为空）`);
  }

  const contains = list(fm, 'expect_contains');
  const tools = list(fm, 'expect_tools');
  const matches = scalar(fm, 'expect_matches', path);
  const ok = scalar(fm, 'expect_ok', path);
  const maxTokens = scalar(fm, 'expect_max_tokens', path);

  if (ok !== undefined && ok !== 'true' && ok !== 'false') {
    throw new HarnessError('eval.invalid', `${path}: expect_ok 只能是 true/false`);
  }
  const maxTokensNum = maxTokens === undefined ? undefined : Number(maxTokens);
  if (maxTokensNum !== undefined && (!Number.isFinite(maxTokensNum) || maxTokensNum <= 0)) {
    throw new HarnessError('eval.invalid', `${path}: expect_max_tokens 应为正数`);
  }

  const expect: EvalExpect = {
    ...(contains.length > 0 ? { contains } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(matches !== undefined ? { matches } : {}),
    ...(ok !== undefined ? { ok: ok === 'true' } : {}),
    ...(maxTokensNum !== undefined ? { maxTokens: maxTokensNum } : {}),
  };
  if (Object.keys(expect).length === 0) {
    throw new HarnessError(
      'eval.invalid',
      `${path}: 没有任何断言 —— 一条永远通过的用例对 RSI 是负资产（它会掩盖回归）`,
    );
  }

  return { name, task, expect, path };
}
