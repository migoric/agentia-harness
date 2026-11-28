import type { HarnessConfig } from '../config.js';

/**
 * `harness run` 失败时的两段人话：**发生了什么**，以及**你现在该改什么**。
 *
 * 为什么单独成一个模块：这两段此前只存在于 `--json` 输出里（`error` 字段），
 * 于是一个不用脚本的人拿到的是「空正文 + 一行 `[error] 0 token`」—— 信息在，
 * 但只对写脚本的人可见。把它们抽出来是为了能单独喂进测试，不必起子进程。
 */
export interface RunErrorShape {
  readonly type: string;
  readonly message: string;
}

/**
 * 把 `{type, message}` 压成一行能读的话。
 *
 * 上游报文的常见形态是 `「Anthropic 请求失败（HTTP 403）：{ ...JSON... }」`——那句
 * JSON 里的 `error.message` 才是人要看的东西（`Request not allowed`），外面那层是
 * 我们自己的壳。原样打印会得到四行花括号，人读到第三行就不读了。
 *
 * 解析失败时**退回原文**而不是猜：报文被截断时，残缺的原文也比编出来的摘要可信。
 */
export function formatError(error: RunErrorShape): string {
  const message = error.message.trim();
  const braceAt = message.indexOf('{');
  if (braceAt !== -1) {
    const head = message.slice(0, braceAt).trim();
    try {
      const body = JSON.parse(message.slice(braceAt)) as { error?: { message?: unknown } };
      const inner = body.error?.message;
      if (typeof inner === 'string' && inner !== '') {
        return `${error.type}: ${head === '' ? inner : `${head.replace(/[：:]\s*$/, '')}：${inner}`}`;
      }
    } catch {
      // 不是完整 JSON —— 落到下面返回原文
    }
  }
  return `${error.type}: ${message}`;
}

/**
 * 401/403 且**工程没配端点**时的可操作提示。
 *
 * 这是 `harness init` 之后最可能撞上的一堵墙：模板只写 `appName`，于是模型取 agentia
 * 的缺省值、端点取官方 Anthropic，而 `assertEndpointKey` 对 `ANTHROPIC_API_KEY`
 * 是放行的（老工程只认环境变量的兼容路径）。结果是一个新工程必然失败，而报错里
 * 完全看不出「你还没选模型」。**上游的错误和本地配置的缺失长得不像**，这一段就是
 * 把后者翻译成前者。
 *
 * 只在「没配 `baseURL`」时提示：配了端点还 401/403，那是 key 本身的问题，
 * 该去查账号，而不是再被劝一遍去配已经配好的东西。
 */
export function authHint(error: RunErrorShape, config: HarnessConfig): string | undefined {
  if (!/HTTP (401|403)/.test(error.message)) return undefined;
  if (config.baseURL !== undefined) return undefined;
  return (
    '这多半不是账号问题：工程里没有配 `endpoint`，所以请求发去了 agentia 的缺省端点（官方 Anthropic）。\n' +
    'harness.config.json 加两段即可（`model` 选你要用的，`apiKeyEnv` 只写变量名）：\n' +
    '  "model": "<模型名>",\n' +
    '  "endpoint": { "baseURL": "<Anthropic 兼容地址>", "apiKeyEnv": "<KEY_ENV_NAME>" }\n' +
    '然后在 .env 写一行 <KEY_ENV_NAME>=sk-...；用非 Anthropic 模型时记得补 "pricing"，否则成本读数是「未知」。'
  );
}
