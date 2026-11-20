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
npx @migor/agentia-harness init     # 或 harness init
harness lock                         # 生成 harness.lock.json
harness eval                         # 会失败 —— 因为没有模型凭据
```

配好 `.env`（如 `ANTHROPIC_API_KEY=...`）后：

```bash
harness run "把这个仓库的未处理 issue 分个类"
harness eval                         # PASS/FAIL + 通过率 + token
harness rsi --dry-run                # 看它想改什么，不落盘
harness rsi                          # 真改（通过回归门才落盘）
harness rsi status                   # 采纳历史
harness rsi revert                   # 回滚最近一次
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
harness init [目录]     生成最小工程
harness run <任务>      跑一次；打印结果、token、traceId
harness eval            跑评测集；有失败退出码 1
harness lock            按当前资产重写锁
harness lock --check    校验资产与锁一致（CI 用），不一致退出码 1
harness rsi             跑一轮闭环
harness rsi --dry-run   只验证不落盘
harness rsi revert      回滚最近一次采纳
harness rsi status      采纳历史
harness serve           起 HTTP 服务（POST /run、GET /health）
```

退出码是接口的一部分：`0` 正常、`1` 断言/门未过、`2` 用法或配置错误。

## 已知边界（如实标注）

- **无并行分支**：图编排与扇出不在本仓（agentia 的 `graph/` 有独立的编排层）。
- **L2 未开**：RSI 不能改 TS 代码。改代码需要沙箱 + 测试门 + 人工审批，是下一版的事。
- **提案只改第一个 agent**：`EvalReport` 里没有「哪条用例走了哪个技能」的映射，硬猜会改错文件。等 trace 回流给出技能命中统计后再按数据选。
- **server 是缝不是产品**：只有 `/run` 与 `/health`。要会话、审批、SSE，用 agentia 的 `transport/`。
- **串行执行**：一个进程同时跑多个任务会污染成本归因；要并发就起多个进程。

## 开发

```bash
npm test          # 48 条（资产 / 评测 / RSI 闭环 / CLI 端到端）
npm run typecheck
npm run lint
npm run build
```
