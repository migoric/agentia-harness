# 运维面：端点、HTTP 服务、代码补丁、边界

## 模型与端点

`harness.config.json` 写三段就够，完整可跑的工程见 [`../examples/starter/`](../examples/starter/)：

```json
{
  "model": "deepseek-flash",
  "endpoint": {
    "baseURL": "https://api.deepseek.com/anthropic",
    "apiKeyEnv": "DEEPSEEK_API_KEY"
  },
  "pricing": { "deepseek-flash": { "in": 0.3, "out": 1.2, "cacheRead": 0.147 } },
  "balance": { "warnBelowUsd": 0.5 }
}
```

- `endpoint.baseURL` 是 `ANTHROPIC_BASE_URL` 的配置化写法；`apiKeyEnv` 只写**变量名**，key 放 `.env`（真实环境变量优先于文件）。密钥永远不进配置文件 —— 那个会被提交。
- 声明了 `apiKeyEnv` 却没有 key ⇒ **开跑前**就报错（退出码 2），不花一轮 token 换一个 401。只拦真会调模型的命令（`run` / `eval` / `rsi` / `serve`），`lock` / `trace` / `report` 不受影响。
- 不给非 Anthropic 模型定价，成本读数是「未知」而**不是 0**：报告里不出现 `$`、回归门的成本判据退回 token、`rsi --max-cost` 不生效。`run` 会在结尾说清病因是「没定价」（配置能修）还是「端点没报计量」（换端点才能修）。
- `cacheRead` / `cacheWrite` 是相对 `in` 的**乘数**，不是绝对价：DeepSeek 缓存命中 $0.044 / 未命中输入 $0.30 ⇒ 写 `0.147`。
- **单价填 `peak` 价**。DeepSeek 分时计价（UTC 01:00–04:00、06:00–10:00 按 2 倍）。价格表的作用是给预算闸一个**上界**：填 off-peak 价会让高峰期估算偏低一半，闸静默超支；填 peak 价只会让闸提前一点点停。便宜时多估一笔，是这里最划算的误差。
- `balance` 让「真实扣了多少钱」有一个与单价无关的读数（`GET /user/balance`，端点是 DeepSeek 时自动识别）。它是**下界**——余额只有两位小数，小额花费读出来是 0 —— 所以它只上推 `costUsd`、不把 `costKnown` 改成 true。见 [`rsi.md`](./rsi.md) 的「未定价模型」一节。

## HTTP 面

`harness serve` 起两样东西：**执行入口**（给别的进程调这个 agent）和**只读看板**
（给人看报告、轮次、账本、谁在跑）。会话、审批、SSE 那一套仍用 agentia 的
`transport/` —— 这里不长第二套。

```bash
curl -s localhost:8787/v1/run -H 'content-type: application/json' \
  -d '{"task":"看下这个 issue 该给谁"}' | jq .text
open http://127.0.0.1:8787/    # 只读看板
```

三道闸，缺省都是安全的那一侧：

| 配置               | 缺省    | 行为                                                                                        |
| ------------------ | ------- | ------------------------------------------------------------------------------------------- |
| `server.apiKeyEnv` | 不设    | 只接受**回环地址**。设了就必须带 `authorization: Bearer <该环境变量的值>`；变量为空拒绝启动 |
| `server.maxQueue`  | `8`     | 排队数（含在跑的那个）到上限返回 `429` + `retry-after: 1`                                   |
| `--timeout <ms>`   | 10 分钟 | 超时返回 `504`，但 trace 仍完整落盘                                                         |

```json
{ "server": { "apiKeyEnv": "HARNESS_API_KEY", "maxQueue": 8 } }
```

路径带 `/v1` 前缀；`/run` 是历史别名，行为完全一样。`GET /health` 不需要 key（探针要能打），返回 `{ ok, agent, assets, assetsOnDisk, assetDrift, uptimeMs, queued, maxQueue, auth }`。

`auth` 告诉你这台机器当前是 `key` 还是 `loopback`；`assetDrift` 告诉你**磁盘上的资产是否已经和进程里那份快照不一样了** —— RSI 采纳之后就是这种情况，此时进程跑的仍是旧资产，该重启。`assetDrift: null` 表示磁盘读不动（文件坏了/被删），这也得能看见：进程还活着，只是它手里的资产来源没了。

`/v1/run` 的超时**从真正开始执行算起**，不含排队时间。否则队列里有 8 个请求时，排在最后那个可能「还没跑就超时」，而它拿到的 504 会被读成「模型太慢」。

### 只读看板与只读 API

路由表的**单一来源**是 `src/server/routes.ts`，`GET /openapi.json` 由它生成 ——
文档与实现不会各说各话（判据 20 用「双向枚举 + 每条路由真的应答」验这件事）。

| 路径 | 内容 |
| --- | --- |
| `GET /` | 看板（静态壳：概览 / 报告 / 轮次 / 账本；零外链，断网可用） |
| `GET /openapi.json` | 路由表自描述 |
| `GET /api/workspace` | 资产指纹与漂移、各目录条目数、worker 状态 |
| `GET /api/reports` | `.workspace/reports/*.json` 的摘要列表 + 读不动的文件与原因 |
| `GET /api/reports/:name` | 单份报告**原样**返回（报告是证据，不替它补字段） |
| `GET /api/rsi/cycles`、`/api/rsi/cycles/:id` | 轮次列表与单轮明细（明细不含宿主绝对路径） |
| `GET /api/rsi/journal?limit=50` | 账本尾部 |
| `GET /api/rsi/worker` | worker 的锁与心跳（谁在跑、还活着吗） |
| `GET /api/progress` | 在飞 / 排队 / 最近一次 run 的结果 |

**web 不持有写权限**（D9）。写工作区（`evals/`、assets、journal）只在 CLI 与
`rsi --watch` 里：`POST /eval`、`PUT /assets` 这类请求一律 `405` + `allow: GET`，
不存在「只是还没做」的写口。理由不是洁癖 —— RSI 的正确性建立在「同时只有一轮在推进、
提案与采纳在同一进程、每一步都可回滚」三个前提上，网络触发会把它们同时打掉，而且
失败是静默的（文件改了、历史没写）。

鉴权口径与 `/v1/run` 一致：配了 `server.apiKeyEnv` 就必须带 Bearer。**例外是 `/` 与
`/openapi.json`** —— 它们是纯静态壳（不含任何工作区数据），浏览器没有方便的带 header
方式，让它们免费换来的是「打开页面就知道该敲哪条命令」；数据仍然要凭据。

生成报告给看板读：

```bash
harness eval --save          # 不给路径 ⇒ 写 .workspace/reports/<UTC 时间戳>.json
harness serve --port 8787
```

`--save` 带路径时仍按给的路径写，但**看板只读 `.workspace/reports/`** —— 想要「跑完就能在
页面里点开」，就别给路径。

## 代码补丁（L2）

L1 改的是提示词，能修的是「模型理解错了」。有些失败改提示词修不了 —— 缺一个工具、参数校验太松、循环里少判一个边界。这类改动落在 TS 里，所以有第二条通道：

```
补丁进来 → git worktree 沙箱里应用 + 跑验证命令 → 人看结果 → --yes 落盘 → git apply -R 回滚
```

四道门都是刚性的：

| 门                 | 为什么                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------ |
| 沙箱验证必须通过   | 主树里试错会把「验证失败」变成有代价的动作，而 RSI 的全部意义建立在试错零成本上            |
| 目标文件必须干净   | 工作区里有未提交改动时落盘，报错会说是「patch does not apply」，真正原因是「你有本地改动」 |
| 必须人工 `--yes`   | 改提示词坏了大不了回滚；改代码能弄坏构建本身。RSI 不该有这个权力                           |
| 回滚先验逐文件指纹 | 落盘后有人动过就拒绝自动回退 —— 反向应用跑一半是最坏的结果                                 |

**提案环节刻意不用 LLM**：本层只接受外部给的 diff（人或别的 agent 写的），负责验证、审批、留痕、回滚这四件真正需要机器纪律的事。让模型直接写 TS 的失败率远高于它写提示词，而一次坏补丁的代价大得多 —— 这个不对称决定了分工。

沙箱是 `git worktree`（缺省在 `.workspace/sandbox/`，用完即删）。放在**仓库里面**是有意的：worktree 里没有 `node_modules`，而 Node/npm 解析依赖会沿目录上溯，放在仓库里才能找到主仓的依赖；搬到 `/tmp` 会让 `npm test` 以「模块找不到」失败，那是与补丁无关的假阴性。

配置（`harness.config.json`，都可省）：

```json
{ "code": { "verify": ["npm", "test"], "timeoutMs": 600000 } }
```

## 已知边界

- **L2 只做增量改**：不支持删除文件、重命名、二进制补丁；一个补丁只跑**一条**验证命令（多条请自己串成 `npm run verify`）。
- **L2 的提案不由 LLM 生成**：见上一节的理由。想接模型，把生成的 diff 喂给 `harness patch` —— 验证与回滚是现成的。
- **只支持 Anthropic 兼容端点**：`endpoint` 底下的实现仍是 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` 这条链路（agentia 的 `createOpenAIClient` 注入不进子循环，属上游边界）。`pricing` 里配一个 OpenAI 模型不会让它走 OpenAI 端点 —— 那只是价格表。
- **不做并行分支编排**：并行留给工具层（`maxToolConcurrency`）。两套并行的闸比没有闸更危险。
- **`suspended` 不在本层**：等审批 / 等时刻交给外层 run 的 `approvals`。图的检查点与 HITL 挂起是两种中断，混在一起会让「续跑」有两个互相不知道的状态源。
- **没有自己的预算账本**：累计成本靠外层 run 或宿主推进。
- **web 只读，写权限只在进程里**：只读看板与 `/api/*` 全是 GET；写 `evals/`、assets、journal 只能通过 CLI 或 `rsi --watch`。要会话、审批、SSE，用 agentia 的 `transport/`。
- **超时与配额只管单进程**：请求串行、队列有上限、单请求有超时；没有跨进程调度与分布式限流。多副本请在前面加一层网关，或按副本数自行分摊。
- **评测默认不落 trace**：`harness eval --keep-traces` 才落盘，同时把 `traceId` 写进报告（失败用例会打印出来）。缺省不落是纪律 —— 评测反复跑会把 `traces.jsonl` 撑成垃圾场。
- **`.workspace/` 可整体删除**：`traces.jsonl`、`rsi/`（journal、cycles、proposals）、`evidence/`、`sandbox/` 全是运行时产物，删掉不影响下次运行。代价是丢掉审计历史 —— 预测对账、采纳记录、回归基准都从这里读，删了就只能从 git 里看资产改了什么。目前没有轮转策略，长期跑要自己看着点。
- **真模型验证只跑了 `run` / `eval`，没跑完整 `rsi` 采纳**：DeepSeek 官方端点上的实测数字见 [`../examples/starter/README.md`](../examples/starter/README.md)。提示词质量、工具选择这类问题只有真模型答得了，本仓的脚本测试答不了；离线 e2e 覆盖的是 fetch / SSE / 重试 / 成本换算那一层。

## 开发与测试

```bash
npm run check        # typecheck + lint + test + build（CI 跑的就是这个）
npm test             # 单跑测试
npm run e2e:offline  # 真实 HTTP 客户端 + 本地假端点，含故障注入（需先 build）
```

流程约定见 [`../CONTRIBUTING.md`](../CONTRIBUTING.md)，编码约定见 [`../AGENTS.md`](../AGENTS.md)。

### 离线 e2e：为什么有一条假端点

单元测试里的模型客户端全是注入的 `scriptedClient`，而线上走 `createAnthropicClient()` —— 两者之间隔着 fetch、SSE 拼装、重试退避、usage→成本换算。那层代码此前只能靠读代码相信。

`scripts/fake-anthropic.mjs` 说 Anthropic Messages 协议（含 SSE 与 `tool_use` 往返），`scripts/offline-e2e.mjs` 用它把这条路径放到真 HTTP 上跑，并顺手点掉几条只在异常分支上才走的路：`500` 退避重试、`429 + retry-after`、流被截断、用例超时、端点不报 usage。CI 里有这一步。

它跑出过一个真 bug：**端点不报 usage 时上游算出的 `costEstimate` 是 `0` 而不是 `undefined`** —— 模型在价格表里，于是「不知道花了多少」与「一分没花」是同一个数，预算闸与成本门一起静默失效。现在按 trace 里的 `usage.missing` 事件判定（词汇从 `@migor/agentia` import，有架构守卫拦字面量副本）。

### 工具链

Node ≥ 20、TypeScript 7（原生 `tsc`，与 `@migor/agentia` 同版本）、tsx 跑测试、biome 管 lint 与格式。类型检查是硬门，`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` 全开。

测试分八组：资产层、评测台与回归门、RSI 闭环（含真实 trace 归因）、多 agent 委派、CLI 与渲染端到端、配置与端点桥接（含价格表口径）、L2 代码补丁（沙箱 / 审批 / 回滚）、HTTP 面（含并发峰值必须为 1）。另有 `tests/architecture.test.ts` 守分层与文件体量 —— 分层写在文档里等于没有，能执行才算。`npm run e2e:offline` 是第九组：它不在 `npm test` 里，因为它要 `dist/` 且起子进程。
