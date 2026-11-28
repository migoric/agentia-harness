import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { type ModelPrice, readPricing } from './config-pricing.js';
import type { RemoteConfig } from './config-remote.js';
import { readRemote } from './config-remote.js';
import { HarnessError } from './errors.js';
import { type Fail, isPlainObject, objectAt, onlyKeys, readJsonObject } from './util/shape.js';

export type { ModelPrice } from './config-pricing.js';
export type { RemoteConfig } from './config-remote.js';

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
/**
 * 「这个工程的文件在哪儿」—— 纯路径，没有一处运行时语义。
 *
 * 单独成一个值对象，是因为**读路径的模块不该拿到模型与预算的旋钮**：此前 21 个
 * config 消费者里有 18 个只用到 1–3 个字段（平均 1.4 个），而它们拿到的是一整个
 * 20 字段的对象 —— 于是「这个模块依赖哪些配置」在类型上无法回答，新增字段也会无声
 * 扩散到所有持有 config 的模块。`HarnessConfig extends WorkspacePaths`，所以调用方
 * 照旧传整个 config，收窄只发生在**被调方**。
 */
export interface WorkspacePaths {
  readonly root: string;
  readonly skillsDir: string;
  readonly agentsDir: string;
  readonly evalsDir: string;
  readonly lockPath: string;
  /** 运行时产物根（trace / 跑分 / 提案），默认 `.workspace/` */
  readonly workspaceDir: string;
  readonly tracesPath: string;
}

/**
 * 报告目录（`<workspace>/reports`）。写侧 `eval --save` 与读侧看板共用这一个函数 ——
 * 两侧各拼一次路径的结果是「刚跑完评测，看板 0 份报告」，且两边都不报错。
 */
export function reportsDir(p: WorkspacePaths): string {
  return join(p.workspaceDir, 'reports');
}

/** 「用哪个模型、花多少钱」—— 与路径无关的另一组旋钮 */
export interface ModelSettings {
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
}

/**
 * Harness —— 工程配置（= 路径 + 模型设置 + 装配/服务面）。
 *
 * 约定优于配置：不写 `harness.config.json` 也能跑（全部落缺省目录）。写了的字段
 * 才覆盖 —— 这与仓库里「显式 undefined 与不传不同」的口径一致，所以 `readConfig`
 * 只认**出现过的键**。
 *
 * 所有路径在返回前都解析成绝对路径：CLI 的工作目录由用户决定，配置里存相对路径
 * 是合理的，但代码里不再做第二次拼接。
 */
export interface HarnessConfig extends WorkspacePaths, ModelSettings {
  /** 远程服务接线；缺席 = 只能本地评测，`rsi --remote` 会被拒 */
  readonly remote?: RemoteConfig;
  readonly appName: string;
  /**
   * L2（代码补丁）的验证命令，缺省 `['npm', 'test']`。
   *
   * 存成数组而不是字符串：字符串要过 shell，而 shell 会把「参数里带空格」和
   * 「多个命令」混成一个不可控的东西 —— 沙箱里跑的东西越简单越可信。
   */
  readonly codeVerify: readonly string[];
  /** 验证命令的超时（毫秒），缺省 10 分钟 */
  readonly codeVerifyTimeoutMs: number;
  /**
   * 装 HTTP 服务鉴权 key 的**环境变量名**（`server.apiKeyEnv`）。
   *
   * 缺席 = 只在回环地址上接受请求（本地开发、单机脚本的常态）。一旦对外监听，
   * 必须配它 —— 「没配 key 但绑了 0.0.0.0」是唯一会让一个评测基座变成公开
   * 烧钱接口的组合，所以 `serve` 在这种情况下拒绝启动，而不是警告一句继续跑。
   */
  readonly serverApiKeyEnv: string | undefined;
  /**
   * HTTP 服务的队列上限（含正在跑的那一个），超了返回 429。
   *
   * 没有上限的队列等于没有反压：请求照收、内存照涨、调用方拿到的是越来越长的
   * 等待而不是「现在别来」。缺省 8 —— 串行执行下的排队深度，超过它延迟已经不可用。
   */
  readonly serverMaxQueue: number;
}

export const CONFIG_FILENAME = 'harness.config.json';

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
  server?: unknown;
  remote?: unknown;
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
  'server',
  'remote',
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
    ...readServer(raw.server),
    ...readRemote(raw.remote, absRoot),
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
  return { baseURL: url, apiKeyEnv: envNameOf(envName, 'endpoint.apiKeyEnv') };
}

/**
 * 「值应该是环境变量名」这一条只有一个实现。
 *
 * 两个地方要它（模型端点的 key、HTTP 服务的 key），而**把 key 本身填进配置文件**
 * 是同一个错，配错后的症状也一样（配置会被提交，密钥进 git）。分开写会漂移成
 * 「一边拦一边放」，所以共用这一处。
 */
function envNameOf(value: string, where: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new HarnessError(
      'config.invalid',
      `配置字段 "${where}" 应填**环境变量名**（如 DEEPSEEK_API_KEY），` +
        `key 本身放 .env（收到 "${value}"）`,
    );
  }
  return value;
}

const SERVER_DEFAULTS = { maxQueue: 8 } as const;

/**
 * `server` 段：HTTP 面的两道闸。
 *
 * 都是**上线前才需要**的东西（本地回环跑不需要），所以缺席必须落到安全的缺省：
 * 不给 `apiKeyEnv` 就只服务回环地址；不给 `maxQueue` 就是 8。反过来（默认放行、
 * 默认无限排队）是那种平时看不出来、被扫到才发现的设计。
 */
function readServer(v: unknown): { serverApiKeyEnv: string | undefined; serverMaxQueue: number } {
  if (v === undefined) {
    return { serverApiKeyEnv: undefined, serverMaxQueue: SERVER_DEFAULTS.maxQueue };
  }
  const o = objectAt(v, '配置字段 "server"', fail);
  onlyKeys(o, '配置字段 "server"', ['apiKeyEnv', 'maxQueue'], fail);

  const raw = readString(o.apiKeyEnv, 'server.apiKeyEnv');
  const envName = raw === undefined ? undefined : envNameOf(raw, 'server.apiKeyEnv');

  const maxQueue = readNumber(o.maxQueue, 'server.maxQueue') ?? SERVER_DEFAULTS.maxQueue;
  if (!Number.isInteger(maxQueue) || maxQueue <= 0) {
    throw new HarnessError(
      'config.invalid',
      `配置字段 "server.maxQueue" 必须为正整数（收到 ${String(o.maxQueue)}）—— 0 会让所有请求都被拒`,
    );
  }
  return { serverApiKeyEnv: envName, serverMaxQueue: maxQueue };
}

/** `pricing` 段：每条都要有 `in` / `out` 两个非负有限数，键名只认那四个 */
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
