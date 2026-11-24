/**
 * harness 要读、但 `@migor/agentia` **公共导出面没给**的 trace 事件名。
 *
 * 这些常量在上游真实存在（`core/trace.ts` 的 `TOOL_INPUT_EVENT` / `TOOL_OUTPUT_EVENT` /
 * `USAGE_MISSING_EVENT`；`llm.fallback` 是 `engine/turn.ts` 换环时写的），但都停在模块级：
 * `src/index.ts` 只导出 `attachScore` / `parseTraceparent` 一类，词汇表本身不外发。
 * 所以 harness 只能复制字面量 —— 上游改名会让读取**静默读到 0 条**。
 *
 * 集中成一个文件（而不是各模块自己写一份）的理由：字面量复制从 2 处变 3 处时，
 * 「改一处漏一处」的概率不再是线性的。防线仍是行为测试：
 * `tests/evals.test.ts` 用真实调用产生的 trace 断言工具序列非空，
 * `tests/model-read.test.ts` 断言降级事件被读到 —— 改名会立刻红。
 *
 * 上游把词汇表进 `index.ts` 之后，这个文件应当整体删除、改为 import：
 * 常量名与上游逐字相同，就是为了让那次改动是纯机械替换。
 */
export const TOOL_INPUT_EVENT = 'tool.input';
export const TOOL_OUTPUT_EVENT = 'tool.output';
export const USAGE_MISSING_EVENT = 'usage.missing';
/**
 * 换环事件：`{ from, to, errorType }`，写在**换到的那一环**第一个尝试的 turn span 上。
 *
 * 注意它的位置（`engine/turn.ts` 的 `streamTurn`）：不是在失败的 span 上，是在新 span 上。
 * 所以「这次降级是从谁换到谁」要读事件体，不能靠 span 相邻关系猜。
 */
export const LLM_FALLBACK_EVENT = 'llm.fallback';
/** 根 span 属性：声明过的 fallback 链（模型名逗号拼接）；没配时键缺席 */
export const CONFIG_FALLBACKS_ATTR = 'config.fallbacks';
