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
  /** 没有可用于对比的基准（没采纳过 / 找不到那次验证记录）—— 属于「用错/没准备好」 */
  | 'rsi.no_baseline'
  | 'run.failed'
  /** 请求体超上限（HTTP 面映射到 413） */
  | 'run.payload_too_large'
  /** 补丁本身不合法（空、二进制、路径逃逸、删文件） */
  | 'code.invalid'
  /** 沙箱验证没通过（测试挂了 / 超时 / 补丁应用不上） */
  | 'code.verify_failed'
  /** 落盘需要人工审批 —— 与「验证失败」区分：这条是流程要求，不是结果 */
  | 'code.unapproved'
  /** 工作区有本地改动 / 回滚前指纹不匹配（会覆盖别人的修改） */
  | 'code.conflict';

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
