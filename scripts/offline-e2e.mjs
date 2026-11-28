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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * 跑 CLI，返回 { code, out, json }。
 *
 * `clean: true` 表示**不**从环境变量给端点/凭据 —— 用来证明「配置 + .env」这条
 * 真实用户路径自己就能走通（不借开发机上可能存在的 ANTHROPIC_* 变量）。
 */
function cli(args, { root, base, clean = false }) {
  const env = { ...process.env };
  if (clean) {
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_API_KEY;
  } else {
    env.ANTHROPIC_BASE_URL = base;
    env.ANTHROPIC_API_KEY = 'fake-key';
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, '--root', root], {
      env,
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
      // 显式钉一个**非缺省**模型名：既让成本断言不随上游价格表漂移，又能抓到
      // 「主 agent 用配置的模型、技能子循环偷偷回落到 claude-opus-5」这种回归
      writeFileSync(
        join(root, 'harness.config.json'),
        `${JSON.stringify(
          {
            appName: 'offline',
            model: 'deepseek-flash',
            pricing: { 'deepseek-flash': { in: 5, out: 25 } },
          },
          null,
          2,
        )}\n`,
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

  // 真端点上踩出来的：上游 capability loop 继承 client 但不继承 model，
  // 装配层不补的话技能那几回合会挂 claude-opus-5、按 opus 单价记账（40×）
  const traceLines = readFileSync(join(root, '.workspace', 'traces.jsonl'), 'utf8')
    .trim()
    .split('\n');
  const trace = JSON.parse(traceLines.at(-1));
  const turns = trace.spans.filter((s) => s.kind === 'llm.turn');
  check(
    '技能子循环用工程生效模型，不回落到 claude-opus-5',
    turns.length >= 3 && turns.every((s) => s.name === 'deepseek-flash'),
    `turns=${turns.map((s) => s.name).join(', ')}`,
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

  // `--repeat` 的 CLI 接线只有这条能覆盖：单测直接调 `aggregateSamples`，绕过了
  // flag 解析、`tuningOf` 透传与 `summarize` 的样本级汇总三处
  const repSave = join(root, '.workspace', 'offline-repeat.json');
  const rep = await cli(['eval', '--repeat', '3', '--save', repSave], { root, base: fake.url });
  const repReport = JSON.parse(readFileSync(repSave, 'utf8'));
  const firstCase = repReport.cases?.[0] ?? {};
  check(
    'eval --repeat 3：每条采 3 次、逐条记样本数、报告带 Wilson 区间',
    rep.code === 0 &&
      repReport.samples === 3 &&
      firstCase.samples === 3 &&
      firstCase.passedSamples === 3 &&
      typeof repReport.passRateLow === 'number' &&
      typeof repReport.passRateHigh === 'number',
    `code=${rep.code} samples=${repReport.samples} case=${JSON.stringify({ s: firstCase.samples, p: firstCase.passedSamples })} ci=${repReport.passRateLow}~${repReport.passRateHigh}\n${rep.out}`,
  );
  check(
    'eval --repeat 3：token 是三次的和，不是平均（报告要能对上账）',
    repReport.tokens === report.tokens * 3,
    `单次=${report.tokens} 三次=${repReport.tokens}`,
  );
  fake.stop();
}

{
  // 并发：只有 ≥2 条用例才真的并发（一条用例时 `--concurrency` 是空转的）
  const fake = await startFake();
  const conc = await project();
  writeFileSync(
    join(conc, 'evals', 'b-second.md'),
    '---\nname: second\nexpect_contains: 要点\n---\n再压一段：把这段话也压成三条要点。\n',
    'utf8',
  );
  const serial = join(conc, '.workspace', 'c1.json');
  const parallel = join(conc, '.workspace', 'c2.json');
  const s1 = await cli(['eval', '--repeat', '2', '--save', serial], { root: conc, base: fake.url });
  const s2 = await cli(['eval', '--concurrency', '2', '--repeat', '2', '--save', parallel], {
    root: conc,
    base: fake.url,
  });
  const r1 = JSON.parse(readFileSync(serial, 'utf8'));
  const r2 = JSON.parse(readFileSync(parallel, 'utf8'));
  check(
    'eval --concurrency 2：结果顺序与串行逐条一致（diff 才是资产差异，不是调度顺序）',
    s1.code === 0 &&
      s2.code === 0 &&
      r2.total === 2 &&
      r1.cases.map((c) => c.name).join() === r2.cases.map((c) => c.name).join(),
    `串行=${r1.cases.map((c) => c.name)} 并发=${r2.cases.map((c) => c.name)}\n${s2.out}`,
  );
  check(
    'eval --concurrency 2 --repeat 2：并发粒度是用例，每条仍采满 2 次',
    r2.cases.every((c) => c.samples === 2) && r2.tokens > 0,
    `samples=${r2.cases.map((c) => c.samples)} tokens=${r2.tokens}\n${s2.out}`,
  );

  // history 的接线只有这里能覆盖：单测直接调 `appendRun`，绕过「eval 结束时记账」
  // 与 flag 解析两处，而「记了但没写进去」正是这类功能最常见的坏法
  const h = await cli(['history', '--json'], { root: conc });
  const hj = h.json ?? {};
  check(
    'history：每次 eval 自动记账，per-case 次数对得上',
    h.code === 0 &&
      hj.runs === 2 &&
      Array.isArray(hj.cases) &&
      hj.cases.length === 2 &&
      hj.cases.every((c) => c.runs === 2),
    `code=${h.code} runs=${hj.runs} cases=${JSON.stringify(
      (hj.cases ?? []).map((c) => `${c.name}:${c.runs}`),
    )}\n${h.out}`,
  );
  rmSync(conc, { recursive: true, force: true });
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
  check(
    '同一轮要说清病因是「端点没报计量」而不是「没定价」',
    String(j.costNote) === 'unreported',
    `costNote=${JSON.stringify(j.costNote)}\n${r.out}`,
  );
  fake.stop();
}

// 端点走配置 + .env（真实用户路径）：`endpoint.baseURL` 与「key 在哪个变量里」进配置，
// key 只进 .env。全程**不给**环境变量 —— 这条过了才说明桥接真的接上了
{
  const fake = await startFake();
  const cfgRoot = await project();
  writeFileSync(
    join(cfgRoot, 'harness.config.json'),
    `${JSON.stringify(
      {
        appName: 'offline',
        model: 'claude-opus-5',
        endpoint: { baseURL: fake.url, apiKeyEnv: 'DEEPSEEK_API_KEY' },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(join(cfgRoot, '.env'), 'DEEPSEEK_API_KEY=fake-key\n', 'utf8');
  const r = await cli(['run', '压成要点', '--json'], { root: cfgRoot, clean: true });
  const j = r.json ?? {};
  check(
    'endpoint + .env：配置里的 baseURL / apiKeyEnv 真的接到了客户端（不借环境变量）',
    r.code === 0 && j.ok === true && (j.costUsd ?? 0) > 0,
    `code=${r.code} ok=${j.ok} cost=${j.costUsd}\n${r.out}`,
  );
  rmSync(cfgRoot, { recursive: true, force: true });
  fake.stop();
}

// 同一个工程，把 .env 拿掉 ⇒ 开跑前就报缺凭据（退出码 2），不花一轮 token 去换 401
{
  const cfgRoot = await project();
  writeFileSync(
    join(cfgRoot, 'harness.config.json'),
    `${JSON.stringify(
      { appName: 'offline', model: 'claude-opus-5', endpoint: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const r = await cli(['run', '压成要点'], { root: cfgRoot, clean: true });
  check(
    '没有 key ⇒ 退出码 2 且点名 DEEPSEEK_API_KEY（不是等 401）',
    r.code === 2 && /缺少模型凭据：DEEPSEEK_API_KEY/.test(r.out),
    `code=${r.code}\n${r.out}`,
  );
  rmSync(cfgRoot, { recursive: true, force: true });
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

// 手写提案：来源可以变，**门不能变**。走真 HTTP 的两遍评测，不只是单测的脚本客户端
{
  const manual = await project();
  writeFileSync(
    join(manual, 'evals', 'strict.md'),
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
  const skillPath = join(manual, 'skills', 'example', 'SKILL.md');
  const original = readFileSync(skillPath, 'utf8');
  const body = original.split('---')[2].trim();
  const proposal = {
    id: 'p-manual-offline',
    modeId: 'm',
    kind: 'wrong_answer',
    rationale: '人工看了线上日志，要求输出带校准标记',
    layer: 'L1',
    patch: {
      target: 'skill:example',
      // patch.before 必须是资产的**正文**（discoverAssets 读到的就是 trim 后的正文）
      before: body,
      after: `${body}\n输出必须以「校准标记」开头。`,
    },
  };
  writeFileSync(join(manual, 'proposal.json'), `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');

  const fake = await startFake();
  const registered = await cli(['rsi', 'propose', '--from', 'proposal.json'], {
    root: manual,
    base: fake.url,
  });
  check(
    'rsi propose --from 登记手写提案（不调模型，只校验+落盘）',
    registered.code === 0 && /p-manual-offline/.test(registered.out),
    `code=${registered.code}\n${registered.out}`,
  );

  const accepted = await cli(['rsi', 'accept', '--from', 'proposal.json'], {
    root: manual,
    base: fake.url,
  });
  const changed = readFileSync(skillPath, 'utf8');
  check(
    '手写提案也要过完整验证门：两遍评测后采纳，真的改到技能正文',
    accepted.code === 0 && changed.includes('校准标记') && changed !== original,
    `code=${accepted.code}\n${accepted.out}\n端点日志:\n${fake.log()}`,
  );
  // 上面的断言只看「文件改了」还不够 —— 若 baseline 根本没跑、直接拿 candidate 当
  // 两份报告，gate 看到「无变化」也会放行。数端点日志：两遍评测各调一次技能。
  const requests = (fake.log().match(/#\d+ /g) ?? []).length;
  const skillCalls = (fake.log().match(/tool_use:example/g) ?? []).length;
  check(
    '手写提案确实跑了两遍评测（基线 + 候选各调一次技能，不是拿一份报告当两份）',
    requests >= 6 && skillCalls >= 2,
    `requests=${requests} skillCalls=${skillCalls}\n${fake.log()}`,
  );

  const reverted = await cli(['rsi', 'revert', 'p-manual-offline'], {
    root: manual,
    base: fake.url,
  });
  check(
    'rsi revert <id> 按 id 精确回滚，逐字恢复',
    reverted.code === 0 && readFileSync(skillPath, 'utf8') === original,
    `code=${reverted.code}\n${reverted.out}`,
  );

  // 证明 accept 走的是验证层而不是「直接写盘」：给一份 before 已过期的提案，
  // 应在 applyPatch 的乐观锁处被拒，源文件一个字都不动。
  // （门本身的退步否决由 gate 单测覆盖；假端点下很难构造出真正的通过率下降）
  proposal.id = 'p-manual-stale';
  proposal.patch.before = '这段正文早就过期了';
  writeFileSync(join(manual, 'proposal.json'), `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
  const blocked = await cli(['rsi', 'accept', '--from', 'proposal.json'], {
    root: manual,
    base: fake.url,
  });
  check(
    '手写提案不是直写：先过验证层的乐观锁，过期 before 拒绝且文件不动',
    blocked.code === 2 &&
      /基础版本已过期/.test(blocked.out) &&
      readFileSync(skillPath, 'utf8') === original,
    `code=${blocked.code}\n${blocked.out}`,
  );

  // 「没变差」不等于「变好了」：no-op 提案即便门放行，也必须被采纳门槛挡住
  proposal.id = 'p-manual-noop';
  proposal.patch.before = body;
  proposal.patch.after = `${body}\n只改一个无关的字。`;
  writeFileSync(join(manual, 'proposal.json'), `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
  const noop = await cli(['rsi', 'accept', '--from', 'proposal.json'], {
    root: manual,
    base: fake.url,
  });
  check(
    '手写提案与自动 RSI 同门槛：没有任何用例变好就拒绝，不用 no-op 污染 git 历史',
    noop.code === 1 && /没有任何用例变好/.test(noop.out),
    `code=${noop.code}\n${noop.out}`,
  );

  fake.stop();
  rmSync(manual, { recursive: true, force: true });
}

{
  // 多轮评测：真实 HTTP 路径下，第 2 轮必须带上第 1 轮的历史。
  // 判据用假端点日志里的 `in=<tokens>`（它按 messages 的 JSON 长度估）——
  // 带了历史就一定更长。删掉技能是为了让每轮只发一次请求，读数才可比。
  const fake = await startFake();
  // 自建最小工程而不是 `init`：init 会带一条 example 用例，`--only` 之外的噪声
  // 会让 `in=` 的读数对不上（那是按用例顺序排的）
  const multi = mkdtempSync(join(tmpdir(), 'harness-multi-'));
  mkdirSync(join(multi, 'agents'), { recursive: true });
  mkdirSync(join(multi, 'evals'), { recursive: true });
  writeFileSync(
    join(multi, 'harness.config.json'),
    `${JSON.stringify({ appName: 'multi', model: 'deepseek-flash', pricing: { 'deepseek-flash': { in: 5, out: 25 } } }, null, 2)}\n`,
    'utf8',
  );
  // 不带工具的主 agent：每轮只发一次请求，`in=` 读数才可比
  writeFileSync(
    join(multi, 'agents', 'main.md'),
    '---\ndescription: 离线多轮测试\n---\n你是执行者，回答要短。\n',
    'utf8',
  );
  writeFileSync(
    join(multi, 'evals', 'multi.md'),
    '---\nname: multi\nexpect_contains: 结论\n---\n任务甲：先看 foo.c\n<!-- turn -->\n任务乙：不对，我要 bar.c\n',
    'utf8',
  );

  const ran = await cli(['eval', '--save', 'multi.json'], { root: multi, base: fake.url });
  const saved = JSON.parse(readFileSync(join(multi, 'multi.json'), 'utf8'));
  const c = saved.cases?.[0];
  const ins = [...fake.log().matchAll(/#\d+ .*? in=(\d+)/g)].map((m) => Number(m[1]));
  check(
    '多轮用例真跑了两轮，且第 2 轮请求带上了第 1 轮的历史',
    ran.code === 0 && c?.turns === 2 && c?.passed === true && ins.length === 2 && ins[1] > ins[0],
    `code=${ran.code} turns=${c?.turns} passed=${c?.passed} in=${ins.join(',')}\n${fake.log()}`,
  );

  fake.stop();
  rmSync(multi, { recursive: true, force: true });
}

rmSync(root, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
process.stdout.write(
  `\n${results.length - failed.length}/${results.length} 通过\n` +
    (failed.length === 0 ? '' : `失败: ${failed.map((f) => f.name).join(' | ')}\n`),
);
process.exit(failed.length === 0 ? 0 : 1);
