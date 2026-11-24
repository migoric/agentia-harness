/**
 * 回滚理由的**写与读，同处一地**。
 *
 * 落盘时写成 `回滚了 p-xxx（原采纳理由：…）`；账本要把它渲染成教训时得**解析**这段括号。
 * 此前生成在 `accept.ts` 与 `rsi/code/apply.ts` 各一份、解析在 `ledger.ts` 一份 ——
 * 三处共同依赖一个**字符串格式**，而它不在任何接口里（典型的后门泄漏，见 AGENTS.md
 * 「同一份事实两处各写一遍」）。改一次格式（多一个空格、把全角括号换成破折号），解析就
 * 静默失配：`revertNote()` 落回原样，提示词里出现「采纳后又被回滚：修好 1 条（a）」——
 * 把**当初的成功理由**当成了回滚原因，而没有任何测试会红。
 *
 * 两个函数必须一起改：这就是它们住在同一个文件里的理由。
 */

/**
 * 回滚理由的统一前缀 —— 生成与**识别**共用这一个常量。
 *
 * 前缀也是契约的一部分：2026-11-22 之前的 code 回滚条目没有 `reverted` 字段，
 * 「这条记录是不是回滚」只能靠它认。它若散落在读取方（ledger 曾字面量复制一份），
 * 改前缀就是又一处静默失配 —— 与括号格式同款的后门泄漏，所以一起收进本文件。
 */
const REVERT_PREFIX = '回滚了 ';

/** 生成落盘用的回滚理由（`accept.ts` 与 `code/apply.ts` 共用） */
export function revertNoteOf(proposalId: string, acceptedReason: string): string {
  return `${REVERT_PREFIX}${proposalId}（原采纳理由：${acceptedReason}）`;
}

/**
 * 这条 journal 记录是不是一次**回滚动作**（区别于「被门拒的提案」—— 两者都记
 * `status: 'rejected'`）。新记录看 `reverted` 字段；没有这个字段的老 code 回滚
 * 靠前缀兜底。判定只有这一处：`liveAccepted` 与账本都从这里读。
 */
export function isRevertEntry(e: {
  readonly reverted?: boolean | undefined;
  readonly reason: string;
}): boolean {
  return e.reverted === true || e.reason.startsWith(REVERT_PREFIX);
}

/**
 * 把回滚条目的 journal reason 改写成能进提示词的一句话。
 *
 * 括号里是**当初采纳**的理由，不是回滚原因 —— `rsi revert` 是人工决定，不记原因。
 * 原样塞进教训会读成「修好 1 条」是被回滚的理由，所以这里改写成「人工回滚 + 当初的理由」。
 */
export function revertNote(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const m = /（原采纳理由：(.*)）$/s.exec(reason);
  return m?.[1] === undefined
    ? reason
    : `人工回滚，回滚记录没写原因（当初的采纳理由是「${m[1]}」）`;
}
