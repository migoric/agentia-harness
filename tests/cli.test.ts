import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { discoverAssets } from '../src/assets/discover.ts';
import { loadConfig } from '../src/config.ts';
import { listReports } from '../src/server/read/reports.ts';
import { runCli as run } from './support/cli.ts';
import { startFakeEndpoint } from './support/fake-endpoint.ts';

/**
 * CLI 端到端：用真实子进程跑，断言**退出码**。
 *
 * 退出码是这个工具对 CI 的契约（`lock --check` 靠它拦「偷偷改提示词」），
 * 用函数内调用测不出「process.exitCode 有没有设对」。
 */

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'harness-cli-'));
}

describe('harness init', () => {
  it('生成可用的最小工程，且不覆盖已有文件', () => {
    const dir = tmp();
    const first = run(['init'], dir);
    assert.equal(first.code, 0, first.out);
    for (const f of [
      'harness.config.json',
      'agents/main.md',
      'skills/example/SKILL.md',
      'evals/example.md',
    ]) {
      assert.ok(existsSync(join(dir, f)), `应生成 ${f}`);
    }

    // 再跑一次：跳过而不是覆盖
    writeFileSync(join(dir, 'agents/main.md'), '---\ndescription: 改过\n---\n正文\n', 'utf8');
    const second = run(['init'], dir);
    assert.equal(second.code, 0);
    assert.match(second.out, /跳过已存在: agents\/main\.md/);
    assert.match(readFileSync(join(dir, 'agents/main.md'), 'utf8'), /改过/);
  });
});

describe('harness lock', () => {
  it('写锁后用 --check 通过；改资产后 --check 失败', () => {
    const dir = tmp();
    run(['init'], dir);

    const write = run(['lock'], dir);
    assert.equal(write.code, 0, write.out);
    assert.ok(existsSync(join(dir, 'harness.lock.json')));

    const clean = run(['lock', '--check'], dir);
    assert.equal(clean.code, 0, clean.out);
    assert.match(clean.out, /资产与锁一致/);

    // 偷偷改一个字（模拟「手改提示词没重新锁」）
    const skill = join(dir, 'skills/example/SKILL.md');
    writeFileSync(skill, `${readFileSync(skill, 'utf8')}\n多出来的一行\n`, 'utf8');

    const dirty = run(['lock', '--check'], dir);
    assert.equal(dirty.code, 1, '资产变了，--check 必须非 0');
    assert.match(dirty.out, /变更 1/);
  });
});

describe('harness eval', () => {
  it('没有用例时报错得体（退出码 1，不是栈崩）', () => {
    const dir = tmp();
    run(['init'], dir);
    // 拿掉唯一用例
    rmSync(join(dir, 'evals/example.md'));

    const r = run(['eval'], dir);
    // 2 = 配置/用法错（没评测集是工程没配好），与「跑了但没达标」的 1 分开
    assert.equal(r.code, 2);
    assert.match(r.out, /没有用例/);
    assert.doesNotMatch(r.out, /at Object\.<anonymous>/);
  });

  it('--save 不带值 ⇒ 写进看板读的那个目录（两侧不再靠人肉对齐）', async () => {
    const dir = tmp();
    run(['init'], dir);
    const fake = await startFakeEndpoint();
    try {
      const r = run(['eval', '--save'], dir, {
        ANTHROPIC_BASE_URL: fake.url,
        ANTHROPIC_API_KEY: 'fake',
      });
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /报告已写入 \.workspace\/reports\//, r.out);

      const files = readdirSync(join(dir, '.workspace', 'reports')).filter((f) =>
        f.endsWith('.json'),
      );
      assert.equal(files.length, 1, `目录里应只有一份报告，实际 ${files.join(',')}`);

      // 真正的判据是**读侧也看得见**：写侧自说自话写到别处，症状正是「看板 0 份报告」
      const listed = listReports(loadConfig(dir));
      assert.equal(listed.reports.length, 1, JSON.stringify(listed));
      assert.equal(listed.invalid.length, 0);
      assert.ok((listed.reports[0]?.total ?? 0) > 0);
    } finally {
      fake.stop();
    }
  });

  it('--save 带值 ⇒ 用户给的路径说了算（默认目录不掺和）', async () => {
    const dir = tmp();
    run(['init'], dir);
    const fake = await startFakeEndpoint();
    try {
      const r = run(['eval', '--save', 'out/mine.json'], dir, {
        ANTHROPIC_BASE_URL: fake.url,
        ANTHROPIC_API_KEY: 'fake',
      });
      assert.equal(r.code, 0, r.out);
      assert.ok(existsSync(join(dir, 'out/mine.json')), r.out);
      assert.equal(existsSync(join(dir, '.workspace', 'reports')), false, '不该顺手写两份');
    } finally {
      fake.stop();
    }
  });
});

describe('用法错误', () => {
  it('未知命令退出码 2 并打帮助', () => {
    const r = run(['nope'], tmp());
    assert.equal(r.code, 2);
    assert.match(r.out, /未知命令/);
  });

  it('run 缺任务描述时给出用法', () => {
    const dir = tmp();
    run(['init'], dir);
    const r = run(['run'], dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /run 需要任务描述/);
  });
});

describe('harness patch（L2）', () => {
  const DIFF = [
    '--- a/calc.ts',
    '+++ b/calc.ts',
    '@@ -1 +1 @@',
    '-export const sum = (a: number, b: number) => a + b;',
    '+export const sum = (a: number, b: number) => a + b + 1;',
    '',
  ].join('\n');

  function gitRepo(): string {
    const dir = tmp();
    const git = (args: string[]): void => {
      execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'harness@test']);
    git(['config', 'user.name', 'harness']);
    writeFileSync(
      join(dir, 'calc.ts'),
      'export const sum = (a: number, b: number) => a + b;\n',
      'utf8',
    );
    writeFileSync(join(dir, '.gitignore'), '.workspace\n', 'utf8');
    writeFileSync(join(dir, 'change.diff'), DIFF, 'utf8');
    git(['add', '-A']);
    git(['commit', '-qm', 'init']);
    return dir;
  }

  it('缺省只验证不落盘；--yes 才落盘；--revert 逐字回滚', () => {
    const dir = gitRepo();
    const original = readFileSync(join(dir, 'calc.ts'), 'utf8');
    const verify = 'node -e process.exit(0)';

    const check = run(['patch', 'change.diff', '--verify', verify], dir);
    assert.equal(check.code, 0, check.out);
    assert.match(check.out, /未落盘/);
    assert.equal(readFileSync(join(dir, 'calc.ts'), 'utf8'), original);

    const apply = run(['patch', 'change.diff', '--verify', verify, '--yes'], dir);
    assert.equal(apply.code, 0, apply.out);
    assert.match(readFileSync(join(dir, 'calc.ts'), 'utf8'), /a \+ b \+ 1/);

    const back = run(['patch', '--revert'], dir);
    assert.equal(back.code, 0, back.out);
    assert.equal(readFileSync(join(dir, 'calc.ts'), 'utf8'), original);
  });

  it('验证失败退出码 1，并且一个字都不写', () => {
    const dir = gitRepo();
    const original = readFileSync(join(dir, 'calc.ts'), 'utf8');
    const r = run(['patch', 'change.diff', '--verify', 'node -e process.exit(3)', '--yes'], dir);

    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /BLOCK/);
    assert.equal(readFileSync(join(dir, 'calc.ts'), 'utf8'), original);
  });
});

describe('凭据缺失只拦「真会调模型」的命令', () => {
  /** 清掉继承来的 ANTHROPIC_* —— 否则本机真配过 key 时这两条会假阴性 */
  const BARE = { ANTHROPIC_API_KEY: undefined, ANTHROPIC_BASE_URL: undefined };

  function projectWithEndpoint(): string {
    const dir = tmp();
    run(['init'], dir);
    writeFileSync(
      join(dir, 'harness.config.json'),
      JSON.stringify({
        appName: 'cred',
        model: 'claude-opus-5',
        endpoint: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
      }),
      'utf8',
    );
    return dir;
  }

  it('声明了 apiKeyEnv 却没有 key ⇒ 退出码 2，文案里点名那个变量', () => {
    const dir = projectWithEndpoint();
    const r = run(['run', '随便跑跑'], dir, { ...BARE, DEEPSEEK_API_KEY: undefined });

    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /缺少模型凭据：DEEPSEEK_API_KEY/);
    assert.match(r.out, /\.env/, '要告诉人 key 该放哪儿，而不是只说他缺什么');
  });

  it('同一个工程，不调模型的命令照常工作（lock / trace 不该被凭据拦住）', () => {
    const dir = projectWithEndpoint();
    const r = run(['lock'], dir, { ...BARE, DEEPSEEK_API_KEY: undefined });
    assert.equal(r.code, 0, r.out);
  });

  it('key 放 .env 就能过凭据这一关（真实环境变量优先，两者都没有才报错）', () => {
    const dir = projectWithEndpoint();
    writeFileSync(join(dir, '.env'), 'DEEPSEEK_API_KEY=sk-test\n', 'utf8');
    // 端点指向一个必然连不上的地址：要证明的是「凭据检查放行了」，
    // 而不是「真能调通」—— 后者由离线 e2e 负责
    writeFileSync(
      join(dir, 'harness.config.json'),
      JSON.stringify({
        appName: 'cred',
        model: 'claude-opus-5',
        endpoint: { baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'DEEPSEEK_API_KEY' },
      }),
      'utf8',
    );
    const r = run(['run', '随便跑跑'], dir, { ...BARE, DEEPSEEK_API_KEY: undefined });

    assert.doesNotMatch(r.out, /缺少模型凭据/, r.out);
    assert.equal(r.code, 1, `凭据过了之后应在调用阶段失败（退出码 1），实际 ${String(r.code)}`);
  });
});

describe('CLI 参数严格化', () => {
  it('未知 flag 退出码 2，并点名拼错的那个（不再静默当成没传）', () => {
    const dir = tmp();
    const r = run(['eval', '--saveh', 'x.json'], dir);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /不认识 --saveh/);
  });

  it('非数字 flag 退出码 2（--timeout abc 此前等于「不设超时」）', () => {
    const dir = tmp();
    const r = run(['eval', '--timeout', 'abc'], dir);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /--timeout 需要数字/);
  });

  it('report 的 --max-cost-growth 真的接到门上', () => {
    const dir = tmp();
    const mk = (costUsd: number) => ({
      total: 1,
      passed: 1,
      passRate: 1,
      tokens: 100,
      costUsd,
      costKnown: true,
      cases: [
        {
          name: 'c1',
          task: '任务原文',
          passed: true,
          failures: [],
          tokens: 100,
          costUsd,
          iterations: 1,
          durationMs: 1,
          stopReason: 'end_turn',
          excerpt: '',
          skills: [],
          subagents: [],
        },
      ],
      assetFingerprint: 'a',
      agent: 'main@1',
      skillHits: [],
    });
    writeFileSync(join(dir, 'base.json'), JSON.stringify(mk(0.01)), 'utf8');
    writeFileSync(join(dir, 'cand.json'), JSON.stringify(mk(0.0105)), 'utf8');

    const loose = run(['report', 'base.json', 'cand.json'], dir);
    assert.equal(loose.code, 0, loose.out);
    const tight = run(['report', 'base.json', 'cand.json', '--max-cost-growth', '0.01'], dir);
    assert.equal(tight.code, 1, tight.out);
    assert.match(tight.out, /成本/);
  });
});

it('eval --keep-traces 是合法 flag（此前只在注释里存在）', () => {
  const dir = tmp();
  run(['init'], dir);
  const r = run(['eval', '--keep-traces'], dir, {
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_BASE_URL: undefined,
  });
  assert.doesNotMatch(r.out, /不认识 --keep-traces/, r.out);
  assert.notEqual(r.code, 2, r.out);
});

describe('rsi revert <id>', () => {
  it('CLI 把 id 传到回滚逻辑：错 id 拒绝，对 id 逐字恢复', () => {
    const dir = tmp();
    run(['init'], dir);
    const config = loadConfig(dir);
    const before = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });
    const agent = before.agents[0];
    assert.ok(agent !== undefined);
    const original = readFileSync(agent.path, 'utf8');

    // 造一条「已采纳」记录，并让资产确实处于采纳后的状态
    const modified = `${agent.body}\n补上的一句。`;
    writeFileSync(agent.path, original.replace(agent.body, modified), 'utf8');
    const afterAssets = discoverAssets({ skills: config.skillsDir, agents: config.agentsDir });

    mkdirSync(join(dir, '.workspace', 'rsi'), { recursive: true });
    writeFileSync(
      join(dir, '.workspace', 'rsi', 'journal.jsonl'),
      `${JSON.stringify({
        at: Date.now(),
        proposalId: 'p-right',
        status: 'accepted',
        target: 'agent:main',
        before: agent.body,
        after: modified,
        reason: 't',
        assetsBefore: before.fingerprint,
        assetsAfter: afterAssets.fingerprint,
        kind: 'asset',
      })}\n`,
      'utf8',
    );

    const wrong = run(['rsi', 'revert', 'p-wrong'], dir);
    assert.equal(wrong.code, 1, wrong.out);
    assert.match(wrong.out, /最近一条可回滚的采纳是 p-right/);

    const right = run(['rsi', 'revert', 'p-right'], dir);
    assert.equal(right.code, 0, right.out);
    assert.match(right.out, /已回滚 p-right/);
    assert.equal(readFileSync(agent.path, 'utf8'), original);
  });
});

describe('harness evidence', () => {
  it('从报告导出分层证据；重复 id 拒绝；拼错的 flag 退出码 2', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'harness.config.json'), '{}\n');
    mkdirSync(join(dir, '.workspace'), { recursive: true });
    writeFileSync(
      join(dir, '.workspace', 'traces.jsonl'),
      `${JSON.stringify({
        traceId: 't-ev',
        rootSpanId: 's0',
        spans: [],
        status: 'ok',
        totalUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      })}\n`,
    );
    writeFileSync(
      join(dir, '.workspace', 'report.json'),
      JSON.stringify({
        total: 1,
        passed: 0,
        passRate: 0,
        tokens: 2,
        costUsd: 0.01,
        costKnown: true,
        assetFingerprint: 'fp',
        agent: 'main@1',
        skillHits: [],
        cases: [
          {
            name: 'a',
            task: '任务甲',
            split: 'train',
            passed: false,
            failures: ['正文缺少 "x"'],
            tokens: 2,
            costUsd: 0.01,
            iterations: 1,
            durationMs: 1,
            stopReason: 'end_turn',
            excerpt: '输出',
            traceId: 't-ev',
            skills: [],
            subagents: [],
          },
        ],
      }),
    );

    const first = run(
      ['evidence', '--from-report', '.workspace/report.json', '--id', 'ev-cli'],
      dir,
    );
    assert.equal(first.code, 0, first.out);
    const corpus = join(dir, '.workspace', 'evidence', 'ev-cli');
    assert.ok(existsSync(join(corpus, 'overview.md')));
    assert.ok(existsSync(join(corpus, 'index.json')));
    assert.match(readFileSync(join(corpus, 'overview.md'), 'utf8'), /\[a\]/);

    const again = run(
      ['evidence', '--from-report', '.workspace/report.json', '--id', 'ev-cli'],
      dir,
    );
    assert.equal(again.code, 1, again.out);
    assert.match(again.out, /不覆盖历史证据/);

    const typo = run(
      ['evidence', '--from-report', '.workspace/report.json', '--id', 'x', '--oops'],
      dir,
    );
    assert.equal(typo.code, 2, typo.out);
    assert.match(typo.out, /不认识 --oops/);
  });
});

describe('harness rsi --remote', () => {
  it('明确拒绝并说明理由（不是「不认识这个 flag」）', () => {
    const dir = tmp();
    run(['init'], dir);
    // 把 apiKeyEnv 指向一个没有值的变量：否则 `assertEndpointKey` 会在
    // `ANTHROPIC_API_KEY` 上直接放行，这条断言就永远绿（空跑过一轮才发现）
    const cfgPath = join(dir, 'harness.config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      cfgPath,
      JSON.stringify(
        { ...cfg, endpoint: { ...(cfg.endpoint as object), apiKeyEnv: 'PROBE_MODEL_KEY' } },
        null,
        2,
      ),
    );

    const r = run(['rsi', '--remote', 'http://127.0.0.1:18080'], dir, {
      PROBE_MODEL_KEY: undefined,
    });
    assert.equal(r.code, 2);
    // 「不认识 --remote」会让人以为只是没接线，去提 issue 或自己 hack；
    // 真实原因是结构性的：改本地资产对远程零影响
    assert.doesNotMatch(r.out, /不认识 --remote/);
    assert.match(r.out, /改资产/);
    assert.match(r.out, /harness eval --remote/, '要给一条语义正确的替代路径');
    // 凭据闸必须排在它后面：否则用户先被叫去配 key，配完才被告知「这个组合不支持」
    assert.doesNotMatch(r.out, /缺少模型凭据/);
  });

  it('--watch 与子命令都不能绕过它（否则就是「静默无视 --remote」）', () => {
    const dir = tmp();
    run(['init'], dir);
    for (const argv of [
      ['rsi', '--watch', '--remote', 'http://127.0.0.1:18080'],
      ['rsi', 'status', '--remote', 'http://127.0.0.1:18080'],
    ]) {
      const r = run(argv, dir);
      assert.equal(r.code, 2, `${argv.join(' ')} 应被拒`);
      assert.match(r.out, /不能用 --remote/, `${argv.join(' ')} 的报错要指明是结构性问题`);
    }
  });
});

describe('--remote 与本地凭据闸', () => {
  it('远程评测不需要本地模型 key（本地一次都不调）', async () => {
    const dir = tmp();
    run(['init'], dir);
    // 指向一个一定连不上的地址：要验的是「没有 key 也不该在凭据闸上停下」，
    // 而不是「它能连上」—— 报错文案里出现「缺少模型凭据」就是顺序错了
    const r = run(
      ['eval', '--remote', 'http://127.0.0.1:1', '--token-env', 'HARNESS_PROBE_TOKEN'],
      dir,
      {
        // 显式抹掉继承来的 key：不抹的话这条测试在有 key 的机器上永远绿，等于没测
        DEEPSEEK_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
        HARNESS_PROBE_TOKEN: 'dummy',
      },
    );
    assert.doesNotMatch(r.out, /缺少模型凭据/);
  });

  it('--watch 与子命令都不能绕过它（否则就是「静默无视 --remote」）', () => {
    const dir = tmp();
    run(['init'], dir);
    for (const argv of [
      ['rsi', '--watch', '--remote', 'http://127.0.0.1:18080'],
      ['rsi', 'status', '--remote', 'http://127.0.0.1:18080'],
    ]) {
      const r = run(argv, dir);
      assert.equal(r.code, 2, `${argv.join(' ')} 应被拒`);
      assert.match(r.out, /不能用 --remote/, `${argv.join(' ')} 的报错要指明是结构性问题`);
    }
  });
});
