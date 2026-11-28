/**
 * `--remote` 的装配：把配置、预检、崩溃回收、runner 与 stage 钩子接成一件东西。
 *
 * 放在 CLI 层而不是 `rsi/` 里，是因为它要读命令行与环境变量（凭据名、`--sync-remote`），
 * 而 `rsi/` 那层只该认识「已经解析好的配置」。顺序也是这里的重点：
 *
 *   回收旧 pending（先把可能残留的未验证改动还原）→ 检查 allowStaging →
 *   预检本地与远端一致 → 造 runner 与 stage
 *
 * 回收排在最前面是刻意的：上一轮崩在「写盘之后」，盘上可能有一个**没被验证过**的
 * 提示词。这时哪怕用户接着把 `allowStaging` 关掉了，也得先把它还原回去 —— 安全动作
 * 不该被开关挡住。
 */

import type { AssetSet } from '../assets/types.js';
import { HarnessError } from '../errors.js';
import { RemoteStager, remoteToken } from '../rsi/remote.js';
import type { StageHook } from '../rsi/types.js';
import type { CaseRunner } from '../run/case-runner.js';
import { createRemoteRunner } from '../run/remote.js';
import { boolFlag, strFlag } from './args.js';
import { assetsOf, type CliContext } from './context.js';
import { warn } from './output.js';

export interface RemoteStage {
  readonly runner: CaseRunner;
  readonly stage: StageHook;
  /** 采纳之后把资产推到远端（否则服务还跑着旧提示词） */
  push(assets: AssetSet): Promise<void>;
}

export async function maybeRemoteStage(ctx: CliContext): Promise<RemoteStage | undefined> {
  const cliUrl = strFlag(ctx.flags, 'remote');
  if (cliUrl === undefined) return undefined;

  const base = ctx.config.remote;
  if (base === undefined) {
    throw new HarnessError(
      'config.invalid',
      '配置里没有 "remote" 段。`--remote` 需要知道「资产目标 → 服务读的那个文件」的映射，' +
        '否则改的东西到不了远端（这正是 rsi --remote 曾经结构性无效的原因）。' +
        '见 docs/rsi.md「配置 remote」',
    );
  }

  // 命令行给的地址覆盖配置文件里的：同一套映射、临时指到另一台验证机是常见需求
  const remote = { ...base, url: cliUrl.replace(/\/+$/, '') };
  const stager = new RemoteStager({ config: ctx.config, remote });

  const recovered = await stager.recoverPending();
  if (recovered !== undefined) warn(recovered);

  if (!remote.allowStaging) {
    throw new HarnessError(
      'config.invalid',
      '远程验证会把**候选提示词写进服务并在验证期间对外提供** —— 这是机制固有的暴露面，' +
        '因为服务只有一份活的提示词。确认目标服务是评测/预发实例后，在配置里写 ' +
        '"remote": { "allowStaging": true }。' +
        '（如果它真的是线上服务，请用另一套部署跑 RSI，别在这里开）',
    );
  }

  const pre = await stager.preflight();
  if (!pre.ok) {
    const lines = pre.rows.map(
      (r) =>
        `  ${r.target}: 本地 ${r.local} / 远端 ${r.remote ?? '（该 agent 没有文件提示词）'}` +
        `\n    文件 ${r.file}`,
    );
    if (!boolFlag(ctx.flags, 'sync-remote')) {
      throw new HarnessError(
        'config.invalid',
        [
          '本地资产与远端不一致 —— 在这种状态下跑 RSI，基线不是当前资产跑出来的，',
          '于是「通过率涨了」可能只是远端本来就不一样：',
          ...lines,
          '确认要用本地这份覆盖远端，就加 --sync-remote（会写文件 + 重载）。',
        ].join('\n'),
      );
    }
    await stager.push(assetsOf(ctx));
    warn('已用本地资产覆盖远端（--sync-remote），并重载');
  }

  const token = remoteToken(remote);
  const runner = createRemoteRunner({
    baseUrl: remote.url,
    token,
    ...(remote.agent !== undefined ? { agentId: remote.agent } : {}),
  });

  return {
    runner,
    stage: async ({ proposal, patched }) => (await stager.stage(proposal, patched)).restore,
    push: (assets) => stager.push(assets),
  };
}
