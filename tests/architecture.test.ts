import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

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
});
