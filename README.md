# agentia-harness

[![npm](https://img.shields.io/npm/v/@migor/agentia-harness.svg)](https://www.npmjs.com/package/@migor/agentia-harness)
[![ci](https://github.com/migoric/agentia-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/migoric/agentia-harness/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)][repo-license]
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)][repo-pkg]

把「一个能跑的 agent」变成「一套能被评测、被改进、被回滚的 agent 工程」。

基于 [`@migor/agentia`](https://github.com/migoric/agentia)。运行时在那边 —— 循环、工具、trace、审批、持久化 —— 这里一行没实现，只补围着运行时的工程设施。

```bash
npx @migor/agentia-harness init my-agent   # 生成一个可跑的最小工程（含资产锁）
harness eval                               # 跑评测集，有失败退出码 1
harness rsi                                # 采集 → 归因 → 提案 → 验证 → 采纳
```

`harness` 是 CLI 的 bin 名，装法见下面的[安装](#安装)。

## 它做什么

agentia 刻意不做的三件事，是这里全部的野心：

- **资产版本化** —— agent、技能、用例都是 Markdown，加一把锁。可 diff、可回滚、可被机器改。
- **可断言的评测** —— 断言只来自 trace 与最终文本，不用 LLM 当裁判（裁判自己不确定，RSI 就会把随机波动当进步）。
- **能自我改进的闭环** —— 归因（规则）→ 提案（模型）→ 验证（零副作用）→ 采纳（唯一写盘）。

一条前提决定了上面全部的形状：**改动必须是文本级的**。只有文本改动才能被机器生成、被 diff 审阅、被逐字回滚。要改 TS 才生效的东西因此走了另一条路 —— 验证、审批、留痕、回滚都齐全，但提案不由模型做。

### 与 agentia 的分工

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

## 安装

```bash
npx @migor/agentia-harness init my-agent   # 不安装，先生成一个可跑的最小工程
npm i -D @migor/agentia-harness            # 装进项目
npm i -g @migor/agentia-harness            # 或全局装
```

CLI 只有一个 bin，名叫 `harness`。**装进项目时**用 `npx harness <命令>`（bin 在 `node_modules/.bin/`）；**全局装**之后才是裸 `harness <命令>`。下文示例都写成裸 `harness`，按你的装法换算。

要改本仓本身，见 [`CONTRIBUTING.md`][repo-contrib]。注意 `npm run harness -- init` **必须带目标目录**，否则模板会写进仓库根。

## 跑起来

生成工程后配好 `.env`（`ANTHROPIC_API_KEY=...`；换端点见下），然后：

```bash
harness run "把这个仓库的未处理 issue 分个类"   # 跑一次：结果、token、命中技能、traceId
harness eval --save .workspace/base.json      # 跑用例集，存一份基线报告
harness rsi --dry-run                         # 看它想改什么，不落盘
harness rsi                                   # 真改（过回归门才落盘）
```

改完提示词，用它回答真正的问题 —— 到底变好没有：

```bash
harness eval --save .workspace/after.json
harness report .workspace/base.json .workspace/after.json    # 门不过退出码 1
```

## 三件核心

### 一、资产是 Markdown

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

`description` 进模型可见的工具列表，正文成为该技能一次子运行的 system。**技能看不到主 agent 的对话历史** —— 这是刻意的：上下文隔离让技能行为可独立评测，而「可独立评测」是 RSI 能验证改动的唯一前提。

能力清单的规则只有一条：**未声明 = 全部技能，声明了 = 精确清单**（`tools: []` 是一个都不挂）。子 agent 是完整独立循环，委派关系在 trace 里是一等事实；委派成环在装配期就报错。

字段全集与委派 → [资产格式][doc-assets]

### 二、评测用规则，不用裁判

```md
---

name: triage-basic
split: train # 或 holdout：留出集每批只验一次（多批用 phase 排）
expect_contains: 优先级
expect_tools: [repo_triage] # 子序列匹配，允许中间夹别的调用
expect_max_tokens: 20000 # 挡住「靠堆循环混过去」
---

判断 issue #12 的优先级
```

| 断言                                          | 判据                                                 |
| --------------------------------------------- | ---------------------------------------------------- |
| `expect_contains` / `expect_not_contains`     | 最终文本必须 / 不得包含某些子串                      |
| `expect_matches`                              | 最终文本匹配正则（坏正则在加载期退出码 2）           |
| `expect_tools` / `expect_tool_counts`         | 工具按序出现（子序列）/ 精确次数 —— 两种语义刻意分开 |
| `expect_skills` / `expect_ok`                 | 必须命中的技能 / 是否正常收尾（缺省 true）           |
| `expect_max_tokens` / `expect_max_iterations` | 上界，挡住「靠堆循环混过去」                         |
| `memory_keys`                                 | 这条用例走记忆。缺席 = 裸 agent                      |

三个旋钮的缺省都是刻意的：不超时、串行（`--concurrency 1`，成本归因要干净）、不重试（**只有跑崩了才重试**，断言失败重试等于用采样次数掩盖问题）。

**留出集不是附加题**：提案和验收用同一批用例，闭环必然过拟合。写 `split: holdout` 给一部分用例，归因与排序只看 train，赢家最后验一次，退步就整轮不采纳。多轮用例用一行 `<!-- turn -->` 分隔。

**留出集要能消耗**：一份留出集验 30 次，累积假阳性约 78%。给 holdout 用例写 `phase: 1/2/3` 分批，每批只用一次，用完就拒（提示补新用例）。不写 `phase` 的老工程照旧可复用，但复用次数会落盘并出声。

断言全集、旋钮、多轮口径、`harvest` → [评测][doc-evals]

### 三、RSI：闭环

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

**回归门是字典序 + 硬否决，不是加权总分：**

| 条件                             | 结论                                 |
| -------------------------------- | ------------------------------------ |
| 两份报告的用例集不同             | 否决（`case_set_changed`，分母变了） |
| 有「基线过、候选挂」的用例       | 否决（能指名是哪条）                 |
| 通过率下降（同名用例内）         | 否决                                 |
| 通过率没升、成本/ token 涨超 10% | 否决                                 |
| 通过率提升                       | 放行（token 涨多少都放行，只记录）   |

为什么不用加权总分：权重随手一调就能让任何结论成立。字典序的每一条都能用一句人话解释，而 RSI 最贵的成本不是算力，是**人重新信任一套自己看不懂的提示词**。

最后一行是**单向**的宽容（通过率涨了，成本涨多少都放行）。它的配套刹车叫**净简化配额**：连续 5 条改动没让资产变小、或累计成本涨超 50%，下一轮就只接受"删与合并"的提案（`--shrink-every` 可调）。配额改的是**调度**，不改判据 —— 阀值一放宽，所有"更努力"的改动都会被一律拒掉，于是 RSI 只学会偷懒。

门在 RSI 的写权限之外 —— 它能提改动，不能提标准。这是产品前提：唯一真正致命的失败模式是「改测试让自己通过」，闭环越转越自信、能力越转越差。所以 `evals/` 与 `gate()` 不在它的可写范围里。

一层只采纳一个改动（单变量才有归因），自进化靠 `rsi --rounds` 串起来。可比性判据、三层可观测、跨轮记忆、坏记录怎么处理 → [RSI 闭环][doc-rsi]

## 换模型 / 换端点

`harness.config.json` 写三段就够，完整可跑的工程见 [`examples/starter/`][repo-starter]：

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

- `apiKeyEnv` 只写**变量名**，key 放 `.env`。密钥永远不进配置文件 —— 那个会被提交。声明了变量却没 key，开跑前就退出码 2，不花一轮 token 换一个 401。
- **没定价的模型，成本读数是「未知」而不是 0**：报告里不出现 `$`、成本门退回 token、`--max-cost` 不生效。「不知道花了多少」与「一分没花」混成一个数，会让预算闸静默失效。

乘数口径、缓存价、拦截范围（哪些命令拦、哪些不拦）→ [运维面][doc-ops]

## 命令

| 命令                     | 作用                                                  |
| ------------------------ | ----------------------------------------------------- |
| `harness init [目录]`    | 生成最小工程（含锁文件）                              |
| `harness run <任务>`     | 跑一次；打印结果、token、命中技能、traceId            |
| `harness eval`           | 跑评测集；有失败退出码 1                              |
| `harness report <A> <B>` | 两份报告比一次并过门；门不过退出码 1                  |
| `harness trace <id>`     | 那次运行的 span 树（人查问题读链路）                  |
| `harness diff <A> <B>`   | 两份 trace 差在哪一步（门只说得出哪条用例退步了）     |
| `harness harvest <id>`   | 把一条 trace 回流成回归用例                           |
| `harness evidence`       | 把报告导出成三层证据语料（经验 / 决策 / 对账）        |
| `harness lock [--check]` | 重写资产锁 / 校验与锁一致                             |
| `harness rsi`            | 跑一轮闭环（`--rounds` / `--dry-run` / `--max-cost`） |
| `harness rsi regress`    | 采纳之后那些用例还通过吗（`--revert` 才动手）         |
| `harness patch <diff>`   | 在 worktree 沙箱里验证一个代码补丁（`--yes` 才落盘）  |
| `harness serve`          | 起 HTTP 服务（POST /v1/run、GET /health）             |

退出码是接口的一部分：`0` 正常、`1` 跑了但没达标、`2` 配置/资产/用法错。**拼错字段一律退出码 2** —— 这些错此前都表现为「配了但没生效」，症状却出现在成本和通过率上。

全量参数 → [命令与退出码][doc-cli]

## 已知边界

- **server 是缝不是产品**：只有 `/v1/run` 与 `/health`。要会话、审批、SSE，用 agentia 的 `transport/`。
- **L2 只做增量改**，且提案不由模型生成：不支持删文件、重命名、二进制补丁；一个补丁只跑一条验证命令。
- **只支持 Anthropic 兼容端点**：`pricing` 里配 OpenAI 模型不会让它走 OpenAI 端点，那只是价格表。
- **评测默认不落 trace**：`--keep-traces` 才落盘。反复跑会把 `traces.jsonl` 撑成垃圾场。
- **`.workspace/` 可整体删除**，代价是丢掉审计历史（预测对账、采纳记录、回归基准都在里面）。目前没有轮转策略。

全表（含超时/配额只管单进程、`suspended` 为什么不在这层）→ [运维面][doc-ops]

## 往下读

- [资产格式][doc-assets] —— frontmatter 字段、能力清单、子 agent 委派、版本锁
- [评测][doc-evals] —— 断言全集、三个旋钮、多轮口径、harvest
- [RSI 闭环][doc-rsi] —— 回归门、可比性判据、三层可观测、跨轮自进化
- [命令与退出码][doc-cli] —— 全量参数、退出码、未知字段纪律
- [运维面][doc-ops] —— 端点、HTTP 服务、L2 代码补丁、已知边界、测试
- [设计不变量][doc-inv] —— 九条不能妥协的约束
- [`AGENTS.md`][repo-agents] —— 编码约定，同时是 AI 助手的权威入口
- [`CONTRIBUTING.md`][repo-contrib] —— 人的流程：装依赖、提交前跑什么、几条会红的硬约定

## 参与

安全问题请走 [私有通道](https://github.com/migoric/agentia-harness/security/advisories/new)，不要开公开 issue（见 [`SECURITY.md`][repo-security]）。

## 许可

[MIT][repo-license] © 2026 migor

<!--
链接定义一律用绝对 GitHub URL：npm 只把 README 快照进页面，docs/ 与根目录的其它文件
都不进 tarball（`files` 只有 dist），相对链接在 npm 上会 404。
-->
[doc-assets]: https://github.com/migoric/agentia-harness/blob/main/docs/assets.md
[doc-evals]: https://github.com/migoric/agentia-harness/blob/main/docs/evals.md
[doc-rsi]: https://github.com/migoric/agentia-harness/blob/main/docs/rsi.md
[doc-cli]: https://github.com/migoric/agentia-harness/blob/main/docs/cli.md
[doc-ops]: https://github.com/migoric/agentia-harness/blob/main/docs/operations.md
[doc-inv]: https://github.com/migoric/agentia-harness/blob/main/docs/invariants.md
[repo-agents]: https://github.com/migoric/agentia-harness/blob/main/AGENTS.md
[repo-contrib]: https://github.com/migoric/agentia-harness/blob/main/CONTRIBUTING.md
[repo-license]: https://github.com/migoric/agentia-harness/blob/main/LICENSE
[repo-pkg]: https://github.com/migoric/agentia-harness/blob/main/package.json
[repo-security]: https://github.com/migoric/agentia-harness/blob/main/SECURITY.md
[repo-starter]: https://github.com/migoric/agentia-harness/tree/main/examples/starter
