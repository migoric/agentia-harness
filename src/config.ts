import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { HarnessError } from './errors.js';

/**
 * Harness —— 工程配置。
 *
 * 约定优于配置：不写 `harness.config.json` 也能跑（全部落缺省目录）。写了的字段
 * 才覆盖 —— 这与仓库里「显式 undefined 与不传不同」的口径一致，所以 `readConfig`
 * 只认**出现过的键**。
 *
 * 所有路径在返回前都解析成绝对路径：CLI 的工作目录由用户决定，配置里存相对路径
 * 是合理的，但代码里不再做第二次拼接。
 */
export interface HarnessConfig {
  readonly root: string;
  readonly skillsDir: string;
  readonly agentsDir: string;
  readonly evalsDir: string;
  readonly lockPath: string;
  /** 运行时产物根（trace / 跑分 / 提案），默认 `.workspace/` */
  readonly workspaceDir: string;
  readonly tracesPath: string;
  readonly appName: string;
  readonly model: string | undefined;
  readonly maxIterations: number | undefined;
  readonly maxCostUsd: number | undefined;
  /**
   * L2（代码补丁）的验证命令，缺省 `['npm', 'test']`。
   *
   * 存成数组而不是字符串：字符串要过 shell，而 shell 会把「参数里带空格」和
   * 「多个命令」混成一个不可控的东西 —— 沙箱里跑的东西越简单越可信。
   */
  readonly codeVerify: readonly string[];
  /** 验证命令的超时（毫秒），缺省 10 分钟 */
  readonly codeVerifyTimeoutMs: number;
}

export const CONFIG_FILENAME = 'harness.config.json';

const DEFAULTS = {
  skillsDir: 'skills',
  agentsDir: 'agents',
  evalsDir: 'evals',
  workspaceDir: '.workspace',
  appName: 'harness',
} as const;

interface RawConfig {
  skills?: unknown;
  agents?: unknown;
  evals?: unknown;
  workspace?: unknown;
  appName?: unknown;
  model?: unknown;
  maxIterations?: unknown;
  maxCostUsd?: unknown;
  code?: unknown;
}

export function loadConfig(root: string): HarnessConfig {
  const absRoot = resolve(root);
  const cfgPath = join(absRoot, CONFIG_FILENAME);
  const raw: RawConfig = existsSync(cfgPath) ? readJson(cfgPath) : {};

  const workspaceDir = joinPath(
    absRoot,
    readDir(raw.workspace, 'workspace', DEFAULTS.workspaceDir),
  );

  return {
    root: absRoot,
    skillsDir: joinPath(absRoot, readDir(raw.skills, 'skills', DEFAULTS.skillsDir)),
    agentsDir: joinPath(absRoot, readDir(raw.agents, 'agents', DEFAULTS.agentsDir)),
    evalsDir: joinPath(absRoot, readDir(raw.evals, 'evals', DEFAULTS.evalsDir)),
    lockPath: join(absRoot, 'harness.lock.json'),
    workspaceDir,
    tracesPath: join(workspaceDir, 'traces.jsonl'),
    appName: readString(raw.appName, 'appName') ?? DEFAULTS.appName,
    model: readString(raw.model, 'model'),
    maxIterations: readNumber(raw.maxIterations, 'maxIterations'),
    maxCostUsd: readNumber(raw.maxCostUsd, 'maxCostUsd'),
    ...readCode(raw.code),
  };
}

const CODE_DEFAULTS = { verify: ['npm', 'test'] as readonly string[], timeoutMs: 600_000 };

/** `code` 段：形状错就炸（配置错必须响亮，否则会以「验证永远失败」的形式出现） */
function readCode(v: unknown): { codeVerify: readonly string[]; codeVerifyTimeoutMs: number } {
  if (v === undefined) {
    return { codeVerify: CODE_DEFAULTS.verify, codeVerifyTimeoutMs: CODE_DEFAULTS.timeoutMs };
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new HarnessError('config.invalid', '配置字段 "code" 应为对象');
  }
  const { verify, timeoutMs } = v as { verify?: unknown; timeoutMs?: unknown };
  let cmd = CODE_DEFAULTS.verify;
  if (verify !== undefined) {
    if (
      !Array.isArray(verify) ||
      verify.length === 0 ||
      !verify.every((x) => typeof x === 'string')
    ) {
      throw new HarnessError('config.invalid', '配置字段 "code.verify" 应为非空字符串数组');
    }
    cmd = verify as string[];
  }
  const timeout = readNumber(timeoutMs, 'code.timeoutMs') ?? CODE_DEFAULTS.timeoutMs;
  if (timeout <= 0) {
    throw new HarnessError('config.invalid', '配置字段 "code.timeoutMs" 必须为正数');
  }
  return { codeVerify: cmd, codeVerifyTimeoutMs: timeout };
}

function readJson(path: string): RawConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new HarnessError('config.invalid', `读不到 ${path}`, e);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new HarnessError('config.invalid', `${path} 顶层必须是对象`);
    }
    return parsed as RawConfig;
  } catch (e) {
    if (e instanceof HarnessError) throw e;
    throw new HarnessError('config.invalid', `${path} 不是合法 JSON`, e);
  }
}

/** 目录名可用相对路径（`../shared/skills`），解析后必须是绝对路径 */
function joinPath(root: string, rel: string): string {
  return abs(resolve(root, rel));
}

function abs(p: string): string {
  if (!isAbsolute(p)) {
    throw new HarnessError('config.invalid', `路径未解析成绝对路径: ${p}`);
  }
  return p;
}

function readDir(v: unknown, key: string, fallback: string): string {
  const s = readString(v, key);
  return s === undefined || s === '' ? fallback : s;
}

function readString(v: unknown, key: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') {
    throw new HarnessError('config.invalid', `配置字段 "${key}" 应为字符串`);
  }
  return v;
}

function readNumber(v: unknown, key: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new HarnessError('config.invalid', `配置字段 "${key}" 应为有限数字`);
  }
  return v;
}
