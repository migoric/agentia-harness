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
- 改 `gate()` 的判定规则时，必须同步 README 里那张表。那张表是使用者对「什么算变好」
  的唯一解释权。

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
  「主 agent 走 DeepSeek、技能偷偷走官方端点」静默发生。所以 `endpoint` 段在 CLI 入口
  一次性落到 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`（`run/endpoint.ts`），
  **不覆盖**已存在的真实环境变量（与 `loadEnvFile` 同款语义）。
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
