# Changelog

本文件记录**行为变化**。内部重构不记 —— 需要看细节时读 git 历史。

格式：`## [版本] - 日期`，每条都说清「改了什么」与「为什么」。

## [Unreleased]

## [0.1.0] - 2026-11-20

首个可用版本。基于 `@migor/agentia` 的独立工程，不改上游。

### 新增

**资产层（`assets/`）** —— Markdown 即能力，纯文件、不依赖 agentia。

- 技能与 agent 两类资产，两种布局都认（`x.md` / `x/SKILL.md`）。
- `name` 在**两类之间**唯一：技能与 agent 会进同一张模型工具表，撞名会让模型随机选。
- `harness.lock.json` 记录 `{ kind:name → version + fingerprint }`，`lock --check` 是 CI 门。

**装配与执行（`run/`）**

- 技能正文即子循环 system（走 `runCapabilityLoop`），子 agent 走 `subagentToTool`。
- `subagents: [x]` 把 agent 变成可委派工具；装配期做环检测（A→B→A 立刻报错）。
- 能力清单语义：`tools` 未声明 = 全部技能，声明 = 精确清单，`tools: []` = 一个都不挂。
- 每次 run 的 trace 带 `harness.assets` / `harness.agent` 标签，归因先看资产有没有变。

**评测台（`evals/`）**

- 用例是 Markdown，断言从 trace 读：文本、工具序列（子序列匹配）、收尾原因、token 上限。
- `--timeout` / `--concurrency` / `--retries`：超时按失败记；并发保序；**只有「跑崩了」才重试**
  —— 断言失败重试等于用采样次数掩盖问题。
- `EvalReport.skillHits`：每个资产被多少条用例走过。这是提案选目标的数据来源。

**RSI 闭环（`rsi/`）**

- 采集 → 归因（规则式，不用模型）→ 提案（模型）→ 隔离验证（内存 `AssetSet` 副本，零副作用）
  → 采纳/回滚。
- **提案按数据选目标**：改「走过这些失败用例的资产」，而不是固定改第一个 agent。
- 回归门是纯函数、字典序 + 硬否决；它是 RSI 唯一的否决权，且在 RSI 可写范围之外。
- 一轮最多采纳一个（单变量才有归因能力）；每条提案的失败不拖垮整轮（跳过并回执）。
- 每轮落盘 `.workspace/rsi/cycles/<cycleId>.json`（dry-run 也写），采纳写 `journal.jsonl`。

**CLI 与 HTTP**

- `init` / `run` / `eval` / `report` / `trace` / `lock` / `rsi` / `serve`。
- 退出码是契约：`0` 正常，`1` 没达标，`2` 配置/资产错。
- `serve`：串行执行、请求体上限、单请求超时、优雅关闭。

### 已知边界

- RSI 只改文本资产（L1），不改 TS 代码（L2）。
- 不做并行分支编排：并行留给工具层（`maxToolConcurrency`）。
- `suspended`（等审批/等时刻）不在 harness 层处理，交给外层 run 的 `approvals`。
- 依赖 `@migor/agentia` 走本地路径 `file:../agentia`（上游尚未发布到 npm）。
