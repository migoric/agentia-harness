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
import { callRemote, type FetchLike } from './remote-call.js';
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
  /**
   * 单次请求的超时（毫秒，默认 15s）。
   *
   * 必须有：`fetch` 在没有 signal 时不会自己放弃一个「连上了但永远不回」的连接
   * （TCP 层的 keepalive 可能挂几十分钟）。而远程 stage 一旦挂住，锁定、心跳、
   * 用户看到的都只是「卡住了」—— 比报错难查得多。
   */
  readonly timeoutMs?: number | undefined;
  /** 取消信号（SIGINT 时由调用方传） */
  readonly signal?: AbortSignal | undefined;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;

export class RemoteStager {
  readonly #config: HarnessConfig;
  readonly #remote: RemoteConfig;
  readonly #fetch: FetchLike;
  readonly #env: NodeJS.ProcessEnv;
  readonly #timeoutMs: number;
  readonly #signal: AbortSignal | undefined;

  constructor(opts: RemoteStagerOptions) {
    this.#config = opts.config;
    this.#remote = opts.remote;
    this.#fetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.#env = opts.env ?? process.env;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#signal = opts.signal;
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
    // GET 是幂等的：一次 502 / 连接重置不该让整轮 RSI 直接失败
    const res = await this.#call<PromptsResponse>(this.#remote.promptsPath, {
      method: 'GET',
      retries: DEFAULT_RETRIES,
    });
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

  /**
   * 把当前资产推到远端（采纳之后 / 预检发现漂移且用户要求对齐时）。
   *
   * **全或全不**：先把要写的内容全部算出来，再统一写；中途有一次失败就把已经写过的
   * 文件回滚成原内容，并重载一次让服务与盘一致。留下「一半新、一半旧」比整体失败更糟：
   * 服务跑着一份谁也没验证过、也不会被任何账本记录的组合。
   */
  async push(assets: AssetSet): Promise<void> {
    const plans: { file: string; next: string; prev: string }[] = [];
    for (const [target, file] of Object.entries(this.#remote.prompts)) {
      const next = renderFile(file, bodyOf(assets, target));
      const prev = readFileSync(file, 'utf8');
      if (next !== prev) plans.push({ file, next, prev });
    }
    if (plans.length === 0) return;

    const written: typeof plans = [];
    try {
      for (const plan of plans) {
        atomicWrite(plan.file, plan.next);
        written.push(plan);
      }
    } catch (err) {
      for (const plan of written.reverse()) {
        try {
          atomicWrite(plan.file, plan.prev);
        } catch {
          // 回滚失败只可能让情况更接近「全旧」，继续尝试剩下的
        }
      }
      await this.#reload().catch(() => undefined);
      throw new HarnessError(
        'config.invalid',
        `推送资产到远端时第 ${written.length + 1}/${plans.length} 个文件写失败：` +
          `${err instanceof Error ? err.message : String(err)}。` +
          '已把写过的文件回滚并重载 —— 远端仍是推送前那一份',
      );
    }
    await this.#reload();
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
    // POST 不重试：第一次可能已经生效、只是响应丢了。重试成功与「第一次就成功」
    // 在服务端看起来一样（重载是幂等的），但**报错**的语义完全不同 —— 宁可让它
    // 报一次「重载失败」，也不要让调用方以为「重试之后才成功」而去做第二次写盘。
    const res = await this.#call<ReloadResponse>(this.#remote.reloadPath, { method: 'POST' });
    if (res.ok !== true) {
      throw new HarnessError('rsi.no_signal', `远端拒绝重载：${res.error ?? '（没有给出原因）'}`);
    }
  }

  /** 所有远程调用都走 `remote-call.ts`：超时/取消/按幂等性重试的判据只有一处 */
  #call<T>(path: string, init: { method: string; retries?: number }): Promise<T> {
    return callRemote<T>(
      {
        fetch: this.#fetch,
        token: () => remoteToken(this.#remote, this.#env),
        timeoutMs: this.#timeoutMs,
        ...(this.#signal !== undefined ? { signal: this.#signal } : {}),
      },
      this.#remote.url,
      path,
      init,
    );
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
