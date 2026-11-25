# 命令与退出码

## 工程

```
harness init [目录]     生成最小工程（含锁文件）
harness lock            按当前资产重写锁
harness lock --check    校验资产与锁一致（CI 用），不一致退出码 1
```

## 运行与观测

```
harness run <任务>      跑一次；打印结果、token、命中技能、traceId
harness trace <traceId> 打印那次运行的 span 树（可用前缀；--tail n 只看最后 n 条）
harness diff <A> <B>    两份 trace 差在哪（run 级 + span 级；id 可用前缀）
  --json                输出结构化差异（TraceDiff）
```

`harness trace` 的存在理由：RSI 归因读的是**汇总**（失败模式、命中统计），人查问题读的是**链路**（谁调了谁、在哪一步炸的）。没有它，`.workspace/traces.jsonl` 只是一堆没人会去 grep 的日志。

`harness diff` 接着回答第三个问题：**这两次差在哪一步**。门只说得出「case 3 从通过变失败」，说不出「第 2 回合少了 search」——后者才是能改的东西。两条 trace 都从 `traces.jsonl` 按 id 前缀取（所以要 `--keep-traces` 才有），差异分 run 级（status、用量、根属性如 `model`）与 span 级（谁多了一步、哪个字段变了、谁只剩一侧）。`rsi` 在门否决时会顺手打印该跑哪条 `diff` —— 只给命令不自动执行：默认不落 trace 时自动版拿不到任何一条，会静默变成空操作。

## 评测与报告

```
harness eval            跑评测集；有失败退出码 1
  --save <文件>         存报告，供 report 对比
  --only <a,b>          只跑这些用例
  --timeout/--concurrency/--retries   见 evals.md 的三个旋钮
  --keep-traces         把 trace 落盘（默认不落；失败用例报告里带 traceId）
harness report <基线.json> <候选.json>   两份报告比一次并过门；门不过退出码 1
  --max-token-growth <r> / --max-cost-growth <r>   两种门阈值
  --allow-case-set-change  用例集不同时不拒绝，只比对同名用例（缺省拒绝）
harness harvest <traceId>  把一条 trace 回流成 evals/harvest-*.md 回归用例
  --task <文本>         任务原文（trace 里没存，必须外来）
  --from-report <文件>  或从 eval --save 的报告按 traceId 反查
harness evidence        把评测报告导出为三层证据语料（overview/detail/raw）
  --from-report <文件>  eval --save 的报告（带任务原文与 traceId）
  --id <名字>           语料 id（已存在则拒绝覆盖）
```

## RSI

```
harness rsi             跑一轮闭环
  --rounds <n>          连续跑 n 轮（每轮最多采纳一个；预算跨轮共享）
  --dry-run             只验证不落盘（记录仍写盘，供人审；不能与 --rounds 同用）
  --max-cost <usd>      整次运行的总预算（含提案、基线、候选；--rounds 下跨轮共享）
  --timeout/--concurrency/--retries   见 evals.md 的三个旋钮
harness rsi status      采纳历史
harness rsi ledger      决策账本：预测 vs 实际结果（--json 输出）
harness rsi journal     采纳日志（--json 输出）；中途崩过留下的半截末行会指出
  --repair              截掉半截末行（先备份；截完必须能读通，中间行坏了不修）
harness rsi regress     采纳之后那些用例还通过吗（有回归退出码 1）
  --revert              检测到回归就自动回滚（仍过指纹校验）
harness rsi revert [id] 回滚最近一次采纳；给 id 可防期间插入了新采纳
harness rsi propose --from <json>  登记手写 L1 提案（不调模型）
harness rsi accept --from <json>   手写提案也过完整验证门才采纳
```

## 服务与代码补丁

```
harness serve           起 HTTP 服务（POST /v1/run、GET /health）
harness patch <diff>    验证一个代码补丁（在 git worktree 沙箱里跑验证命令）
  --yes                 验证通过后落盘（代码补丁必须人工确认）
  --verify "npm test"   覆盖配置里的验证命令（code.verify）
  --timeout <ms>        验证命令超时（缺省 10 分钟）
  --revert              回滚最近一次代码补丁
```

两者的细节见 [`operations.md`](./operations.md)。

## 退出码与未知字段

退出码是接口的一部分：

| 码  | 含义                                               |
| --- | -------------------------------------------------- |
| `0` | 正常                                               |
| `1` | 跑了但没达标（断言未过 / 门否决 / 锁不一致 / 回归） |
| `2` | 配置、资产或用法错                                 |

**拼错字段一律退出码 2**：配置顶层与 `endpoint` / `pricing` / `code` 的未知键、eval frontmatter 里的未知 `expect_*`、CLI 的未知 flag、非数字的 `--timeout` 都会被当场拒绝。这不是洁癖 —— 这些错此前都表现为「配了但没生效」，而症状会出现在成本或通过率上，没人会往拼写上想。

预算与迭代上限还必须是正数：`0` 在 agentia 里是「不设上限」。
