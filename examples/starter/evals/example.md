---
name: example
expect_contains: 要点
expect_max_tokens: 20000
---

把下面这段话压成三条要点：

本项目是一个基于类型化契约的 agent 运行时，提供 trace、审批、断点续跑与
多后端持久化。它刻意不内置编排图与向量库，把「怎么组织流程」留给调用方。
目前支持 fs / redis / sqlite / postgres 四种任务存储，并有一份不断增长的
决策日志记录每个取舍的理由。
