#!/usr/bin/env node
/**
 * nightly：用**真模型**跑三条最便宜的用例，看外部世界还在不在。
 *
 * 为什么单有这个脚本：`e2e:offline` 验证的是**协议实现**（fetch / SSE / 重试 /
 * usage→成本），它用假端点，所以「DeepSeek 改了 usage 字段」「价格表过期」
 * 「模型侧行为漂移」这三件事它一件也测不到 —— 而这三件恰好是线上才会炸的那类。
 *
 * 它跑源码而不是 `dist/`：这条脚本要回答的是「外部世界变了没」，不是「产物打对了没」
 * （后者由 prepublishOnly 的 check 加离线 e2e 负责）。用源码能保证测的是**此刻改的代码**。
 *
 * 用法：
 *   node scripts/nightly.mjs                      # 缺 key 时退出码 2（本地）
 *   node scripts/nightly.mjs --allow-missing-key # 缺 key 时跳过并退出 0（CI）
 *
 * 环境变量：
 *   DEEPSEEK_API_KEY   必需（端点与变量名由 examples/pipeline 的配置决定）
 *   NIGHTLY_MAX_USD    成本上限，缺省 0.05（三条例句实测约 $0.007）
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const CLI = join(ROOT, 'src/cli.ts');
const PROJECT = 'examples/pipeline';
const OUT = join(ROOT, '.tmp/nightly');
/** 三条最便宜的 train 用例；**不含** holdout —— 留出集是 RSI 的验收资源，不该被冒烟消耗 */
const CASES = ['triage-outage', 'triage-invoice', 'triage-followup'];
const MAX_USD = Number(process.env.NIGHTLY_MAX_USD ?? '0.05');
/** 端点不再报 usage 时 tokens 会变 0；异常膨胀通常意味着循环失控 */
const MAX_TOKENS = 60_000;

const allowMissing = process.argv.includes('--allow-missing-key');
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  ${detail}`}`);
}

function cli(args) {
  return execFileSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function main() {
  if ((process.env.DEEPSEEK_API_KEY ?? '').trim() === '') {
    const msg = '没有 DEEPSEEK_API_KEY：真模型冒烟未执行（配置 secret 后这条才会真正跑起来）';
    if (!allowMissing) {
      console.error(`错误：${msg}`);
      return 2;
    }
    // `::warning::` 是 GitHub Actions 的注解语法：跳过必须在 UI 上**看得见**，
    // 否则「nightly 一直绿」会被读成「模型一直正常」
    console.log(`::warning::${msg}`);
    return 0;
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const reportPath = join(OUT, 'report.json');

  let report;
  let runError;
  // eval 在有失败用例时退出码是 1，但**报告照样会写**。所以先不判生死：
  // 失败了也要读报告，让下面逐条断言说清「挂在哪条、为什么」——
  // 一句「eval 没跑完」是最难排查的那种错误（它把 3 条有用信息压成了 0 条）
  try {
    // `--no-history`：冒烟要回答的是「外部世界还在不在」，不是「这条用例怎么走的」。
    // 它每天跑、只跑三条、失败多半是基础设施问题 —— 记进账本只会把 evaluate 的真实
    // 趋势挤掉（窗口按「出现过该用例的运行」算）
    cli([
      'eval',
      '--root',
      PROJECT,
      '--only',
      CASES.join(','),
      '--no-history',
      '--save',
      reportPath,
    ]);
  } catch (e) {
    runError = e;
  }
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    const detail = `${runError?.stdout ?? ''}${runError?.stderr ?? ''}${runError?.message ?? ''}`;
    console.log(`FAIL  eval 没产出报告（连不上 / 401 / 崩了）\n${detail.trim().slice(0, 800)}`);
    return 1;
  }

  check('三条用例都跑到', report.cases.length === CASES.length, `实跑 ${report.cases.length} 条`);
  check(
    '全部通过',
    report.passed === report.total,
    report.passed === report.total
      ? ''
      : `${report.passed}/${report.total}；失败：${report.cases
          .filter((c) => !c.passed)
          .map((c) => `${c.name}(${c.failures.join('；')})`)
          .join(', ')}`,
  );
  // 「成本读不出来」与「成本为 0」必须分开：前者说明价格表或 usage 字段变了，
  // 而那会让预算闸静默失效 —— 这正是 nightly 最该抓的一种病
  check(
    '成本读数可用（价格表覆盖该模型，端点报了 usage）',
    report.costKnown === true,
    report.costKnown === true ? `$${report.costUsd.toFixed(5)}` : 'costKnown=false',
  );
  check(
    `成本在上限内（$${MAX_USD}）`,
    report.costKnown === true && report.costUsd <= MAX_USD,
    `$${(report.costUsd ?? 0).toFixed(5)}`,
  );
  check(
    'token 读数正常（>0 且未失控）',
    report.tokens > 0 && report.tokens <= MAX_TOKENS,
    `${report.tokens} token`,
  );
  // 每 token 的隐含单价：DeepSeek 分时计价（peak 是 off-peak 两倍），落在这个区间
  // 之外说明价格表过期了或者计费口径变了
  if (report.costKnown === true && report.tokens > 0) {
    const perMillion = (report.costUsd / report.tokens) * 1e6;
    check(
      '隐含单价在合理区间（$0.1–$2.5 / 1M token）',
      perMillion >= 0.1 && perMillion <= 2.5,
      `$${perMillion.toFixed(3)} / 1M`,
    );
  }

  // 余额只做提示，不做判据：两次查询的差额受两位小数与约 20 秒结算延迟限制，
  // 一次冒烟（约 $0.007）读出来的差值是 0，硬断言只会制造假失败
  try {
    const b = JSON.parse(cli(['balance', '--root', PROJECT, '--json']));
    const main = b.balances[0];
    console.log(
      `INFO  余额 ${main.currency} ${main.total.toFixed(2)}（约 $${main.usd.toFixed(4)}）`,
    );
    if (!b.available) check('余额足以调用', false, '可用状态为 false');
  } catch (e) {
    console.log(
      `INFO  余额查不到（不影响本次结论）：${(e.stderr ?? e.message).toString().trim().slice(0, 200)}`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  return failed.length === 0 ? 0 : 1;
}

process.exitCode = main();
