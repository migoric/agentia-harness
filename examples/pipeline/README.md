# examples/pipeline —— 两个技能 + 多轮 + 留出集

`starter` 证明「最小工程能跑通」。这个目录证明**另一种工程形态也能跑通**：分诊与回复
是两个技能，由同一个 agent 按任务挑；有一条多轮追问的用例，还有一个只在最后才用的
留出集（`split: holdout` + `phase: 1`）。

它存在的理由：只留一个单技能单轮的例子，等于只验证了「一个提示词能不能被调用」。
工程一旦长到「按任务挑技能」「多轮追问」「留出集分期」，`expect_skills`、多轮的断言口径、
留出集批次号这些机制才真正被走到 —— 而它们恰好是最容易在升级时悄悄坏掉的部分。

## 形状

| 资产 | 作用 | 为什么这么切 |
| --- | --- | --- |
| `agents/triage.md` | 判类别与优先级；要回复时转 `draft-reply` | 分诊要短、回复要软，两个技能的提示词混在一起会互相稀释 |
| `skills/queue-policy/SKILL.md` | 分诊口径表 | 口径会变；抽成资产后改口径不必碰主提示词 |
| `skills/draft-reply/SKILL.md` | 三句以内的客户回复 | 同上；也用它演示「主 agent 按任务选技能」 |
| `evals/*` | 4 条 train + 1 条 holdout（`phase: 1`） | 留出集用来验「没被优化的那部分有没有变差」 |

**为什么不是一个 agent 一个工程**：`eval` 一次只用一个 agent（`--agent`），用例不与
agent 绑定。两个 agent 的工程要跑两遍并各自 `--only` 挑用例，否则会拿 A 的提示词去跑
B 的用例，出来一堆假失败。这个边界写在 `README.md` 的「怎么跑」一节里。

## 怎么跑

```bash
cd examples/pipeline
cp .env.example .env      # 填 DEEPSEEK_API_KEY=sk-...

harness eval              # 5 条用例（含 1 条多轮、1 条留出集）
harness history           # 每条用例的走向（跑两次之后才有意义）
harness eval --repeat 3   # 同一份资产重复采样：把噪声和真实变化分开
```

用源码跑（本仓开发时）：

```bash
npm run harness -- eval --root examples/pipeline
```
