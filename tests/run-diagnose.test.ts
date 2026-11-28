import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { authHint, formatError } from '../src/cli/run-diagnose.ts';
import { type HarnessConfig, loadConfig } from '../src/config.ts';

/**
 * `run` 失败的诊断文案。
 *
 * 这层的失败模式是**沉默**：错误对象里有完整报文，但打印路径只顾着 `text` 与状态行，
 * 于是一个失败看起来像「空输出 + 一行红」。所以断言的重点不是「文案好看」，而是
 * **关键事实不许丢**（HTTP 码、上游原话、该改哪个字段）。
 */

function cfg(json: unknown): HarnessConfig {
  const root = mkdtempSync(join(tmpdir(), 'harness-diag-'));
  if (json !== undefined) {
    writeFileSync(join(root, 'harness.config.json'), JSON.stringify(json), 'utf8');
  }
  return loadConfig(root);
}

describe('run 失败诊断 —— formatError', () => {
  it('把上游报文里的 error.message 摘出来，不留花括号', () => {
    const text = formatError({
      type: 'api',
      message:
        'Anthropic 请求失败（HTTP 403）：{\n  "error": {\n    "type": "forbidden",\n    "message": "Request not allowed"\n  }\n}',
    });
    assert.equal(text, 'api: Anthropic 请求失败（HTTP 403）：Request not allowed');
    assert.doesNotMatch(text, /[{}]/);
  });

  it('报文没有 JSON 时原样带上（不猜、不截断）', () => {
    assert.equal(formatError({ type: 'threw', message: 'fetch failed' }), 'threw: fetch failed');
  });

  it('JSON 残缺 ⇒ 退回原文（截断的报文比编出来的摘要可信）', () => {
    const raw = 'Anthropic 请求失败（HTTP 500）：{"error": {"message": "trunc';
    assert.equal(formatError({ type: 'api', message: raw }), `api: ${raw}`);
  });

  it('JSON 里没有 error.message ⇒ 退回原文', () => {
    const raw = '请求失败：{"ok": false}';
    assert.equal(formatError({ type: 'api', message: raw }), `api: ${raw}`);
  });

  it('报文以 JSON 开头（没有前缀）时只留内层消息，不留「：」', () => {
    assert.equal(
      formatError({ type: 'api', message: '{"error":{"message":"boom"}}' }),
      'api: boom',
    );
  });
});

describe('run 失败诊断 —— authHint', () => {
  it('401/403 且没配 endpoint ⇒ 指出「你还没选模型」，并给出要加的字段', () => {
    const hint = authHint(
      {
        type: 'api',
        message: 'Anthropic 请求失败（HTTP 403）：{"error":{"message":"Request not allowed"}}',
      },
      cfg(undefined),
    );
    assert.ok(hint !== undefined, '应当给提示');
    assert.match(hint, /没有配 `endpoint`/);
    assert.match(hint, /"model"/);
    assert.match(hint, /apiKeyEnv/);
  });

  it('401（凭据无效）同样给提示 —— 新工程的缺省路径就撞这个', () => {
    const hint = authHint({ type: 'api', message: 'x（HTTP 401）：unauthorized' }, cfg(undefined));
    assert.ok(hint !== undefined);
  });

  it('配了 endpoint 还 403 ⇒ 不再劝去配 endpoint（那是账号问题）', () => {
    const hint = authHint(
      { type: 'api', message: 'x（HTTP 403）：forbidden' },
      cfg({ endpoint: { baseURL: 'https://api.deepseek.com/anthropic' } }),
    );
    assert.equal(hint, undefined);
  });

  it('非鉴权类失败（500 / 超时）⇒ 不给这条提示', () => {
    const c = cfg(undefined);
    assert.equal(authHint({ type: 'api', message: 'x（HTTP 500）：boom' }, c), undefined);
    assert.equal(authHint({ type: 'threw', message: 'timeout' }, c), undefined);
  });
});
