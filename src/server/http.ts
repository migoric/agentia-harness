import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HarnessError, type HarnessErrorCode } from '../errors.js';

/**
 * HTTP 面的**传输细节**：状态码映射、鉴权、请求体读取、JSON 响应、内部错误落日志。
 *
 * 与 `serve.ts`（路由与执行编排）分开，是因为两者变化原因不同：这里改的是「协议怎么
 * 表达」（加错误码、换状态码、加限流头），`serve.ts` 改的是「请求怎么被执行」（串行、
 * 排队、超时、关闭）。此前它们在一个 410 行的文件里，已经撞上「单文件 ≤400 行」的守卫。
 */

/** 请求超时的哨兵值（与 `RunOutcome` 区分开，避免「模型返回了一个长得像超时的结果」） */
export const TIMED_OUT: unique symbol = Symbol('timed-out');

/**
 * 错误码 → HTTP 状态。
 *
 * 写成**穷尽的表**而不是 if 链，是为了让「新增错误码」这件事无法静默通过：
 * `Record<HarnessErrorCode, number>` 缺一个键就编译不过，作者必须当场决定
 * 「这对调用方意味着什么」。此前默认落 422，最容易出的错是把「你的请求不合法」
 * （400，该改请求）报成「业务处理失败」（422，别重试）—— 这两者对客户端的
 * 处置建议完全相反。
 *
 * 状态码的选择口径：
 * - **4xx 客户端可自救**：400 改请求 / 409 换状态再来 / 413 截断 / 429 等一会儿；
 * - **5xx 换谁都没用**：配置错、资产坏、锁不匹配 —— 这类是部署问题，
 *   把 5xx 变成 4xx 只会让调用方以为是自己写错了。
 */
export const STATUS_BY_CODE: Readonly<Record<HarnessErrorCode, number>> = {
  // —— 客户端请求本身不合法：改请求就能过
  'run.bad_request': 400,
  'code.invalid': 400,
  'run.payload_too_large': 413,
  // —— 状态/流程不允许：同样的请求换个时刻可能就成
  'rsi.gate_blocked': 409,
  'rsi.no_baseline': 409,
  // 记录坏了要先看一眼（盘上可能有个没被验证的提示词）—— 重试不会变好
  'rsi.bad_record': 409,
  'code.unapproved': 409,
  'code.conflict': 409,
  // —— 执行了但结果不达标：改请求没用，得改代码/改用例
  'run.failed': 422,
  'code.verify_failed': 422,
  // —— 服务端自己的问题：配置、资产、数据完整性
  'config.invalid': 500,
  'asset.missing': 500,
  'asset.invalid': 500,
  'lock.mismatch': 500,
  'eval.invalid': 500,
  'rsi.no_signal': 500,
};

/** 异常 → 状态码。未分类异常一律 500（它的 message 也不回显，见 `serve.ts`） */
export function statusOf(e: unknown): number {
  return e instanceof HarnessError ? STATUS_BY_CODE[e.code] : 500;
}

/**
 * 从环境变量名解析出 key。
 *
 * 三条都是刻意的：
 * - 没配 `apiKeyEnv` ⇒ `undefined`（只服务回环），这是本地开发的常态；
 * - 配了但变量不存在/是空白 ⇒ **抛错**，因为「配了闸却没有闸」比不配更危险；
 * - 值只进闭包，不进日志、不进 `ServerOptions` 的可打印字段。
 */
export function resolveKey(envName: string | undefined): string | undefined {
  if (envName === undefined) return undefined;
  const key = process.env[envName]?.trim() ?? '';
  if (key === '') {
    throw new HarnessError(
      'config.invalid',
      `配置了 server.apiKeyEnv="${envName}" 但该环境变量是空的 —— ` +
        '空 key 会被当成「不用鉴权」，所以这里直接拒绝启动',
    );
  }
  return key;
}

/**
 * 请求有没有资格进来。
 *
 * 两种模式互斥：配了 key 就只认 Bearer；没配就只认回环来源。**不存在**「两个条件
 * 任一满足」。混合判定会在「配了 key 却忘了转发头」时静默放行本机代理，而代理后面
 * 往往就是整个内网。
 */
export function authorized(req: IncomingMessage, key: string | undefined): boolean {
  if (key === undefined) return isLoopback(req.socket.remoteAddress);
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match !== null && sameKey(match[1]?.trim() ?? '', key);
}

export function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false;
  // IPv4-mapped IPv6（::ffff:127.0.0.1）是 Node 在双栈监听时的常见形态
  const a = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return a === '::1' || /^127\./.test(a);
}

/** 定长比较：逐字节 `===` 会按「第一个不同字节」提前返回，把 key 的长度与前缀泄给计时 */
export function sameKey(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 读请求体并解析成对象，**有字节上限**。
 *
 * 三种坏输入三条码，别混：
 * - 太大 ⇒ `run.payload_too_large` / 413（截断重发还是改格式，客户端能自己决定）；
 * - 不是 JSON、或 JSON 但不是一个对象 ⇒ `run.bad_request` / 400（该改请求）；
 * - 空体 ⇒ `{}`（调用方随后会因为缺 `task` 拿到 400，文案更准）。
 *
 * 合法 JSON 但不是对象（`"abc"` / `[1]` / `null`）此前被静默收成 `{}`，
 * 调用方只看到「缺 task 字段」—— 而真正的原因是他发的根本不是对象。
 */
export async function readJson(
  req: IncomingMessage,
  limit: number,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const buf = Buffer.from(c);
    size += buf.length;
    if (size > limit) {
      throw new HarnessError('run.payload_too_large', `请求体超过 ${limit} 字节上限`);
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HarnessError('run.bad_request', '请求体不是合法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HarnessError('run.bad_request', '请求体必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

/** 未分类异常落 stderr（一行 JSON，便于被日志采集直接吞） */
export function logInternal(url: string, method: string, e: unknown): void {
  const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
  console.error(JSON.stringify({ level: 'error', at: 'harness.server', method, url, detail }));
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}
