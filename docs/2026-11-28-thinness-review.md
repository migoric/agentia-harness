# Harness 工程厚度 review（2026-11-28）

> 触发：作者直觉「harness 的工程还是略轻薄了一些」。
> 方法：全仓实测（覆盖率、注释密度、测试/源码比、模块清单、CI 配置、依赖面），
> 逐项核对而不是凭印象。所有数字可用本文末尾的命令复现。

## 结论

**代码层不薄，测量层薄。**

> **状态更新（同日）**：3.1（重复采样 + 区间判定）与 3.2（覆盖率门禁）已实施并进了门禁，
> 见 `CHANGELOG.md` 的 `[Unreleased]`。3.3 / 3.4 / 3.5 仍是缺口。

判断依据不是行数，而是「测量的地基有多深」。harness 的整个价值主张是给 agent 的改动
一个可信的判据（`gate` 有否决权），而这个判据建立在**每条用例单次采样、且不控制采样
温度**之上。全仓没有一处测量噪声，却有一整套机制在对噪声做显著性判断。

代码质量维度反而是这个仓最强的地方（见第二节）。所谓「轻薄感」来自：**机制很密，
但都围着一次观测转**。

## 一、实测画像

| 指标 | harness | agentia（引擎） | 读数方式 |
|---|---|---|---|
| 源码 | 104 文件 / 15,658 行 | 125 / 27,921 | `find src -name '*.ts'` |
| 测试 | 44 文件 / 11,695 行 | 197 / 53,424 | 同上 |
| 测试/源码（行） | **0.75** | **1.91** | 比值 |
| 测试/源码（文件） | **0.42** | **1.58** | 比值 |
| 断言数 | 1,356 | — | `grep assert.` |
| 行覆盖 | **93.61%** | — | `--experimental-test-coverage` |
| 分支覆盖 | **85.36%** | — | 同上 |
| 函数覆盖 | **95.04%** | — | 同上 |
| 注释密度 | **26.9%**（4,208 行） | — | 注释行/总行 |
| `any` / `@ts-ignore` / `TODO` | **0 / 0 / 0** | — | grep |
| lint | Biome recommended + `noExplicitAny: error` | — | `biome.json` |
| tsconfig | `strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` + `noImplicitOverride` + `verbatimModuleSyntax` | — | `tsconfig.json` |
| 运行时依赖 | 1 个（`@migor/agentia`） | — | `package.json` |

一句话：**15.7k 行源码里有 4.2k 行在解释为什么这么做**，有效代码约 11.4k。密度高、口径细、
文档重；测试量只有引擎的 2/5。

## 二、不薄的地方（先排除误判）

这四项不是「看起来还行」，是实测确实扎实：

1. **类型纪律**：0 个 `any`、0 个 `@ts-ignore`，且开了 `exactOptionalPropertyTypes` +
   `noUncheckedIndexedAccess`。这两项是最容易被关掉的严格开关，这里一直开着。
2. **覆盖率均匀**：全仓 93.6%，逐文件最差是 `config-balance.ts` 77.27%（本次新增），
   其余全部 ≥ 91.6%。这不是「主路径覆盖、分支靠猜」的形态。
3. **语义口径**：三态（`usd`/`tokens`/`blind`）、「缺席 ≠ 空数组」、「下界不是精确值」、
   `sameCaseSet` 的 `undefined` 与 `true` 分开、`onlyInBaseline` 单独报
   `case_set_changed`。这些是**踩过坑之后写下来的**，不是设计文档里的漂亮话。
4. **结构守卫**：`tests/architecture.test.ts` 守 400 行上限与依赖方向；`loop.ts` 涨到 461 行
   时被它逼出 `spender.ts` / `cycle-sink.ts` / `target-filter.ts`。守卫真的在工作。

另外，下面这两点我原本怀疑是缺口，核对后**不成立**，撤掉：

- 评测报告**有** `schemaVersion` + 读侧 `reportSchemaVersion()` 迁移入口（`evals/types.ts:233`）；
- 轮次记录**有** `schema` 标记 + `journal-repair` 修复测试。

## 三、真薄的地方

### 3.1 测量没有噪声模型（唯一「薄到影响正确性」的一处）

事实：

- 全仓（含引擎）**没有一处设置 `temperature` / `seed`** —— 采样参数走 SDK 默认（Anthropic
  系默认 `1.0`，即最大随机性）。
- 报告里**没有温度字段**（`EvalReport` 有 `model` / `models` / `harnessVersion` /
  `caseFingerprint`，没有采样参数），所以事后也无法判断两份报告是不是同一套采样条件。
- 每条用例**只跑一次**：全仓无 `repeat` / N 次采样，`passRate` 是单点估计。
- `gate` 自己写了「`sameAssets: true` 说明结论只反映采样随机性，调用方应重跑」——
  **知道病在哪，但没有机制**：它返回一个布尔值，把责任推给操作者。
- `holdout` 的 `SMALL_SAMPLE = 3` 管的是**用例条数**，不是**每条用例的重复次数**，
  两者不是一件事：3 条用例各跑 1 次，与 1 条用例跑 3 次，噪声完全不同。

后果不是「不够严谨」，是**判据可能指向错的方向**：88% → 92% 在 n=20 时的一次采样差
完全可能是噪声，`pass_rate_dropped` 会据此否决一个好提案；反过来一次「进步」被接受、
写进账本、成为下一轮的先验（`lessons`），错误就此复利。RSI 的整套学习信号都建在这一层上。

这一处薄，是**结构性**的。补法见第四节第 1 项。

### 3.2 覆盖率没有门禁，正在被稀释

`ci.yml` 只跑 `npm run check`（typecheck + lint + test + build），**不跑
`--experimental-test-coverage`，也没有阈值**。

本次读数 93.61%，但最新加的 `config-balance.ts` 已经是 77.27% 行 / 58.33% 分支 ——
新代码正在拉低均值。没有门禁时，93.6% 只是「这次碰巧」，两三个模块之后就是 89%，
而没人会注意到，因为没有任何一次 CI 报过这个数。

补法是一行配置的量级。

### 3.3 真模型路径不在 CI

`npm run e2e:offline` + `scripts/fake-anthropic.mjs` 覆盖了真实 HTTP 客户端（fetch / SSE /
重试 / usage→成本），这是聪明的做法。但它验证的是**协议实现**，不是**外部世界**：

- 端点改 `usage` 字段形状、改错误码、改分时计价 → 全绿；
- 模型侧行为漂移（同一提示词输出变差）→ 全绿。

真 key 的验证目前只发生在我手动跑的时候（`balance` 真机、`patch --eval` 真机）。这类验证
有成本，所以不该进每次 CI，但没有 nightly 就等于「从来不跑」。

### 3.4 没有时间维度

报告是**孤立文件**。`observe` 比两份文件，`rsi` 比基线一份，`cycles` 有账本但那是 RSI 的
轮次，不是**用例级**的历史：

- 同一用例这周挂、下周过 —— 无法判断是抖动还是真变化（没有 per-case 历史通过率）；
- 没有 `flaky` 概念，也就没有「这条用例不可信，先别拿它当判据」的机制；
- 成本/延迟没有时间序列，`maxTokens` 只能做单条用例的硬上限，看不到整体趋势。

这是评测台与「跑一次脚本」的分界线：**评测台的价值一半在趋势**。

### 3.5 工程外围

| 项 | 现状 | 影响 |
|---|---|---|
| 版本发布 | 手写 `CHANGELOG.md` + 手改 `package.json`，无 changesets | 上版依赖人肉顺序，易漏 |
| 示例 | 只有 `examples/starter` 一个 | 无法证明「换一种工程形态也能跑」，泛化未验证 |
| 并发 | `--concurrency` 默认 1，未测过多并发下的限流/背压/公平性 | 大评测集只能串行，实际吞吐未知 |
| 自造轮子 | 参数解析、HTTP 服务、模板、渲染（`cli/render.ts` 326 行、`server/page*.ts` 480 行）全靠自己 | 好处是零依赖；代价是边界情况全靠自己测，且这类代码天然是测试盲区（UI/渲染 480 行只有 `server.test` 与 `web.test` 间接覆盖） |

## 四、如果只做三件事

按「单位投入的收益」排序：

**1. `--repeat N` + 方差 + 用区间判定（唯一动到正确性的一件）**

- `run-one` 已经支持 `retries`，加 `repeat` 是同一处的小改：跑 N 次，聚合 `passRate` 均值
  与标准差；
- 报告新增 `passRateStd` / `samples`（可选字段，老报告自动退化为 `samples: 1`）；
- `gate` 的 `pass_rate_dropped` 改为**区间不重叠**才否决（或 n 小的时候只报不拦，与
  `SMALL_SAMPLE` 同一套哲学：**置信度不够就说，但不假装确定**）；
- 顺带把采样参数写进报告（`temperature` / `seed`），否则下一次还是无法回答
  「这两份报告可比吗」。
- 不改任何既有语义，只让点估计变成区间估计。

**2. 覆盖率阈值进 CI（一行）**

```json
"test": "node --experimental-test-coverage --test-coverage-exclude='tests/**' --test-coverage-lines=90 --test-coverage-branches=80 --import tsx --test 'tests/**/*.test.ts'"
```

当前 93.48 / 85.37，留 3/5 个点余量，够日常写新代码，又拦得住「新模块 77%」这种滑坡。

两个实测出来的注意点：

- 阈值**按整体算**：只跑单个测试文件时分母变小，51% 的读数必然失败（已验，EXIT=1）。
  所以这条只能挂在全量 `test` 上，不能给 `test:watch` 之类复用；
- 不加 `--test-coverage-exclude='tests/**'` 时，报告会把 `tests/` 自身也计入分母，
  数字被测试代码本身稀释 —— 看不出 `src/` 的真实水位。

**3. nightly 真模型 3 条用例**

挑最便宜的三条（无工具、单轮、短输出），断言两件事：通过 + 总成本 < 阈值（比如 ¥0.1）。
失败即说明「外部世界变了」或「价格表过期了」—— 这两种病目前都只能在线上发现。

## 五、不建议做的事

- **不要引入 LLM judge**。`evals/types.ts` 开头那句「裁判不确定，RSI 就会把随机波动当进步」
  是对的；加 judge 会让 3.1 的问题放大十倍。
- **不要为了「厚」加依赖**。1 个运行时依赖是资产，不是缺点；自造轮子的成本已经付过了。
- **不要放宽 holdout 阈值**。`SMALL_SAMPLE` 只加提示不放宽阈值，这个取舍是对的，别改。

## 六、落地（同日）

五处里动了四处，另一处（3.1 的采样参数）并进了 3.4 的账本 —— 因为「两次跑分可比吗」
最终要靠事实回答，而不是靠记录一个 `temperature` 值。

| 缺口 | 落了什么 | 入口 |
| --- | --- | --- |
| 3.1 无噪声模型 | `--repeat n` + Wilson 区间 + 两比例 z 检验；门只在显著时否决 | `docs/evals.md`「重复采样」 |
| 3.2 覆盖率无门禁 | 阈值写进 `npm test`（只统计 `src/`，87/79/88） | `package.json` |
| 3.3 真模型不在 CI | 三条最便宜用例 + 成本/单价/token 三道上限，每天一次 | `scripts/nightly.mjs`、`.github/workflows/nightly.yml` |
| 3.4 没有时间维度 | JSONL 账本 + `harness history` + 抖动用例不再有否决权 | `docs/evals.md`「历史与抖动」 |
| 3.5 工程外围 | 第二个示例（两技能 + 多轮 + 留出集）、版本一致性检查、并发顺序 e2e | `examples/pipeline`、`scripts/version.mjs` |

**没做的两件，以及为什么：**

- **changesets**。这仓只有一个包、一份手写 CHANGELOG，而 CHANGELOG 写的是「为什么这么改」。
  changesets 的价值在多包联动与从 fragments 拼 changelog，这里都不成立。真正的风险是
  「版本号与 CHANGELOG 错位」，一个 90 行的 `scripts/version.mjs` 就锁住了。
- **per-case 绑定 agent**。多 agent 工程现在只能「整轮换 agent + `--only` 挑用例」。
  改成本要动 `runSuite` 的 runner 装配、`report.agent` 的语义与门的 `sameAgent` 判据 ——
  收益是省一个 flag，代价是把一条已经在跑的数据流拆开。记在这里，不当成疏忽。

## 附：复现

```bash
# 覆盖率
node --experimental-test-coverage --import tsx --test 'tests/**/*.test.ts' | tail -5

# 规模
find src -name '*.ts' -exec wc -l {} + | tail -1
find tests -name '*.test.ts' -exec wc -l {} + | tail -1

# 采样参数（预期无输出 —— 这正是 3.1 的证据）
grep -rn 'temperature\|seed\|topP' --include=*.ts src/ ../agentia/src/

# 注释密度
find src -name '*.ts' -exec cat {} + | grep -cE '^\s*(//|/\*|\*)'
```
