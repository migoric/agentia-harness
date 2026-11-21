import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HarnessConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import { atomicWrite } from './journal.js';
import { validateManifest } from './manifest.js';
import { FAILURE_KINDS, type Proposal } from './types.js';

/**
 * 手写提案的读写边界。
 *
 * `LlmProposer` 不是唯一的提案来源：人也写得出更好的补丁（他看过线上日志）。
 * 但外部 JSON 是**不可信输入**，而提案最终会写源文件 —— 所以这里拒绝一切
 * 形状不对的字段，缺一个就退出码 2，不靠后续环节兜底。
 *
 * 刻意不提供「跳过验证门直接采纳」的入口：提案来源可以变，门不能变。
 * 门在 `verifyProposal` 里，是纯函数、吃两份评测报告，手写提案也必须过。
 */
export function readProposal(path: string): Proposal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new HarnessError('config.invalid', `读不到或不是合法 JSON 的提案：${path}`, e);
  }
  return validate(parsed, path);
}

export function writeProposal(config: HarnessConfig, proposal: Proposal): string {
  // id 已经过 validate，这里再防一次（直接调本函数或用别的来源构造时）
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(proposal.id)) {
    throw new HarnessError('config.invalid', `提案 id "${proposal.id}" 不能当文件名`);
  }
  const path = join(config.workspaceDir, 'rsi', 'proposals', `${proposal.id}.json`);
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, `${JSON.stringify(proposal, null, 2)}\n`);
  return path;
}

function validate(raw: unknown, source: string): Proposal {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HarnessError('config.invalid', `${source}: 提案应是 JSON 对象`);
  }
  const p = raw as Record<string, unknown>;
  keys(p, source, ['id', 'modeId', 'kind', 'rationale', 'layer', 'patch', 'manifest']);
  const patch = p.patch;
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new HarnessError('config.invalid', `${source}: patch 应是对象`);
  }
  const q = patch as Record<string, unknown>;
  keys(q, `${source}.patch`, ['target', 'before', 'after']);

  const id = text(p.id, `${source}.id`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    throw new HarnessError(
      'config.invalid',
      `${source}.id 只能含字母数字 _ -（它会当文件名用），收到 "${id}"`,
    );
  }
  const kind = p.kind;
  if (typeof kind !== 'string' || !FAILURE_KINDS.includes(kind as (typeof FAILURE_KINDS)[number])) {
    throw new HarnessError('config.invalid', `${source}.kind 不是已知失败类型：${String(kind)}`);
  }
  const target = text(q.target, `${source}.patch.target`);
  if (!/^(skill|agent):[A-Za-z0-9][A-Za-z0-9_-]*$/.test(target)) {
    throw new HarnessError(
      'config.invalid',
      `${source}.patch.target 应写成 "skill:名字" / "agent:名字"，收到 "${target}"`,
    );
  }
  const before = q.before;
  const after = q.after;
  if (typeof before !== 'string' || typeof after !== 'string' || after.trim() === '') {
    throw new HarnessError(
      'config.invalid',
      `${source}.patch: before/after 必须是字符串，且 after 不能为空`,
    );
  }
  if (p.layer !== 'L1') {
    throw new HarnessError(
      'config.invalid',
      `${source}.layer 只能是 "L1"（改代码走 harness patch，不走这里）`,
    );
  }
  return {
    id,
    modeId: text(p.modeId, `${source}.modeId`),
    kind: kind as Proposal['kind'],
    rationale: text(p.rationale, `${source}.rationale`),
    ...(p.manifest !== undefined
      ? { manifest: validateManifest(p.manifest, `${source}.manifest`) }
      : {}),
    layer: 'L1',
    patch: { target, before, after },
  };
}

function keys(obj: Record<string, unknown>, source: string, allowed: readonly string[]): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) {
      throw new HarnessError(
        'config.invalid',
        `${source}: 不认识的字段 "${k}"（只认 ${allowed.join(' / ')}）—— 拼错会静默丢字段`,
      );
    }
  }
}

function text(v: unknown, label: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new HarnessError('config.invalid', `${label} 应是非空字符串`);
  }
  return v;
}
