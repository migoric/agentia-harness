import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  CONFIG_FALLBACKS_ATTR,
  CONTEXT_BUDGET_EVENT,
  LLM_FALLBACK_EVENT,
  TOOL_INPUT_EVENT,
  TOOL_OUTPUT_EVENT,
  USAGE_MISSING_EVENT,
  USAGE_PARTIAL_EVENT,
} from '@migor/agentia';

/**
 * 架构守卫 —— 用测试守住「分层」这件事。
 *
 * 分层写在文档里等于没有：第一次赶工就会有人 `import` 上层的模块，而 TS 不会抱怨。
 * 这里把 `src/index.ts` 头注里那三条依赖方向变成断言，越界立刻红。
 *
 * 与 agentia 主仓同一个立场：约束要**可执行**，否则它只是愿望。
 */
const SRC = join(import.meta.dirname, '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** 只看 `from '...'`（`import type` / 动态 import 都覆盖不到，但那种写法在本仓没有） */
function importsOf(file: string): { spec: string; resolved: string | null }[] {
  const text = readFileSync(file, 'utf8');
  const out: { spec: string; resolved: string | null }[] = [];
  for (const m of text.matchAll(/from\s+'([^']+)'/g)) {
    const spec = m[1];
    if (spec === undefined) continue;
    // ESM 约定里 import 写的是 `.js`，源文件是 `.ts` —— 归一化到磁盘上的真实文件名
    const raw = spec.startsWith('.') ? resolve(dirname(file), spec) : null;
    out.push({
      spec,
      resolved: raw === null ? null : raw.endsWith('.js') ? `${raw.slice(0, -3)}.ts` : raw,
    });
  }
  return out;
}

function label(file: string): string {
  return relative(SRC, file);
}

/**
 * 上游 trace 词汇表 —— 0.10.14 起全部在 `@migor/agentia` 的公共导出面上。
 *
 * 本仓此前复制过一份字面量（`run/trace-events.ts`，已随 0.10.14 删除）。下面两条守卫
 * 保证它不会再长回来。理由不是整洁：抄字面量的失败方式**不是报错**，而是上游改名之后
 * 静默读到 0 条 —— 工具序列变成空、`usage.missing` 判据恒真。那种错不会有人发现，
 * 直到两份跑分被拿来比较并得出「没有退步」。
 */
const TRACE_VOCAB = [
  'tool.input',
  'tool.output',
  'usage.missing',
  'usage.partial',
  'context.budget',
  'llm.fallback',
  'config.fallbacks',
] as const;

/**
 * 取**代码区**的字符串字面量，跳过注释。
 *
 * 为什么不用 TS 的 AST：本仓装的是 typescript 7（native port），它的 JS 入口只剩
 * `version` / `versionMajorMinor`，`createSourceFile` 已经没有了（`node -e` 探过）。
 * 为一个 7 元素的黑名单再引一个解析器不划算，所以这里做一次够用的扫描。
 *
 * 为什么不能用裸正则：`src/run/model-read.ts` 的注释里就写着「上游会记 `usage.partial`」。
 * 正则会把这种**注释里的举例**算成违规，于是下一个人只好把守卫删掉 —— 那等于没有守卫。
 */
function codeLiterals(file: string): { text: string; line: number }[] {
  const text = readFileSync(file, 'utf8');
  const out: { text: string; line: number }[] = [];
  let line = 1;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      const startLine = line;
      let value = '';
      let interpolated = false;
      i++;
      while (i < text.length) {
        const c = text[i];
        if (c === '\\') {
          // 转义原样保留（不解释 \n / \u）：本仓词汇表里没有转义，保留反而不会误判
          value += c + (text[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (c === quote) {
          i++;
          break;
        }
        // 带插值的模板串不是一个静态字面量，不参与比对
        if (quote === '`' && c === '$' && text[i + 1] === '{') interpolated = true;
        if (c === '\n') line++;
        value += c;
        i++;
      }
      if (!interpolated) out.push({ text: value, line: startLine });
      continue;
    }
    i++;
  }
  return out;
}

describe('架构守卫', () => {
  it('assets/ 是纯文件层：不依赖 agentia，也不依赖任何上层', () => {
    for (const file of walk(join(SRC, 'assets'))) {
      for (const imp of importsOf(file)) {
        assert.doesNotMatch(
          imp.spec,
          /^@migor\//,
          `${label(file)} 不该 import ${imp.spec} —— 资产层要能被纯文件工具复用`,
        );
        if (imp.resolved === null) continue;
        assert.ok(
          imp.resolved.startsWith(join(SRC, 'assets')) ||
            imp.resolved.startsWith(join(SRC, 'util')) ||
            imp.resolved === join(SRC, 'errors.ts'),
          `${label(file)} 越界依赖 ${imp.spec}（资产层只许用 assets/ + util/ + errors）`,
        );
      }
    }
  });

  it('util/ 不认识业务：只依赖其它 util', () => {
    for (const file of walk(join(SRC, 'util'))) {
      for (const imp of importsOf(file)) {
        if (imp.resolved === null) continue;
        assert.ok(
          imp.resolved.startsWith(join(SRC, 'util')),
          `${label(file)} 不该依赖 ${imp.spec} —— util 是被所有层共用的，反过来依赖谁都会成环`,
        );
      }
    }
  });

  it('run/ 与 evals/ 不反向依赖 rsi/', () => {
    for (const dir of ['run', 'evals']) {
      for (const file of walk(join(SRC, dir))) {
        for (const imp of importsOf(file)) {
          assert.doesNotMatch(
            imp.spec,
            /\.\.\/rsi\//,
            `${label(file)} 依赖了 rsi/ ${imp.spec} —— 闭环建在执行之上，反过来就成环了`,
          );
        }
      }
    }
  });

  it('公共出口不暴露 cli/ 与 server/（它们不是库的一部分）', () => {
    const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
    for (const m of index.matchAll(/from\s+'\.\/([^']+)'/g)) {
      const target = m[1] ?? '';
      assert.ok(
        !target.startsWith('cli') && !target.startsWith('server'),
        `index.ts 导出了 ${target} —— CLI 与 HTTP 面是宿主入口，不是库 API`,
      );
    }
  });

  it('单文件不超过 400 行（超了就说明该拆了）', () => {
    const MAX = 400;
    for (const file of walk(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n').length;
      assert.ok(lines <= MAX, `${label(file)} 有 ${lines} 行（上限 ${MAX}）—— 拆成两个模块`);
    }
  });

  it('trace 词汇只从 @migor/agentia 取，src/ 里不许自己写一份', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      for (const lit of codeLiterals(file)) {
        if ((TRACE_VOCAB as readonly string[]).includes(lit.text)) {
          offenders.push(`${label(file)}:${lit.line}  '${lit.text}'`);
        }
      }
    }
    assert.equal(
      offenders.length,
      0,
      `src/ 里出现了 trace 词汇的字面量 —— 从 @migor/agentia import 同名常量：\n  ${offenders.join('\n  ')}`,
    );
  });

  it('trace 词汇的取值与上游约定逐字一致（改一个字符就是改协议）', () => {
    const actual: Record<(typeof TRACE_VOCAB)[number], string> = {
      'tool.input': TOOL_INPUT_EVENT,
      'tool.output': TOOL_OUTPUT_EVENT,
      'usage.missing': USAGE_MISSING_EVENT,
      'usage.partial': USAGE_PARTIAL_EVENT,
      'context.budget': CONTEXT_BUDGET_EVENT,
      'llm.fallback': LLM_FALLBACK_EVENT,
      'config.fallbacks': CONFIG_FALLBACKS_ATTR,
    };
    assert.deepEqual(
      actual,
      Object.fromEntries(TRACE_VOCAB.map((v) => [v, v])),
      '上游改了某个 trace 词汇的值 —— 这是协议变更，不是重构：本仓的 trace 读取口径、' +
        '以及「两份跑分可比」的判据都建立在这些名字上，改完要同步这条表和 CHANGELOG',
    );
  });
});
