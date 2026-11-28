/**
 * 远程舞台：把候选提示词**写到服务读的那个文件**，重载，跑完再还原。
 *
 * 这是 `rsi --remote` 的核心，也是它最危险的一段。本地 RSI 的顺序是「验证通过才落盘」，
 * 远程必须反过来 —— 候选不写进去，远程根本看不见它。于是有三个必须同时成立的保证：
 *
 * 1. **先备份再写**（`pending.ts`）：崩在中间时，下一次启动知道该还原哪个文件、从哪还原。
 * 2. **还原无论如何都执行**（调用方用 `try/finally`）：包括「评测抛错」「预算中止」。
 * 3. **还原之后要重载**：只把文件写回去而不重载，服务仍跑着尚未验证的候选 ——
 *    这是最隐蔽的一种「以为还原了」。
 *
 * 还有一条不是代码能解决的：远程只有一份活的提示词，所以**验证期间这个服务对外提供的
 * 就是候选**。`remote.allowStaging` 必须显式打开，就是为了让这件事成为有人签字的决定。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AssetSet } from '../assets/types.js';
import type { HarnessConfig, RemoteConfig } from '../config.js';
import { HarnessError } from '../errors.js';
import { atomicWrite } from './journal.js';
import { beginPending, finishPending, readPending, restoreFromPending } from './pending.js';
import type { Proposal } from './types.js';
import { renderFile } from './verify.js';

/**
 * 正文的指纹，与服务侧 `prompt-file.ts` 的 `digest` **必须是同一个算法**
 * （sha256(trim(body)) 前 12 位）。两边不一致的后果很讨厌：预检会一直报「本地与远端
 * 不一致」，于是这个功能看起来永远没配好。所以两边各有一个固定向量测试。
 */
export function bodyDigest(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex').slice(0, 12);
}

export function remoteToken(remote: RemoteConfig, env: NodeJS.ProcessEnv = process.env): string {
  const token = env[remote.tokenEnv];
  if (token === undefined || token.trim() === '') {
    throw new HarnessError(
      'config.invalid',
      `远程需要凭据：设置环境变量 ${remote.tokenEnv}（服务端一把带 admin 角色的 key）。` +
        '不放在配置里是刻意的 —— 配置文件会进仓库',
    );
  }
  return token.trim();
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** 服务侧 `/admin/prompts` 的响应（只取用得到的字段） */
interface PromptsResponse {
  agents?: Array<{ agent?: string; prompt?: { digest?: string; bytes?: number; source?: string } }>;
}

interface ReloadResponse {
  ok?: boolean;
  changed?: Array<{ agent?: string; before?: string; after?: string }>;
  unchanged?: string[];
  error?: string;
}

export interface PreflightRow {
  readonly target: string;
  readonly agent: string;
  readonly file: string;
  readonly local: string;
  readonly remote: string | undefined;
  readonly ok: boolean;
}

export interface PreflightResult {
  readonly ok: boolean;
  readonly rows: readonly PreflightRow[];
}

export interface RemoteStagerOptions {
  readonly config: HarnessConfig;
  readonly remote: RemoteConfig;
  /** 测试注入 */
  readonly fetchImpl?: FetchLike;
  /** 测试注入（避免真起服务） */
  readonly env?: NodeJS.ProcessEnv;
}

export class RemoteStager {
  readonly #config: HarnessConfig;
  readonly #remote: RemoteConfig;
  readonly #fetch: FetchLike;
  readonly #env: NodeJS.ProcessEnv;

  constructor(opts: RemoteStagerOptions) {
    this.#config = opts.config;
    this.#remote = opts.remote;
    this.#fetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.#env = opts.env ?? process.env;
    // 凭据**惰性取**：构造时就要 token 的话，「allowStaging 没开」的用户会先看到
    // 「缺少凭据」—— 于是他去配 token，配完才被告知这条路本来就不许走
  }

  get remote(): RemoteConfig {
    return this.#remote;
  }

  /**
   * 预检：远端每个 agent 的 digest 必须与本地文件一致。
   *
   * 不一致意味着「远端跑的不是你以为的那份」—— 在这种状态下开始一轮 RSI，基线本身就
   * 是个谎：提案是通过率变化算出来的，而基线不是当前资产跑出来的。
   */
  async preflight(): Promise<PreflightResult> {
    const res = await this.#call<PromptsResponse>(this.#remote.promptsPath, { method: 'GET' });
    const remoteDigests = new Map<string, string | undefined>();
    for (const item of res.agents ?? []) {
      if (item.agent !== undefined) remoteDigests.set(item.agent, item.prompt?.digest);
    }

    const rows: PreflightRow[] = [];
    for (const [target, file] of Object.entries(this.#remote.prompts)) {
      const agent = target.slice('agent:'.length);
      const local = bodyDigest(readBody(file));
      const remote = remoteDigests.get(agent);
      rows.push({ target, agent, file, local, remote, ok: remote === local });
    }
    return { ok: rows.every((r) => r.ok), rows };
  }

  /**
   * 把候选写到盘上并重载。返回的 `restore` **必须**在 finally 里调用。
   *
   * `patched` 里已经有补丁之后的正文（`applyPatch` 的产物），所以这里不再算补丁 ——
   * 只负责「把它变成远端能读到的东西」。
   */
  async stage(
    proposal: Proposal,
    patched: AssetSet,
  ): Promise<{ restore(): Promise<void>; before: string; after: string }> {
    const target = proposal.patch.target;
    const file = this.#remote.prompts[target];
    if (file === undefined) {
      throw new HarnessError(
        'rsi.no_signal',
        `提案目标是 ${target}，但配置里的 remote.prompts 没为它指定文件 —— ` +
          '候选无法被远程看见。要么给它加一条映射，要么把这类提案排除在 --remote 之外',
      );
    }
    const body = bodyOf(patched, target);
    const before = bodyDigest(readBody(file));
    const stage = beginPending(this.#config, {
      proposalId: proposal.id,
      target,
      file,
    });

    try {
      // `renderFile` 复用目标文件自己的 frontmatter —— 远端文件可能带 description
      // 之类的字段，重写正文时把它们抹掉会让「只是改了措辞」变成「顺手删了元数据」
      atomicWrite(file, renderFile(file, body));
      await this.#reload();
    } catch (err) {
      await this.#abortStage(stage);
      throw err;
    }

    return {
      before,
      after: bodyDigest(body),
      restore: async () => {
        restoreFromPending(stage);
        // 顺序：先还原文件、再重载、最后删记录。删记录放最后，是为了「重载失败」时
        // 下次启动还能再还原一次（幂等），而不是留下一个「记录没了、远端还是候选」的状态
        await this.#reload();
        finishPending(this.#config, stage);
      },
    };
  }

  /** 把当前资产推到远端（采纳之后 / 预检发现漂移且用户要求对齐时） */
  async push(assets: AssetSet): Promise<void> {
    let wrote = false;
    for (const [target, file] of Object.entries(this.#remote.prompts)) {
      const body = bodyOf(assets, target);
      const next = renderFile(file, body);
      if (next === readFileSync(file, 'utf8')) continue;
      atomicWrite(file, next);
      wrote = true;
    }
    if (wrote) await this.#reload();
  }

  /**
   * 上次崩在「写盘之后、判定之前」时，把文件还原并把远端拉回旧版本。
   *
   * 返回一句人话（写进日志/账本），没有待回收的返回 `undefined`。
   */
  async recoverPending(): Promise<string | undefined> {
    const stage = readPending(this.#config);
    if (stage === undefined) return undefined;
    restoreFromPending(stage);
    try {
      await this.#reload();
    } catch (err) {
      // 文件已还原但远端多半还跑着候选 —— 保留记录，下次再试。宁可每次都报错，
      // 也不要「清掉记录、假装没事」
      throw new HarnessError(
        'rsi.bad_record',
        `回收了 ${stage.file} 的内容，但重载失败（${err instanceof Error ? err.message : String(err)}）。` +
          '远端可能仍在使用未验证的提示词 —— 服务恢复后再跑一次 rsi 即可自动完成',
      );
    }
    finishPending(this.#config, stage);
    return `回收了一个未完成验证的远程改动：${stage.target}（提案 ${stage.proposalId}）已还原并重载`;
  }

  async #abortStage(stage: ReturnType<typeof beginPending>): Promise<void> {
    try {
      restoreFromPending(stage);
      await this.#reload();
      finishPending(this.#config, stage);
    } catch {
      // 还原失败时**保留** pending 记录：下次启动会再试。这里吞掉是因为原始错误
      // （写盘/重载失败）才是调用方需要的；pending 的存在会在下一次 rsi 时报出来
    }
  }

  async #reload(): Promise<void> {
    const res = await this.#call<ReloadResponse>(this.#remote.reloadPath, { method: 'POST' });
    if (res.ok !== true) {
      throw new HarnessError('rsi.no_signal', `远端拒绝重载：${res.error ?? '（没有给出原因）'}`);
    }
  }

  async #call<T>(path: string, init: { method: string }): Promise<T> {
    const url = `${this.#remote.url}${path}`;
    let res: Response;
    try {
      // 带 content-type 却不给 body，Fastify 会直接 400
      // （"Body cannot be empty when content-type is set to 'application/json'"）——
      // 重载端点不需要请求体，所以只有 POST 补一个 `{}`
      res = await this.#fetch(url, {
        method: init.method,
        headers: {
          authorization: `Bearer ${remoteToken(this.#remote, this.#env)}`,
          'content-type': 'application/json',
        },
        ...(init.method === 'POST' ? { body: '{}' } : {}),
      });
    } catch (err) {
      throw new HarnessError(
        'config.invalid',
        `连不上 ${url}：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const text = await res.text();
    if (!res.ok) {
      // 服务侧 400 会带 `{error}`（文件坏了）；401/403 是凭据问题（角色不是 admin）
      let reason = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (typeof parsed.error === 'string') reason = parsed.error;
      } catch {
        // 非 JSON：原样截断
      }
      throw new HarnessError(
        'config.invalid',
        `${init.method} ${path} 返回 ${res.status}：${reason}`,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HarnessError('config.invalid', `${init.method} ${path} 的响应不是 JSON`);
    }
  }
}

/** 读文件正文（去 frontmatter）—— 与服务侧 `loadPromptFile` 同一口径 */
function readBody(file: string): string {
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return text.trim();
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) {
    throw new HarnessError('config.invalid', `${file} 的 frontmatter 未闭合`);
  }
  return lines
    .slice(end + 1)
    .join('\n')
    .trim();
}

/** 从资产集里取某个 target 的正文 */
function bodyOf(assets: AssetSet, target: string): string {
  const [kind, name] = target.split(':', 2);
  const list = kind === 'agent' ? assets.agents : kind === 'skill' ? assets.skills : undefined;
  if (list === undefined) {
    throw new HarnessError('asset.invalid', `不认识的资产目标 "${target}"`);
  }
  const found = list.find((a) => a.name === name);
  if (found === undefined) {
    throw new HarnessError('asset.missing', `资产集里没有 "${target}"`);
  }
  return found.body;
}
