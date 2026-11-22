import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { HarnessError } from './errors.js';
import { type Fail, isPlainObject, objectAt, onlyKeys, readJsonObject } from './util/shape.js';

// ⚠️ 必须**注解在变量上**（`const fail: Fail`）而不是只注解箭头函数的返回类型：
// TS 的「never 返回 ⇒ 后续分支已收敛」只认「变量有显式类型」的那种声明，否则
// `if (!isPlainObject(v)) fail(…)` 之后 `v` 仍是 unknown（类型守卫白写）。
const fail: Fail = (message, cause) => {
  throw new HarnessError('config.invalid', message, cause);
};

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
   * Anthropic 兼容端点的 baseURL（`endpoint.baseURL`）；不给就完全交给环境变量
   * （`ANTHROPIC_BASE_URL` → 官方端点）。
   *
   * 放配置而不是只认 env 的理由：**「这个工程连的是哪个端点」是可提交、可 review 的
   * 事实**（换模型时同一份 diff 里能看见），而 key 不是。
   */
  readonly baseURL: string | undefined;
  /**
   * 装 API key 的**环境变量名**（`endpoint.apiKeyEnv`），缺省 `ANTHROPIC_API_KEY`。
   *
   * 配置里只写名字，值放 `.env` —— 这个文件会被提交，密钥不会。
   */
  readonly apiKeyEnv: string;
  /**
   * 价格表追加/覆盖（`pricing` 段，$/1M token）。
   *
   * 不给非 Anthropic 模型定价的后果是**静默**的：`costEstimate` 变成 `undefined`，
   * 回归门的成本判据退回 token、`rsi --max-cost` 不生效。`run` 与 `eval` 都会在
   * 没有读数时明确说出来（见 `run/endpoint.ts` 的 `unpricedHint`）。
   */
  readonly pricing: Readonly<Record<string, ModelPrice>>;
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

/**
 * 一条单价（对齐 agentia 的 `ModelPricing`，但**不 import** 它：配置文件层不认识
 * 运行时）。字段含义逐条对齐，差一个都算配置错——
 *
 * - `in` / `out`：$/1M token，**绝对价**；
 * - `cacheRead` / `cacheWrite`：相对 `in` 的**乘数**（不是绝对价！），缺省 0.1 / 1.25。
 *   这条最容易配错：DeepSeek 缓存读 $0.003/1M、输入 $0.15/1M ⇒ 乘数是 `0.02`，不是 `0.003`。
 */
export interface ModelPrice {
  readonly in: number;
  readonly out: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

const PRICE_KEYS: readonly string[] = ['in', 'out', 'cacheRead', 'cacheWrite'];

const DEFAULTS = {
  skillsDir: 'skills',
  agentsDir: 'agents',
  evalsDir: 'evals',
  workspaceDir: '.workspace',
  appName: 'harness',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
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
  endpoint?: unknown;
  pricing?: unknown;
}

/** 顶层键白名单：拼错一个键（如 `modle`）静默吃缺省是最难查的一类错 */
const CONFIG_KEYS: readonly string[] = [
  'skills',
  'agents',
  'evals',
  'workspace',
  'appName',
  'model',
  'maxIterations',
  'maxCostUsd',
  'code',
  'endpoint',
  'pricing',
];

export function loadConfig(root: string): HarnessConfig {
  const absRoot = resolve(root);
  const cfgPath = join(absRoot, CONFIG_FILENAME);
  const raw: RawConfig = existsSync(cfgPath) ? readJson(cfgPath) : {};
  onlyKeys(raw, CONFIG_FILENAME, CONFIG_KEYS, fail);

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
    maxIterations: positiveNumber(raw.maxIterations, 'maxIterations'),
    maxCostUsd: positiveNumber(raw.maxCostUsd, 'maxCostUsd'),
    pricing: readPricing(raw.pricing),
    ...readEndpoint(raw.endpoint),
    ...readCode(raw.code),
  };
}

/**
 * `endpoint` 段：形状错就炸。
 *
 * 只校验「能立刻证伪」的形态（协议、空白、环境变量名形状），不去猜端点能不能用 ——
 * 那是第一次真实调用的活。多拦一层「看起来像 URL 但不是」的价值在于：错在这里
 * 会以 `config.invalid`（退出码 2）出现，而错在 `fetch` 里会以「模型调用失败」出现，
 * 后者要花一轮 token 才看得见。
 */
function readEndpoint(v: unknown): { baseURL: string | undefined; apiKeyEnv: string } {
  if (v === undefined) {
    return { baseURL: undefined, apiKeyEnv: DEFAULTS.apiKeyEnv };
  }
  const o = objectAt(v, '配置字段 "endpoint"', fail);
  onlyKeys(o, '配置字段 "endpoint"', ['baseURL', 'apiKeyEnv'], fail);

  const url = readString(o.baseURL, 'endpoint.baseURL');
  if (url !== undefined) {
    if (!/^https?:\/\//i.test(url) || /\s/.test(url)) {
      throw new HarnessError(
        'config.invalid',
        `配置字段 "endpoint.baseURL" 应是 http(s) 地址（收到 "${url}"）`,
      );
    }
  }
  const envName = readString(o.apiKeyEnv, 'endpoint.apiKeyEnv');
  if (envName === undefined) return { baseURL: url, apiKeyEnv: DEFAULTS.apiKeyEnv };
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
    throw new HarnessError(
      'config.invalid',
      `配置字段 "endpoint.apiKeyEnv" 应填**环境变量名**（如 DEEPSEEK_API_KEY），` +
        `key 本身放 .env（收到 "${envName}"）`,
    );
  }
  return { baseURL: url, apiKeyEnv: envName };
}

/** `pricing` 段：每条都要有 `in` / `out` 两个非负有限数，键名只认那四个 */
function readPricing(v: unknown): Readonly<Record<string, ModelPrice>> {
  if (v === undefined) return {};
  if (!isPlainObject(v)) fail('配置字段 "pricing" 应为 { 模型名: { in, out } } 对象');
  const out: Record<string, ModelPrice> = {};
  for (const [model, raw] of Object.entries(v)) {
    const where = `pricing["${model}"]`;
    if (model.trim() === '') {
      throw new HarnessError('config.invalid', '配置字段 "pricing" 里有空模型名');
    }
    if (!isPlainObject(raw)) fail(`${where} 应为 { in, out } 对象`);
    onlyKeys(raw, where, PRICE_KEYS, fail);
    const e = raw;
    out[model] = {
      in: priceOf(e.in, where, 'in'),
      out: priceOf(e.out, where, 'out'),
      ...(e.cacheRead === undefined ? {} : { cacheRead: priceOf(e.cacheRead, where, 'cacheRead') }),
      ...(e.cacheWrite === undefined
        ? {}
        : { cacheWrite: priceOf(e.cacheWrite, where, 'cacheWrite') }),
    };
  }
  return out;
}

function priceOf(v: unknown, where: string, key: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    const detail =
      key === 'cacheRead' || key === 'cacheWrite'
        ? '（cacheRead / cacheWrite 是相对 in 的**乘数**，不是绝对价）'
        : '（$/1M token）';
    throw new HarnessError('config.invalid', `${where}.${key} 应为非负有限数${detail}`);
  }
  return v;
}

const CODE_DEFAULTS = {
  verify: ['npm', 'test'] as readonly string[],
  timeoutMs: 600_000,
};

/** `code` 段：形状错就炸（配置错必须响亮，否则会以「验证永远失败」的形式出现） */
function readCode(v: unknown): { codeVerify: readonly string[]; codeVerifyTimeoutMs: number } {
  if (v === undefined) {
    return { codeVerify: CODE_DEFAULTS.verify, codeVerifyTimeoutMs: CODE_DEFAULTS.timeoutMs };
  }
  const o = objectAt(v, '配置字段 "code"', fail);
  onlyKeys(o, '配置字段 "code"', ['verify', 'timeoutMs'], fail);
  const { verify, timeoutMs } = o;
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
  // 三步（读 / 解析 / 顶层是对象）与锁文件、手写提案同一份实现，见 util/shape.ts
  return readJsonObject(path, fail) as RawConfig;
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

/**
 * 预算 / 步数必须是正数：`0` 和负数在 agentia 里是「不设上限」而不是「一步都不能走」，
 * 写错的后果是护栏静默消失 —— 那比没有护栏更糟，因为报告里看不出来。
 */
function positiveNumber(v: unknown, key: string): number | undefined {
  const n = readNumber(v, key);
  if (n !== undefined && n <= 0) {
    throw new HarnessError('config.invalid', `配置字段 "${key}" 必须为正数（收到 ${n}）`);
  }
  return n;
}
