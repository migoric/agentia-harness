/**
 * `@migor/agentia-harness` —— 基于 `@migor/agentia` 的 Agent harness 工程基座。
 *
 * 三层职责，刻意不重叠：
 *
 * | 层 | 做什么 | 依赖 |
 * |---|---|---|
 * | `assets/` | 把 Markdown 变成可装配、可锁版本的能力 | 无（纯文件） |
 * | `run/` + `evals/` | 装配、执行、断言、回归门 | agentia |
 * | `rsi/` | 采集→归因→提案→验证→采纳 | 上面两层 |
 *
 * `rsi/` 不直接调用模型做「归因」，只在「提案」一步用模型 —— 归因必须确定，
 * 否则闭环的每一步都在猜。
 */

export { discoverAssets } from './assets/discover.js';
export {
  type AssetDrift,
  type AssetLock,
  buildLock,
  describeDrift,
  diffLock,
  driftIsEmpty,
  type LockEntry,
  readLock,
  writeLock,
} from './assets/lockfile.js';

export {
  type AgentAsset,
  type Asset,
  type AssetBase,
  type AssetKind,
  type AssetSet,
  assetKey,
  findAsset,
  type SkillAsset,
} from './assets/types.js';
export { CONFIG_FILENAME, type HarnessConfig, loadConfig } from './config.js';
export { describeError, HarnessError, type HarnessErrorCode, isHarnessError } from './errors.js';
export { type GateOptions, type GateResult, gate } from './evals/gate.js';
export { loadEvalCases } from './evals/load.js';
export { check, type RunSuiteOptions, runSuite, toolSequence } from './evals/run.js';
export {
  type CaseResult,
  type EvalCase,
  type EvalExpect,
  type EvalReport,
  summarize,
} from './evals/types.js';
export {
  acceptManually,
  acceptProposal,
  journalPath,
  type RevertResult,
  readJournal,
  revertLast,
} from './rsi/accept.js';
export { attribute, classify, collectFailures } from './rsi/attribute.js';
export { type CycleOptions, runCycle } from './rsi/loop.js';
export { LlmProposer, type ProposeContext, type Proposer } from './rsi/propose.js';
export type {
  AssetPatch,
  CycleReport,
  FailureKind,
  FailureMode,
  FailureSample,
  JournalEntry,
  Proposal,
  ProposalStatus,
  VerifyOutcome,
} from './rsi/types.js';
export { applyPatch, renderFile, type VerifyOptions, verifyProposal } from './rsi/verify.js';
export { type BuildAppOptions, type BuiltApp, buildApp } from './run/app.js';
export { createRunner, Runner, type RunOptions, type RunOutcome } from './run/runner.js';
export { assertNoCycles, buildSkillTools } from './run/tools.js';
