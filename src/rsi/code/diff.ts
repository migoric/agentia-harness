import { HarnessError } from '../../errors.js';
import type { CodePatch } from './types.js';

/**
 * 解析并**先**校验 unified diff。
 *
 * 为什么校验放在跑 git 之前：`git apply` 会老老实实按路径写文件，而路径来自
 * diff 文本 —— 一段 `../../.ssh/authorized_keys` 的补丁在沙箱里能过、在主树里就是
 * 任意写。这不是「多做一层防御」，是补丁通道**唯一**的边界检查点。
 *
 * 拒绝清单（每条都对应一种真实的坏输入）：
 * - 绝对路径 / 带 `..` 的路径 —— 逃出仓库；
 * - `GIT binary patch` 与 `Binary files ... differ` —— 二进制补丁的语义（base85 块）
 *   不在本层的校验能力内，静默放过等于让「验证过的补丁」与「落盘的补丁」不同；
 * - 没有任何 `@@` hunk —— 那只是一段没有改动的文本，落盘是空操作却会记一条采纳；
 * - `---`/`+++` 不对齐（少一边）—— 说明 diff 被截断，应用到一半是最坏的结果。
 */
export function parsePatch(input: string): CodePatch {
  const text = input.trim();
  if (text === '') {
    throw new HarnessError('code.invalid', '补丁是空的');
  }
  if (/^GIT binary patch$/m.test(text) || /^Binary files .* differ$/m.test(text)) {
    throw new HarnessError('code.invalid', '不支持二进制补丁 —— 本层只处理文本 diff');
  }
  if (!/^@@ /m.test(text)) {
    throw new HarnessError('code.invalid', '补丁里没有任何 @@ hunk —— 没有实际改动');
  }

  const lines = text.split('\n');
  const files: string[] = [];
  let pending: string | undefined;
  for (const line of lines) {
    if (line.startsWith('--- ')) {
      pending = patchPath(line.slice(4), '---');
      continue;
    }
    if (!line.startsWith('+++ ')) continue;
    const plus = patchPath(line.slice(4), '+++');
    // 一边是 /dev/null（新增/删除文件）时，另一边才是真实路径
    const picked = plus ?? pending;
    pending = undefined;
    if (picked === undefined) {
      throw new HarnessError('code.invalid', '补丁里有 +++ 行但对不上任何路径（diff 被截断？）');
    }
    if (!files.includes(picked)) files.push(picked);
  }

  if (pending !== undefined) {
    throw new HarnessError('code.invalid', `补丁在 "${pending}" 的 --- 行之后结束 —— 文件块不完整`);
  }
  if (files.length === 0) {
    throw new HarnessError('code.invalid', '补丁里没有可识别的文件（缺 ---/+++ 头）');
  }
  return { diff: text.endsWith('\n') ? text : `${text}\n`, files };
}

/** `a/src/x.ts\t2026-01-01` → `src/x.ts`；`/dev/null` → undefined（新增/删除的那一侧） */
function patchPath(raw: string, tag: string): string | undefined {
  // 时间戳是可选的，用 tab 分隔；空格在路径里是合法的，不能按空白切
  const path = raw.split('\t')[0]?.trim() ?? '';
  if (path === '') {
    throw new HarnessError('code.invalid', `${tag} 行没有路径`);
  }
  if (path === '/dev/null') return undefined;
  const stripped = path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
  assertSafePath(stripped, tag);
  return stripped;
}

function assertSafePath(path: string, tag: string): void {
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
    throw new HarnessError('code.invalid', `${tag} 用了绝对路径 "${path}" —— 只接受仓库相对路径`);
  }
  if (path.split('/').includes('..')) {
    throw new HarnessError('code.invalid', `${tag} 路径含 ".."（"${path}"）—— 会逃出仓库`);
  }
  if (path.includes('\\')) {
    throw new HarnessError('code.invalid', `${tag} 路径含反斜杠（"${path}"）`);
  }
}
