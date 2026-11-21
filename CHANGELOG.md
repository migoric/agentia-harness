# Changelog

本文件记录**行为变化**。内部重构不记 —— 需要看细节时读 git 历史。

格式：`## [版本] - 日期`，每条都说清「改了什么」与「为什么」。

## [Unreleased]

### 新增

- **多轮评测**：eval 用例正文用一行 `<!-- turn -->` 分隔轮次，首段仍是 `task`、后续段进
  `followUps`。跑法走 agentia 的会话存储（`session: { store, id }`），历史由上游拼接，
  不是 harness 自己拼 messages —— 拼一套就等于评测的不是线上那条路。
  - 断言口径：文本判**最后一轮**，工具/token/迭代看**累计**；`turns` 记计划轮数，
    `failedTurn` 指出第几轮崩的。`expect_ok: false` 判的是整段会话。
  - 中间轮失败即中止：会话只在成功收尾时追加历史，失败轮不留记录，继续跑等于在
    真实会话里不存在的上下文上作答。
  - 超时 / 抛异常不再把整段会话的账单清零：已跑完那几轮的 token 与前缀成本留在报告里，
    并指出卡在第几轮。`--retries` 重放整段（新会话），只计成功那次尝试的成本。
  - 多轮用例拒绝 `harvest --from-report`（一条 traceId 对不上多段任务原文）；
    空轮次在加载期退出码 2。

- **跨轮自进化**：`harness rsi --rounds <n>` 连续跑，提案器每轮新建，资产每轮重新发现
  （复用快照会让第 2 轮基线用的还是改前正文）。`--max-cost` 是**整次运行**上限
  （`priorSpentUsd` 跨轮累加），不是每轮一份 —— 此前文档写「本轮」，与实现不符。
  没有可采纳改动就停；跑完才发现超限也记「预算用完」，否则会多跑一整轮基线才发现没钱。
  `--dry-run` 与 `--rounds` 互斥（资产不变，后面几轮只会重复第一轮）。

- **账本回灌提案器**：提案前读 `lessonsOf()`（账本里 `not_realized` / `reverted` 两类），
  以「已经试过、但没成立的方向」写进提示词，并明确要求换一种改法。此前提案器每轮
  从零开始，会把刚被门否掉的改法原样再提一遍 —— 白烧一遍评测钱，且看起来完全正常。
  `historyConsulted` 随轮次落盘（三态：缺席 = 没走到提案 / 0 = 有提案但无历史 / N = N 条），
  `rsi` 输出会打印条数。`reverted` 的教训原因取 journal 的回滚措辞而不是门结论 ——
  那条门结论是当初**通过**时写的，拿来讲失败会把成功理由说成失败证据。

- **回归监测 `harness rsi regress`**：拿最近一条采纳的 `candidate` 报告当基准，跑当前
  全集比对，指出「当初通过、现在挂了」的用例，有回归退出码 1。默认只报告；
  `--revert` 才回滚，且仍走 `revertLast` 的指纹校验（采纳后被人手改过就拒绝）。
  基准取自轮次记录而不是用 journal 的 `after` 重跑重建 —— 后者是「现在能不能过」，
  会把回归判成通过。手工采纳（`rsi accept --from`）也落轮次记录，否则手写提案的改动
  永远在监测之外；用例被删/改名记 `missingCases`（不算绿）；全部用例都跑崩时拒绝判
  回归（那不是退步，是基础设施故障，照它回滚会误伤正常采纳）。
  `rsi ledger` 也据此分开标注：dry-run 的「本会采纳」不再显示成 `rejected`/被门拒，
  回滚条目的门结论标成「采纳时」。

### 新增（AHE 三层）

- **`endpoint` 段：把「连哪个端点」变成可提交的配置**。此前换端点只能靠环境变量
  （`ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`），于是「这个工程跑的是 DeepSeek 还是
  Anthropic」在仓库里看不出来。现在：

  ```json
  { "endpoint": { "baseURL": "https://api.deepseek.com/anthropic", "apiKeyEnv": "DEEPSEEK_API_KEY" } }
  ```

  `apiKeyEnv` 只写**变量名**，key 留在 `.env`（配置文件会被提交）。真实环境变量仍然
  优先于配置文件与 `.env` —— 命令行的显式设置永远赢。

- **`pricing` 段：给非 Anthropic 模型定价**，接到 agentia 的 `priceOverrides`。
  不给的后果是**静默**的（成本读数「未知」⇒ 回归门的成本判据退回 token、`rsi --max-cost`
  不生效），现在 `run` 会在结尾点明是哪一种。

- **`examples/starter/`**：一个接 DeepSeek 端点、能直接跑的完整工程。
- **`eval --keep-traces`**：注释里承诺过但一直没实现。现在可显式把每次评测的 trace
  落盘，并把 `traceId` 写进报告（失败用例会打印），供 `harness trace <id>` 回查；
  缺省仍不落盘。
- **`report --max-cost-growth`**：门早已支持成本阈值，此前只有 token 阈值能从 CLI 调。
- **eval 断言扩到十类**：新增 `expect_not_contains` / `expect_skills` / `expect_max_iterations`
  与 `expect_tool_counts`（精确调用次数）、`expect_tool_args`（入参子串）。此前「输出不得
  包含 X」「某工具必须调两次且带某参数」这类回归无法表达。工具事件提取收在
  `evals/tool-events.ts`，序列、次数、参数三种断言共用一份扫描，不再各扫一遍 trace。
- **`harness harvest <traceId>`**：把失败 trace 回流成 `evals/harvest-*.md`。trace 里没有
  任务原文，所以必须给 `--task` 或用 `--from-report` 从评测报告反查；前缀有歧义时拒绝，
  已有用例不覆盖。自动生成的断言只有 `expect_ok: true` —— trace 记的是实际行为而非正确行为，
  把当时调过的工具固化成断言等于把错误一起固化，结果类断言留给人补。
- **手写提案的 CLI 入口**：`rsi propose --from <json>` 登记、`rsi accept --from <json>` 采纳。
  提案来源可以是人，门不能变 —— 手写提案照样跑完整两遍评测与回归门，没有跳门的 `--yes`；
  `patch.before` 与当前正文逐字不匹配时，在验证层的乐观锁处就被拒。
- **`rsi revert [id]`**：指定 id 时必须是最近一条可回滚的采纳，否则拒绝。它是一道确认阀
  （防止期间又采纳了别的而误退），不是「退任意一条」—— 回滚依据仍是 journal 里的 before。
- **AHE 三层可观测：证据 / 决策 / 留出**。参考 Superagentic AI 的 harness 思路：
  - `harness evidence --from-report <报告.json>` 把报告 + traces 导出成 `overview.md` /
    `detail/*.md` / `raw/*.jsonl` 三层证据语料；原始 trace 不整坨进提示词，语料目录不覆盖。
  - 提案与采纳记录带 `manifest`（依据、假设、预测、风险），在验证之前生成；新增
    `harness rsi ledger [--json]` 把预测与 cycle 的实际门结果对账，被拒的尝试也进账本。
  - eval frontmatter 新增 `split: holdout`：归因与候选排序只看 train，留出集在赢家选定后
    只验一次（默认硬门），退步则整轮不采纳；`rsi accept --from` 也走同一条路。
    拼错的 split 与「全是 holdout」在加载期退出码 2。

### 严格化（拼错就退出码 2）

此前这几类错全都表现为「配了但没生效」，症状出现在成本或通过率上，没人会往拼写上想：

- 配置顶层 / `endpoint` / `pricing` / `code` 的未知键（后者注释承诺过、实现漏了）；
- eval frontmatter 的未知 `expect_*`；非法 `expect_matches` 正则现在在加载期就炸，
  不再等用例跑到一半；
- CLI 未知 flag；`--timeout abc` 此前静默等于「不设超时」；
- `maxCostUsd` / `maxIterations` 必须是正数 —— `0` 在 agentia 里是「不设上限」；
- 手写提案 JSON 的未知字段、非法 `kind` / `target` / `id`（id 会当文件名用）、空 `after`。

### 修复

- **换端点后，技能与子 agent 子循环偷偷用回缺省模型**：agentia 的 capability loop
  继承 `client` 却不继承 `model`，装配层不显式传就会拿 `claude-opus-5` 去打 DeepSeek；
  真端点未必报错，但成本按 Opus 单价记（实测一轮 1158 token 记成 $0.02375，实际约
  $0.0006），`maxCostUsd` 会提前刹车。现在把工程生效模型与迭代上限一路传给所有子循环
  （资产自己的 `model` 仍优先）。真端点复跑后同样用量从 $0.024 降到 $0.00071。
- **RSI 提案器用回缺省模型、且花费不计入预算**：`LlmProposer` 只认构造参数的 `model`
  （CLI 从不传），与技能踩过同一个坑；它的模型调用也没进 `CycleBudget`。现在用与
  buildApp 同源的生效模型与价格表，并把提案花费（含「不可知」状态）回到轮次记录。
- **RSI 轮次记录改为原子写**（与 journal 同款 tmp + rename）：半截审计记录比没有更糟。
- **评测报告现在带每条用例的 `task`**：`harvest --from-report` 此前读的是报告里根本不存在
  的字段，而测试夹具手写这个字段制造了假绿 —— 真实报告上那条路径 100% 失败。现在
  `CaseResult.task` 由 `runOne` 透传，夹具也改成真实 `runSuite` 产出的报告。
- **手写提案补上「必须变好」门槛**：此前只要 `gate.ok`（「无变化」也算）就采纳，而自动
  RSI 还会拒绝「没有任何用例变好」的 no-op —— 同样的提案走两条路径结论不同。现在共用
  `verify.ts` 的 `isWorthAccepting()`，手写提案不会用 no-op 污染 git 历史。
- **`harvest` 写前查用例重名**（frontmatter 的 `name` 可能在子目录里已占用）；trace 前缀
  找不到或有歧义统一按用法错退出码 2；`FAILURE_KINDS` 改为运行时值导出（此前放进
  `export type`，`verbatimModuleSyntax` 会把整个导出擦掉）。
- **端点不报 usage 时成本被算成 `0`**：模型在价格表里时，上游按「0 token × 单价」
  算出 `costEstimate = 0`，与「真的一分没花」是同一个数 ⇒ `costKnown` 判成 true，
  预算闸与回归门一起静默失效。现在按 trace 里的 `usage.missing` 事件把这种情况折回
  `undefined`（literal 复制，有测试守着上游改名）。
- **「没有成本读数」的两种病因分开报**（`RunOutcome.costNote`：`unpriced` / `unreported`）。
  补救动作完全不同：一个是改配置，一个是换端点。此前都表现为「报告里少了个 `$`」。
- **eval 报告的成本缺失提示不再要求 `costUsd > 0`**：未定价时总成本恰好是 0，
  而按 `>0` 判会让最该看到这句话的人看不到它。
- **缺 key 时在开跑前报 config.invalid（退出码 2）**，而不是等第一次模型调用换回一个
  401（那时人先去怀疑端点、模型名、网络）。只对显式声明了 `endpoint.apiKeyEnv` 的工程
  生效，且只拦 `run` / `eval` / `rsi` / `serve` —— `lock` / `trace` / `report` 与
  `rsi status|revert` 不调模型，不该被凭据拦住。

### 工具

- **离线 e2e**（`npm run e2e:offline`）：`scripts/fake-anthropic.mjs` 说 Anthropic
  Messages 协议（SSE + `tool_use` 往返），驱动真实 `createAnthropicClient()` 跑
  `run` / `eval` / `rsi`。覆盖此前只能靠读代码相信的一层：fetch、SSE 拼装、重试退避、
  usage→成本换算。含故障注入（500 / 429+retry-after / 流截断 / 超时 / 不报 usage）
  与完整 RSI 闭环（归因 → 提案 → 验证 → 采纳 → 回滚，逐字比对）。CI 已接入。

  它立刻兑现了价值：上面那条成本 bug 就是它跑出来的。

  新增两条用例走**配置 + `.env`** 而不是环境变量 —— 只有这条路能证明配置里的
  `baseURL` / `apiKeyEnv` 真的接到了客户端上（对照：缺 key 时退出码 2）。

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

**HTTP 面补齐（此前零测试）。**

- `POST /run` 返回 `costUsd`（无读数时 `null`，与 CLI 同口径）。
- 请求体超上限从 `422` 改成 `413`：这是「请求太大」，不是「内容不合法」——
  客户端据此决定截断重发还是改格式。
- `ServerOptions.client` 可注入模型客户端：没有这个口子，`/run` 的正常路径只能在有
  凭据时验证，而「串行闸真的在生效吗」只有并发两个请求时才看得出来。
- 8 条 HTTP 测试：`/health` 形状、`405 + allow`、`404/400`、`413`、正常路径、
  **并发峰值必须是 1**、关闭时等在飞的请求跑完。

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
