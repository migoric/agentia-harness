import { startServer } from '../../server/serve.js';
import { numFlag, strFlag } from '../args.js';
import { assetsOf, type CliContext } from '../context.js';
import { say } from '../output.js';

/**
 * `harness serve` —— 让别的进程能调这个 agent。
 *
 * 常驻进程的退出必须是**优雅的**：SIGINT/SIGTERM 之后先关监听（不再接新请求），
 * 再等在飞的 run 收尾。直接 `process.exit` 会让正在跑的 trace 缺一个收尾 span，
 * 而那份 trace 恰恰是事后查「为什么这个请求超时」的唯一证据。
 */
export async function serveCommand(ctx: CliContext): Promise<number> {
  const port = numFlag(ctx.flags, 'port') ?? 8787;
  const host = strFlag(ctx.flags, 'host') ?? '127.0.0.1';
  const timeoutMs = numFlag(ctx.flags, 'timeout');

  const running = await startServer({
    config: ctx.config,
    assets: assetsOf(ctx),
    port,
    host,
    ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    apiKeyEnv: ctx.config.serverApiKeyEnv,
    maxQueue: ctx.config.serverMaxQueue,
  });
  const auth =
    ctx.config.serverApiKeyEnv === undefined
      ? '无鉴权（只接受回环地址）'
      : `Bearer（key 来自 ${ctx.config.serverApiKeyEnv}）`;
  say(
    `harness 在 http://${host}:${running.port} 上（POST /v1/run，GET /health）\n` +
      `  鉴权：${auth} · 队列上限：${ctx.config.serverMaxQueue}`,
  );

  await new Promise<void>((done) => {
    const stop = (): void => done();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  say('正在收尾在飞的请求…');
  await running.close();
  return 0;
}
