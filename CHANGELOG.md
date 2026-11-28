# Changelog

本文件记录**行为变化**。内部重构不记 —— 需要看细节时读 git 历史。

格式：`## [版本] - 日期`，每条都说清「改了什么」与「为什么」。

## [0.4.1] - 2026-11-28

### 新增

**RSI 从「改措辞」跨到「改策略」：四维归因 + frontmatter 白名单 + 声明式策略字段。**
此前 RSI 只能重写 Markdown 正文，改不了真正决定运行时行为的旋钮；而失败归因只有
`stopReason` 与断言文本，「上下文撑爆」「绕圈」「工具选错」「结果不对」长得一样。这次
三段一起补上，让「改策略」成为一轮能被装配、能被评测、能被门验证的进化，而不是改了
磁盘却没人读的空壳。

- **L1 四维归因**：`evals/types.ts` 的 `CaseResult` 带上峰值上下文 / 压缩次数 / 工具调用数，
  由 agentia 0.10.17 的 `runSummary(trace)` 派生（`usage.missing` 的 turn 不算峰值）。
  归因据此把结果类失败中的「反复压缩或峰值远超输出」升级成 `context_overflow`，
  失败签名带行为档位（`[ctx≥100 tools1]`），同类断言失败按运行行为细分。提示词的失败
  证据同步显示四维读数；
- **L2 frontmatter 白名单**：提案可带一个只含白名单字段的 `---` 头改策略，入选标准是
  「harness 解析 → buildApp 装配 → agentia 真执行」。agent 可改 `maxIterations` /
  `maxCostUsd` / `contextBudgetTokens` / `retryMaxAttempts`，skill 除 `maxCostUsd`。
  非白名单字段一旦出现**整份提案拒**（不是忽略、不是只采纳一半）。`AssetPatch` /
  `AcceptIntent` / `JournalEntry` 都记 `settings` 与 `settingsBefore`，采纳落盘、回滚
  恢复 frontmatter；`renderFile` 按 settings 覆盖/追加、按 removeKeys 删除字段行，
  保留排版与注释；
- **L3 声明式策略字段**：`src/run/policy-fields.ts`（在 `run/` 层，不反依赖 `rsi/`）把
  `contextBudgetTokens → createBudgetPolicy({ budgetTokens })`、
  `retryMaxAttempts → retry: { maxAttempts }`，`buildApp` 装配进 `AgentApp`。坏值在
  `createRunner()` 阶段就抛错（不是静默忽略）；文档点名但 agentia 运行时没有的字段
  （`compactWhen` / `retryOn` / `stopWhen` / `maxDelegate`）不实现空壳；
- **提示词**：策略字段节给出各字段当前值与用途（各自取自己的来源，不把 maxCostUsd
  当成上下文预算）；运行时类失败（上下文撑爆 / 绕圈 / 成本失控）优先拧旋钮，结果类
  失败仍优先改正文。真机验证：给 `context_overflow` + 峰值 128k + 压缩 5 次的证据，
  提案器自发输出 `{"maxIterations":"6","contextBudgetTokens":"48000"}`。

依赖下限抬到 `^0.10.17`（`runSummary` 在该版进公共导出面，须先于本包发布）。

**`--repeat n`：把「单次观测」变成「测量」。**

回归门一直有否决权，而它读的 `passRate` 此前是**一次观测**：温度不是 0，同一条用例同一份
资产两次跑分本来就可能一个过一个挂。88% → 92% 可能只是两次抽样之差，`pass_rate_dropped`
会据此否决一个本身没问题的提案；反向的假进步还会进账本，成为下一轮的先验 —— 错误就此复利。

- `src/evals/sample.ts`（新）：同一条用例重复采样 N 次并聚合。**N=1 时原样返回**，
  一个字段都不加 —— 默认路径与没有这个特性时逐字节相同；
- `CaseResult` 增 `samples` / `passedSamples`；`EvalReport` 增 `samples` 与
  `passRateLow` / `passRateHigh`（Wilson 95%，小样本与极端比例下都不越界）；
- `passRate` 改为**样本级微平均**（`Σ passed / Σ samples`）。`samples=1` 时与旧的
  用例级比值逐位相同，老报告的读法不变；
- `src/evals/significance.ts`（新）：两比例单侧 z 检验。`gate` 只在「两边采样数相同且
  ≥ 2、用例集相同、z < -1.645」时按退步否决；否则退回点估计，行为与之前完全一致；
- 新增门结论 `pass_rate_dropped_not_significant`（`ok: true`）：看见了下降但采样量
  不足以支持结论。**单独一个 code**，因为它下一步该做的是加大 `--repeat`，不是改提示词；
- `--repeat` 走 `tuningOf` 单点接线，`eval` / `rsi` / `rsi --watch` / `rsi regress` /
  留出集自动同值 —— 基线跑 1 次、候选跑 3 次会让门拿两种噪声水平的读数互比。

**`harness history`：用例级时间维度，抖动用例不再有否决权。**

报告是孤立文件：它能回答「这次比上次好不好」，回答不了「这条用例本来就是抖的还是这次
真坏了」。没有后者，门的每一次否决都可能是在给一次坏运气发奖。

- 每次 `harness eval` 往 `.workspace/evals/history.jsonl` 追加一行（`--no-history` 关掉）。
  与 `--save` 无关：报告是某一次的快照，历史是所有次的走向；
- `src/evals/history.ts`（新）：读侧坏行**计数跳过**、不抛错（它是旁证，不该挡住主流程），
  但把 `skipped` 交回调用方，由 `harness history` 出声；
- 抖动判据是**同条件矛盾**：同一 `(资产指纹, 用例集指纹)` 下既有全过又有全挂，或同一次
  运行内 `0 < passedSamples < samples`。不是「历史通过率 < 100%」—— 那会把「修好过一次、
  之后一直稳」的用例也算成不可信，而它恰恰是可靠的；
- `error` / `threw` / `timeout` 这三类**运行失败**不参与判定（`recent` 里画成 `E`）。
  这条是照真机误判加的：用错 key 跑了一轮 nightly，三条用例全 `stopReason=error`，
  于是账本里成了「同样条件下既过又挂」，三条用例一起失去否决权；
- `gate` 增 `GateOptions.flaky`：变失败的用例**全部**是抖动的才降级为
  `case_regression_flaky`（`ok: true`，理由带依据）；混着一条稳的就照旧否决，并把被排除的
  几条列进理由（读的人要能复核）。名单由 `verify` / `holdout` 自己读，不做四跳透传 ——
  漏传一处的症状是「有时认抖动有时不认」，那是最难查的不一致；
- `harness history [--tail n] [--check] [--json]`：表格 + 抖动依据，`--check` 有抖动即退出码 1。

**nightly：真模型冒烟，三条最便宜的用例。**

离线 e2e 验证的是协议实现，用假端点 ⇒「DeepSeek 改了 `usage` 字段」「价格表过期」
「模型行为漂移」一件也测不到。`scripts/nightly.mjs` 用真 key 跑
`examples/pipeline` 的三条 train 用例，断言：跑到 3 条、全过、成本读数可用、成本
`< $0.05`、token 正常、**隐含单价在 `$0.1–$2.5 / 1M`**（价格表过期的探测器）。
`.github/workflows/nightly.yml` 每天 UTC 18:00 跑；secret 缺失时打 `::warning::` 并退出 0。

### 变更

**第二个示例 `examples/pipeline`**：两个技能 + 多轮 + 留出集（`phase: 1`）。`starter` 只证明
「最小工程能跑通」，这个证明「换一种形态也能跑」—— `expect_skills`、多轮断言口径、留出集
批次号这些机制才开始被走到。真机 5/5 通过，约 `$0.009`。

**版本一致性检查进 `npm run check`**（`scripts/version.mjs`）。防两种事后才发现的错：
升了包版本没写 CHANGELOG（发布页是空的一节），或写了新版本节却没升包版本。顺带查版本号
重复与「最新应在最上」。`npm run bump patch|minor|major` 一键升版（把 `[Unreleased]` 落成
版本节）。没用 changesets：单包 + 手写 CHANGELOG 的场景下它只带来维护面。

**离线 e2e 增并发与账本两条**（31 条）：`--concurrency 2 --repeat 2` 的结果顺序必须与串行
逐条一致（顺序变了，diff 就不再只是资产差异）、并发粒度是用例而不是采样；以及
「每次 eval 自动记账」的 CLI 接线。

**内部拆分**（都在 400 行守卫之内）：`evals/model-note.ts`（报告的模型事实）、
`evals/verdict.ts`（「能指名到用例」那条判据，因为它会被历史改写）。

**测试带上覆盖率门禁**（`npm test` 内建）。

此前 93% 只是「这次碰巧」：CI 不跑覆盖率、不设阈值，新模块（`config-balance.ts`）
已经掉到 77% 行 / 58% 分支而无人知晓。现在 `npm test` 用
`--test-coverage-exclude='tests/**'` 只统计 `src/`，阈值 87 行 / 79 分支 / 88 函数
（当前水位 89.4 / 81.1 / 90.2）。

顺带修一处旧文案：`pass_rate_dropped` 的理由原先输出「下降 -33.3pt」（负号重复）。

## [0.4.0] - 2026-11-28

> **依赖前提**：本版起 `src/run/menu-read.ts` 从 `@migor/agentia` import 三个 run 根属性常量
> （`MENU_HASH_ATTR` / `MENU_NAMES_ATTR` / `PROMPTS_VERSIONS_ATTR`）。它们**在 agentia 0.10.16
> 才存在**，所以发布顺序是「先发 agentia 0.10.16 → 再把本仓下限写准 → 发本仓」。
> 锁在 0.10.15 的工程会在 `tsc` 上响亮报 `TS2305`（不是静默降级），`npm i` 一次即自愈。

### 新增

**报告能回答「这次的菜单与措辞，跟上次是同一个吗」。**

此前 `model-read.ts` 只回答了「换了模型没有」。两份跑分不可比的病因还有两个，而它们恰好
都写在 run 根属性上：**菜单变了**（多一个工具 / 某个 schema 收紧）与**措辞变了**（`@Prompt`
资产换版本）。缺这两个读数时，通过率掉 20pt 只能靠回忆归因，而回忆错的方向是把「换了资产」
读成「模型抖动」—— 归因错的结论比没有结论更贵。

- `src/run/menu-read.ts`（新）：`menuFacts(trace)` 只在 **run 根**读（子循环不设根属性，
  故无需另做过滤）；多个根说同一句话才取值，互相矛盾则缺席；
- `CaseResult` 增 `menuHash` / `promptVersions`（成功路径与「前几轮已跑完但崩了」的路径都带）；
- `EvalReport` 增 `menuHashes` / `promptVersions`（**集合**），三档语义不许压平：
  缺席 = 不知道（老报告 / 有用例没留下根属性）、`[]` = 确认没有、多个值 = 这批内部就不一致；
- `harness report` 的比较视图多两行读数（`菜单` / `版本`）与三条注意；
- `tests/menu-facts.test.ts` 12 条（读取 / 聚合 / 渲染出声 / 「只出声不否决」）。

**刻意不动 `gate()`**：加一条否决会改变「什么算变好」的对外解释权（那张表在 README 里），
而「换菜单 / 换资产版本」都是合法实验。RRSI 的正则化也不是否决，是**选择端**的过滤。

**留出集从「一轮验一次」变成「每批验一次」。**

留出集不变、轮次无限时，30 轮 × 每轮 5% 的累积假阳性约 78%：每一轮的门都在"合法地"
放过一点噪声，而每一轮都比上一轮更自信。修法不是多留几条用例（那只是把常数改大），
是让留出集**可消耗**。

- `evals/*.md` 增 `phase`（正整数，只对 `split: holdout` 有意义的批次号；写在 train 上
  或写错格式在加载期就报错 —— 两种都会静默失效）；
- `src/rsi/holdout-batch.ts`（新）：`holdoutProgress` / `pickHoldoutBatch` 选「序号最小且
  没用过」的那批，`appendHoldoutUse` / `readHoldoutUses` 记消耗账
  （`.workspace/rsi/holdout-uses.jsonl`）。**消耗与结果无关**：通过、否决都算用过；
  `--dry-run` 也算（验一眼就是看一眼）；验证本身崩了不算（那不是一次观测）；
- 全部批次用完后**拒绝**验证（不退回第一批发重用），理由里写清"补一批新用例或收工"；
  `rsi accept --from` 走同一条规则 —— 手写提案不是绕开消耗账的后门；
- 未声明 `phase` 的老工程**行为不变**（整份算一批、可复用），但复用次数落盘并在
  `rsi status` 出声 —— 加字段之前不偷偷改掉既有行为，是这个仓一贯的口径；
- `subsetReport`（`evals/split.ts` 新）：基线与候选必须比**同一批**，否则门会先报
  `case_set_changed`（"仅基线有 h2"）—— 那不是判定标准变了；
- `CycleReport` 增 `holdoutBatch`（批次 / 用例 / 用之前被用过几次 / 是否强制）。

**净简化配额：给「成本只涨不跌」的棘轮装刹车。**

回归门第 5 行刻意宽容（通过率提升时成本涨多少都放行），但宽容是单向的：每轮都能加一点，
没有一轮被迫删。改的是**调度**，不是判据：

- `src/rsi/shrink.ts`（新）：连续 `every`（缺省 5）条采纳的改动没让资产变小，或累计成本
  增幅超 `maxGrowth`（缺省 50%，相对增幅逐条相加）⇒ 这一轮是**简化轮**；
- 简化轮里：提案提示词明确"只许删与合并"并给出目标字数；变胖的提案在**跑评测之前**被挡下；
  「通过率没变但资产确实更小」算值得（判据是正文净减少 ≥ 5%）；
- 状态从 `cycles/*.json` 现算，不落游标：多一个"当前是不是简化轮"的文件，就多一处会与
  历史不一致的真相；
- `--shrink-every <n>` 可临时收窄触发间隔；`RoundStopReason` 增 `shrink_stalled`
  （这一轮被配额限定为只许删，而模型没交出可用的删除 —— 人去删一段）；
- `isWorthAccepting(outcome, { shrink })`：口子开得很窄，仍要过门（含留出集）。

**内部**：`evals/types.ts` 的聚合读数拆到 `evals/aggregate.ts`、轮次记录的读写并入
`rsi/cycles.ts`（单文件 400 行上限）；`CYCLE_SCHEMA` 2 → 3（只增字段，老记录照常可读）。

### 依赖

- `@migor/agentia` `^0.10.15` → `^0.10.16`。直接原因见上方「依赖前提」：`src/run/menu-read.ts`
  从上游 import 的三个 run 根属性常量在 0.10.16 才进公共导出面。caret 范围本来就允许
  0.10.16，**消费者侧装到的实际版本不变**，改动只是把下限写准。
- 0.10.16 只是把三个名字收进 `core/trace.ts`（写侧改引常量，写出的字符串逐字不变），
  本仓因此**无可观测行为变化** —— 记在这里是为了让人知道「跟了版本」而不是漏改。

## [0.3.1] - 2026-11-25

> **无行为变化。** 这版只为把 README 瘦身版刷上 npm（npm 页面上的 README 是 publish 时的
> 快照，0.3.0 那份还是 541 行的旧版），并把上游依赖下限写准。

### 文档

- README 从 541 行收到 239 行，深度内容拆进 `docs/`（`assets` / `cli` / `evals` /
  `invariants` / `operations` / `rsi`）。代码没动，所以测试与产物不受影响。

### 依赖

- `@migor/agentia` `^0.10.14` → `^0.10.15`。caret 范围本来就允许 0.10.15，**消费者侧
  装到的实际版本不变**，改动只是把下限写准（`CONTRIBUTING.md` 同步）。
  0.10.15 修的是「会话回写只看 `finalText`，结构化结果整段丢失」；harness 目前不给被测
  agent 声明 `resultSchema`，也从不读会话正文，因此本仓无可观测影响 —— 这条记在这里是为了
  让人知道「跟了版本但没有跟着改逻辑」，不是漏改。

## [0.3.0] - 2026-11-25

> **首个发布到 npm 的版本。** 下面 `0.1.0` / `0.2.0` 两节是仓库内的里程碑记录，从未上传
> registry —— 所以从 npm 看 0.3.0 之前没有历史，不是你升级时漏了两个版本。

### 新增

- **报告能表达「实际用过哪些模型」**：`EvalReport` / `CaseResult` 增 `models` 与
  `fallbackUsed`。`model` 是单值，而配了 fallback 链之后**一次 run 内部**就可能换模型 ——
  单值会把「A 降级到 B 才跑完」记成「用了 A」，于是 `sameModel` 判据静默失效：基线降级过、
  候选没降级，通过率差异被读成 agent 的进退步。
  三处证据全部现成（`llm.turn` 的 span 名就是模型 id、换环写 `llm.fallback { from, to,
  errorType }`、根属性 `config.fallbacks` 是**声明**链），所以不需要上游加接口，也不用改
  装配 —— 这一版**没有**接 fallbacks，只是让报告不再说谎。
  报告层**任一条用例没记就整体缺席**（与 `costKnown` 同一条纪律）：并集少一个模型得出的
  「两边一样」比「不知道」贵得多。
  `gate` 的 `sameModel` 改判**集合**（老报告退回单值），并新增 `modelNote` 并入 `reason`：
  集合不同、发生过降级，两条都会让通过率不再可读成改动效果。降级本身**不否决** ——
  否决权只给回归与成本。

- **`harness diff <A> <B>`**：两份 trace 差在哪。`harness trace` 回答「这次发生了什么」，
  `harness report` 回答「整体有没有变好」，人在修问题时问的是第三个问题。此前这个位置是
  空的：门说得出「case 3 从通过变失败」，说不出「第 2 回合少了 search」。
  用上游 `diffTraces`（配对是结构性的：`llm.turn` 只按 kind 配对、模型名降格成字段差，
  正是「换模型重跑」这个主用例）。缺侧写「仅 A 有」「仅 B 有」，不写成 `（无） → （无）`。
  `rsi` 在门否决且两边都有 traceId 时打印一行带前提的命令（需那两次跑都开了 `--keep-traces`）——
  刻意**不自动 diff**：评测默认不落 trace，自动版在默认配置下拿不到任何一条，会静默变成空操作。

- **用例可以声明走不走记忆**：frontmatter `memory_keys: [notes, profile]`。记忆一旦参与，
  「同一条用例两次跑结果不同」就是**设计如此**而不是抖动；用例不声明，评测与线上测的是不是
  同一个东西就无从判断。缝开在 run 级（`RunOptions.memory`，agentia 的语义就是 run 边界
  水合/回写），不是装配级。每次尝试各造一个空 store —— 上次尝试写进黑板的键若留下，重试
  就不是「同样条件再来一次」。种子只支持「空 store + 这些键」：格式等业务框架定下来再定。
  `RunOutcome` 同时增 `models` / `fallbacks`（可选，外部构造的 outcome 不必填）。

- **报告自带环境事实**：`EvalReport` 增 `model` / `harnessVersion` / `finishedAt` /
  `caseFingerprint`（全部可选，老报告照样能读）。`harness report` 会打印「模型 A → B ·
  agent · harness 版本」，发现不一致时给出警告。没有这四个字段时，「两份报告能不能比」
  只能靠假设 —— 换模型、改断言、升级 harness 都会让通过率变化被读成 agent 的进退步。
  `caseFingerprint` 覆盖名字 + 任务 + 后续轮次 + 断言 + 分组，但**不含文件路径**：
  把 `evals/a.md` 改名不该让两份报告失去可比性。
  `harnessVersion()` 从 `package.json` 读（不写常量 —— 常量要在每次发版时手工同步，
  漏一次就会让两个版本互相声称「同一个 harness」）。

- **`harness report --allow-case-set-change`**：用例集不同时显式只比交集。缺省拒绝
  （见下方修复），显式开这个口子等于声明「我知道分子分母变了」。

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

### 新增（生产可选的两道闸）

- **HTTP 面可以对外了（默认仍然不对外）**：`harness serve` 的路径改为
  `POST /v1/run`、`GET /health`（`/run` 保留为历史别名，行为完全一样）。新增
  `server` 配置段：
  - `server.apiKeyEnv`：不给 ⇒ 只接受回环地址；给了 ⇒ 必须带
    `authorization: Bearer <该环境变量的值>`。**配了但变量为空会拒绝启动** ——
    把空 key 当成「不用鉴权」是这类闸最典型的静默失效。
  - `server.maxQueue`（缺省 8，含在飞的那一个）：满了返回 `429` + `retry-after`。
    此前队列无上限，串行执行下请求只会越排越久，调用方拿到的是十分钟后的超时。
  - `GET /health` 免鉴权（探针要能打），多返回 `maxQueue` 与 `auth`（`key` /
    `loopback`），运维一眼看出这台机器挡没挡。
  - 鉴权在**读请求体之前**：没凭据的连接不该有机会占内存。
- **依赖改为 registry 版本**：`@migor/agentia` 从 `file:../agentia` 改为
  `^0.10.12`，CI 不再并排 checkout 上游仓。此前任何人都装不上这个包（仓库里的
  路径在别人机器上不存在），CI 也验证不到「别人装到的那一份」。

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

### 新增（账本可修、成本账、读取层）

- **`harness rsi journal [--json] [--repair]`**：把 journal 变成能被看的对象。此前它
  只有写入侧，读取侧散在 `accept` / `regress` / `ledger` / `cycle` 四条路径上。

  `--repair` 只截**末行半截**，且先备份到 `journal.jsonl.bak-<ISO>`、截完用同一套
  解析再复核一遍才落盘。之所以不让读取侧「宽容跳过」：那会把「回滚基于不完整的历史」
  变成静默行为。而中间行坏了**不修** —— 结尾有换行却解析不了，是内容真坏了（手改、
  磁盘错误），自动化去截它只会把「数据坏了」变成「数据少了一行」。

- **末行半截不再让整条链路永久死掉**。append-only 文件被杀在写系统调用中间，只会
  产出末行半截（前面各行完整），那是「中断的追加」不是「历史损坏」。此前它让
  `rsi accept/regress/ledger/cycle` **一致地**抛原生 `SyntaxError`（`Unterminated
  string in JSON`，没有 `code`，没有修复建议），看起来像程序坏了。现在两种情形分开
  报：半截行指出「这不是损坏，跑 `--repair`」；中间行坏仍然拒绝，并且指出是第几行。

- **`cycles/*.json` 带 `schemaVersion`**。此前磁盘上的记录没有任何版本标记，字段
  一旦增删，读的一方只能靠「有没有这个 key」猜。老记录读进来按 0 处理（并现场迁移
  出 `timeMs`），新记录写 `schema: 2`。同时把 `cycles/` 的**四份读取实现**（`regress`
  的候选查找、`ledger` 的采纳历史、`rsi status`、`rsi regress` 的基准回溯）收成一个
  `readCycles()` —— 之前它们对坏记录的容忍度各不相同，同一份坏文件在不同子命令下
  表现不一致，是最难查的那种。

- **`GET /health` 多报 `assetsOnDisk` 与 `assetDrift`**。服务的 runner 用的是**启动时**
  的资产快照，而 RSI 采纳会在进程活着的时候改盘 —— 探针只报快照指纹时，运维看到的
  是一台「资产是新的」的旧进程。`assetDrift: null` 表示磁盘读不动（文件被删/frontmatter
  坏了），这也要能看见：进程还活着，只是它手里的资产来源没了。

- **取消信号贯通到提案器**。此前 `/v1/run` 超时或客户端断开时，signal 只传到执行层，
  提案器还在一个模式一个模式地调模型 —— 钱照花，结果没人要。现在 `ProposeContext.signal`
  直通 `app.run`，且每个模式循环开头都查一次 `aborted`。同时 `propose()` 的**花费**
  从「事后再读提案器的可变属性」改成随结果返回（`{ proposals, cost }`）：读完属性再
  问跑没跑成，中间有任何异常都会让那一笔钱凭空消失。

### 不兼容（库调用方）

- **`gate().sameModel` 的判据从「单值相等」变成「集合相等」**。单模型场景结果不变；
  跨模型的合法实验（「换个便宜模型还过不过」）在预置了 fallback 链时说法会变：以前
  两边主模型同名就判 `true`，现在按**实际尝试过的模型集合**判。想回到「只看主模型」的
  语义，就传没有 `models` 的旧报告（那条路仍在）。
- **`Proposer.propose()` 返回 `{ proposals, cost: { usd, known } }`**，不再是裸数组 +
  `costUsd` / `costKnown` 两个属性。实现自定义提案器的地方要改：`cost.known === false`
  表示这次花费**不可知**（不是 0）—— 预算闸只在这时为真时生效。
- **`acceptProposal()` / `acceptManually()` 返回 `{ entry, assets }`**（`writePatch` 同），
  `assets` 是落盘之后的资产快照。此前调用方（`rounds`）只能重新扫一遍磁盘来避开
  「下一轮还在用旧快照」—— 那是在替实现的缺口兜底，而不是设计。
- **`applyEndpointEnv()` 改名 `ensureEndpointEnv()`**。它的语义一直是「只填空位」：
  幂等、不覆盖真实环境变量、且是**进程级**的（同进程两个 config，第一个赢）。
  名字里带 `ensure` 是让「调多次没关系」这件事在调用点一眼可见 —— 现在有三处调用
  （CLI 入口、`createRunner`、`LlmProposer` 构造），看起来像重复劳动，实际是刻意的。

### 严格化（拼错就退出码 2）

此前这几类错全都表现为「配了但没生效」，症状出现在成本或通过率上，没人会往拼写上想：

- 配置顶层 / `endpoint` / `pricing` / `code` 的未知键（后者注释承诺过、实现漏了）；
- eval frontmatter 的未知 `expect_*`；非法 `expect_matches` 正则现在在加载期就炸，
  不再等用例跑到一半；
- CLI 未知 flag；`--timeout abc` 此前静默等于「不设超时」；
- `maxCostUsd` / `maxIterations` 必须是正数 —— `0` 在 agentia 里是「不设上限」；
- 手写提案 JSON 的未知字段、非法 `kind` / `target` / `id`（id 会当文件名用）、空 `after`。

### 修复

- **train / holdout 视图不再丢掉模型事实**：`splitReport()` 重建视图时没传环境，
  于是门在视图上比对时 `sameModel` 恒为「不知道」，而那本来是可确认的。
  **`caseFingerprint` 刻意不带**：它是整批用例的哈希，带进子集视图会让基线（全量指纹）
  与候选（只跑 train 得到的子集指纹）永不相等，每轮验证都被误判成 `case_set_changed`。

- **`/v1/run` 的超时从真正开始执行起算**。此前超时闸在**入队前**创建：队列深度 8 ×
  单任务最长 10 分钟时，排在最后的那个请求完全可能「还没开始跑就已经超时」，而它拿到
  的 504 会被读成「模型太慢」—— 那条排查方向是错的，改模型、改提示词都没用。

- **错误码 → HTTP 状态改成了穷尽的表**。此前是 if 链，默认落 `422`：于是「你的请求
  不合法」（该改请求）与「业务处理失败」（别重试）在客户端看来是同一个东西，而这两条
  的处置建议完全相反。现在 `run.bad_request` / `code.invalid` ⇒ 400、
  `run.payload_too_large` ⇒ 413、`rsi.gate_blocked` / `code.unapproved` /
  `code.conflict` / `rsi.no_baseline` ⇒ 409、配置与资产类 ⇒ 500。写成
  `Record<HarnessErrorCode, number>` 而不是带默认值的映射，是因为**新增错误码必须
  当场选一个状态**，缺键编译不过。

- **坏请求体不再报成「执行失败」**：不是合法 JSON ⇒ `400 + run.bad_request`，此前抛
  `run.failed`（422），调用方会以为任务跑过一遍。合法 JSON 但不是对象
  （`"abc"` / `[1]` / `null`）此前被静默收成 `{}`，调用方只看到「body 需要非空的 task」
  —— 真正的原因是他发的根本不是对象，现在直接 400 说清楚。

- **未分类异常不再回显内部 message**。它可能带绝对路径、上游响应片段甚至凭据片段；
  「内部为什么坏」该进服务端日志（一行 JSON 落 stderr），而不是进调用方的响应体。
  已知错误码的文案是**为调用方写的**，照旧透出。

- **用例集变了不再被说成「整体退步」**：加一条候选没做的用例，会让通过率的分母变大、
  通过率下降，此前门报 `pass_rate_dropped`「通过率下降 Xpt（整体退步）」—— 结论对
  （该拒绝），但**归因错**：这不是提案让 agent 变差，是基线过期了。照着这条理由去改
  提示词，会改一个不存在的问题。现在独立成 `case_set_changed`，指出哪些用例只在基线 /
  只在候选，并给出两条出路（重跑基线，或 `--allow-case-set-change` 只比交集）。
  只比交集时 token 与成本也只在**同一批用例**上算 —— 否则「多了几条用例的开销」会被
  读成「这条用例变贵了」。两条报告完全没有同名用例时是 `not_comparable`，不是 `pass`。
- **`sameCaseSet` 有两种「看不出来」**：两边都有 `caseFingerprint` 时按指纹判（能抓到
  「名字没变、断言改了」）；老报告没有指纹时只能确认名字相同 —— 这时返回 `undefined`
  表示「断言是否一致不知道」，与 `true`（确认一致）严格区分。
- **库用法下 `endpoint` 配置静默不生效**：`applyEndpointEnv` 此前只在 CLI 入口调用，
  直接调 `createRunner` / `runCycle` / `LlmProposer` 的库用户会踩「主 agent 走得通、
  技能子循环 401」的分裂故障（子循环各自现造默认 client，只读环境变量）。现在
  `createRunner` 与 `LlmProposer` 构造时都幂等落地一次 —— 不覆盖已有环境变量，
  CLI 已落过时是无操作。
- **已回滚的采纳不再被当成「还生效」**：journal 是 append-only（回滚只追加记录、不改原
  accepted 行），而「最近一条采纳」的三个读取点此前只看 `status === 'accepted'`。症状：
  回滚后 `rsi regress` 仍拿已作废的提案当基准，把「回滚的预期结果」报成回归；二次
  `rsi revert` 撞指纹校验，报「采纳之后资产又被改过」—— 真相是「已经回过了」，两者修法
  完全不同。现在「仍生效的采纳」只有 `journal.ts` 的 `liveAccepted()` 一个判法，「这条
  是不是回滚」只有 `revert-note.ts` 的 `isRevertEntry()` 一个判法；二次回滚的报错也
  区分「没有可回滚的」与「这个 id 已经回过」。
- **code 回滚条目补上 `reverted` 作废标记**：此前只能靠 reason 的「回滚了」前缀识别
  （前缀还不在任何接口里），与文本资产不同款。
- **账本靠文件名反解时间**：轮次记录现在自带 `at`（ISO 时刻）字段，`rsi ledger` 与教训
  排序按它走；`2026-11-22` 之前的旧记录没有该字段，回落到文件名解析（不会读不出来）。
  此前排序依赖 `cycleId` 的命名格式 —— 改一次命名就让解析静默失败并回落 0，最该被记住的
  教训被排到最后、在截取最近 N 条时被丢掉。
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

### 内部（依赖下限 0.10.14；trace 词汇改由上游供）

- **`@migor/agentia` 下限 `^0.10.13` → `^0.10.14`**：`^0.10.x` 的实际区间是
  `>=0.10.13 <0.11.0`，0.10.14 一发，CI 就会装新版而本地 lockfile 钉旧版 —— 那种
  「本地绿、CI 红」不值得赌一次。
- **删掉 `src/run/trace-events.ts`**（本地字面量副本），三处引用改为从 `@migor/agentia`
  import 同名常量：`run/cost.ts`（`USAGE_MISSING_EVENT`）、`run/model-read.ts`
  （`LLM_FALLBACK_EVENT` / `CONFIG_FALLBACKS_ATTR`）、`evals/tool-events.ts`
  （`TOOL_INPUT_EVENT`）。常量名与上游逐字相同，所以这次是纯机械替换。
  副本里另外三个（`TOOL_OUTPUT_EVENT` / `USAGE_PARTIAL_EVENT` / `CONTEXT_BUDGET_EVENT`）
  本仓从未读过，随之一起删除。
- **加两条架构守卫**（`tests/architecture.test.ts`）：`src/` 里出现这 7 个字面量就红
  （按代码区扫描，注释里的举例不算）；以及这 7 个常量在上游的**取值**必须与约定逐字一致。
  后一条的意义是：上游若改值，这是协议变更，得红在我们自己这里，而不是等两份跑分
  被拿来比较时才暴露。
- **测试夹具继续写字面量，这是刻意的**。夹具若也 import 常量，上游改名时夹具跟着变，
  「工具序列非空」「降级事件被读到」这些行为断言就永远绿 —— 夹具必须是独立证人。
  所以守卫只扫 `src/`。

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
