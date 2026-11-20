# agentia-harness

基于 [`@migor/agentia`](https://github.com/migoric/agentia) 的 **Agent harness 工程基座**：把「一个能跑的 agent」变成「一套能被评测、被改进、被回滚的 agent 工程」。

agentia 提供运行时（循环、工具、trace、审批、持久化）。这个仓提供围着运行时的**工程设施**：资产库、评测台、RSI 闭环。

```bash
npx @migor/agentia-harness init      # 生成一个可跑的最小工程
harness eval                        # 跑评测集，有失败就退出码 1
harness rsi                         # 采集→归因→提案→验证→采纳
```

## 三个判断

**一、harness 不是又一个 agent 框架。** 它不实现循环、不实现工具协议、不实现持久化 —— 那些在 agentia 里已经做完了（含 SSE、审批挂起、断点续跑、四种后端）。这里只补三样 agentia 刻意不做的：**资产版本化**、**可断言的评测**、**能自我改进的闭环**。

**二、技能是 Markdown，不是代码。** 一个技能 = 一个 `.md` 文件，正文就是它那次子运行的 system prompt。理由是 RSI 的前提：**改动必须是文本级的**，才能被机器生成、被 diff 审阅、被逐字回滚。要改 TS 才生效的东西，首版一律不做。

**三、评测门在 RSI 的写权限之外。** RSI 唯一真正致命的失败模式是「改测试让自己通过」——闭环越转越自信，能力越转越差。所以 `evals/` 与 `gate()` 不进 RSI 的可写范围：它能提改动，不能提标准。

## 与 agentia 的分工

| 能力                                                   | 谁提供               |
| ------------------------------------------------------ | -------------------- |
| agent 循环 / 工具 / 子 agent / MCP                     | agentia              |
| trace、审批、断点续跑                                  | agentia              |
| fs / redis / sqlite / postgres 持久化                  | agentia              |
| HTTP serve、SSE、任务队列、调度                        | agentia `transport/` |
| `defineEval` / `scriptedClient` / `harvest` / `export` | agentia `eval/`      |
| **技能与 agent 资产的发现、校验、版本锁**              | **harness**          |
| **评测台：用例、断言、回归门**                         | **harness**          |
| **RSI：归因、提案、隔离验证、采纳与回滚**              | **harness**          |
| **L2 代码补丁：worktree 沙箱验证、审批、留痕、回滚**   | **harness**          |

依赖是单向的：harness → agentia。harness 不改 agentia，也不要求 agentia 为它改。

## 快速开始

```bash
npm install
npx @migor/agentia-harness init     # 或 harness init；会一并生成 harness.lock.json
harness eval                         # 会失败 —— 因为没有模型凭据
```

配好 `.env`（如 `ANTHROPIC_API_KEY=...`）后：

```bash
harness run "把这个仓库的未处理 issue 分个类"
harness eval --save .workspace/base.json   # PASS/FAIL + 通过率 + token/成本 + 命中统计
harness rsi --dry-run                # 看它想改什么，不落盘
harness rsi                          # 真改（通过回归门才落盘）
harness rsi --max-cost 0.5           # 本轮最多花 $0.5，超了直接收工
harness rsi status                   # 采纳历史
harness rsi revert                   # 回滚最近一次
```

改完提示词之后，用它判断「到底变好没有」：

```bash
harness eval --save .workspace/after.json
harness report .workspace/base.json .workspace/after.json   # 门不过退出码 1
```

### 换端点 / 换模型（以 DeepSeek 为例）

`harness.config.json` 写三段就够，完整可跑的工程见 [`examples/starter/`](examples/starter/)：

```json
{
  "model": "deepseek-flash",
  "endpoint": {
    "baseURL": "https://api.deepseek.com/anthropic",
    "apiKeyEnv": "DEEPSEEK_API_KEY"
  },
  "pricing": { "deepseek-flash": { "in": 0.15, "out": 0.6, "cacheRead": 0.02 } }
}
```

- `endpoint.baseURL` 是 `ANTHROPIC_BASE_URL` 的配置化写法；`apiKeyEnv` 只写**变量名**，
  key 放 `.env`（真实环境变量优先于文件）。密钥永远不进配置文件 —— 那个会被提交。
- 声明了 `apiKeyEnv` 却没有 key ⇒ **开跑前**就报错（退出码 2），不花一轮 token 换一个 401。
  只拦真会调模型的命令（`run` / `eval` / `rsi` / `serve`），`lock` / `trace` / `report` 不受影响。
- 不给非 Anthropic 模型定价，成本读数是「未知」而**不是 0**：报告里不出现 `$`、回归门的
  成本判据退回 token、`rsi --max-cost` 不生效。`run` 会在结尾说清病因是「没定价」（配置能修）
  还是「端点没报计量」（换端点才能修）。
- `cacheRead` / `cacheWrite` 是相对 `in` 的**乘数**，不是绝对价：DeepSeek 缓存读
  $0.003 / 输入 $0.15 ⇒ 写 `0.02`。价格表填的是 off-peak 价，高峰期实际是 2 倍。

## 目录

```
agents/*.md          主 agent 的 system（正文）+ frontmatter（description/tools/model）
skills/*.md          技能：正文 = 子循环 system；description = 模型看到的工具描述
evals/*.md           评测用例：frontmatter 是断言，正文是任务
harness.config.json  可选：目录、模型、端点（endpoint）、价格表（pricing）、L2 验证命令
harness.lock.json    资产版本锁（提交进 git）
.workspace/          运行时产物：traces.jsonl、rsi/journal.jsonl、sandbox/（不提交）
examples/starter/    一个接 DeepSeek 端点的完整工程（可直接跑）
```

## 资产格式

```md
---

name: repo-triage
version: 2
description: 读一个 issue，判断优先级并给出负责人建议
maxIterations: 6
tools: [search_issue] # 可选：本技能内部可调的其他技能
---

你是仓库分诊员。读入 issue 描述后：

1. 先判断类型（bug / feature / question），不同类型用不同判据；
2. 再判优先级：影响面 × 可复现性，不要只看「紧急」字样；
3. 输出固定三段：类型、优先级、理由。
```

装配时：`description` 进模型可见的工具列表，正文成为该技能一次子运行的 system。**技能看不到主 agent 的对话历史** —— 这是刻意的：上下文隔离让技能行为可独立评测，而「可独立评测」是 RSI 能验证改动的唯一前提。

### 能力清单的语义

`tools` 与 `subagents` 决定一个 agent 能看到什么，规则只有一条：**未声明 = 全部技能，声明了 = 精确清单**（`tools: []` 表示一个都不挂）。

```md
---

name: lead
description: 主编排 —— 拆任务、分派、汇总
tools: [search_issue] # 只挂这一个技能
subagents: [reviewer] # 把 reviewer 变成可委派的工具
---
```

子 agent 是**完整独立循环**：自己的 system、自己的工具、自己的模型，主 agent 的对话历史它看不见，只交回最终文本。委派在 trace 里是带 `subagent` 属性与 `agentia.handoff.from/to` 的 capability span，所以「谁把活交给了谁」是一等事实，不用靠命名反推。

委派成环（A→B→A）在**装配期**就报错并指名路径 —— 留到运行期会一直跑到预算耗尽，而那一刻的 trace 里只有几十层同名 span。

## 评测

用例的断言只能来自 **trace 与最终文本**，不用 LLM 当裁判（裁判自己不确定，RSI 就会把随机波动当进步）：

```md
---

name: triage-basic
expect_contains: 优先级
expect_tools: [repo_triage] # 子序列匹配，允许中间夹别的调用
expect_max_tokens: 20000 # 挡住「靠堆循环混过去」
---

判断 issue #12 的优先级
```

断言全集（全部是规则式，没有一条依赖模型判断）：

| 字段                                          | 判据                                                       |
| --------------------------------------------- | ---------------------------------------------------------- |
| `expect_contains` / `expect_not_contains`     | 最终文本必须 / 不得包含某些子串                            |
| `expect_matches`                              | 最终文本匹配正则（加载期就编译，坏正则退出码 2）           |
| `expect_tools`                                | 工具名按序出现（子序列，允许中间夹别的调用）               |
| `expect_tool_counts: [grep:2]`                | 工具调用**精确**次数 —— 与上面的子序列语义刻意分开         |
| `expect_tool_args: [grep:foo.c]`              | 该工具入参里必须含某子串（frontmatter 行内数组不能含逗号） |
| `expect_skills`                               | 必须命中的技能                                             |
| `expect_ok`                                   | 是否正常收尾（缺省 true）                                  |
| `expect_max_tokens` / `expect_max_iterations` | token / 轮数上限                                           |

跑评测的三个旋钮，各自的语义都是刻意的：

| 旋钮                | 缺省   | 为什么                                                                                      |
| ------------------- | ------ | ------------------------------------------------------------------------------------------- |
| `--timeout <ms>`    | 不超时 | 超时**按失败记**并写进失败原因。超时由 harness 自己 race 兑现，不依赖下游配合               |
| `--concurrency <n>` | `1`    | 并发会让「这轮花了多少」与「哪条贵」互相污染，而成本归因是 RSI 的输入。结果顺序永远按用例名 |
| `--retries <n>`     | `0`    | **只对「跑崩了」重试**（`stopReason=error`）。断言失败重试等于用采样次数掩盖问题            |

报告里带 `skillHits`（每个资产被多少条用例走过），这是提案「该改哪个文件」的数据来源。

## RSI 闭环

```
采集 collectFailures  ←  一份 EvalReport
  ↓
归因 attribute         ←  规则式聚类（可单测、可解释、零成本）
  ↓
提案 propose           ←  唯一用 LLM 的一步：怎么改
  ↓
验证 verify            ←  在内存 AssetSet 副本上改，跑 eval，零副作用
  ↓
采纳 accept / 回滚 revert  ←  唯一写源文件的地方（原子写 + journal）
```

**回归门**是字典序 + 硬否决，不是一个加权总分：

| 条件                             | 结论                               |
| -------------------------------- | ---------------------------------- |
| 有「基线过、候选挂」的用例       | 否决（能指名是哪条）               |
| 通过率下降                       | 否决                               |
| 通过率没升、成本/ token 涨超 10% | 否决                               |
| 通过率提升                       | 放行（token 涨多少都放行，只记录） |

为什么不用加权总分：权重随手一调就能让任何结论成立。字典序的每一条都能用一句人话解释，而 RSI 最贵的成本不是算力，是**人重新信任一套自己看不懂的提示词**。

判「更贵」优先用**美元成本**（`trace.totalUsage.costEstimate` 逐条累加），两边都有读数时不再看 token ——token 只对同一模型可比，而「换模型」是合法提案。任一条用例没有成本读数（模型不在价格表内）就退回 token，并把 `costBasis` 一并记录：结论用的是哪个指标，必须可复核。「不知道花了多少」与「花了 0」是两件事，混成一个数会让成本门静默失效。

**一轮最多采纳一个提案。** 同时采纳三个，评测从 70% 涨到 85%，没人知道是哪个起的作用 —— 单变量是让「采纳记录」变成可信知识的唯一做法。

**提案来源可以换，门不能换。** 缺省由 `LlmProposer` 生成；也可以手写一份 L1 提案 JSON，
用 `rsi propose --from` 登记（存到 `.workspace/rsi/proposals/<id>.json`），再把那个路径交给
`rsi accept --from` 采纳。手写提案**照样跑完整两遍评测与回归门**（没有跳门的 `--yes` 开关），
并且 `patch.before` 必须与当前资产正文逐字相等 —— 来源是人还是模型，验证路径是同一条。

## 命令

```
harness init [目录]     生成最小工程（含锁文件）
harness run <任务>      跑一次；打印结果、token、命中技能、traceId
harness eval            跑评测集；有失败退出码 1
  --save <文件>         存报告，供 report 对比
  --only <a,b>          只跑这些用例
  --timeout/--concurrency/--retries   见上表
  --keep-traces         把 trace 落盘（默认不落；失败用例报告里带 traceId）
harness report <基线.json> <候选.json>   两份报告比一次并过门；门不过退出码 1
  --max-token-growth <r> / --max-cost-growth <r>   两种门阈值
harness trace <traceId> 打印那次运行的 span 树（可用前缀；--tail n 只看最后 n 条）
harness harvest <traceId>  把一条 trace 回流成 evals/harvest-*.md 回归用例
  --task <文本>         任务原文（trace 里没存，必须外来）
  --from-report <文件>  或从 eval --save 的报告按 traceId 反查
harness lock            按当前资产重写锁
harness lock --check    校验资产与锁一致（CI 用），不一致退出码 1
harness rsi             跑一轮闭环
  --dry-run             只验证不落盘（记录仍写盘，供人审）
  --max-cost <usd>      本轮总预算（含提案、基线、候选；覆盖配置 maxCostUsd）
  --timeout/--concurrency/--retries   见上表
harness rsi revert [id] 回滚最近一次采纳；给 id 可防期间插入了新采纳
harness rsi status      采纳历史
harness rsi propose --from <json>  登记手写 L1 提案（不调模型）
harness rsi accept --from <json>   手写提案也过完整验证门才采纳
harness serve           起 HTTP 服务（POST /run、GET /health）
harness patch <diff>    验证一个代码补丁（在 git worktree 沙箱里跑验证命令）
  --yes                 验证通过后落盘（代码补丁必须人工确认）
  --verify "npm test"   覆盖配置里的验证命令（`code.verify`）
  --timeout <ms>        验证命令超时（缺省 10 分钟）
  --revert              回滚最近一次代码补丁
```

退出码是接口的一部分：`0` 正常、`1` 跑了但没达标（断言/门未过）、`2` 配置/资产/用法错。

**拼错字段一律退出码 2**：配置顶层与 `endpoint` / `pricing` / `code` 的未知键、eval
frontmatter 里的未知 `expect_*`、CLI 的未知 flag、非数字的 `--timeout` 都会被当场拒绝。
这不是洁癖 —— 这些错此前都表现为「配了但没生效」，而症状会出现在成本或通过率上，
没人会往拼写上想。预算与迭代上限还必须是正数：`0` 在 agentia 里是「不设上限」。

`harness trace` 的存在理由：RSI 归因读的是**汇总**（失败模式、命中统计），人查问题读的是**链路**（谁调了谁、在哪一步炸的）。没有它，`.workspace/traces.jsonl` 只是一堆没人会去 grep 的日志。

`harness harvest` 把链路变成回归用例。先跑 `harness eval --keep-traces --save report.json`
把 trace 留下。trace 里**没有任务原文**（root span 只记模型与配置），所以必须给 `--task`，
或用 `--from-report` 从那份报告按 traceId 反查；前缀匹配到多条时拒绝，写文件不接受歧义。生成的断言只有 `expect_ok: true`，注释里列出观察到的工具、技能与
收尾状态 —— trace 记的是**实际行为**，不是**正确行为**；把当时调过的工具固化成断言，等于把
错误一起固化。结果类断言（`expect_contains` / `expect_matches`）要人补。已有的用例文件不会被覆盖。

## 设计不变量

这几条是**不能妥协**的，改它们等于换一个系统。每条都在 `AGENTS.md` 与本仓测试里各有一份：

1. **门在 RSI 的写权限之外** —— 它能提改动，不能提标准。
2. **归因不用模型** —— 归因是地基，地基不能是概率的。
3. **验证零副作用** —— 提案只在内存副本上生效，跑完源文件一字未动。
4. **一轮最多采纳一个** —— 单变量才有归因能力。
5. **采纳前三次校验、回滚前验指纹** —— 落盘是唯一不可逆的动作。
6. **只有「跑崩了」才重试** —— 断言失败是结果，不是抖动。
7. **历史先写、后改文件** —— 顺序选反，回滚就成破坏。

## 代码补丁（L2）

L1 改的是提示词，能修的是「模型理解错了」。有些失败改提示词修不了 —— 缺一个工具、
参数校验太松、循环里少判一个边界。这类改动落在 TS 里，所以有第二条通道：

```
补丁进来 → git worktree 沙箱里应用 + 跑验证命令 → 人看结果 → --yes 落盘 → git apply -R 回滚
```

四道门都是刚性的：

| 门                 | 为什么                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------ |
| 沙箱验证必须通过   | 主树里试错会把「验证失败」变成有代价的动作，而 RSI 的全部意义建立在试错零成本上            |
| 目标文件必须干净   | 工作区里有未提交改动时落盘，报错会说是「patch does not apply」，真正原因是「你有本地改动」 |
| 必须人工 `--yes`   | 改提示词坏了大不了回滚；改代码能弄坏构建本身。RSI 不该有这个权力                           |
| 回滚先验逐文件指纹 | 落盘后有人动过就拒绝自动回退 —— 反向应用跑一半是最坏的结果                                 |

**提案环节刻意不用 LLM**：本层只接受外部给的 diff（人或别的 agent 写的），负责验证、
审批、留痕、回滚这四件真正需要机器纪律的事。让模型直接写 TS 的失败率远高于它写提示词，
而一次坏补丁的代价大得多——这个不对称决定了分工。

沙箱是 `git worktree`（缺省在 `.workspace/sandbox/`，用完即删）。放在**仓库里面**是有
意的：worktree 里没有 `node_modules`，而 Node/npm 解析依赖会沿目录上溯，放在仓库里才
能找到主仓的依赖；搬到 `/tmp` 会让 `npm test` 以「模块找不到」失败，那是与补丁无关的
假阴性。

配置（`harness.config.json`，都可省）：

```json
{ "code": { "verify": ["npm", "test"], "timeoutMs": 600000 } }
```

## 已知边界（如实标注）

- **L2 只做增量改**：不支持删除文件、重命名、二进制补丁；一个补丁只跑**一条**验证命令
  （多条请自己串成 `npm run verify`）。
- **L2 的提案不由 LLM 生成**：见上一节的理由。想接模型，把生成的 diff 喂给
  `harness patch` —— 验证与回滚是现成的。
- **不做并行分支编排**：并行留给工具层（`maxToolConcurrency`）。两套并行的闸比没有闸更危险。
- **`suspended` 不在本层**：等审批 / 等时刻交给外层 run 的 `approvals`。图的检查点与 HITL 挂起是两种中断，混在一起会让「续跑」有两个互相不知道的状态源。
- **没有自己的预算账本**：累计成本靠外层 run 或宿主推进。
- **server 是缝不是产品**：只有 `/run` 与 `/health`。要会话、审批、SSE，用 agentia 的 `transport/`。
- **依赖走本地路径**：`@migor/agentia` 用 `file:../agentia`（上游尚未发 npm）。发版前需改成版本号。
- **真模型验证只跑了 `run` / `eval`，没跑完整 `rsi` 采纳**：DeepSeek 官方端点上的实测数字
  见 `examples/starter/README.md`。提示词质量、工具选择这类问题只有真模型答得了，本仓的
  脚本测试答不了；离线 e2e 覆盖的是 fetch / SSE / 重试 / 成本换算那一层。
- **评测默认不落 trace**：`harness eval --keep-traces` 才落盘，同时把 `traceId` 写进报告
  （失败用例会打印出来）。缺省不落是纪律 —— 评测反复跑会把 `traces.jsonl` 撑成垃圾场。

## 开发

```bash
npm run check        # typecheck + lint + test + build（CI 跑的就是这个）
npm test             # 单跑测试
npm run e2e:offline  # 真实 HTTP 客户端 + 本地假端点，含故障注入（需先 build）
npm run harness -- help
```

### 离线 e2e：为什么有一条假端点

单元测试里的模型客户端全是注入的 `scriptedClient`，而线上走 `createAnthropicClient()` ——
两者之间隔着 fetch、SSE 拼装、重试退避、usage→成本换算。那层代码此前只能靠读代码相信。

`scripts/fake-anthropic.mjs` 说 Anthropic Messages 协议（含 SSE 与 `tool_use` 往返），
`scripts/offline-e2e.mjs` 用它把这条路径放到真 HTTP 上跑，并顺手点掉几条只在异常分支上
才走的路：`500` 退避重试、`429 + retry-after`、流被截断、用例超时、端点不报 usage。
CI 里有这一步。

它跑出过一个真 bug：**端点不报 usage 时上游算出的 `costEstimate` 是 `0` 而不是
`undefined`** —— 模型在价格表里，于是「不知道花了多少」与「一分没花」是同一个数，
预算闸与成本门一起静默失效。现在按 trace 里的 `usage.missing` 事件判定（literal 复制，
有测试守着改名）。

工具链：Node ≥ 20、TypeScript 7（原生 `tsc`，与 `@migor/agentia` 同版本）、tsx 跑测试、biome 管 lint 与格式。类型检查是硬门，`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` 全开。

测试分八组：资产层、评测台与回归门、RSI 闭环（含真实 trace 归因）、多 agent 委派、
CLI 与渲染端到端、配置与端点桥接（含价格表口径）、L2 代码补丁（沙箱 / 审批 / 回滚）、
HTTP 面（含并发峰值必须为 1）。另有 `tests/architecture.test.ts` 守分层与文件体量 ——
分层写在文档里等于没有，能执行才算。`npm run e2e:offline` 是第九组：它不在 `npm test` 里，
因为它要 `dist/` 且起子进程。
