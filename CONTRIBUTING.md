# 参与贡献

感谢你愿意贡献。本仓的**详细约定只有一份** —— 见 [`AGENTS.md`](./AGENTS.md)（它同时是 AI 编码助手的
权威入口）。本文只讲**人**的流程，不重复那份约定，避免出现两套说法。

## 准备本地环境

本仓依赖 `@migor/agentia`，声明写的是 `file:../agentia` —— 两个仓必须**并排**放：

```bash
mkdir -p ~/src && cd ~/src
git clone https://github.com/migoric/agentia.git
git clone https://github.com/migoric/agentia-harness.git

cd agentia && npm ci && npm run build   # 上游必须先构建
cd ../agentia-harness && npm install
```

为什么先构建上游：`file:` 依赖指向的是它的 `dist/`（类型声明在那），而 `dist` 不进 git。
为什么不用 registry 上的版本号：本仓还没有发布，且这里要验的恰恰是**未发布的上游**——
把版本号钉死会让「上游改了语义」变成一件安静的事。

Node ≥ 20（`engines` 声明），CI 跑 22（`.nvmrc` 同值）。

## 提交前必须跑

```bash
npm run check         # typecheck + lint + test + build —— CI 跑的就是这一条
npm run e2e:offline   # 需要先 build；真实 HTTP 客户端 + 本地假端点，含故障注入
```

`npm run check` **不含** e2e：它要 `dist/` 且要起子进程。改动碰了 fetch / SSE / 重试 /
`usage`→成本这一段，e2e 必须单独跑 —— 单元测试里的模型客户端全是注入的，那一层
否则只能靠读代码相信。

## 几条硬约定（会红，不是建议）

| 约定                                     | 守在哪                                            |
| ---------------------------------------- | ------------------------------------------------- |
| 依赖方向单向，`src/` 内不许向上层 import | `tests/architecture.test.ts`（见 `AGENTS.md` §1） |
| 单文件 ≤ 400 行（超了说明该拆了）        | 同上                                              |
| `dependencies` 只允许有 `@migor/agentia` | 代码评审 + `AGENTS.md` §1                         |
| RSI 不能改 `evals/`、不能改 `gate()`     | `AGENTS.md` §2（这是产品前提，不是洁癖）          |
| 新行为带测试；**守卫要做反向验证**       | 见下                                              |

反向验证的意思是：把实现改回旧写法 → 确认那条测试真的变红 → 恢复。没做过反向验证的
守卫很可能是永远绿的空断言，本仓有过这种教训。

**行为变化写 `CHANGELOG.md`**，内部重构不写（要细节读 git 历史）。文档与实现不一致按
bug 算，不按「文档待更新」算。

## 提交信息

沿用 Conventional Commits 前缀（`feat:` / `fix:` / `docs:` / `chore:` / `refactor:` /
`test:` / `perf:`），正文用中文讲清**为什么**，而不只是做了什么。语义有变更的用 `!` 标记
并在正文说明影响面。

## 提 PR

- 小改动（文档、单点修复）：直接推 `main`，推之前本地门禁全绿。
- 结构性改动：开分支走 PR（`feat/…` · `fix/…` · `docs/…` · `chore/…`），用 squash 合并。

PR 模板里的自查项请**真的逐条答**：它们是从真实的「静默失效」缺陷反推出来的，不是仪式。

## 报 issue

用 issue 模板（Bug 报告 / 功能建议）。安全漏洞**不要**开公开 issue —— 见 [`SECURITY.md`](./SECURITY.md)。

## 许可

贡献即表示同意以本仓的 [MIT 许可](./LICENSE) 发布你的贡献。
