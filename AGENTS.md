# AGENTS.md — 本仓的架构不变量

给在此仓工作的 agent（以及未来的人）读。这些东西改起来很「顺手」，但每一条的破坏都会
以**静默**的方式让 RSI 变成负资产。

## 一、依赖方向

```
cli / server          ← 宿主入口（不进公共导出面）
     ↓
    rsi               ← 闭环：采集→归因→提案→验证→采纳（含 code/ 的 L2 通道）
     ↓
run / evals           ← 装配、执行、断言、回归门（这一层起依赖 agentia）
     ↓
  assets              ← 纯文件层：不依赖 agentia，谁都不依赖

util/                 ← 横切：所有层都能用，但它自己只依赖 util/
```

- `assets/` 不 import 任何 agentia 的东西，也不 import `run/`。它是纯文件层，因此在
  任何环境（含测试）都能单独跑。
- `rsi/` 可以 import `evals/` 与 `run/`，**反方向不行**。评测台不认识 RSI —— 一旦它
  认识，RSI 就能通过「理解评测台」去找漏洞。
- `util/` 不认识业务：它只许依赖其它 util。反过来依赖谁都会成环，而 util 是被所有层
  共用的，成环就成在它身上。
- `cli/` 与 `server/` 是**宿主入口**，不进 `index.ts` 的公共导出面。
- 本仓**不改 agentia**。需要 agentia 的新能力时，问「能不能在本仓绕过去」，绕不过去
  才去改上游，并单独发版。

以上五条由 `tests/architecture.test.ts` 执行，不是文档约定。

## 二、RSI 的七条不变量

1. **评分门在 RSI 可写范围之外**。`evals/` 目录与 `gate()` 不允许被 RSI 的提案触碰。
   提案只能改 `agents/*.md` 与 `skills/*.md` 的正文。这是整个设计的地基。
2. **归因不用 LLM**。`attribute()` 必须是规则式、可单测、纯函数。LLM 只出现在
   `propose()`。
3. **验证零副作用**。`verifyProposal()` 只在内存里的 `AssetSet` 副本上生效，绝不写盘。
   一旦验证阶段写盘，「试错」就变成「有成本」，RSI 会自我审查到不敢改。
4. **一轮最多采纳一个**。`runCycle()` 里 `committed` 一旦为真，其余提案全部拒绝。
   不要为了「快」放开它 —— 那会让采纳记录失去归因能力。
5. **采纳三次校验**：patch.before 等于当前正文 → 渲染出的期望内容等于磁盘内容 →
   原子写。跳过任一步，就会静默覆盖别人的改动。
6. **回滚要先验指纹**。当前资产指纹必须等于当初采纳后的指纹，否则拒绝自动回滚。
7. **journal 后写**。先写文件、再记 journal。反过来的话，记了 journal 却写盘失败，
   回滚会把状态改到更糟的地方。

## 三、L2（代码补丁）的五条不变量

L2 与 L1 的差别不在「改什么文件」，在**失败的代价**：提示词坏了大不了回滚，代码坏了
能弄坏构建本身。所以这一层的纪律比 L1 更硬：

1. **验证必须在 worktree 里做，不能在主树里「先改了再说」**。主树里试错会让「验证失败」
   变成有代价的动作（要还原、要担心还原不干净），而 RSI 的全部价值建立在试错零成本上。
2. **不验证不落盘、不审批不落盘**。库里也判一次，不能只靠 CLI —— 调用方可以绕过命令行。
   `code.verify_failed` 与 `code.unapproved` 是两个不同的错误码：一个是结果，一个是流程。
3. **落盘前目标文件必须干净**。只看**补丁要动的文件**，不要求整个工作区干净 —— 后者会让
   「有个无关的未提交文件」变成落盘失败，人会开始用 `--force` 之类的办法绕过纪律。
4. **回滚先验逐文件指纹，再 `git apply -R`**。顺序反了就会出现「反向应用跑到一半发现
   文件被改过」—— 那时文件已经动过了，比不动更糟。
5. **沙箱放在仓库里面**（`.workspace/sandbox/`）。worktree 没有 `node_modules`，只有靠
   目录上溯才解析得到主仓依赖；搬到 `/tmp` 会让验证以「模块找不到」失败，那是**假阴性**。

补丁通道的边界检查在 `parsePatch`：绝对路径、`..`、二进制、没有 hunk、删除文件、
`---` 与 `+++` 不成对 —— 一律拒绝。**不要**放宽这些，它们是补丁唯一的边界检查点
（`git apply` 会老老实实按 diff 里的路径写文件）。

## 四、资产契约

- `description` 是必需字段，它会进模型可见的工具列表。空描述 = 该能力不存在。
- **`name` 在技能与 agent 之间也唯一**。两者会进同一张模型工具表；分别唯一会让模型在
  两个同名工具间随机选，而那在评测里表现为「同一提示词时好时坏」—— 会被误判成模型不稳定。
- 能力清单：`tools` **未声明 = 全部技能**（缺省必须安全），声明 = 精确清单，`tools: []`
  = 一个都不挂。`subagents` 未声明 = 不委派。这个不对称是有意的：多挂能力只是浪费，
  少挂能力是静默故障。
- 技能与 agent 的引用环都在**装配期**检测（`assertNoCycles` / `buildTools` 的 trail）。
  运行期才炸会只剩几十层同名 span，看不出根因。
- 技能的正文是**子运行的完整 system**，不是可拼接片段。它看不到主 agent 的历史。
- 改 frontmatter 会改资产语义（name/tools 变了，评测结果就不可比）。RSI 只许改正文。
- frontmatter 支持行尾 `#` 注释（`#` 前须是空白）。这不算宽容，是为了让人愿意写说明。

## 五、改动纪律

- 任何改动都要跑 `npm run check`（typecheck + lint + 全部测试 + build）。新增能力必须
  带来可断言的断言 —— 只测「没抛错」不算测试。
- 动了 `run/`、`server/`、`integrations` 相关的东西，**再跑一次 `npm run e2e:offline`**：
  它覆盖的是注入客户端碰不到的那一层（fetch / SSE / 重试 / usage→成本）。
- **L2 的测试要断言「拒绝时文件没被动过」**，不能只断言「抛了 code.conflict」：
  靠 `git apply -R` 失败兜底与真的在动手前就拒绝，抛的是同一个错误码。
- **超时与重试的语义别随便改**：超时靠 `Promise.race([work, gate.expired])` 由本层兑现，
  不能只把 signal 传下去（下游可能不配合）；重试只认 `stopReason === 'error'`，断言失败
  重试等于用采样次数掩盖问题。
- 断言工具序列（`expect_tools`）依赖 agentia 的 `tool.input` 事件名。该名字是上游的
  core 词汇表，**没有**进公共导出面，本仓用字面量复制了一份。防线是
  `tests/evals.test.ts` 里那条真实 trace 断言：上游改名会立刻红。
- **这类字面量只能存在于 `run/trace-events.ts` 一处**。此前 `tool.input` 与
  `usage.missing` 各写一份，加 `llm.fallback` 时就变成三处 —— 改一处漏两处是这类债的
  唯一形态。上游把词汇表进 `index.ts` 之后整份删掉改 import（常量名与上游逐字相同，
  那次改动应当是纯机械替换）。
- **「用了哪个模型」只能从 trace 读，不许用 `config.model` 近似**。唯一入口是
  `run/model-read.ts`：`llm.turn` 的 span 名就是实际模型，`llm.fallback` 是换环，
  根属性 `config.fallbacks` 是**声明**链（配了没触发 ≠ 没配）。报告层的 `models` /
  `fallbackUsed` 只要有一条用例没记就整体缺席 —— 并集少一个模型得出的「两边一样」
  比「不知道」贵得多，而假结论会让人照着去改提示词。
- 改 `gate()` 的判定规则时，必须同步 README 里那张表。那张表是使用者对「什么算变好」
  的唯一解释权。
- **磁盘上同一份数据只能有一个读入口**。`.workspace/rsi/cycles/*.json` 走
  `rsi/cycles.ts#readCycles`，`journal.jsonl` 走 `rsi/journal.ts#readJournal`。这不是
  「为了整洁」：此前 `cycles/` 有四份读取实现，容忍度各不相同 —— 同一份坏文件在
  `rsi regress` 下报错、在 `rsi status` 下静默少一条，最难查的正是这种「不同子命令
  说法不一样」。加新读点前先看现有仓储能不能长一个方法。
- **append-only 文件的坏记录分两种，态度也必须分两种**：末行没有换行收尾 = 中断的追加
  （可修，走 `rsi journal --repair`，先备份再截，截完必须用同一套解析复核）；中间行坏 =
  真损坏（拒绝修，报第几行）。**不许**在读的时候宽容跳过 —— 那会让「回滚基于不完整的
  历史」变成静默行为。
- **预算状态只能在一处改**：`Budget`（`rsi/budget.ts`）。加新的花钱点要
  `budget.charge(usd, known)`，不要在外面 `spent +=`。「花费不可知」是 `known: false`
  而不是 `0` —— 后者会让预算闸静默失效，且长得像合法读数。
- 动 `server/` 时守住 `http.ts`（协议怎么表达）与 `serve.ts`（请求怎么执行）的边界：
  加错误码只改 `http.ts` 的 `STATUS_BY_CODE`，改排队/超时只改 `serve.ts`。两者混回一个
  文件就会再次撞上「单文件 ≤400 行」的守卫。

## 六、已知的坑

- **`report()` 级别的测试夹具别复用 token**：`EvalReport.tokens` 是从 `cases` 求和的，
  夹具里给 0 会让 token 回归门静默失效。
- **`runSuite` 不落 trace**。反复跑评测会把 `traces.jsonl` 撑成垃圾场。
- **临时目录不清理**：测试用 `mkdtemp` 建工程，交给系统回收，不做 `rmSync`
  （与被测代码的写盘时序有竞态）。
- **无模型凭据时** `harness run` / `eval` / `rsi` 会失败在第一次模型调用上，
  这不是 bug —— 单测全部用 `scriptedClient`，不需要网络。要证明「线协议那一段没接错」，
  跑 `npm run e2e:offline`（本地假端点 + 真实 HTTP 客户端）。
- **「没报 usage」与「没定价」是两件事，但都会让 `costEstimate` 变成「看起来免费」**：
  未定价是 `undefined`；**已定价 + 端点不报计量是 `0`**（0 token × 单价）。后者更阴险，
  因为它长得像合法读数。`runner.ts` 靠 trace 里的 `usage.missing` 事件（literal 复制，
  公共导出面没有）把这种情况折回 `undefined`。改这段先看 `evals.test.ts` 那条测试。
- **`system` 在线上有两种形态**：纯字符串（技能走 `runCapabilityLoop`）与块数组
  （`SystemPrompt` 加过 label 之后）。任何读 `system` 的代码（假端点、未来的 judge）
  都要两种都认 —— 只认字符串会让主 agent 与提案器落进兜底分支。
- **`scriptedClient` 的游标跟着「成功消费」走**。超时那条用例的后台调用还在飞时，
  下一个用例会拿到同一步 —— 要按请求内容分派（用函数步骤），别用固定顺序的脚本。
- **成本是 `undefined` 不是 `0`**：模型不在价格表内时 `costEstimate` 缺省，`0` 会让成本门
  静默失效。`EvalReport.costKnown` 由**逐条**读数推导 —— 拿总和 `> 0` 当「有读数」是错的。
- **`agentia` 把模型层错误收成 `stopReason: 'error'` 而不是抛异常**，且 `error.retryable`
  常为 `false`（裸 Error 会被归类为 unknown）。harness 的重试语义**不看**那个字段，
  理由写在 `evals/run.ts` 的注释里。
- **端点走环境变量是唯一能覆盖所有调用点的方式**。agentia 的默认客户端是**每次 run 现造**
  的（技能子循环、RSI 提案器各造各的），显式注入 client 传不进子循环 —— 那会让
  「主 agent 走 DeepSeek、技能偷偷走官方端点」静默发生。所以 `endpoint` 段落到
  `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`（`run/endpoint.ts`），**不覆盖**已存在的
  真实环境变量（与 `loadEnvFile` 同款语义）。落点有**两处**：CLI 入口与库入口
  （`createRunner` 与 `LlmProposer` 构造时，幂等）—— 只在 CLI 落的话，库用法下
  endpoint 段静默不生效，症状是「主 agent 走得通、子循环 401」的分裂故障。
  新增「会现造默认 client」的库入口时，记得同样落一次。
- **`ensureEndpointEnv` 是进程级的**：同进程里两个不同 `config` 跑起来，**第一个赢**，
  而且第二个不会报错 —— 它会安静地用上第一个的端点。多租户或并行测试想要两套端点，
  只能起两个进程。所以那个函数叫 `ensure`（幂等、只填空位），不叫 `set`。
- **子循环继承 client，但不继承 model**。上游 `runCapabilityLoop` 的设计如此
  （见 `toolkit/capability-loop.ts` 的边界段）：端点不会分裂，**模型名会** —— 不给
  `model` 就落到 `claude-opus-5`。harness 在 `buildApp` 把生效模型传给 `buildTools`，
  再由技能 / 子 agent 装配透传（资产自己的 `model` 优先）。改这条要看
  `tests/multi-agent.test.ts` 的模型继承用例与离线 e2e 的同名断言。
- **`pricing` 的 `cacheRead` / `cacheWrite` 是相对 `in` 的乘数，不是绝对价**。把
  DeepSeek 的 $0.003（缓存读）当成乘数填进去，缓存命中那部分会便宜 100 倍，而成本
  数字看上去「很正常」。`tests/config.test.ts` 只守形状，口径靠人守 —— 改这块先读
  agentia 的 `engine/usage.ts`。
- **「没读数」有两种病因，别合并**：`unpriced`（没定价，改配置）与 `unreported`
  （端点没报计量，改不了配置）。合并成一句「没有成本」会把人引向错误的动作。
- **拼错的键必须当场炸**：配置顶层 / `endpoint` / `pricing` / `code` 的未知键
  （`config.ts` 的 `rejectUnknownKeys`）、eval frontmatter 的未知 `expect_*`
  （`evals/load.ts`）、CLI 的未知 flag（`cli/args.ts` 的 `assertKnownFlags`）都拒绝。
  `numFlag` 对非数字抛错而不是返回 `undefined` —— 后者会让 `--timeout abc` 变成
  「不设超时」且命令返回 0。预算 / 迭代上限必须是正数，因为 `0` 在 agentia 里是
  「不设上限」。新增配置字段或 CLI flag 时，记得同步白名单与 HELP。
- **提案器与子循环一样要继承生效模型**：`LlmProposer` 用 `effectiveModel(config, agent)`
  和 `config.pricing`（此前只认构造参数，CLI 从不传 ⇒ 另一个 `claude-opus-5` 静默错账）。
  它的花费经 `costUsd` / `costKnown` 回到 `CycleBudget`，预算闸别再只记基线与候选。
- **成本读数只有一个实现**：`run/cost.ts` 的 `costOf()` / `usageReported()`。
  runner 与提案器都用它，别再各写一份 `usage.missing` 字面量。
- **RSI 的 cycle JSON 与 journal 一样原子写**（`journal.ts` 的 `atomicWrite`）：
  半截审计记录比没有更糟。
- **工具事件只有一个出口**：`evals/tool-events.ts` 的 `toolInvocations()`。序列、次数、
  参数三种断言共用同一份扫描；上游把 `tool.input` 改名时，靠真实 trace 的测试报警
  （字面量不能 import，它不在 agentia 公共导出面）。
- **trace 里没有任务原文**：root span 只记模型与配置。`harvest` 的 task 必须来自
  `--task` 或 `--from-report` 反查，不要从 span 里猜；自动生成的断言只覆盖过程类回归，
  结果类断言（`expect_contains` / `expect_matches`）必须留给人补。
- **提案来源可以变，门不能变**：`rsi accept --from` 走的是与 LLM 提案相同的
  `verifyProposal` + `gate`，**不要加跳门的 `--yes`**。手写提案的 id 会当文件名，
  校验必须挡住路径逃逸；`patch.before` 与正文逐字不等时在乐观锁处就拒。
- **`rsi revert <id>` 是确认阀，不是任意回滚**：只接受最近一条采纳的 id —— 回滚依据
  仍是 journal 的 before，退中间一条会覆盖后续改动。原有指纹保护不能因为加了 id 而放松。
- **采纳门槛只有一个判据**：`rsi/verify.ts` 的 `isWorthAccepting(outcome)`。`gate.ok`
  只保证「没退步」—— 通过率不变时它也返回 true；「没有任何用例变好」的 no-op 不许落盘，
  否则 git 历史会被看不出效果的改动污染。自动 RSI 与手写提案都走它，新增采纳入口别另写一份。
- **报告必须能回溯任务**：`CaseResult.task` 由 `runOne` 透传，`harvest --from-report` 靠它反查。
  测试夹具要来自真实 `runSuite`——手写生产代码根本不写入的字段会让功能在测试里绿、真实报告上
  100% 失败（这条真的发生过）。同理，公共出口里的运行时常量不能放进 `export type`。
- **「两份报告可比」要由字段证明**：`EvalReport` 必须带 `model` / `harnessVersion` /
  `finishedAt` / `caseFingerprint`，否则换模型、改断言、升级 harness 都会被读成 agent 的
  进退步（归因错的结论比没有结论更贵）。用例集不同（含「名字没变、断言改了」）一律
  `case_set_changed` 拒绝：分母变了，通过率的高低不是同一件事。只比交集时 token 与成本
  也必须只在同一批用例上算 —— 否则「多了几条用例的开销」会伪装成「这条用例变贵了」。
  判不出来的情况（老报告没有指纹）返回 `undefined`，不许拿 `true` 冒充「确认过」。
- **已回滚的采纳不算「还生效」**：journal 是 append-only，回滚只追加记录、不改原
  accepted 行，所以只看 `status === 'accepted'` 会把已作废的采纳当成还有效 ——
  `rsi regress` 盯错基准、二次回滚把「已经回过了」报成「资产被手改过」。「仍生效的
  采纳」唯一判法是 `journal.ts` 的 `liveAccepted()`；「这条是不是回滚」唯一判法是
  `revert-note.ts` 的 `isRevertEntry()`（`reverted` 字段优先，老记录靠 reason 前缀兜底）。
  新增「找最近采纳 / 识别回滚」的读取点别自己写过滤条件。
- **`/v1/run` 的超时闸必须在入队的那个回调里造**，不能在入队前造。入队前造 = 排队时间
  算进超时：队列 8 个 × 单任务 10 分钟时，最后的请求「还没跑就超时」，它拿到的 504 会被
  读成「模型太慢」。测这条要用两个请求 + 一个按调用序号分派的 `ModelClient`（固定顺序的
  脚本会重放第一步，测不出差异）。
- **`acceptProposal()` 已经返回落盘后的 `assets`**，别再 `discoverAssets()` 重扫一遍。
  重扫的代价不只是慢：扫描与写入之间有窗口，扫到的可能是别人（或上一轮）改过的状态，
  而 `rounds` 需要的恰恰是「我刚写进去的那一份」。
- **评测默认不落 trace**（`runSuite` 的 `keepTraces: false`），所以任何「事后读
  `traces.jsonl`」的自动化都必须先假设**读不到**。`rsi` 的 `diffHint` 因此只打印命令、
  不自己执行：自动 diff 在默认配置下拿不到任何一条，会静默变成空操作 —— 而一个大多数
  时候什么都不做的自动化，比一条说清前提的命令有害。真要自动化，先让调用方显式开
  `--keep-traces`，再谈。

## 七、AHE 三层可观测（经验 / 决策 / 留出）

参考 Superagentic AI 那套 Agentic Harness Engineering 的思路，本仓把「闭环为什么可信」
拆成三层。每层都有对应的物理产物与不可变量：

1. **经验可观测**：`rsi/evidence.ts` 把评测报告 + traces 蒸馏成 `overview / detail / raw`
   三层语料。原始 trace **不整坨塞进提示词** —— 那会被噪声淹没且烧掉成本。
   trace 文件解析只有 `run/trace-read.ts` 一处实现；报告有 traceId 但文件缺失时记进
   `missingTraces`，不能装作没发生；语料目录**不覆盖**，证据是历史物。
2. **决策可观测**：`rsi/manifest.ts` 的清单在提案时生成（验证之前），含依据 / 假设 /
   预测 / 风险。预测**不许事后倒推**，否则验证结果会污染假设。清单随采纳进 journal；
   `rsi/ledger.ts` 再把它与 cycle 的实际门结果拼成「当初的预测兑现了没有」。
   被拒的提案也进账本 —— RSI 最值钱的知识往往是「试过但没兑现」。
3. **留出可观测**：`evals/split.ts` 拆 train / holdout。归因与候选排序**只准看 train**；
   留出集在赢家选定后只跑**一次**，用**默认门**，不过就整轮不采纳 —— 回头试第二个
   候选会让留出集退化成第二个调参集。`acceptProposal` 里还有第二道闸：留出集退步、
   或工程配了 holdout 却没有留出集验证结果，都拒绝落盘。它是内部可信入口，手伪造
   `holdout.gate.ok=true` 的结构体属于越过库信任边界，不在防线内。
   split 拼错与「全是 holdout」必须在加载期退出码 2；缺席的 `split` 归 train（兼容老报告）。

## 八、多轮与跨轮自进化（会话 / 记忆 / 回归）

前三层回答「凭什么信这一轮」，这一节回答「凭什么信一段会话与一长串轮次」。

1. **多轮是评测数据的性质，不是运行时开关**：`evals/*.md` 正文用一行
   `<!-- turn -->` 分隔轮次，首段仍是 `task`、后续段进 `followUps`。走的是
   agentia 的 `InMemorySessionStore`（`session: { store, id }`），**不是**自己拼
   messages —— 拼一套就等于评测的不是线上那条路。
   - **中间轮失败即中止**：上游只在 `succeeded` 时把消息追加进会话，失败轮不留历史，
     继续跑等于让后面几轮在一段真实会话里不存在的上下文上作答。
   - 断言口径：文本类看**最后一轮**，工具/token/迭代看**合并后的累计**。合并只有
     `run/trace-merge.ts` 一处；`traceId` 取最后一轮（回查要打开最终失败那一轮）。
   - 多轮用例**不许 harvest**：一条 traceId 对应好几段任务原文，压成一句就是另一个
     场景。加载期空轮次直接退出码 2。
   - **记忆由用例显式声明**（`memory_keys`），缺省是裸 agent。记忆一旦参与，「同一用例
     两次跑不同」就是设计如此而不是抖动 —— 不声明就没法判断评测与线上是不是同一个东西。
     缝在 **run 级**（`RunOptions.memory`），不是装配级：agentia 的语义就是 run 边界
     水合/回写。每次尝试一个新空 store，重试带着上次残留就不是「同样条件再来一次」。
2. **自进化必须跨轮有记忆**：`rsi/rounds.ts` 连续跑 N 轮，每轮一个新提案器；每轮**重新
   发现资产**（采纳只写磁盘，复用快照会让第 2 轮基线用的还是改前的正文，且 accept 的
   乐观锁必抛）。`maxCostUsd` 是**整次运行**的上限（`priorSpentUsd` 跨轮累加），不是每轮
   一份；跑完才发现超限也算「用完」，否则会多跑一整轮基线才发现没钱。
   没有可采纳改动就停 —— 继续跑只会在同一批失败上提同一批方案。
   提案器读取 `lessonsOf()`（账本里 `not_realized` / `reverted` 两类）并在提示词里
   列为「已试过、没成立的方向」；`historyConsulted` 必须落盘，否则看不出它到底有没有
   看到历史。它是**三态**：缺席 = 这轮没走到提案，`0` = 提了案但没有历史，`N` = 带了
   N 条 —— 早停时也写 N 会让这两件事在记录里长得一样。
   `reverted` 的教训原因取 journal 的回滚措辞，不取门结论：那条门结论是**当初通过**
   时写的，拿来讲失败会把成功理由说成失败证据。
   DRY-RUN 与多轮互斥：资产没变，第二轮只会重复第一轮。
   多轮每轮的基线都会跑一遍 holdout —— 这是**基线**（报告要完整），不参与候选排序，
   所以没有破坏「留出集只验一次」那条规则；代价是总成本里会重复计这部分。
3. **采纳之后要被监测**：`rsi regress` 只看**文本资产**的采纳（代码补丁有自己的
   回滚入口 `revertLastCode`，混在一起会让一条资产回滚顺手把代码也退了）；它拿最近一条采纳的 `candidate` 报告当基准，
   跑当前全集比对；基准来自轮次记录，**不**用 journal 的 `after` 重跑重建（那是
   「现在能不能过」，会把回归判成通过）。因此**手工采纳也必须写轮次记录**
   （`acceptFrom` 与 `runCycle` 共用 `writeCycle`），否则手写提案的改动永远在监测之外。
   默认只报告（回归退出码 1），`--revert` 才回滚且仍走 `revertLast` 的指纹校验 ——
   监测自己不许动资产。全部用例都跑崩（缺凭据/端点挂）时**拒绝判回归**：那不是退步，
   照它回滚会把一条正常的采纳误伤。

## 九、HTTP 面的五条契约

server 不是产品，但它**能被别的进程调到**，所以这五条是契约的一部分：

1. **默认不对外**：没配 `server.apiKeyEnv` ⇒ 只接受回环地址；配了 ⇒ 必须带
   `authorization: Bearer`；配了但环境变量是空的 ⇒ **启动失败**。
   第三条最容易被「优化」掉 —— 把空 key 当成「不用鉴权」，会让一台自认为配了安全
   措施的机器以无鉴权状态对外服务。实现只有 `server/http.ts` 的 `resolveKey()` 与
   `authorized()`，两种模式互斥（不存在「带对 key 或来自回环任一满足」）。
2. **队列有上限**：`server.maxQueue`（缺省 8，**含在飞的那一个**），满则 429 +
   `retry-after`。容量检查与入队之间不能有 `await`（Node 单线程下靠这一点才不超卖）。
   串行 + 无限队列 = 调用方拿到十分钟后超时，而不是「现在别来」。
3. **路径带版本前缀**：`/v1/run` 是对外契约，`/run` 只是历史别名；`/health` 不带前缀
   （探针）。真要改协议就加 `/v2`，不要改 `/v1` 的语义。
4. **状态码是枚举出来的，不是默认值兜出来的**：`http.ts` 的 `STATUS_BY_CODE` 是
   `Record<HarnessErrorCode, number>`，新增错误码不选状态就**编译不过**。理由：默认
   落 422 会把「你的请求不合法」（改请求）报成「业务处理失败」（别重试），而这两条对
   客户端的处置建议完全相反。
5. **超时从开始执行起算**，不是从入队起算。闸（`combineAbort`）要在入队的回调里造。
   另外超时必须由 `Promise.race([run, gate.expired])` 在本层兑现 —— 只把 signal 传下去
   等于依赖下游配合。

`tests/server.test.ts` 的「HTTP 面的闸」守前两条：401 三态、空 key 拒启、429 与恢复、
鉴权先于读请求体（没凭据的连接不该有机会占内存）。超时起点、错误码映射、坏请求体
各有一条独立用例。
