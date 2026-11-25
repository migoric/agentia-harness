# 资产：Markdown、能力清单与锁

harness 的资产只有三类 Markdown 文件。**正文就是提示词，frontmatter 就是契约** —— 这条约束是 RSI 能工作的前提：改动必须是文本级的，才能被机器生成、被 diff 审阅、被逐字回滚。

## 目录约定

```
agents/*.md          主 agent 的 system（正文）+ frontmatter（description/tools/model）
skills/*.md          技能：正文 = 子循环 system；description = 模型看到的工具描述
evals/*.md           评测用例：frontmatter 是断言，正文是任务
harness.config.json  可选：目录、模型、端点（endpoint）、价格表（pricing）、L2 验证命令
harness.lock.json    资产版本锁（提交进 git）
.workspace/          运行时产物：traces.jsonl、rsi/journal.jsonl、sandbox/（不提交）
examples/starter/    一个接 DeepSeek 端点的完整工程（可直接跑）
```

## 技能与 agent 文件

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

## 能力清单的语义

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

## 版本锁

`harness.lock.json` 记下每个资产的内容指纹，提交进 git。`harness lock` 按当前资产重写，`harness lock --check` 校验一致（CI 用，不一致退出码 1）。

它的用途是挡住「改了提示词、忘了锁」这类静默漂移：没有锁，线上跑的到底是哪版提示词只能靠猜。

## 拼错字段会被当场拒绝

eval frontmatter 里的未知 `expect_*`、配置里的未知键，一律退出码 2 —— 详见 [`cli.md`](./cli.md#退出码与未知字段)。
