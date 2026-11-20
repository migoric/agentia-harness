# AGENTS.md — 本仓的架构不变量

给在此仓工作的 agent（以及未来的人）读。这些东西改起来很「顺手」，但每一条的破坏都会
以**静默**的方式让 RSI 变成负资产。

## 一、依赖方向

```
cli / server          ← 宿主入口（不进公共导出面）
     ↓
    rsi               ← 闭环：采集→归因→提案→验证→采纳
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

## 三、资产契约

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

## 四、改动纪律

- 任何改动都要跑 `npm run check`（typecheck + lint + 78 条测试 + build）。新增能力必须
  带来可断言的断言 —— 只测「没抛错」不算测试。
- **超时与重试的语义别随便改**：超时靠 `Promise.race([work, gate.expired])` 由本层兑现，
  不能只把 signal 传下去（下游可能不配合）；重试只认 `stopReason === 'error'`，断言失败
  重试等于用采样次数掩盖问题。
- 断言工具序列（`expect_tools`）依赖 agentia 的 `tool.input` 事件名。该名字是上游的
  core 词汇表，**没有**进公共导出面，本仓用字面量复制了一份。防线是
  `tests/evals.test.ts` 里那条真实 trace 断言：上游改名会立刻红。
- 改 `gate()` 的判定规则时，必须同步 README 里那张表。那张表是使用者对「什么算变好」
  的唯一解释权。

## 五、已知的坑

- **`report()` 级别的测试夹具别复用 token**：`EvalReport.tokens` 是从 `cases` 求和的，
  夹具里给 0 会让 token 回归门静默失效。
- **`runSuite` 不落 trace**。反复跑评测会把 `traces.jsonl` 撑成垃圾场。
- **临时目录不清理**：测试用 `mkdtemp` 建工程，交给系统回收，不做 `rmSync`
  （与被测代码的写盘时序有竞态）。
- **无模型凭据时** `harness run` / `eval` / `rsi` 会失败在第一次模型调用上，
  这不是 bug —— 单测全部用 `scriptedClient`，不需要网络。
- **`scriptedClient` 的游标跟着「成功消费」走**。超时那条用例的后台调用还在飞时，
  下一个用例会拿到同一步 —— 要按请求内容分派（用函数步骤），别用固定顺序的脚本。
- **`agentia` 把模型层错误收成 `stopReason: 'error'` 而不是抛异常**，且 `error.retryable`
  常为 `false`（裸 Error 会被归类为 unknown）。harness 的重试语义**不看**那个字段，
  理由写在 `evals/run.ts` 的注释里。
