# examples/starter —— 接一个非 Anthropic 端点的完整例子

这个目录是 `harness init` 的产物，只改了一处：`harness.config.json` 里加上了
`endpoint` 与 `pricing` 两段，指向 **DeepSeek 的 Anthropic 兼容端点**。

它存在的理由：harness 的很多口径（成本读数、回归门的成本判据、RSI 的预算闸）
**只在换了端点之后才暴露问题**。一个能直接跑通的例子比一段文档可信。

## 怎么跑

```bash
cd examples/starter
cp .env.example .env      # 填上 DEEPSEEK_API_KEY=sk-...
harness eval              # 跑评测集（有失败用例则退出码 1）
harness run "把这段话压成三条要点：……"
```

在本仓开发时可以不自带全局安装，用源码跑：

```bash
npm run harness -- eval --root examples/starter
npm run harness -- run "压一下这段文字" --root examples/starter
```

## 这三段配置各自在做什么

| 字段 | 作用 | 少了会怎样 |
| --- | --- | --- |
| `model` | 发给端点的模型名，**所有子循环也用它** | 吃 agentia 缺省（`claude-opus-5`）：真端点未必 404，但会按 Opus 单价记账（实测约 40×） |
| `endpoint.baseURL` | 端点地址（替代 `ANTHROPIC_BASE_URL`） | 直连 `api.anthropic.com`，401 |
| `endpoint.apiKeyEnv` | 「key 在哪个环境变量里」——**只是名字** | 报「缺少模型凭据」，开跑前就停（退出码 2） |
| `pricing` | 价格表，成本读数靠它 | 成本是「未知」：报告里没有 `$`，成本门退回 token，`rsi --max-cost` 不生效 |

密钥永远不进 `harness.config.json`：那个文件会被提交，`.env` 不会（`init` 生成的
`.gitignore` 已经包含它）。真实环境变量优先于 `.env`，所以 CI 里导出
`DEEPSEEK_API_KEY` 即可，不用改文件。

## 价格表的三个坑（都踩过）

**一、`cacheRead` 是乘数不是绝对价。** DeepSeek 缓存命中读 $0.044/1M、未命中输入
$0.30/1M（都是 peak 价）⇒ 写 `0.147`（`0.044 / 0.30`）。写 `0.044` 会让缓存命中部分
便宜 1000 倍，而成本数字看上去「很正常」。

**二、填 `peak` 价，不要填你此刻在付的价。** DeepSeek 在 UTC 01:00–04:00 与
06:00–10:00（周一至周五）按 **2 倍**计费。价格表的用途是**给预算闸一个上界**，不是记账：
- 填 off-peak 价 ⇒ 高峰期估算偏低一半 ⇒ `--max-cost` 在高峰时段静默超支；
- 填 peak 价 ⇒ 估算永远是上界 ⇒ 闸只会提前一点点停（方向安全），真实账单不会超。

「便宜时多估一点」是这套系统里最划算的一笔误差。要精确账单就去查余额
（见下）—— 那是**另一个读数**，不是价格表的替代。

**三、`cacheWrite` 没写** ⇒ 走缺省 `1.25×`。DeepSeek 不单独收缓存写费，缺省值会
让估算**偏高**（成本门提前刹车，方向安全）。如果你的端点确实在 `usage` 里报
`cache_creation_input_tokens`，按实际情况把它改成 `0` 或 `1`。

## 余额对账（`balance`）

`pricing` 回答不了的事 ——「这个月到底扣了多少钱」—— 用余额接口：

```bash
harness balance          # 原币 + 折算美元 + 是否可调用
harness balance --json
```

端点是 `api.deepseek.com` 时自动识别；别的网关写 `"balance": { "url": … }`。
RSI 每跑一轮会在每个阶段结束后读一次余额，把差额记进轮次记录的 `billed` 字段。

**它是一个下界，不是精确值**，两重截断：

| 截断 | 后果 |
| --- | --- |
| 余额只保留**两位小数** | 一轮 7459 token 的花费（约 $0.002）读出来的差值是 **0** |
| 结算可能滞后几秒 | 刚结束的那几笔可能还没入账 |

所以：`billed` 有值**不代表** `costKnown` 变 true，`costUsd` 也只被它**上推**不被下压。
它的用途是「累计下界已超上限 ⇒ 一定超了」（充分条件）与事后对账，不是逐笔发票。


## 真机实测（2026-11-21，DeepSeek 官方端点）

```text
harness run  … → [end_turn] 2394 token $0.00071 · 2 轮 · 7181ms · 技能：example
harness eval … → 1/1 通过 · 6006 token $0.00285 · costKnown: true
```

这两条命令跑出了一个此前离线 e2e 没抓到的 bug：上游 `runCapabilityLoop` 继承
`client` 但**不继承 `model`**，技能子循环拿着 `claude-opus-5` 去打 DeepSeek，
一轮 1158 token 被记成 $0.02375（实际约 $0.0006）。已在装配层把工程生效模型
传给技能与子 agent，并加了单测 + 离线 e2e 双重守门。

## 已知的兼容性观察

- DeepSeek 两个型号默认开 thinking，输出 token 会明显多于非 thinking 模式；
  `expect_max_tokens` 这类断言要留够余量。
- harness 不主动请求 thinking，但会把端点返回的 `thinking` 块**原样带进下一轮**
  （agentia 的 SSE 组装会累积 `signature`）。若端点对「回传的 thinking 块」有额外要求，
  第一个出问题的位置会是 `harness run` 的第一次工具调用。
