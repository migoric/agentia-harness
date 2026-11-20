#!/usr/bin/env node
/**
 * 离线 e2e：用本地假端点（`scripts/fake-anthropic.mjs`）把**真实客户端路径**跑一遍。
 *
 * 为什么单独有这个脚本：`npm test` 里的客户端全是注入的 `scriptedClient`，与
 * `createAnthropicClient()` 之间隔着 fetch、SSE 拼装、重试退避、usage→成本 换算。
 * 那层代码此前只能靠读代码相信。这里把它放到真的 HTTP 上跑，并顺手把几条只在
 * 异常路径上才走的分支（500 退避重试、429 retry-after、流被截断、超时）也点一遍。
 *
 * 它不能替代真实模型的验证：提示词写得好不好、工具选得对不对，假端点答不了。
 *
 * 用法：`node scripts/offline-e2e.mjs`（需先 `npm run build`）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const FAKE = new URL('./fake-anthropic.mjs', import.meta.url).pathname;

const results = [];
let nextPort = 8801;

/** 起假端点并等到它就绪 —— 不 sleep 猜，读它吐的 `ready <port>` */
async function startFake(args = []) {
  const port = nextPort++;
  const child = spawn(process.execPath, [FAKE, '--port', String(port), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = [];
  child.stderr.on('data', (c) => stderr.push(c.toString()));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`假端点未在 5s 内就绪: ${stderr.join('')}`)),
      5000,
    );
    child.stdout.on('data', (c) => {
      if (c.toString().includes('ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`假端点退出 code=${code}: ${stderr.join('')}`));
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => {
      child.kill('SIGTERM');
    },
    log: () => stderr.join(''),
  };
}

/** 跑 CLI，返回 { code, out, json } */
function cli(args, { root, base }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, '--root', root], {
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: base,
        ANTHROPIC_API_KEY: 'fake-key',
        // 退避默认是秒级；测试要的是「重试发生了」，不是「等够了」
        HARNESS_TEST_FAST_BACKOFF: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    child.stdout.on('data', (c) => out.push(c.toString()));
    child.stderr.on('data', (c) => out.push(c.toString()));
    child.on('close', (code) => {
      const text = out.join('');
      let parsed;
      if (args.includes('--json')) {
        // `--json` 是**美化过的多行** JSON（不是单行），所以从第一个 `{` 取到最后一个 `}`
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end > start) {
          try {
            parsed = JSON.parse(text.slice(start, end + 1));
          } catch {
            parsed = undefined;
          }
        }
      }
      resolve({ code, out: text, json: parsed });
    });
  });
}

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${detail}`}\n`);
}

function project() {
  const root = mkdtempSync(join(tmpdir(), 'harness-offline-'));
  const init = spawn(process.execPath, [CLI, 'init', root], { stdio: 'ignore' });
  return new Promise((resolve, reject) => {
    init.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`init 失败 code=${code}`));
        return;
      }
      // 显式钉模型：不写就吃缺省模型，成本断言会随上游价格表变动而漂
      writeFileSync(
        join(root, 'harness.config.json'),
        `${JSON.stringify({ appName: 'offline', model: 'claude-opus-5' }, null, 2)}\n`,
        'utf8',
      );
      resolve(root);
    });
  });
}

// —— 场景 ——

const root = await project();

{
  const fake = await startFake();
  const r = await cli(['run', '把这段话压成三条要点', '--json'], { root, base: fake.url });
  const j = r.json ?? {};
  check(
    'run 正常路径：SSE 拼装 + 技能调用 + 成本读数',
    r.code === 0 && j.ok === true && String(j.stopReason) === 'end_turn' && (j.costUsd ?? 0) > 0,
    `code=${r.code} ok=${j.ok} stop=${j.stopReason} cost=${j.costUsd}\n${r.out}`,
  );
  check(
    'run 命中技能（trace 归因读的是 capability span）',
    Array.isArray(j.skills) && j.skills.includes('example'),
    `skills=${JSON.stringify(j.skills)}`,
  );
  check(
    'run 的 token 计量非零（usage 从流里拼出来的）',
    typeof j.tokens === 'number' && j.tokens > 0,
    `tokens=${j.tokens}`,
  );
  fake.stop();
}

{
  const fake = await startFake();
  const save = join(root, '.workspace', 'offline-base.json');
  const r = await cli(['eval', '--save', save], { root, base: fake.url });
  const report = JSON.parse(readFileSync(save, 'utf8'));
  check(
    'eval：用例通过、报告落盘、成本入档',
    r.code === 0 && report.passed === 1 && report.total === 1 && report.costUsd > 0,
    `code=${r.code} passed=${report.passed}/${report.total} cost=${report.costUsd}\n${r.out}`,
  );
  check(
    'eval：技能命中统计进报告（RSI 提案要靠它选目标）',
    (report.skillHits ?? []).some((h) => h.target === 'skill:example'),
    `skillHits=${JSON.stringify(report.skillHits)}`,
  );
  fake.stop();
}

{
  const fake = await startFake(['--fail-first', '1']);
  const r = await cli(['run', '压成要点', '--json'], { root, base: fake.url });
  const j = r.json ?? {};
  check(
    '500 一次后重试成功（客户端的指数退避真的在跑）',
    r.code === 0 && j.ok === true,
    `code=${r.code} ok=${j.ok}\n${r.out}\n端点日志:\n${fake.log()}`,
  );
  fake.stop();
}

{
  const fake = await startFake(['--rate-limit-first', '1']);
  const r = await cli(['run', '压成要点', '--json'], { root, base: fake.url });
  check(
    '429 + retry-after 后重试成功（限流窗口被尊重而不是硬撞）',
    r.code === 0 && r.json?.ok === true,
    `code=${r.code}\n${r.out}\n端点日志:\n${fake.log()}`,
  );
  fake.stop();
}

{
  const fake = await startFake(['--truncate']);
  const r = await cli(['run', '压成要点', '--json'], { root, base: fake.url });
  const j = r.json ?? {};
  check(
    '流被截断 ⇒ 判失败而不是把半截当归结（这是最容易被吞的坏结果）',
    r.code === 1 && j.ok === false,
    `code=${r.code} ok=${j.ok} stop=${j.stopReason}\n${r.out}`,
  );
  fake.stop();
}

{
  const fake = await startFake(['--no-usage']);
  const r = await cli(['run', '压成要点', '--json'], { root, base: fake.url });
  const j = r.json ?? {};
  check(
    '端点不报 usage ⇒ costUsd 是 null（「不知道」不是「免费」）',
    j.costUsd === null,
    `costUsd=${JSON.stringify(j.costUsd)}\n${r.out}`,
  );
  fake.stop();
}

{
  const fake = await startFake(['--slow', '1500']);
  const r = await cli(['eval', '--timeout', '300'], { root, base: fake.url });
  check(
    '用例超时按失败记、不挂住整轮（AbortSignal 传下去不等于下游会早返回）',
    r.code === 1 && /超时/.test(r.out),
    `code=${r.code}\n${r.out}`,
  );
  fake.stop();
}

{
  const fake = await startFake();
  const r = await cli(['rsi', '--dry-run'], { root, base: fake.url });
  check(
    'RSI 在「基线全过」时如实收工，不硬凑提案',
    r.code === 0 && /失败样本|没有失败|无需/.test(r.out),
    `code=${r.code}\n${r.out}`,
  );
  fake.stop();
}

// 完整闭环：造一条会失败的用例，让 RSI 真的走完 归因 → 提案 → 验证 → 采纳 → 回滚
{
  const cycle = await project();
  // 期望里要求「校准标记」这四个字，而技能原来的正文/回答里都没有 ——
  // 一条干净的、只能靠改提示词修好的失败
  writeFileSync(
    join(cycle, 'evals', 'strict.md'),
    [
      '---',
      'name: strict',
      'expect_contains: 校准标记',
      '---',
      '',
      '把这段话压成三条要点。',
      '',
    ].join('\n'),
    'utf8',
  );
  spawn(process.execPath, [CLI, 'lock', '--root', cycle], { stdio: 'ignore' });

  const fake = await startFake();
  const before = readFileSync(join(cycle, 'skills', 'example', 'SKILL.md'), 'utf8');
  const r = await cli(['rsi'], { root: cycle, base: fake.url });
  const after = readFileSync(join(cycle, 'skills', 'example', 'SKILL.md'), 'utf8');
  const journalPath = join(cycle, '.workspace', 'rsi', 'journal.jsonl');
  const journal = existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : '(没有 journal)';

  check(
    'RSI 闭环：归因 → 提案 → 验证 → 采纳（真的改到了技能正文）',
    r.code === 0 && /采纳 1 个/.test(r.out) && after.includes('校准标记') && after !== before,
    `code=${r.code}\n${r.out}\n端点日志:\n${fake.log()}`,
  );
  check(
    '采纳写进了 journal（一条审计线索，可复核）',
    journal.includes('"status":"accepted"') && journal.includes('"target":"skill:example"'),
    `journal=\n${journal}`,
  );

  const back = await cli(['rsi', 'revert'], { root: cycle });
  const restored = readFileSync(join(cycle, 'skills', 'example', 'SKILL.md'), 'utf8');
  check(
    'rsi revert 逐字恢复（不是「差不多」而是 byte 相等）',
    back.code === 0 && restored === before,
    `code=${back.code}\n${back.out}`,
  );

  const status = await cli(['rsi', 'status'], { root: cycle });
  check(
    'rsi status 记得这轮（含已回滚的那条）',
    /accepted|reverted/.test(status.out),
    `${status.out}`,
  );
  fake.stop();
  rmSync(cycle, { recursive: true, force: true });
}

rmSync(root, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
process.stdout.write(
  `\n${results.length - failed.length}/${results.length} 通过\n` +
    (failed.length === 0 ? '' : `失败: ${failed.map((f) => f.name).join(' | ')}\n`),
);
process.exit(failed.length === 0 ? 0 : 1);
