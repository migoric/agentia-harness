import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { HarnessError } from '../../errors.js';
import type { CodePatch, CodeVerify } from './types.js';

const run = promisify(execFile);

/**
 * 沙箱验证 —— L2 的**唯一**验证手段。
 *
 * 为什么必须是 git worktree 而不是「在主树里 git stash 一下」：
 * - 主树里试错会把「验证失败」变成**有代价**的动作（要还原、要担心还原失败），
 *   而 RSI 的全部意义建立在「试错零成本」上；
 * - worktree 是 HEAD 的一个独立检出，验证期间主树的状态（含未提交改动、正在跑的
 *   dev server）完全不受影响；
 * - 验证命令在 worktree 里跑，**即使它写文件也写不脏主树**。
 *
 * 为什么沙箱目录选在 `<repo>/.workspace/sandbox` 而不是 `os.tmpdir()`：worktree
 * 里没有 `node_modules`，但 Node / npm 解析依赖时会**沿目录向上**走 —— 放在仓库
 * 里面，它们就能找到主仓的依赖。搬到 /tmp 的话，`npm test` 会以「模块找不到」
 * 失败，而那与补丁对错毫无关系（假阴性比假阳性更浪费时间）。
 *
 * 一个诚实的边界：超时用 SIGTERM 杀**直接子进程**，它派生的孙进程可能残留。
 * 这是 `execFile` 的边界，不是本层能解决的；默认超时给得足够长以减少触发。
 */
export interface SandboxOptions {
  readonly repoRoot: string;
  readonly patch: CodePatch;
  readonly command: readonly string[];
  readonly timeoutMs: number;
  /** 沙箱目录的父目录；默认 `<repo>/.workspace/sandbox` */
  readonly sandboxRoot?: string | undefined;
}

export interface SandboxResult {
  readonly verify: CodeVerify;
  /** worktree 路径（已删除，仅作为证据留痕） */
  readonly sandbox: string;
}

/** 输出尾部：失败时人要看的是最后几行，不是前 10000 行安装日志 */
const TAIL_LINES = 40;
const TAIL_CHARS = 4000;

export async function verifyInSandbox(opts: SandboxOptions): Promise<SandboxResult> {
  const repo = await gitTopLevel(opts.repoRoot);
  if (opts.command.length === 0) {
    throw new HarnessError('code.invalid', '没有配置验证命令（code.verify）');
  }
  const sandboxRoot = opts.sandboxRoot ?? join(repo, '.workspace', 'sandbox');
  mkdirSync(sandboxRoot, { recursive: true });
  const sandbox = join(
    sandboxRoot,
    `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );

  const started = Date.now();
  let patched = true;
  let applyOut = '';
  try {
    await run('git', ['-C', repo, 'worktree', 'add', '--detach', '--quiet', sandbox, 'HEAD']);

    const patchFile = writePatchFile(opts.patch.diff);
    try {
      await run('git', ['-C', sandbox, 'apply', '--whitespace=nowarn', patchFile]);
    } catch (e) {
      patched = false;
      applyOut = outputOf(e);
    } finally {
      rmSync(dirname(patchFile), { recursive: true, force: true });
    }

    if (!patched) {
      return {
        sandbox,
        verify: {
          ok: false,
          exitCode: null,
          timedOut: false,
          durationMs: Date.now() - started,
          command: opts.command,
          outputTail: tail(`补丁应用失败（git apply 拒绝了它）：\n${applyOut}`),
        },
      };
    }

    const outcome = await runVerifier(opts.command, sandbox, opts.timeoutMs);
    return {
      sandbox,
      verify: {
        ok: outcome.exitCode === 0 && !outcome.timedOut,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        durationMs: Date.now() - started,
        command: opts.command,
        outputTail: tail(outcome.output),
      },
    };
  } finally {
    // worktree 必须在任何退出路径上删掉：留着会让下一次 `git worktree add` 撞名，
    // 也会让 `git status` 在主树里看到一堆本不该存在的文件
    await run('git', ['-C', repo, 'worktree', 'remove', '--force', sandbox]).catch(() =>
      run('git', ['-C', repo, 'worktree', 'prune']).catch(() => undefined),
    );
  }
}

async function gitTopLevel(dir: string): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
    return stdout.trim();
  } catch {
    throw new HarnessError(
      'code.invalid',
      `${dir} 不是 git 仓库 —— L2 的验证与回滚都建立在 git 之上`,
    );
  }
}

function writePatchFile(diff: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-patch-'));
  const path = join(dir, 'change.diff');
  writeFileSync(path, diff, 'utf8');
  return path;
}

interface Verified {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly output: string;
}

async function runVerifier(
  command: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<Verified> {
  const [bin, ...args] = command;
  if (bin === undefined) throw new HarnessError('code.invalid', '验证命令为空');
  try {
    const { stdout, stderr } = await run(bin, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CI: '1' },
    });
    return { exitCode: 0, timedOut: false, output: `${stdout}${stderr}` };
  } catch (e) {
    const err = e as { code?: number | string; killed?: boolean; signal?: string };
    const timedOut = err.killed === true || err.signal === 'SIGTERM';
    const code = typeof err.code === 'number' ? err.code : null;
    return { exitCode: code, timedOut, output: outputOf(e) };
  }
}

function outputOf(e: unknown): string {
  const err = e as { stdout?: unknown; stderr?: unknown; message?: unknown };
  const out = typeof err.stdout === 'string' ? err.stdout : '';
  const errText = typeof err.stderr === 'string' ? err.stderr : '';
  const message = typeof err.message === 'string' ? err.message : '';
  return `${out}${errText}`.trim() === '' ? message : `${out}${errText}`;
}

function tail(text: string): string {
  const lines = text.trimEnd().split('\n').slice(-TAIL_LINES).join('\n');
  return lines.length > TAIL_CHARS ? lines.slice(lines.length - TAIL_CHARS) : lines;
}
