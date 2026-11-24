import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorkspacePaths } from '../config.js';
import { HarnessError } from '../errors.js';
import { type Fail, objectAt, onlyKeys, readJsonObject, requiredText } from '../util/shape.js';
import { atomicWrite } from './journal.js';
import { validateManifest } from './manifest.js';
import { FAILURE_KINDS, type Proposal } from './types.js';

/** 手写提案与清单都是「配置形状」类失败（退出码 2）——码由本模块定，判定共用 util/shape */
const fail: Fail = (message, cause) => {
  throw new HarnessError('config.invalid', message, cause);
};

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
  return validate(readJsonObject(path, fail), path);
}

export function writeProposal(
  config: Pick<WorkspacePaths, 'workspaceDir'>,
  proposal: Proposal,
): string {
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
  const p = objectAt(raw, `${source}: 提案`, fail);
  onlyKeys(p, source, ['id', 'modeId', 'kind', 'rationale', 'layer', 'patch', 'manifest'], fail);
  const q = objectAt(p.patch, `${source}: patch`, fail);
  onlyKeys(q, `${source}.patch`, ['target', 'before', 'after'], fail);

  const id = requiredText(p.id, `${source}.id`, fail);
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
  const target = requiredText(q.target, `${source}.patch.target`, fail);
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
    modeId: requiredText(p.modeId, `${source}.modeId`, fail),
    kind: kind as Proposal['kind'],
    rationale: requiredText(p.rationale, `${source}.rationale`, fail),
    ...(p.manifest !== undefined
      ? { manifest: validateManifest(p.manifest, `${source}.manifest`) }
      : {}),
    layer: 'L1',
    patch: { target, before, after },
  };
}
