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
harness eval --save .workspace/base.json   # PASS/FAIL + 通过率 + token + 命中统计
harness rsi --dry-run                # 看它想改什么，不落盘
harness rsi                          # 真改（通过回归门才落盘）
harness rsi status                   # 采纳历史
harness rsi revert                   # 回滚最近一次
```

改完提示词之后，用它判断「到底变好没有」：

```bash
harness eval --save .workspace/after.json
harness report .workspace/base.json .workspace/after.json   # 门不过退出码 1
```

## 目录

```
agents/*.md          主 agent 的 system（正文）+ frontmatter（description/tools/model）
skills/*.md          技能：正文 = 子循环 system；description = 模型看到的工具描述
evals/*.md           评测用例：frontmatter 是断言，正文是任务
harness.config.json  可选，覆盖缺省目录
harness.lock.json    资产版本锁（提交进 git）
.workspace/          运行时产物：traces.jsonl、rsi/journal.jsonl（不提交）
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

| 条件                       | 结论                               |
| -------------------------- | ---------------------------------- |
| 有「基线过、候选挂」的用例 | 否决（能指名是哪条）               |
| 通过率下降                 | 否决                               |
| 通过率没升、token 涨超 10% | 否决                               |
| 通过率提升                 | 放行（token 涨多少都放行，只记录） |

为什么不用加权总分：权重随手一调就能让任何结论成立。字典序的每一条都能用一句人话解释，而 RSI 最贵的成本不是算力，是**人重新信任一套自己看不懂的提示词**。

**一轮最多采纳一个提案。** 同时采纳三个，评测从 70% 涨到 85%，没人知道是哪个起的作用 —— 单变量是让「采纳记录」变成可信知识的唯一做法。

## 命令

```
harness init [目录]     生成最小工程（含锁文件）
harness run <任务>      跑一次；打印结果、token、命中技能、traceId
harness eval            跑评测集；有失败退出码 1
  --save <文件>         存报告，供 report 对比
  --only <a,b>          只跑这些用例
  --timeout/--concurrency/--retries   见上表
harness report <基线.json> <候选.json>   两份报告比一次并过门；门不过退出码 1
harness trace <traceId> 打印那次运行的 span 树（可用前缀；--tail n 只看最后 n 条）
harness lock            按当前资产重写锁
harness lock --check    校验资产与锁一致（CI 用），不一致退出码 1
harness rsi             跑一轮闭环
harness rsi --dry-run   只验证不落盘（记录仍写盘，供人审）
harness rsi revert      回滚最近一次采纳
harness rsi status      采纳历史
harness serve           起 HTTP 服务（POST /run、GET /health）
```

退出码是接口的一部分：`0` 正常、`1` 跑了但没达标（断言/门未过）、`2` 配置/资产/用法错。

`harness trace` 的存在理由：RSI 归因读的是**汇总**（失败模式、命中统计），人查问题读的是**链路**（谁调了谁、在哪一步炸的）。没有它，`.workspace/traces.jsonl` 只是一堆没人会去 grep 的日志。

## 设计不变量

这几条是**不能妥协**的，改它们等于换一个系统。每条都在 `AGENTS.md` 与本仓测试里各有一份：

1. **门在 RSI 的写权限之外** —— 它能提改动，不能提标准。
2. **归因不用模型** —— 归因是地基，地基不能是概率的。
3. **验证零副作用** —— 提案只在内存副本上生效，跑完源文件一字未动。
4. **一轮最多采纳一个** —— 单变量才有归因能力。
5. **采纳前三次校验、回滚前验指纹** —— 落盘是唯一不可逆的动作。
6. **只有「跑崩了」才重试** —— 断言失败是结果，不是抖动。
7. **历史先写、后改文件** —— 顺序选反，回滚就成破坏。

## 已知边界（如实标注）

- **L2 未开**：RSI 只能改文本资产，不能改 TS 代码。改代码需要沙箱 + 测试门 + 人工审批。
- **不做并行分支编排**：并行留给工具层（`maxToolConcurrency`）。两套并行的闸比没有闸更危险。
- **`suspended` 不在本层**：等审批 / 等时刻交给外层 run 的 `approvals`。图的检查点与 HITL 挂起是两种中断，混在一起会让「续跑」有两个互相不知道的状态源。
- **没有自己的预算账本**：累计成本靠外层 run 或宿主推进。
- **server 是缝不是产品**：只有 `/run` 与 `/health`。要会话、审批、SSE，用 agentia 的 `transport/`。
- **依赖走本地路径**：`@migor/agentia` 用 `file:../agentia`（上游尚未发 npm）。发版前需改成版本号。

## 开发

```bash
npm run check     # typecheck + lint + test + build（CI 跑的就是这个）
npm test          # 单跑测试
npm run harness -- help
```

测试分五组：资产层、评测台与回归门、RSI 闭环（含真实 trace 归因）、多 agent 委派、CLI 与渲染端到端。另有 `tests/architecture.test.ts` 守分层与文件体量 —— 分层写在文档里等于没有，能执行才算。
