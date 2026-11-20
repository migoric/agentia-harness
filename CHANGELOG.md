# Changelog

本文件记录**行为变化**。内部重构不记 —— 需要看细节时读 git 历史。

格式：`## [版本] - 日期`，每条都说清「改了什么」与「为什么」。

## [Unreleased]

## [0.2.0] - 2026-11-20

### 新增

**L2：代码补丁通道（`rsi/code/` + `harness patch`）。** L1 能修「模型理解错了」，修不了
「缺一个工具 / 校验太松 / 少判一个边界」—— 那些改动落在 TS 里。这一版把它补上，但补的
不是「让模型改代码」，而是**让改代码这件事可验证、可审批、可回滚**：

- `harness patch <diff>` 在 `git worktree` 沙箱里应用补丁并跑验证命令，缺省**不落盘**；
  `--yes` 才落盘，`--revert` 逐文件校验指纹后反向应用。
- 沙箱缺省在 `.workspace/sandbox/`（仓库内），用完即删：Node/npm 靠目录上溯解析依赖，
  搬到 `/tmp` 会让 `npm test` 因「模块找不到」假阴性。
- `parsePatch` 是补丁的唯一边界检查：绝对路径 / `..` / 二进制 / 无 hunk / 删除文件 /
  `---` 与 `+++` 不成对，一律 `code.invalid`。
- 落盘前只要求**补丁要动的文件**干净（不是整个工作区）：要求整树干净会让人开始绕过纪律。
- `JournalEntry` 增加 `kind: 'asset' | 'code'`，两条通道共用一条审计线索；`rsi revert`
  只回滚文本资产，`patch --revert` 只回滚代码，互不越界。
- 新增错误码 `code.invalid` / `code.verify_failed` / `code.unapproved` / `code.conflict`：
  「验证没过」与「没审批」是两件事，脚本要能分开处理。

**成本归因（真实美元）。** 此前只有 token，而 token 只是成本的代理。

- `RunOutcome.costUsd` / `CaseResult.costUsd` / `EvalReport.costUsd` 取自
  `trace.totalUsage.costEstimate`；`undefined` = 没有读数（脚本客户端，或模型不在价格表内）。
- `EvalReport.costKnown` 由**逐条**读数推导：任一条没定价就整轮不可比 —— 拿总和 `> 0`
  当「有读数」会漏判成本回退。
- 回归门判「没变好还更贵」时**优先用成本**（`costBasis: 'cost'`），成本不可比才退回 token
  （`costBasis: 'tokens'`）。换模型是合法提案，而 token 跨模型不可比。
- `harness report` / `eval` 的输出带上成本；无读数时刻意**不打印 `$0`**（那会被读成免费）。

**RSI 轮次预算闸。** 一轮闭环要跑两遍以上评测，真模型上这是最贵的一步；没有上限时
「花了 $12 什么都没采纳」很容易发生。

- `harness rsi --max-cost <usd>`（或配置 `maxCostUsd`）设本轮上限；基线一跑完就超限
  会**连提案都不提**（那一步也要调模型）。
- `CycleReport.costUsd` / `costKnown` / `budget` 如实记录：成本不可比时闸不生效，并把
  `costKnown: false` 写进记录 —— 不拿偏低的数字假装闸住了。

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
