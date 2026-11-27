import {
  MENU_HASH_ATTR,
  MENU_NAMES_ATTR,
  PROMPTS_VERSIONS_ATTR,
  type Span,
  type Trace,
} from '@migor/agentia';

/**
 * 从 trace 读「这次的**能力菜单**与**提示词资产版本**」—— 可比性判断的另外两半。
 *
 * 存在理由（2026-11-27）：`model-read.ts` 只回答了「换了模型没有」。但两份跑分不可比
 * 的病因不止一个，剩下两个恰好都写在 **run 根属性**上：
 *
 * - `tools.menuHash`：菜单签名（排序后的「名字 + 规范 schema」的 sha1 前 12 位）。
 *   **覆盖输入 schema**，所以「工具还在、签名变了」也判得出来；
 * - `tools.names`：同一份签名「给人读」的那一半 —— 变了的是哪一个；
 * - `prompts.versions`：`name@ver` 逗号串，@Prompt 资产的版本表。
 *
 * 为什么值得单独一件：通过率掉了 20pt 时，人问的第一个问题是「我改的那句话生效了吗」。
 * 没有这三个读数，答案只能靠回忆；而回忆错的方向是把「菜单里多了一个工具」读成
 * 「模型这轮不行」—— 归因错的结论比没有结论更贵。
 *
 * 三条读法（与 `modelUsage` 同一套纪律）：
 *
 * 1. **只在 run 根读**（`parentSpanId === null`）。子循环走 `runAgentScoped`，不开 run 根、
 *    不设根属性，所以不会把子菜单覆写到根上 —— 这也是上游把写入点钉在 `engine/loop.ts`
 *    的原因，本仓不需要另做过滤。
 * 2. **键缺席 ≠ 空串**。上游只在「菜单非空」「有带版本的 prompt 资产」时才写；
 *    缺席表示**没有**，不是「记了但为空」。所以这里返回 `undefined`，由报告层去分
 *    「整批都没有（合法的空）」与「有的有有的没有（不知道）」。
 * 3. **多轮用例合并后会有多个根**（`mergeTraces` 只是平铺）。同一个值写了几遍不算冲突；
 *    真出现**两个不同的值**说明这条用例跑到一半换了菜单 —— 那这条用例的差异无法归因到
 *    单一次改动，如实返回 `undefined`。
 */
export interface MenuFacts {
  /** 菜单摘要（`tools.menuHash`）；缺席 = 没挂工具，或这条用例的多个根互相矛盾 */
  readonly menuHash?: string | undefined;
  /** 菜单名单（`tools.names`，有界、给人读）；同上 */
  readonly menuNames?: string | undefined;
  /** 提示词资产版本表（`prompts.versions`）；缺席 = 菜单里没有带版本的 @Prompt 资产 */
  readonly promptVersions?: string | undefined;
}

export function menuFacts(trace: Trace): MenuFacts {
  const roots = trace.spans.filter((s): s is Span => s.parentSpanId === null);
  if (roots.length === 0) return {};
  const hash = agreed(roots, MENU_HASH_ATTR);
  const names = agreed(roots, MENU_NAMES_ATTR);
  const versions = agreed(roots, PROMPTS_VERSIONS_ATTR);
  return {
    ...(hash === undefined ? {} : { menuHash: hash }),
    ...(names === undefined ? {} : { menuNames: names }),
    ...(versions === undefined ? {} : { promptVersions: versions }),
  };
}

/**
 * 多个根对同一个键「说同一句话」才返回它。
 *
 * 三档语义刻意分开：全都没写 ⇒ `undefined`（没挂）；写了一遍或多遍相同 ⇒ 那个值；
 * **出现了两个不同的值** ⇒ `undefined`（这条用例自己内部就不一致，不能拿来判可比性）。
 * 后两档在返回值上长得一样，但调用方的动作一致（都当「不知道」），所以不必再多一个
 * 字段把它们分开 —— 真要区分的人去看 trace，那里两个值都在。
 */
function agreed(roots: readonly Span[], key: string): string | undefined {
  const values = new Set<string>();
  for (const span of roots) {
    const v = span.attributes[key];
    if (typeof v === 'string' && v !== '') values.add(v);
  }
  return values.size === 1 ? [...values][0] : undefined;
}
