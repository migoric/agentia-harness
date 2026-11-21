import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessError } from '../errors.js';
import { list, parseFrontmatter, scalar } from '../util/frontmatter.js';
import type { EvalCase, EvalExpect, ToolArgExpect } from './types.js';

/** 用例 frontmatter 白名单：多写一个断言键就静默少一道门，比配置拼错更难发现 */
const CASE_KEYS: readonly string[] = [
  'name',
  'split',
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
 * 多轮用例的轮次分隔符 —— 正文里单独一行写成 `<!-- turn -->`。
 *
 * 为什么不用 frontmatter 数组：轮次正文是**给模型的话**，里面天然会带引号、冒号、
 * `#`（看起来像注释）、甚至 `---`（markdown 分隔线）。塞进我们那个刻意做小的 YAML
 * 子集只会让「写一个带 # 的追问」变成解析失败。一行 HTML 注释不会出现在人话里，
 * 而且对 diff / grep 都友好。
 */
export const TURN_SEPARATOR = '<!-- turn -->';

const TURN_LINE = /^[ \t]*<!--\s*turn\s*-->[ \t]*\r?$/m;

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
 * 多轮用例用分隔符把后续轮次写在同一个正文里（首轮仍是第一段）：
 *
 * ```md
 * ---
 * name: fix-path
 * expect_contains: bar.c
 * ---
 * 先看下 foo.c 里的函数
 * <!-- turn -->
 * 不对，我要的是 bar.c
 * ```
 *
 * 用 Markdown 而不是 JSON：RSI 的提案会**生成**用例（从线上失败 trace 回流），
 * md 让 diff 可读、也让人能直接改一个字重跑。正文就是 task。
 */
export function loadEvalCases(dir: string): EvalCase[] {
  if (!existsSync(dir)) return [];
  const files = collect(join(dir));
  const cases = files.map(parseCase);
  // 留出集不是「附加题」：全是 holdout 时没有优化信号，RSI 会拿着零条 train 失败
  // 去做归因，然后声称「没有失败无需改进」。这是配置错，必须在加载期炸。
  if (cases.length > 0 && cases.every((c) => c.split === 'holdout')) {
    throw new HarnessError(
      'eval.invalid',
      `evals 全被标成 split: holdout —— 至少要留一条 train 用例供 RSI 归因与提案`,
    );
  }
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
  const split = scalar(fm, 'split', path);
  if (split !== undefined && split !== 'train' && split !== 'holdout') {
    throw new HarnessError(
      'eval.invalid',
      `${path}: split 只能是 train / holdout（收到 "${split}"）—— 拼错会让用例静默混进 train，留出集就此失效`,
    );
  }
  const { task, followUps } = splitTurns(fm.body, path);

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

  return {
    name,
    task,
    ...(followUps.length > 0 ? { followUps } : {}),
    expect,
    ...(split !== undefined ? { split } : {}),
    path,
  };
}

/**
 * 把正文切成轮次。
 *
 * 空段一律拒绝：`<!-- turn -->` 后面忘了写内容，跑起来会变成「发一条空消息」——
 * 那在真实会话里根本不存在，测出来的东西也就不是用户会遇到的问题。
 */
function splitTurns(body: string, path: string): { task: string; followUps: string[] } {
  const segments = body.split(TURN_LINE).map((s) => s.trim());
  const empty = segments.indexOf('');
  if (empty !== -1) {
    throw new HarnessError(
      'eval.invalid',
      `${path}: 第 ${empty + 1} 段轮次是空的（多轮用例用 "${TURN_SEPARATOR}" 分行，每段都必须有内容）`,
    );
  }
  const [first = '', ...rest] = segments;
  return { task: first, followUps: rest };
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
