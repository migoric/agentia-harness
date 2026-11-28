#!/usr/bin/env node
/**
 * 版本一致性检查与升版。
 *
 * 为什么不用 changesets：这个仓只有一个包、一份手写的 CHANGELOG，而且 CHANGELOG 里
 * 写的是「为什么这么改」，不是「改了哪些 API」—— changesets 的核心价值（多包联动 +
 * 从 fragments 自动拼 changelog）在这里都不成立，装它等于多一个要维护的东西。
 *
 * 真正的风险只有一个：**版本号与 CHANGELOG 错位**。两组症状都很常见 ——
 * `package.json` 升了但忘了写 CHANGELOG（发布页上是空的一节），或者写了
 * `## [0.5.0]` 却没升包版本（发出去的还是 0.4.0）。两者的共同点是**发布之后才发现**，
 * 而 npm 的版本一旦发出去就撤不回来。
 *
 * 用法：
 *   node scripts/version.mjs               # 检查（挂在 npm run check 里）
 *   node scripts/version.mjs --bump minor  # 升版：改写 package.json + 把 Unreleased 落成版本节
 */
import { readFileSync, writeFileSync } from 'node:fs';

const pkgPath = new URL('../package.json', import.meta.url);
const clPath = new URL('../CHANGELOG.md', import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const changelog = readFileSync(clPath, 'utf8');

function fail(msg) {
  console.error(`错误：${msg}`);
  process.exit(1);
}

function headings() {
  return [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]);
}

function cmp(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

function check() {
  const all = headings();
  const released = all.filter((h) => /^\d+\.\d+\.\d+$/.test(h));
  if (released.length === 0) fail('CHANGELOG.md 里没有任何 `## [x.y.z]` 版本节');

  // 重复版本号：手工合并分支时最容易出现，而它的症状是「两节都写着改了同一件事」
  const dup = released.filter((h, i) => released.indexOf(h) !== i);
  if (dup.length > 0) fail(`CHANGELOG.md 里版本号重复：${[...new Set(dup)].join(', ')}`);

  // 顺序：最新在上。写反了不会有人发现，直到某天按「取第一节」发布了一个旧版本
  for (let i = 1; i < released.length; i += 1) {
    if (cmp(released[i - 1], released[i]) < 0) {
      fail(
        `CHANGELOG.md 版本节顺序不对：${released[i - 1]} 在 ${released[i]} 上面（最新应在最上）`,
      );
    }
  }

  if (all[0] !== 'Unreleased' && all[0] !== released[0]) {
    fail(`CHANGELOG.md 第一节是 "${all[0]}"，既不是 Unreleased 也不是版本号`);
  }
  if (released[0] !== pkg.version) {
    fail(
      `package.json 是 ${pkg.version}，CHANGELOG 最新版本是 ${released[0]}。\n` +
        '  两边的修法不同：\n' +
        `    - 还没发版 ⇒ 把 CHANGELOG 里那节改成 Unreleased，或 \`npm run bump\` 升版\n` +
        `    - 已经发版 ⇒ 把 package.json 改成 ${released[0]}`,
    );
  }
  console.log(`版本一致：${pkg.version}（CHANGELOG ${released.length} 个版本节）`);
}

function bump(level) {
  if (!['patch', 'minor', 'major'].includes(level)) {
    fail('--bump 需要 patch / minor / major 之一');
  }
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  const next =
    level === 'major'
      ? `${major + 1}.0.0`
      : level === 'minor'
        ? `${major}.${minor + 1}.0`
        : `${major}.${minor}.${patch + 1}`;

  const date = new Date().toISOString().slice(0, 10);
  // 只改第一节的标题：`[Unreleased]` 就是「待发布的那些改动」，
  // 升版这件事在文本上恰好等于把它命名为一个版本
  if (!/^## \[Unreleased\]/m.test(changelog)) {
    fail(
      'CHANGELOG.md 里没有 `## [Unreleased]` 一节 —— 先补一节再升版（否则这一版的改动没有落点）',
    );
  }
  const nextCl = changelog.replace(/^## \[Unreleased\]/m, `## [${next}] - ${date}`);
  writeFileSync(clPath, nextCl, 'utf8');
  writeFileSync(pkgPath, `${JSON.stringify({ ...pkg, version: next }, null, 2)}\n`, 'utf8');
  console.log(
    `已升版：${pkg.version} → ${next}（CHANGELOG 的 Unreleased 变成 [${next}] - ${date}）`,
  );
  console.log('下一步：补一版 CHANGELOG 正文 → npm run check → git commit → npm publish');
}

const i = process.argv.indexOf('--bump');
if (i === -1) check();
else bump(process.argv[i + 1]);
