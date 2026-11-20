/**
 * Harness —— L2（代码补丁）的数据模型。
 *
 * 为什么 L2 不复用 `AssetPatch`：文本资产的语义是「整段正文替换」，回滚就是写回
 * `before`；代码的语义是「对多个文件的增量修改」，回滚必须**反向应用同一个 diff**，
 * 而且要先确认这期间没人动过这些文件。两者的安全条件不同，共用一个结构会让其中
 * 一方永远带着多余（或缺失）的校验。
 */
export interface CodePatch {
  /** 原样保留的 unified diff（`git apply` 的输入） */
  readonly diff: string;
  /** diff 触及的仓库相对路径（按首次出现序，已去重） */
  readonly files: readonly string[];
}

/** 一个文件在补丁前后的指纹（`null` = 补丁前不存在，即新增文件） */
export interface CodeFileState {
  readonly path: string;
  readonly before: string | null;
  readonly after: string;
}

/**
 * 沙箱里跑验证命令的结果。
 *
 * `exitCode` 是 `number | null`：被信号杀死（超时）时没有退出码。**不要**把 null 当 0 ——
 * 「没跑完」不该看起来像成功，这是这道门唯一的正确读法。
 */
export interface CodeVerify {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly command: readonly string[];
  /** 输出尾部（最后 40 行 / 4000 字），失败时人要看的就是这一段 */
  readonly outputTail: string;
}

/** journal 里属于代码补丁的那一半 */
export interface CodeJournal {
  readonly diff: string;
  readonly files: readonly CodeFileState[];
  readonly verify: CodeVerify;
  /** 沙箱 worktree 的路径 —— 事后要能指出「在哪儿验的」 */
  readonly sandbox: string;
}
