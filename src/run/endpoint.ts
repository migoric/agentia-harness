import { DEFAULT_PRICING } from '@migor/agentia';
import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';

/**
 * 端点 —— 把配置里的 `endpoint` 段接到 agentia 实际读的地方。
 *
 * **为什么要走环境变量而不是注入 client**：agentia 的默认客户端是**每次 run 现造**的
 * （技能子循环、RSI 提案器各造各的），构造参数只有 `apiKey` / `baseURL` 两个来源：
 * 显式传入，或环境变量。显式注入要求每个入口都把 client 传一遍，而子循环里的那个
 * 谁也传不进去 —— 于是「主 agent 走 DeepSeek、技能偷偷走官方端点」这种分裂会静默发生。
 * 进程环境变量是唯一一处**所有调用点都会读**的地方，所以在这里落地一次。
 *
 * 两条纪律（与 `loadEnvFile` 同款，别改）：
 * - **真实环境变量优先**：`process.env` 里已有值就不覆盖 —— 命令行 / CI / docker 的
 *   显式设置永远赢过配置文件的便利层；
 * - **只搬名字不搬值**：配置里存的是「key 在哪个环境变量里」（`apiKeyEnv`），值在 `.env`。
 *   配置文件是会被提交的。
 */

/** agentia 的默认客户端读的变量名（`integrations/anthropic.ts`） */
const AGENTIA_BASE_URL = 'ANTHROPIC_BASE_URL';
const AGENTIA_API_KEY = 'ANTHROPIC_API_KEY';

/**
 * 生效的端点摘要 —— 给人看的（`harness run --json` 与诊断输出）。
 * `keyFrom` 只写「从哪个变量取到了 key」，**永远不回显 key 本身**。
 */
export interface EndpointSummary {
  readonly baseURL: string;
  readonly keyFrom: string | null;
}

export function endpointSummary(config: HarnessConfig): EndpointSummary {
  return {
    baseURL: process.env[AGENTIA_BASE_URL] ?? config.baseURL ?? 'https://api.anthropic.com',
    keyFrom: keySource(config),
  };
}

/**
 * 把 `endpoint` 段落到环境变量上（**只填空位，不覆盖已有值**）。
 *
 * 名字里的 `ensure` 是契约，不是风格：这个函数有**三个必须成立的性质**，调用点
 * 越多越要守住 ——
 *
 * 1. **幂等**：调多少次结果一样。`createRunner`、`LlmProposer` 构造、CLI 入口各调
 *    一次是刻意的，不是重复劳动。
 * 2. **不覆盖**：`process.env` 里已经有值就不动。真实环境变量（命令行 / CI / docker）
 *    永远赢过配置文件的便利层。
 * 3. **进程级、只写一次**：这是它唯一的、已知的副作用。同进程里跑两个不同 `config`
 *    （多租户、并行测试）时**第一个赢** —— 想要两套端点就得起两个进程。这条写在这里
 *    是因为它不会自己报错：第二个 config 会安安静静地用上第一个的端点。
 *
 * 真正的解在上游：agentia 若支持显式注入 `baseURL` / `apiKey` 的 client 工厂，这里
 * 就不必碰环境变量。已作为上游诉求记着，不在本仓再绕一层。
 */
export function ensureEndpointEnv(config: HarnessConfig): void {
  if (process.env[AGENTIA_BASE_URL] === undefined && config.baseURL !== undefined) {
    process.env[AGENTIA_BASE_URL] = config.baseURL;
  }
  if (process.env[AGENTIA_API_KEY] === undefined) {
    const k = process.env[config.apiKeyEnv];
    if (k !== undefined && k !== '') process.env[AGENTIA_API_KEY] = k;
  }
}

/**
 * key 从哪儿来：`null` = 一个都没有。
 *
 * 顺序就是客户端实际用的顺序（`ANTHROPIC_API_KEY` 先），所以这个函数和
 * `ensureEndpointEnv` 必须保持一致 —— 否则「诊断说没有 key」而「请求却带着 key 出去了」。
 */
function keySource(config: HarnessConfig): string | null {
  if (nonEmpty(process.env[AGENTIA_API_KEY])) return AGENTIA_API_KEY;
  if (nonEmpty(process.env[config.apiKeyEnv])) return config.apiKeyEnv;
  // 两者同名的情形在上面第二条已经覆盖；这里只剩「都没设」
  return null;
}

function nonEmpty(v: string | undefined): boolean {
  return v !== undefined && v.trim() !== '';
}

/**
 * 开跑之前就拦住「没有 key」。
 *
 * 为什么不等 401：第一次模型调用失败时，harness 报的是**上游**的错误（`stopReason:
 * error`），人会先去怀疑端点、模型名、网络 —— 而真正的病因是 `.env` 里少一行。
 *
 * **豁免的边界是「显式配了 baseURL」而不是「apiKeyEnv 是缺省值」**。这两条看着等价，
 * 差别在新工程上：`harness init` 只写 `appName`，于是 `apiKeyEnv` 取缺省
 * `ANTHROPIC_API_KEY`、`baseURL` 为空 ⇒ 请求发往官方端点，没有 key **必然**失败。
 * 按「apiKeyEnv 是缺省值就放行」来写，这个最常见的新手路径会被直接放过去，
 * 最后以 403 `Request not allowed` 的身份出现（上游的错误和本地缺配置长得不像）。
 *
 * 反过来，`baseURL` 给了、`apiKeyEnv` 没声明，正是假端点/自建端点的形态
 * （`npm run e2e:offline` 用的就是它，那里不需要 key）—— 这条豁免保留。
 */
export function assertEndpointKey(config: HarnessConfig): void {
  if (keySource(config) !== null) return;
  if (config.baseURL !== undefined && config.apiKeyEnv === AGENTIA_API_KEY) return;
  const missing =
    config.apiKeyEnv === AGENTIA_API_KEY
      ? `缺少模型凭据：${config.apiKeyEnv} 没有值。`
      : `缺少模型凭据：${config.apiKeyEnv} 没有值（也没有 ANTHROPIC_API_KEY 兜底）。`;
  const where =
    config.apiKeyEnv === AGENTIA_API_KEY
      ? `在 ${config.root}/.env 里写一行 ${config.apiKeyEnv}=sk-... 即可；` +
        '要用别的模型或端点，在 harness.config.json 加 endpoint.baseURL 与 endpoint.apiKeyEnv。'
      : `在 ${config.root}/.env 里写一行 ${config.apiKeyEnv}=sk-... 即可 —— ` +
        '真实环境变量优先，两者都没有才报这个错。';
  throw new HarnessError('config.invalid', `${missing}${where}`);
}

/**
 * 「这个模型没有单价」的提示；有单价时返回 `undefined`。
 *
 * 为什么必须说出来：未定价的后果是**静默失效**的三件事 —— 报告里不出现 `$`、
 * 回归门的成本判据退回 token、`rsi --max-cost` 不生效。三件都不报错，只是「少了个数字」，
 * 而人会以为那是「这次跑得便宜」。
 *
 * 模型名取**生效值**（配置 > agent 资产 > agentia 缺省），由调用方传进来：本函数
 * 不认识资产层，而算错模型名等于给出错误的诊断。
 */
export function unpricedHint(config: HarnessConfig, model: string): string | undefined {
  if (Object.hasOwn(DEFAULT_PRICING, model)) return undefined;
  if (Object.hasOwn(config.pricing, model)) return undefined;
  return (
    `模型 "${model}" 不在价格表里 —— 成本读数为「未知」：报告里不会出现 $，` +
    '回归门的成本判据退回 token，RSI 的 --max-cost 不会生效。' +
    `要启用：在 harness.config.json 加 "pricing": { "${model}": { "in": 0.15, "out": 0.6 } }（$/1M token）。`
  );
}
