import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { revertNote, revertNoteOf } from '../src/rsi/revert-note.ts';

/**
 * 回滚理由的「写」与「读」是一对**字符串格式契约**：生成在 `accept` / `code/apply`，
 * 解析在账本。两边各写一份时，改格式（多一个空格、换括号样式）就是静默失配 ——
 * 提示词里会出现「采纳后又被回滚：修好 1 条（a）」，把成功理由当成回滚原因。
 *
 * 这组用例钉的正是那一对：只要两边有一边改了格式，这里就红。
 */
describe('回滚理由的写与读必须成对', () => {
  it('revertNoteOf 产出的文本能被 revertNote 解析回「当初的采纳理由」', () => {
    const raw = revertNoteOf('p-1', '修好 1 条（a）');
    const note = revertNote(raw);
    assert.ok(note?.includes('人工回滚'), `要点明是人工回滚：${note}`);
    assert.ok(note?.includes('修好 1 条（a）'), `当初的采纳理由要保留：${note}`);
    assert.ok(!note?.startsWith('修好'), `不能把成功理由直接当成回滚原因：${note}`);
  });

  it('解析不了就原样返回（老记录、人手改名都不该丢证据）', () => {
    assert.equal(revertNote('回滚了 p-9'), '回滚了 p-9');
    assert.equal(revertNote('回滚了 p-9（原因：x）'), '回滚了 p-9（原因：x）');
    assert.equal(revertNote(undefined), undefined);
  });
});
