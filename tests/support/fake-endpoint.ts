import { spawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * 起 `scripts/fake-anthropic.mjs` 里的本地假端点，等它吐 `ready` 再返回。
 *
 * 为什么测试需要它：CLI 的成功路径（`eval` 跑完、写报告）必须过真实的
 * `createAnthropicClient` —— fetch、SSE 拼装、usage → 成本都在这条路上。注入
 * scriptedClient 的单元测试绕过了它们，于是「`--save` 到底写到哪个目录」这类
 * **只有端到端才看得见**的事就没人验。
 *
 * 端口取随机高位：并行跑测试时复用固定端口会让第二个用例 EADDRINUSE，
 * 而那个失败看起来像「被测代码坏了」。
 */
export interface FakeEndpoint {
  readonly url: string;
  stop(): void;
}

export async function startFakeEndpoint(args: readonly string[] = []): Promise<FakeEndpoint> {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const script = join(import.meta.dirname, '..', '..', 'scripts', 'fake-anthropic.mjs');
  const child = spawn(process.execPath, [script, '--port', String(port), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr: string[] = [];
  child.stderr.on('data', (c: Buffer) => stderr.push(c.toString()));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`假端点未就绪：${stderr.join('')}`)), 5000);
    child.stdout.on('data', (c: Buffer) => {
      if (c.toString().includes('ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`假端点退出 code=${String(code)}：${stderr.join('')}`));
    });
  });

  return {
    url: `http://127.0.0.1:${String(port)}`,
    stop: () => {
      child.kill('SIGTERM');
    },
  };
}
