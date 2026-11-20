/**
 * Harness —— 统一错误形状。
 *
 * 这里的每个 `code` 都是**可以被程序判断**的（RSI 闭环要靠它区分「该重试」和
 * 「该停下来找人」），所以不允许抛出裸 `Error`：裸 Error 只能靠 message 匹配，
 * 一改文案判定就失效。
 */
export type HarnessErrorCode =
  | 'config.invalid'
  | 'asset.missing'
  | 'asset.invalid'
  | 'lock.mismatch'
  | 'eval.invalid'
  | 'rsi.no_signal'
  | 'rsi.gate_blocked'
  | 'run.failed';

export class HarnessError extends Error {
  readonly code: HarnessErrorCode;
  readonly detail: unknown;

  constructor(code: HarnessErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = 'HarnessError';
    this.code = code;
    this.detail = detail;
  }
}

export function isHarnessError(e: unknown): e is HarnessError {
  return e instanceof HarnessError;
}

/** 把任意抛出物转成可读一行（日志与 CLI 输出用，不吞栈） */
export function describeError(e: unknown): string {
  if (e instanceof HarnessError) return `[${e.code}] ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}
