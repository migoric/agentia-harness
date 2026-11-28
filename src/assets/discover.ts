import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { HarnessError } from '../errors.js';
import { type Frontmatter, list, parseFrontmatter, scalar } from '../util/frontmatter.js';
import { fingerprint } from '../util/hash.js';
import type { AgentAsset, AssetKind, AssetSet, SkillAsset } from './types.js';

/**
 * 资产发现 —— 扫目录、解析 frontmatter、校验、算指纹。
 *
 * 两种布局都认（一能力一目录是给「将来带附件」留的口子，现在不额外实现附件解析）：
 *
 * ```
 * skills/repo-triage.md
 * skills/repo-triage/SKILL.md
 * agents/triage.md
 * agents/triage/AGENT.md
 * ```
 *
 * 校验口径：`description` 必需（它要进模型看到的工具列表，空描述等于模型看不见这个能力）；
 * `name` 在**两类之间**唯一（技能与 agent 共用同一个工具名空间，见 `assets/types.ts`）。
 */
const ENTRY_FILES: Record<AssetKind, string> = { skill: 'SKILL.md', agent: 'AGENT.md' };

export function discoverAssets(dirs: { skills: string; agents: string }): AssetSet {
  const skills = scan(dirs.skills, 'skill') as SkillAsset[];
  const agents = scan(dirs.agents, 'agent') as AgentAsset[];
  assertToolNames(skills, agents);
  return { skills, agents, fingerprint: setFingerprint(skills, agents) };
}

function scan(dir: string, kind: AssetKind): Array<SkillAsset | AgentAsset> {
  if (!exists(dir)) return [];
  const out: Array<SkillAsset | AgentAsset> = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      const entry = join(full, ENTRY_FILES[kind]);
      if (exists(entry)) out.push(parse(entry, kind));
      continue;
    }
    if (extname(name) === '.md') out.push(parse(full, kind));
  }
  return out;
}

function parse(path: string, kind: AssetKind): SkillAsset | AgentAsset {
  const text = readFileSync(path, 'utf8');
  const fm = parseFrontmatter(text, path);
  const stem = basename(path, '.md');
  const name =
    scalar(fm, 'name', path) ??
    (stem === 'SKILL' || stem === 'AGENT' ? basename(dirname(path)) : stem);
  if (name === '') {
    throw new HarnessError('asset.invalid', `${path}: name 不能为空`);
  }
  const description = scalar(fm, 'description', path);
  if (description === undefined || description.trim() === '') {
    throw new HarnessError(
      'asset.invalid',
      `${path}: 缺少 description —— 它要进模型可见的工具列表，空描述等于这个能力不存在`,
    );
  }
  const body = fm.body.trim();
  if (body === '') {
    throw new HarnessError('asset.invalid', `${path}: 正文为空 —— 资产的意义就是这段文本`);
  }

  const base = {
    name,
    version: scalar(fm, 'version', path) ?? '1',
    description,
    body,
    fingerprint: fingerprint(text),
    path,
    model: scalar(fm, 'model', path),
    tools: list(fm, 'tools'),
    toolsDeclared: fm.data.tools !== undefined,
    maxIterations: positiveInt(scalar(fm, 'maxIterations', path), path, 'maxIterations'),
    // 声明式策略字段的原始字符串；值校验与转译在 buildApp（policy-fields.ts），
    // 这里保持 assets 层不反向依赖 rsi。缺席的键不落进对象。
    policyFields: policyRaw(fm),
  };

  if (kind === 'skill') return { ...base, kind: 'skill' };
  return {
    ...base,
    kind: 'agent',
    maxCostUsd: positiveNum(scalar(fm, 'maxCostUsd', path), path, 'maxCostUsd'),
    subagents: list(fm, 'subagents'),
  };
}

/**
 * 工具名唯一 —— 跨 kind 检查。
 *
 * 分开检查（skill 内唯一 + agent 内唯一）留下一个真实的坑：一个叫 `review` 的技能与
 * 一个叫 `review` 的 agent 同时挂上主 agent，模型看到两个同名工具，选哪个看采样。
 * 这类错在评测里表现为「同一提示词时好时坏」，最容易被误判成模型不稳定。
 */
function assertToolNames(
  skills: readonly { name: string; path: string }[],
  agents: readonly { name: string; path: string }[],
): void {
  const seen = new Map<string, string>();
  for (const a of [...skills, ...agents]) {
    const prev = seen.get(a.name);
    if (prev !== undefined) {
      throw new HarnessError(
        'asset.invalid',
        `工具名重名 "${a.name}"：${prev} 与 ${a.path}（技能与 agent 共用模型侧的工具名空间，` +
          '重名会让模型在两个同名工具间随机选）',
      );
    }
    seen.set(a.name, a.path);
  }
}

/** 全体指纹：排序后拼接，任一资产变动都会变 —— 用它一条属性归因整批资产 */
export function setFingerprint(
  skills: readonly { name: string; fingerprint: string }[],
  agents: readonly { name: string; fingerprint: string }[],
): string {
  const parts = [
    ...skills.map((s) => `skill:${s.name}=${s.fingerprint}`),
    ...agents.map((a) => `agent:${a.name}=${a.fingerprint}`),
  ].sort();
  return fingerprint(parts.join('\n'));
}

/** 抽取声明式策略字段的原始字符串（键白名单在 policy-fields.ts，这里只做机械读取） */
function policyRaw(fm: Frontmatter): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['contextBudgetTokens', 'retryMaxAttempts']) {
    const v = fm.data[key];
    if (typeof v === 'string') out[key] = v;
  }
  return out;
}

function positiveInt(v: string | undefined, path: string, key: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HarnessError('asset.invalid', `${path}: ${key} 应为正整数，收到 "${v}"`);
  }
  return n;
}

function positiveNum(v: string | undefined, path: string, key: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new HarnessError('asset.invalid', `${path}: ${key} 应为正数，收到 "${v}"`);
  }
  return n;
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
