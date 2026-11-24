import type { RunOutcome } from '../run/runner.js';
import { toolInvocations } from './tool-events.js';
import type { EvalCase } from './types.js';

/**
 * 断言引擎 —— 用例的判定标准，**纯函数**：给一个用例与一次运行结果，返回失败原因列表。
 *
 * 从 `run.ts` 抽出来的理由不是行数，是**变化原因不同**：`run.ts` 管「跑」，这里管
 * 「算不算过」。加一类断言不该碰到超时、重试、并发、成本折算这些执行细节；反过来，
 * 改执行语义也不该有机会顺手改判定（那正是 RSI 最怕的一类静默漂移）。
 *
 * 全部是规则式判定，没有一条依赖模型 —— 裁判不确定，RSI 就会把随机波动当进步。
 */
export function check(c: EvalCase, out: RunOutcome): string[] {
  const f: string[] = [];
  // 只在这一轮真的需要过程类断言时才扫 trace —— 多数用例只看文本
  const needsTools =
    c.expect.tools !== undefined ||
    c.expect.toolCounts !== undefined ||
    (c.expect.toolArgs?.length ?? 0) > 0;
  const invocations = needsTools ? toolInvocations(out.trace) : [];
  const wantOk = c.expect.ok ?? true;
  if (wantOk && !out.ok) {
    f.push(
      out.failedTurn === undefined
        ? `期望正常收尾，实际 stopReason=${out.stopReason}`
        : `第 ${out.failedTurn} 轮非正常收尾（stopReason=${out.stopReason}），后续轮次已中止`,
    );
  }
  if (!wantOk && out.ok) {
    f.push('期望非正常收尾，实际正常收尾');
  }
  for (const s of c.expect.contains ?? []) {
    if (!out.text.includes(s)) f.push(`正文缺少 "${s}"`);
  }
  for (const s of c.expect.notContains ?? []) {
    if (out.text.includes(s)) f.push(`正文不该出现 "${s}"`);
  }
  if (c.expect.matches !== undefined) {
    // 正则在加载期已经校验过一次（`load.ts` 的坏正则当场退出 2），这里不再兜
    const re = new RegExp(c.expect.matches);
    if (!re.test(out.text)) f.push(`正文不匹配 /${c.expect.matches}/`);
  }
  if (c.expect.tools !== undefined && c.expect.tools.length > 0) {
    const seq = invocations.map((i) => i.tool);
    if (!isSubsequence(c.expect.tools, seq)) {
      f.push(
        `工具序列不符：期望 ${c.expect.tools.join(' → ')}，实际 ${seq.join(' → ') || '（无调用）'}`,
      );
    }
  }
  if (c.expect.toolCounts !== undefined) {
    const actual = countTools(invocations);
    for (const [tool, want] of Object.entries(c.expect.toolCounts)) {
      const got = actual.get(tool) ?? 0;
      if (got !== want) f.push(`工具 "${tool}" 调用 ${got} 次，期望恰好 ${want} 次`);
    }
  }
  for (const a of c.expect.toolArgs ?? []) {
    const hit = invocations.some((i) => i.tool === a.tool && i.input.includes(a.substring));
    if (!hit) {
      f.push(`工具 "${a.tool}" 的入参里没有 "${a.substring}"`);
    }
  }
  for (const s of c.expect.skills ?? []) {
    if (!out.skills.includes(s)) {
      f.push(`没有命中技能 "${s}"（实际：${out.skills.join(', ') || '无'}）`);
    }
  }
  if (c.expect.maxTokens !== undefined && out.tokens > c.expect.maxTokens) {
    f.push(`token 超预算：${out.tokens} > ${c.expect.maxTokens}`);
  }
  if (c.expect.maxIterations !== undefined && out.iterations > c.expect.maxIterations) {
    f.push(`轮数超预算：${out.iterations} > ${c.expect.maxIterations}`);
  }
  return f;
}

function countTools(invocations: readonly { tool: string }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const i of invocations) out.set(i.tool, (out.get(i.tool) ?? 0) + 1);
  return out;
}

/** 子序列匹配：允许中间夹别的调用（「先查再改」不该被无关调用判失败） */
function isSubsequence(need: readonly string[], seq: readonly string[]): boolean {
  let i = 0;
  for (const s of seq) {
    if (need[i] === s) i++;
    if (i === need.length) return true;
  }
  return i === need.length;
}
