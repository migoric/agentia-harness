# 第二遍框架评审：内聚 / 耦合 / 可维护 / 鲁棒

- 评审日期：2026-11-24
- 评审对象：`agentia-harness`（src 8,409 行、291 条测试），基线提交 `5341627`
- 评审视角：agent 运行时设计、算法评测、软件设计、服务设计四个角度交叉
- 方法：全量读 `src/`；用脚本算**文件级值导入图**（Tarjan 求环、扇入/扇出）、**配置字段使用分布**、**函数体量**；对三条鲁棒性怀疑做**可执行复现**（不是读码推断）
- 与 2026-11-21 那版的关系：上一版结论「可以放心作为基座」在**分层与职责边界**上仍然成立；这一版补的是它没量化、也没测过的部分——**读取层的鲁棒性**、**参数袋耦合**、**成本账的状态分散**

---

## 一、总体结论

**架构骨架是好的，问题集中在「读取层」和「胖上下文」两处，且都属于「改起来机械、但放久了会长成结构性债务」的类型。**

三句话：

1. **依赖方向没有失守**：脚本实测 **0 条值导入环**，层间无反向依赖（`evals/run → rsi` 为 0），架构测试守着 4 条方向约束。这在一个 8.4k 行、10 个子系统的仓里不常见。
2. **内聚在「文件粒度」上被高估了**：上一版给了内聚 ★★★★★，但按职责数看，`evals/run.ts`（编排 + 单用例执行 + 断言引擎）、`rsi/loop.ts`（`runCycle` 一个函数 223 行办 6 件事）、`config.ts`（20 字段参数袋）都不满足「一个模块一个变化原因」。评 B 更准确。
3. **最脆的是磁盘数据的读取**：`journal.jsonl` 与 `cycles/*.json` 全部 `JSON.parse(...) as T` 直接吃，没有一处形状校验、没有 `schemaVersion`、坏一行就永久卡死整个 RSI（已实测）。这是**唯一一条我认为必须马上修**的问题。

| 维度 | 评分 | 依据 |
|---|---|---|
| 分层与依赖方向 | **A** | 0 值环；层间无反向；`tests/architecture.test.ts` 四条断言在守 |
| 模块内聚 | **B** | `run.ts` 三职责；`runCycle` 223 行 / 6 个阶段；`config` 参数袋 |
| 耦合 | **B−** | 21 个消费者里 18 个只读 1–3 个字段（均值 1.4）；`process.env` 构造期写全局 |
| 可维护性 | **B+** | 注释记录了「为什么」与事故史（罕见的高水位）；但接口契约靠散文（`Proposer` 的读取时序） |
| 鲁棒性 | **C+** | 磁盘数据零校验（实测 `SyntaxError` / `TypeError` 直达调用方）；半截行不可恢复 |
| 强壮性 / 可演进 | **B−** | 无 `schemaVersion`；`AssetSet` 快照不随采纳刷新（`rounds.ts` 用重新 discover 兜） |
| 测试与门禁 | **A−** | 291 条 + e2e 26/26；但「坏数据」「取消」「坏请求体」三类路径没有测试 |

---

## 二、实测数据（可重跑）

### 2.1 依赖图

```
值导入环：0
层间反向依赖：0（assets→上层 0；util→业务 0；run/evals→rsi 0）
扇入最高：errors.ts 34 · config.ts 24 · assets/types.ts 16 · rsi/types.ts 16 · evals/types.ts 14
扇出最高：index.ts 35 · cli/commands/rsi.ts 17 · rsi/loop.ts 15 · cli.ts 15 · evals/run.ts 12
```

`errors` / `types` 高扇入是**正确**的（错误码与领域类型是公共词汇表）。`config` 扇入 24 需要单独看，见 §3.4。

### 2.2 配置对象的使用分布

```
配置字段总数：20
消费者：21 个文件
平均使用字段：1.4
只用 1 个字段：11 个      只用 ≤3 个：18 个
仅使用路径字段（root/skillsDir/agentsDir/evalsDir/lockPath/workspaceDir/tracesPath）：18 个
```

也就是说：**18 个模块为了读 1–3 个字符串，拿到了 20 个字段的全部可达性。**

### 2.3 函数体量（前 5）

```
119 行  src/evals/run.ts        runOne       （执行 + 超时合并 + 成本折算 + 失败构造）
 223 行 src/rsi/loop.ts         runCycle     （基线 → 归因 → 提案 → 验证循环 → 留出集 → 采纳）
 90 行  src/server/serve.ts     handle       （路由 + 鉴权 + 限额 + 排队 + 超时 + 序列化）
 54 行  src/cli/render.ts       renderComparison
 48 行  src/rsi/regress.ts      findCandidate
```

`runCycle` 不在「单文件 ≤400 行」守卫的射程内（文件 330 行），所以它长得下来。

---

## 三、P0：读取层（坏起来不可自愈）

### 3.1 `journal.jsonl` 半截行会让整个 RSI 永久不可用

`readJournal` 对每一行裸解析，没有 try/catch：

```ts
// src/rsi/journal.ts:30-34
return text.split('\n').filter((l) => l.trim() !== '')
  .map((l) => withKind(JSON.parse(l) as JournalEntry));
```

实测（临时目录 + 一行完整 + 一行半截）：

```
journal 半截行 → SyntaxError | Unterminated string in JSON at position 23
```

影响链：`readJournal` 被 `accept` / `regress` / `ledger` / `loop` 全部消费，所以一次 `appendFileSync` 中途被杀（断电、OOM、Ctrl-C 恰好落在写系统调用中间）之后，**`rsi accept`、`rsi regress`、`rsi ledger`、`rsi cycle` 全部失败**，错误还没有 `code`（`describeError` 只印 message，CLI 退出码 1），且**没有任何修复命令**。

这是本仓唯一一处「原子写只保护了一半」的地方：`atomicWrite`（tmp+rename）保护了 cycle/proposal/资产，而 append-only 的 journal 用的是裸 `appendFileSync`——它的「半截」不会损坏旧数据，但会挡住读。

修法（小，约 40 行）：读取时区分「末行半截」与「中间行坏了」——

- 末行且文件不以 `\n` 结尾 ⇒ 视为中断的半次追加，抛 `HarnessError('rsi.no_signal')` 并给出可执行建议；
- 新增 `harness rsi journal --repair`：备份原文件后截断到最后一个完整行（只允许截尾，绝不重写中间）。

### 3.2 同一份 `cycles/` 有两份读实现，且健壮性不一致

| 位置 | 解析 | 形状校验 | 坏数据表现 |
|---|---|---|---|
| `rsi/regress.ts:150-175` | `JSON.parse as CycleReport` | 有（`Array.isArray(report.verified)`） | `HarnessError('rsi.no_signal')` |
| `rsi/ledger.ts:215-232` | `JSON.parse as CycleReport` | 无 | **`TypeError: report.verified is not iterable`**（实测） |

两条错误文案还各自写着「拒绝跳过它」，说明这是**同一条策略的两份拷贝**。修法：抽 `rsi/cycles.ts` 作为读取仓储（`readCycles(config): CycleRecord[]`，内部做形状校验 + 未来 schema 迁移），`findCandidate` 与 `loadOutcomes` 改为消费它。顺带把「坏记录怎么办」收敛成一处决策。

### 3.3 磁盘数据没有版本，全靠 `as` 断言

`journal` / `cycles` / `EvalReport` 三处都是「写的人知道形状，读的人假装知道」。目前靠两个默契活着：

- 新字段一律可选（`EvalReport.model?` / `harnessVersion?` / `caseFingerprint?`）；
- 老记录靠读侧宽容（`withKind` 补 `kind`、`cycleTime` 从 id 反解时间）。

默契能用，但**没有一处集中的迁移点**：`withKind` 在 journal 里，`cycleTime` 在 ledger 里，`at` 的缺失处理在 ledger 里又是第三处。建议：写入带 `schema: 2`，读取统一在第 3.2 条的仓储里「按版本补默认」，并把 `withKind` / `cycleTime` 迁进去。这是一次性动作，越晚做摊子越大。

---

## 四、P1：耦合与内聚

### 4.1 `HarnessConfig` 是 20 字段参数袋（量化见 §2.2）

`rsi/paths.ts` 是这条问题的微缩样本：整个文件只为拿 `workspaceDir` 一个字符串，却接收整个 `HarnessConfig`。它当初的目的是断环（`loop ↔ ledger`），断得很对；但它同时示范了一种传染性写法——「需要点东西就把 config 传进去」。

代价不是性能，是**变更半径**：新增一个配置字段，所有持有 config 的模块都自动获得读它的能力；测试夹具必须构造全量配置（`tests/` 里大量 `loadConfig(project())` 就是这个形状）；「这个模块到底依赖哪些配置」这个问题在类型上无法回答。

修法（机械、类型系统会指路）：

```ts
export interface WorkspacePaths { root; skillsDir; agentsDir; evalsDir; lockPath; workspaceDir; tracesPath }
export interface ModelSettings { model?; maxIterations?; maxCostUsd?; pricing; baseURL?; apiKeyEnv }
export type HarnessConfig = WorkspacePaths & ModelSettings & { appName; codeVerify; codeVerifyTimeoutMs; serverApiKeyEnv?; serverMaxQueue };
```

然后让 18 个「只读路径」的消费方签名收窄到 `WorkspacePaths`。这不会破坏公共面（`HarnessConfig` 仍是全集），但会让新增字段不再无声扩散。

### 4.2 成本账是散落的可变累加 + 时序耦合的 getter

`runCycle` 里同一件事写了 11 次：

```
spent +=            4 处（loop.ts:106/156/202/245）
costKnown = &&      4 处（107/157/203/246）
budgetStopped       3 处（168/226 + 末尾合流）
```

每新增一个花钱阶段（历史上就漏过一次：提案成本后补），必须记得改 4 行；漏一行的症状是**预算闸静默偏低**，而它不会报错，只会多花钱。

更隐性的耦合在 `Proposer`：

```ts
// src/rsi/loop.ts:145-157
const proposals = await opts.proposer.propose({...});
const proposalCost = opts.proposer.costUsd;   // 必须在 propose 之后读
```

「必须先 propose、再读 costUsd、且实现必须在每次 propose 开头重置」这条契约**只写在注释里**。`rounds.ts` 已经为此付出代价：它必须每轮 `makeProposer(i)` 造新实例，并在接口注释里写「提案器带累计花费状态，复用会把两轮的账并成一条」——一个 `Proposer` 实现忘了重置，两轮成本就会翻倍，而门与预算都不会报错。

修法：

```ts
propose(ctx): Promise<{ proposals: Proposal[]; cost?: { usd: number | undefined; known: boolean } }>
```

再配一个 `Budget` 值对象（`charge()` / `exceeded()` / `snapshot()`）。收益不只是少几行：`Budget` 可以单测，「成本未知 ≠ 免费」的口径只在一个地方实现。

### 4.3 取消传播在「提案」这一步断了

| 阶段 | 是否接 `signal` |
|---|---|
| `runSuite`（基线/候选） | 是 |
| `verifyProposal` | 是 |
| `validateHoldout` | 是 |
| `proposer.propose` | **否**（`loop.ts:145` 未传；`ProposeContext` 无该字段） |
| `LlmProposer.ask → app.run` | **否**（`propose.ts:195` 只传 `client`） |

上游明确支持（`dist/engine/types.d.ts:162`：「中止则本回合结束后以 `stopReason='aborted'` 收尾」）。所以在 `--max-cost` 逼近上限或用户 Ctrl-C 时，最坏情况还要再跑 `maxModes`（默认 3）次模型调用才停——**「说停还在花钱」**，恰好打在 RSI 最在意的成本归因上。

修法很小：`ProposeContext.signal?` → `ask` → `app.run({ signal })`，加一条「abort 后不再调用第二次模型」的测试。

### 4.4 `applyEndpointEnv` 在构造函数里写 `process.env`

`run/endpoint.ts:41-49` 把配置搬进 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`；`createRunner` 与 `LlmProposer` 构造时各调一次（这是上一轮为修「库用法下端点是静默的」而加的，方向正确）。

但它带来两个结构后果，现在只是「没人踩」：

1. **进程级全局**：同进程里两个 config（多租户、测试并行）第一个赢；
2. **构造即副作用**：`new LlmProposer(config)` 会改环境变量，测试顺序敏感。

短期（可接受）：把它重命名为 `ensureEndpointEnv`，在文档与接口注释里钉死「进程级、幂等、只写一次」，并在测试里用 `--test-concurrency=1` 或显式快照/还原环境。
长期（真正的解）：让 agentia 支持显式注入 `baseURL`/`apiKey` 的 client 工厂，harness 就不再需要改环境。这条应作为**上游诉求**记下来，而不是在 harness 里再绕。

---

## 五、P2：可维护性与服务面

| # | 问题 | 证据 | 修法 |
|---|---|---|---|
| 5.1 | `evals/run.ts` 三职责：编排 + `runOne`（119 行）+ 断言引擎 `check` + 一个 re-export | `src/evals/run.ts:1-22,150-270` | 拆 `evals/check.ts`（纯判定）、`evals/run-one.ts`；`run.ts` 只留 `runSuite` |
| 5.2 | `/v1/run` 的超时**包含排队时间**：gate 在入队前创建 | `serve.ts:212` 创建 → `215` 入队 → `224` race | 把 gate 移进 `queue()` 回调（从真正开始执行起算），或明确文档化为「端到端预算」 |
| 5.3 | 坏 JSON 请求体报 `run.failed` → 422 | `serve.ts:334` + `statusOf` | 新增 `run.bad_request` → 400；`run.failed` 只留给执行失败 |
| 5.4 | 500 回显内部 `e.message`（可能含绝对路径） | `serve.ts:262-266` | 非 `HarnessError` 只回「internal error」+ 本地日志留全量 |
| 5.5 | `acceptProposal` 返回 `void`，内存 `AssetSet` 不刷新 | `rounds.ts:118-123` 靠重新 `discoverAssets` 兜 | 返回 `{ asset, set }`，让「谁拥有资产生命周期」有答案 |
| 5.6 | server 的 `Runner` 与资产快照 = 进程生命周期 | `serve.ts:84` | `/health` 现读指纹，或提供 `POST /v1/reload`（RSI 采纳后服务端仍在用旧 prompt） |

---

## 六、上一版评审的遗留项（逐条核对，不凭记忆）

| 编号 | 内容 | 状态 |
|---|---|---|
| F1 | 删本地 `mapLimit` 用上游 `mapWithConcurrency` | **已闭环**（`19aa9b8`，附带修掉 `limit=NaN` 静默丢用例） |
| F4 | `endpoint` 段在库入口也落地 | **已闭环**（`15347a4`） |
| F3 | `EvalCase`/`EvalReport` 与 agentia 同名不同形 | **仍在**；改名窗口越来越小（0.2.0 时最便宜） |
| F6 | 提案器不落 trace | **仍在**（`propose.ts` 无 sink；RSI 唯一用 LLM 的一步不可回查） |
| F7 | 架构守卫只扫 `from '...'` | **仍在**（当前无副作用/动态 import，属潜在盲区而非现存违规） |
| F8 | `.workspace/` 只增不减 | **仍在**（cycles/journal/evidence 无轮转、README 也未写「可整体删除」） |

---

## 七、不建议改的（避免用「优雅」换掉「可信」）

- **布尔 `passed`、无 LLM judge、无加权总分**：这是 RSI 可解释性的地基，换成评分档等于把最贵的性质换掉。
- **单变量采纳、留出集只跑一次、乐观锁指纹**：纪律比效率重要，不动。
- **`server` 只做一层缝**：不做会话/审批/SSE/多租户。缺的是运维面，不是产品面。
- **400 行 / 无环 / 分层三条守卫**：继续守，只补 `import type` 与副作用 import 的覆盖。

---

## 八、三批修复计划（每批自带验收）

**第一批 · 读取层（P0，1 天）**

1. `readJournal` 半截行 → `HarnessError` + `rsi journal --repair`；
2. 抽 `rsi/cycles.ts` 仓储，`regress`/`ledger` 改为消费；坏记录行为统一；
3. 写入带 `schema: 2`，读取集中迁移。

验收：`npm run check` 全绿且新增 ≥6 条（坏末行、坏中间行、缺 `verified`、缺 `at`、老版本记录、repair 幂等）；三处变异必红（去掉末行判定 / 去掉形状校验 / 迁移函数写错版本）。
可复现证据：本文 §3.1、§3.2 的两条实测输出应在修复后变成 `HarnessError`。

**第二批 · 成本与取消（P1，1 天）**

4. `Budget` 值对象替掉 11 处散落赋值；
5. `propose()` 返回 `{ proposals, cost }`，删掉 `Proposer.costUsd` 的时序契约；
6. `signal` 贯通提案阶段。

验收：预算用例覆盖「基线超限 / 提案后超限 / 留出集前超限」三条路径；取消用例断言「abort 后模型调用次数不再增长」。

**第三批 · 收窄上下文（P1，2–3 天，纯机械）**

7. 拆 `WorkspacePaths` / `ModelSettings`，18 个消费方收窄签名；
8. `evals/run.ts` 拆三件；`serve.ts` 的超时改从执行起算 + 错误码修正。

验收：`typecheck` 通过即为调用点全覆盖；`index.ts` 导出面不变（`HarnessConfig` 仍是全集）；门禁测试条数不减。

---

## 附：本文数据的复现方式

```bash
# 依赖图 / 环 / 扇入扇出：对 src 下每个 .ts 扫 `from './x.js'` 建图，Tarjan 求 SCC
# 配置字段分布：从 src/config.ts 提取 `readonly (\w+):` 作为字段表，统计 config.<field> 出现
# 函数体量：按 `function name` 起算到括号闭合
# 两条鲁棒性实测：临时工程 + 写入半截 journal 行 / 缺 verified 的 cycle JSON，调 readJournal / readLedger
```

评审基线：`npm run check` 291 条、`e2e:offline` 26/26（2026-11-24 实跑，提交 `5341627`）。
