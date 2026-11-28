import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * CLI 子进程夹具。
 *
 * 为什么坚持起真进程而不是直接调命令函数：退出码是 CLI 对 CI 的契约
 * （`lock --check` / `report` 都靠它拦），而 `process.exitCode` 有没有设对，
 * 在进程内是测不出来的。
 */
const CLI = join(import.meta.dirname, '..', '..', 'src', 'cli.ts');
/**
 * 子进程的 cwd 是临时目录，`--import tsx` 在那个位置解析不到（node_modules 在本仓
 * 而不在它的祖先链上）。用 `import.meta.resolve` 拿到绝对 URL 再交给 --import。
 */
const TSX = import.meta.resolve('tsx');

export function runCli(
  args: string[],
  cwd: string,
  /** 追加/覆盖的环境变量（`undefined` 值表示**删掉**继承来的那个变量） */
  env: Record<string, string | undefined> = {},
  /** `out` 是 stdout+stderr 的合并（大多数断言只关心「说了没有」）；需要区分哪条流时用 `err` */
): { code: number | null; out: string; err: string } {
  const merged: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  const r = spawnSync(process.execPath, ['--import', TSX, CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: merged,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, err: r.stderr };
}

export function tmpProject(prefix = 'harness-cli-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
