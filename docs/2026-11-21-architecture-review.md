# agentia × agentia-harness 深度架构评估报告

- 评审日期：2026-11-21
- 评审对象：`@migor/agentia`（基座，src ~27.4k 行）与 `@migor/agentia-harness`（harness，src ~6.4k 行）
- 评审方式：全量通读 harness 源码（src/ 每个文件），抽审 agentia 的公共面、引擎主循环、capability-loop、subagent、core/trace、eval；实跑 harness 测试（245/245 绿）；核对两仓 AGENTS.md 不变量与代码实际是否一致
- 评审视角：作为「harness 框架基座」的架构合理性、模块化、通用性、高内聚低耦合、重复工作

---

## 一、总体结论

**这两个仓库的工程质量在我评审过的 TypeScript 项目里属于头部水平，可以放心作为框架基座继续投入。**

最值得说的不是「分层合理」这种泛泛结论，而是两仓共享的一套工程哲学，且**每条哲学都有可执行的防线**，不是靠文档自觉：

1. **「静默失败」是一级敌人**。几乎所有设计决策都围绕「消灭静默」：配置拼错键当场炸（`config.ts` 的 `rejectUnknownKeys`）、eval 断言键拼错当场炸（`evals/load.ts` 的白名单）、成本「没读数」与「免费」严格分开（`run/cost.ts`）、超时必须自己兑现不能只传 signal（`util/abort.ts`）。
2. **约束可执行化**。依赖方向、文件行数、公共出口形状全部有测试看守（harness `tests/architecture.test.ts`；agentia `tests/architecture/` 一整套），不是写在 README 里的愿望。
3. **单源原则贯彻得很彻底**。每个「容易写两份」的口径都有明确的唯一实现点，且注释里写明「为什么只能有一处」（详见 §4）。
4. **每个「为什么」都留在代码里**。文件头注释解释的是设计动机与历史事故，不是复述代码。这让「别做重复工作」的前提成立：后来者知道什么东西已经存在、为什么长成那样。

一句话总评：**harness 没有重新发明 agentia 已经有的东西，它发明的是 agentia 刻意不做的那一层（资产化、评测台、RSI 闭环），两层职责几乎零重叠** —— 这正是「基座」与「上层建筑」应有的关系。

| 维度 | 评分 | 一句话 |
|---|---|---|
| 分层与依赖方向 | ★★★★★ | 两仓都是单向分层 + 可执行守卫，环的断法（paths.ts / types.ts 下沉）干净 |
| 模块化（粒度与边界） | ★★★★★ | 单文件 ≤400 行有测试看守；每个文件一个明确职责 |
| 高内聚 | ★★★★★ | 文件内聚于「一个口径 / 一个判定 / 一个出口」 |
| 低耦合 | ★★★★☆ | 对 agentia 有 4 处「字面量复制」的隐性耦合（有测试兜底，但本质是私有契约） |
| 通用性（可复用/可替换） | ★★★★☆ | Proposer 可换、资产层独立可用；端点面 Anthropic-only 是已知边界 |
| 测试与门禁 | ★★★★★ | 245 测试全绿；架构守卫、离线 e2e、错误码即接口 |
| 重复工作 | ★★★★☆ | 有 2 处可直接消除的小重复（见 §5），无结构性重复 |

---

## 二、agentia 作为基座的评估

### 2.1 做得对的地方

**分层是「构造性」的，不是靠约定。** `core ← engine ← {runtime, store}`、`store ← transport`、`runtime ← toolkit`、`integrations` 只依赖 core、`eval` 是叶子消费模块——这套方向由 `tests/architecture/layering.test.ts` 与 `file-cycles.test.ts` 强制执行。更难能可贵的是对「类型级依赖也计入分层」的坚持（`RunStatus`/`RunMeta` 从 runtime 下沉 core 的那段记录），这是多数项目会放过、日后变成兄弟层乱麻的地方。

**trace 是一等公民，这直接决定了 harness 能否成立。** harness 的整个 RSI 归因（`capabilityHits`、`toolInvocations`、成本口径）都建立在 agentia 的 span/事件模型上。子 agent 是 capability span、工具 IO 是 span 事件、usage 逐回合记账——**harness 没有为观测打任何一个自己的埋点**，全部读基座的 trace。这是基座质量最高的证明：上层的核心功能可以纯消费基座的观测面而零侵入。

**「旋钮不可漏」的接口设计。** `runCapabilityLoop` 不直接暴露 `runAgentScoped`，而是包成「`...forwardToolContext(ctx)` 一次取自单源」的形状——因为它自己的历史事故就是「手写清单漏了 `toolTimeoutMs`，静默失效」（`capability-loop.ts` 头注）。把「容易漏」从使用者的责任变成类型的责任，这是框架设计里最值钱的一类决定。

**零运行时依赖 + 公共面单出口。** 三个包运行时只 import 相对路径与 `node:` 内置，有测试强制；新增导出必须在 `src/index.ts` 登记，内部 helper 只做 module 级 export。harness 因此能精确知道自己依赖的是「承诺过的面」。

### 2.2 作为基座的摩擦点（对 harness 的影响已在 harness 侧被妥善处理，但根源在上游）

**B1. 引擎→integrations 的反向依赖（已知的架构妥协）。** `engine/loop.ts` 直接 import `integrations/anthropic.ts` 造默认 client，`engine/mcp-server.ts` 取 `DEFAULT_PROTOCOL_VERSION`。分层图里 `integrations` 只许依赖 core，于是默认 client 的缝只能开成「engine 依赖 integrations」这条反向边。AGENTS.md 如实记录了这是刻意的，但它意味着**「换默认模型供应商」不是配置问题而是依赖问题**。harness 的应对（环境变量落地端点，`run/endpoint.ts`）是目前最务实的绕法，但根源在上游没有「client 注册表」这类缝。不构成行动项，记录为架构债的已知位置。

**B2. 事实上的跨进程契约没有进公共面。** `core/trace.ts` 里 `TOOL_INPUT_EVENT = 'tool.input'`、`USAGE_MISSING_EVENT = 'usage.missing'` 是 module 级 export 但不进 `index.ts`；`addUsage` 同理。harness 不得不在三处复制字面量（`evals/tool-events.ts`、`run/cost.ts`、`run/trace-merge.ts`），并靠「真实 trace 断言」测试兜底上游改名。这些字符串**已经是**跨仓契约——任何外部评测/审计工具都需要它们。建议直接提升进 agentia 公共导出面（见 §5 F2）。

**B3. 默认 client 每次 run 现造，注入的 client 进不了子循环。** `runCapabilityLoop` 继承 `ctx.client` 但**不继承 model**（刻意边界）；显式注入的 client 传不进技能子循环与任何「自己造 app」的角落（如 harness 的 `LlmProposer`）。后果链：换端点的工程只能靠进程环境变量保证「所有调用点同源」。harness 已在 CLI 入口一次性落地（`run/endpoint.ts`），但**这只覆盖 CLI 入口**，库用法有坑（见 §5 F4）。

**B4. 公共类型名与 harness 撞名。** agentia 的 `eval/defineEval.ts` 导出 `EvalCase` / `EvalReport`，harness 的 `evals/types.ts` 也导出同名但形状完全不同的类型。两个包是依赖关系，下游一旦同时 import 两边就必须起别名。见 §5 F3。

---

## 三、harness 逐层评估

### 3.1 `assets/` —— 纯文件层（优）

- 零 agentia 依赖、零上层依赖，有架构测试钉死。可以在任何环境（含浏览器式工具、CI 脚本）单独使用——「纯文件层」这个定位为它将来的复用留足了余地。
- 校验口径全部「响亮失败」：`description` 必需、正文非空、跨 kind 名字唯一（`discover.ts` 的 `assertToolNames`——注释把「分别唯一为什么不够」讲得很清楚：两个同名工具会让模型随机选，评测上表现为「提示词不稳定」这种误诊）。
- `toolsDeclared` 字段把「没写 tools」与「写了空数组」区分开（缺省=全部技能 vs 显式=零技能），这个不对称是有意的并且在类型上落了地，是「缺省必须安全」原则的典型实现。
- 指纹设计克制：单资产指纹 = 全文件 sha256-12，集合指纹 = 排序拼接再 hash。「改一个标点也要变」是正确的保守。

### 3.2 `config.ts` —— 严格配置的样板（优）

339 行里大部分是校验代码，这是对的。「约定优于配置 + 出现过的键才覆盖 + 未知键一律拒 + 每类错都有针对性文案」四件事同时做到。两个细节值得点名：

- `ModelPrice` 刻意不 import agentia 的 `ModelPricing`（配置层不认识运行时），字段逐条对齐且注释里把 `cacheRead/cacheWrite` 是**乘数不是绝对价**这个最容易配错的点写死。这是「有意识的重复」，理由成立（分层 purity），代价是口径漂移风险——AGENTS.md 如实写明「`tests/config.test.ts` 只守形状，口径靠人守」，**这是全仓少数几个「靠人守」的点之一**，建议补一条类型级 conformance 断言（`satisfies` 或类型测试）把它也变成机器守。
- `positiveNumber` 拒绝 0 与负数，因为「0 在 agentia 里是『不设上限』」——配置层主动消化了上游语义里最容易踩的那颗雷。

### 3.3 `run/` —— 装配与执行（优，是本仓写得最好的一层）

- **`buildApp` 是纯装配**（同资产集 → 同 app），归因 label（`harness.assets` / `harness.agent`）在装配期就挂好。「评测与线上走同一条路」由 `Runner` 保证——CLI、评测、RSI 验证、server 全部经它，差别只收进 `RunOptions`。
- **成本口径是全仓最见功力的地方**：`costOf()` / `usageReported()` 单源（`run/cost.ts`），把「未定价（undefined）」「端点没报计量（折回 undefined）」「真 0」三种状态分开；`costNote` 区分 `unpriced` / `unreported` 两种病因——因为它们对应的修复动作完全不同。这个区分贯穿 runner → 报告 → 门 → 预算闸，没有一处偷懒。
- `runTurns` 的多轮纪律（中间轮失败即中止，因为上游只在成功时回写会话）把「评测数据性质」与「运行时开关」分得很干净；首轮即抛时造空 trace 而不是让用例变成「run 抛出」，保住了「这是多轮用例」的报告事实。
- `buildTools` / `assertNoCycles`：技能环与委派环都在**装配期**检测，理由写在注释里（运行期才炸只剩几十层同名 span，看不出根因）。`SubloopDefaults` 把生效模型透传进子循环，正面解决了上游「子循环继承 client 不继承 model」造成的 40 倍错账——注释里连实测数字都留了。

### 3.4 `evals/` —— 评测台（优）

- **断言体系刻意无 LLM**（规则式判定），理由一句话说透：「裁判不确定，RSI 就会把随机波动当进步」。断言维度覆盖结果（contains/matches）、过程（tools 子序列/toolCounts/toolArgs/skills）、边界（ok/maxTokens/maxIterations），且三种工具断言共用 `tool-events.ts` 一个扫描出口——「什么算一次调用」只有一个解释。
- `gate()` 是**字典序 + 硬否决**，明确拒绝加权总分（「权重随手一调就能让任何结论成立」）。每条否决理由都能用一句人话解释，且 `reason` 字段确实就是那句人话。两个刻意的宽容（通过率升则 token 涨放行；用例集不同只比交集）都写明了动机。
- `runOne` 的超时兑现（`Promise.race` + `expired`）、「只重试 stopReason=error、断言失败绝不重试」「多轮超时时合并已跑轮次保住成本账」——每一处都对应一类真实的「评测说谎」方式。
- `load.ts`：断言键白名单、加载期编译正则、`contains ∩ notContains ≠ ∅` 拒收、空断言用例拒收（「永远通过的用例对 RSI 是负资产」）。这是「评测台自己也要被评测」的自觉。
- `split.ts` 的 `HOLDOUT_GATE_OPTIONS = Object.freeze({})` 用**常量**而非约定来保证「留出集必须用默认门」——让调用方没法顺手把调参阈值传进去。用结构防误用，优于用文档防误用。

### 3.5 `rsi/` —— 闭环（优，设计密度最高的一层）

逐条核对 AGENTS.md 的七条不变量与 L2 五条不变量，**代码与文档全部一致**，无一处空转：

1. **评分门在可写范围外** ✓ `gate()` 是纯函数吃两份报告；提案补丁只能改 body（`AssetPatch` 类型上就没有 frontmatter 字段）。
2. **归因不用 LLM** ✓ `attribute.ts` 是规则式聚类 + 归一化签名，`classify` 可单测；`isNormalStop` 特意调 agentia 的 `isSuccessStopReason` 而不是自己维护一份表（「单源」意识延伸到上游）。
3. **验证零副作用** ✓ `verifyProposal` → `applyPatch` 在内存副本上换 body 重算指纹；`renderFile` 对原排版逐字透明（头注记录了「自己渲染的差异被误判成手改」的那次事故与修法）。
4. **一轮最多采纳一个** ✓ `runCycle` 里 winner 一旦选定，后续提案记「单变量原则」拒绝，且拒绝原因落盘。
5. **采纳三次校验** ✓ `writePatch`：patch.before 对内存 body → `renderFile(before)` 对磁盘逐字 → `atomicWrite`。
6. **回滚先验指纹** ✓ `revertLast` 先比 `current.fingerprint !== last.assetsAfter` 再动文件；`revertLastCode` 逐文件验 after 指纹 → `git apply -R` → 逐文件验 before 指纹，顺序正确。
7. **journal 后写** ✓ `acceptProposal` 先写文件再 `appendJournal`，头注把方向选错的后果讲清楚了。

超出不变量的亮点：

- **`isWorthAccepting` 是唯一的采纳判据**（`verify.ts`），自动 RSI 与手写提案共用；`gate.ok` 只保证「没退步」而采纳还要求「有用例真的变好」——把「no-op 污染 git 历史」挡在门外。
- **留出集纪律是结构性的**：只跑一次、不参与排序、用默认门（`HOLDOUT_GATE_OPTIONS`）、且 `acceptProposal` 里还有第二道闸（配了 holdout 却没有 holdout 验证结果 ⇒ 拒绝落盘），库调用绕不过。
- **账本（ledger）把「被拒的提案」也当知识**，`lessonsOf` 只取 `not_realized` / `reverted` 两类回灌提案器；`historyConsulted` 三态落盘（缺席/0/N）让「提案器到底有没有看到历史」可审计。`revertNote` 那段「回滚条目的 gate 结论是当初通过时写的，不能当失败证据」的处理，是只有真的踩过才会写的代码。
- **回归监测（regress）拒绝在基础设施故障上判回归**（全部用例 stopReason=error 时抛 `rsi.no_baseline`）——防的是「端点挂了 → `--revert` 误回滚一条正常采纳」，这套系统里最不该发生的误伤。
- **L2（code/）的边界检查在 `parsePatch`**（绝对路径、`..`、二进制、无 hunk、删文件、`---/+++` 不成对），理由一句话：「`git apply` 会老老实实按 diff 里的路径写文件」。沙箱放仓库内（worktree 沿目录上溯找 `node_modules`，搬 /tmp 会假阴性）——这个决定反直觉但论证完整。`applyCodePatch` 在**库层**重判 verify.ok 与 approved（「调用方可以绕过 CLI」），这是纵深防御的正确位置。
- **预算闸**：`maxCostUsd` 是整次运行口径（`priorSpentUsd` 跨轮累加）、提案器自己的花费计入（`proposer.costUsd`）、`costKnown=false` 时闸如实失效而不是拿偏低的数字假装闸住。

### 3.6 `cli/` 与 `server/` —— 宿主入口（良）

- CLI：退出码即接口（0/1/2 的语义区分「结果不达标」与「用法错误」）；flag 白名单按命令给；`needsModel` 保证「看历史记录」这类不调模型的命令不被凭据检查误拦；`--json` 输出与 HELP 文案同步。
- server：自觉保持最小（两个端点），头注直接写明「真要会话/审批/SSE 用 agentia 的 transport，别在这里长第二套」——这是对「别做重复工作」最干脆的一次践行。串行链、请求体上限、超时 race、优雅关闭四条硬规矩都有。

### 3.7 `util/` —— 横切层（良）

`frontmatter.ts` 的「刻意做小的 YAML 子集」决定正确（资产是人和 RSI 都要写的东西，语法面越小补丁越不容易死在解析层）；行尾注释的处理（`#` 前须空白）与「不认识就抛」的立场一致。`abort.ts` 的 `combineAbort` 见 §5 F5（与上游部分重叠）。

---

## 四、高内聚 / 低耦合专项分析

### 4.1 单源点清单（本仓「别做重复工作」的实际执行情况）

| 口径 | 唯一实现 | 消费方 |
|---|---|---|
| 成本读数（含 usage.missing 折回） | `run/cost.ts` | runner、提案器、报告、门 |
| 工具事件扫描 | `evals/tool-events.ts` | 序列/次数/参数三种断言 + harvest |
| trace 文件解析 | `run/trace-read.ts` | CLI、harvest、evidence |
| 多轮 trace 合并 | `run/trace-merge.ts` | runTurns、runOne 的 partial 合并 |
| 评测调优旋钮形状 | `evals/run.ts` 的 `SuiteTuning` | runSuite、verifyProposal、validateHoldout |
| 原子写 | `rsi/journal.ts` 的 `atomicWrite` | 资产落盘、cycle JSON、提案 JSON、锁文件 |
| RSI 落盘路径 | `rsi/paths.ts` | loop ↔ ledger（断环件） |
| 采纳判据 | `rsi/verify.ts` 的 `isWorthAccepting` | runCycle、rsi accept --from |
| 资产渲染（排版透明） | `rsi/verify.ts` 的 `renderFile` | verify、accept、revert |

观察：多处单源是**后验修复**出来的（注释里保留了「曾经有两份」的事故记录），说明这套纪律是被真实故障教育出来的，不是纸上设计。`evals/run.ts` 与 `rsi/loop.ts` 里保留的 re-export（`toolSequence`、`cyclesDir`）证明单源化时照顾了既有调用方，没有为了整洁制造 breaking change。

### 4.2 成环的断法

- `loop ↔ ledger`（值级环风险）→ 抽 `paths.ts`；
- `types ↔ manifest`（类型级环）→ `ChangeManifest` 定义下沉 types.ts，manifest.ts re-export。
两处都是最小动作断环，且注释写明「为什么是这个文件当底座」。架构测试防的是层间环；层内环靠作者自觉，目前处理得当。

### 4.3 耦合面

harness 对 agentia 的耦合点全部经过 `@migor/agentia` 公共导出面（`AgentApp` / `SystemPrompt` / `runCapabilityLoop` / `subagentToTool` / `scriptedClient` / `InMemorySessionStore` / `isSuccessStopReason` / `jsonlTraceSink` / `loadEnvFile` / `DEFAULT_PRICING` / `resolveDefaultModel`），**没有 reach-in 到上游内部路径**——这是低耦合的正面证据。例外是 §2.2 B2 的 4 个字面量契约，性质是「上游没把已是契约的东西放进承诺面」，责任在上游。

`HarnessConfig` 作为胖上下文对象逐层透传是可接受的取舍（避免了十几个参数的签名），代价是 rsi 层模块对它只有「几个路径」的真实需求被掩盖；现状无伤大雅。

---

## 五、发现与建议（按优先级）

### P1 —— 建议近期处理

**F1. `evals/run.ts` 的 `mapLimit` 与 agentia 公共导出的 `mapWithConcurrency` 是同一实现。**
两处都是有界并发 + 保序 + 取号自增，逐行等价。agentia 的版本在公共面（`index.ts` line 91）且边界处理更细（(0,1) 区间小数压成 ≥1 的防护注释）。建议 harness 删掉本地 `mapLimit` 直接 import，消除一份「改一处漏一处」的隐患。这是全仓唯一一处**无条件该删**的重复。

**F2. 推动 agentia 把 4 个事实契约提升进公共面：`TOOL_INPUT_EVENT`、`USAGE_MISSING_EVENT`、`addUsage`、`withTimeout`/`TIMED_OUT`。**
harness 目前用字面量复制了前两个、用本地实现复刻了后两个的语义（`mergeUsage`、`combineAbort` 的超时臂）。虽有真实 trace 测试兜底，但「上游改名 → 下游静默读到 0 条工具调用」这类失败的特征就是**防线本身也可能同批被改**。这些符号已经在被跨仓消费，进公共面是让承诺追上事实。（若上游坚持不进公共面，次优方案：harness 在 `tests/` 里把兜底断言集中到一处并加注释索引，目前分散在 `evals.test.ts`。）

**F3. `EvalCase` / `EvalReport` 与 agentia 同名不同形。**
两包是依赖关系，下游同时 import 时必须 `as` 别名，且语义相近（都是「评测用例/报告」）更容易误用。建议 harness 侧改名为 `SuiteCase` / `SuiteReport`（或 `HarnessEvalCase`）。改名的 breaking 成本现在最低——包还在 0.2.0。

**F4. 端点接线只在 CLI 入口生效，库用户会踩坑。**
`applyEndpointEnv` + `assertEndpointKey` 只在 `cli.ts` 里调用。库用户直接 `createRunner` / `runCycle` 时，配置里的 `endpoint.baseURL` / `apiKeyEnv` 不会生效——而提案器、技能子循环各自现造 client，症状是「主 agent 走得通、子循环 401」这种分裂故障。建议：在 `createRunner`（或 `buildApp`）里幂等调用一次 `applyEndpointEnv`（它本就不覆盖已有 env，重复调用安全）；`assertEndpointKey` 留在 CLI。否则「配置里写了 endpoint 段」在库用法下是**静默不生效**的——与本仓自己的第一原则冲突。

### P2 —— 值得排期

**F5. `util/abort.ts` 与 agentia 的 `combineSignals` 部分重叠。**
harness 需要 `timedOut()` 与 `expired` promise（上游没有），但信号合并那一臂与 `combineSignals` 重复。若 F2 落地（`withTimeout` 进公共面），`combineAbort` 可以瘦身为「上游原语 + race 兑现」。不紧迫：当前实现 72 行、有测试、语义正确。

**F6. 提案器的 trace 不落盘。**
`LlmProposer.ask` 每次新建 `AgentApp` 且不挂 sink，提案这一步的可观测只剩成本数字。提案是 RSI 里唯一用 LLM 的环节，「模型当时看到了什么提示词、回了什么原文」在事后审计时拿不出来（`stripFence` 之前的原文不可考）。建议挂一个独立的 jsonl sink（如 `.workspace/rsi/proposer-traces.jsonl`）。

**F7. harness 的架构守卫弱于 agentia 的。**
`tests/architecture.test.ts` 只扫 `from '...'` 一种 import 形式（头注自知），agentia 的守卫覆盖 from / 副作用 import / 动态 import 三种且带「解析计数下限」防真空变绿。建议直接移植 agentia 的 import-graph 扫描器——它已被验证过，且两仓同作者，移植成本低于维护差异。

**F8. `.workspace/` 只增不减。**
cycles JSON、evidence 语料、journal、proposals 都没有轮转/清理策略。设计理由成立（证据是历史物），但建议至少给 `harness evidence` / cycles 一个 `--prune <天数>` 或在 README 写明「`.workspace` 可整体删除，代价是丢失审计历史」。

### P3 —— 记录为已知边界（不建议现在动）

**F9. 端点面是 Anthropic 形状的。**
`run/endpoint.ts` 写死 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`；agentia 虽有 `createOpenAIClient`，但注入 client 进不了子循环（上游边界）。当前「Anthropic 兼容端点」（含 DeepSeek 的兼容端点）足够覆盖目标场景，这是合理取舍；建议在 README 的「已知边界」里明示，免得使用者以为 `pricing` 配了 OpenAI 模型就能走 OpenAI 端点。

**F10. `RunOutcome.stopReason` 混入合成值 `'threw'` / `'timeout'`。**
这两个值不在 agentia 的 `AgentStopReason` 词汇表里，与上游值并置在同一字段。有类型层面的混淆风险（消费者若拿它 `isSuccessStopReason` 判定恰好安全，因为两者都非正常收尾，算侥幸正确）。建议给 `RunOutcome` 加注释钉死这个并集，或拆字段。低优先。

**F11. `gate()` 在 `baseline.tokens === 0` 时 `tokenDelta` 退化为 0/1 二值。**
任意性较强（涨 1 token 与涨 10 倍同判为 1）。实践中基线 token=0 只出现在夹具误用（AGENTS.md 已警告夹具别复用 0 token），真实场景碰不到。记录即可。

---

## 六、结论

1. **agentia 配当基座**：分层构造性可执行、trace 一等公民、公共面克制、「旋钮不可漏」的接口哲学——harness 能在其上做到「零自有埋点、零 reach-in」，是对基座最硬的背书。
2. **harness 的三层（assets / run+evals / rsi）职责不重叠、方向不倒置、验证链完整**，AGENTS.md 的 12 条核心不变量（L1 七条 + L2 五条）逐条与代码核对一致。RSI 闭环的「可信」不是宣传语：单变量采纳、乐观锁、留出集一次跑、账本回灌、回归监测的每条纪律都有对应的代码结构与测试。
3. **重复工作量很小且集中在边界上**：1 处可直接删除（F1），4 处是「上游未公开的契约」导致的被迫复制（F2），1 处有意识的重复（`ModelPrice`，分层 purity 的代价，建议补类型级守卫）。
4. **下一步最值钱的两件事**：F2（把跨仓契约变成上游承诺，一劳永逸）与 F4（端点接线对库用户生效）——前者消掉最脆弱的一类耦合，后者补上「配置可能静默不生效」这个与本仓第一原则直接冲突的洞。

---

*附：评审基线 —— harness `npm test`：245 tests / 73 suites 全绿（2026-11-21 实跑）；两仓 AGENTS.md 所述不变量与代码逐条核对。*
