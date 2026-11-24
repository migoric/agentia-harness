/**
 * `@migor/agentia-harness` —— 基于 `@migor/agentia` 的 Agent harness 工程基座。
 *
 * 三层职责，刻意不重叠：
 *
 * | 层 | 做什么 | 依赖 |
 * |---|---|---|
 * | `assets/` | 把 Markdown 变成可装配、可锁版本的能力 | 无（纯文件） |
 * | `run/` + `evals/` | 装配、执行、断言、回归门 | agentia |
 * | `rsi/` | 采集→归因→提案→验证→采纳（`code/` 是 L2：补丁验证与回滚） | 上面两层 |
 *
 * `rsi/` 不直接调用模型做「归因」，只在「提案」一步用模型 —— 归因必须确定，
 * 否则闭环的每一步都在猜。L2（`rsi/code/`）连提案都不用模型：它只负责把外部给的
 * diff 验证、留痕、落盘、回滚。
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
export { CONFIG_FILENAME, type HarnessConfig, loadConfig, type ModelPrice } from './config.js';
export { describeError, HarnessError, type HarnessErrorCode, isHarnessError } from './errors.js';
export { type GateOptions, type GateResult, gate } from './evals/gate.js';
export { type HarvestedCase, harvestCase } from './evals/harvest.js';
export { loadEvalCases, TURN_SEPARATOR } from './evals/load.js';
export {
  check,
  type RunSuiteOptions,
  runSuite,
  type SuiteTuning,
  toolInvocations,
  toolSequence,
} from './evals/run.js';
export { HOLDOUT_GATE_OPTIONS, type SplitViews, splitReport } from './evals/split.js';
export {
  type AssetHit,
  type CaseResult,
  caseSetFingerprint,
  type EvalCase,
  type EvalExpect,
  type EvalReport,
  type EvalSplit,
  type ReportEnv,
  summarize,
  type ToolArgExpect,
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
export {
  type ApplyOptions,
  applyCodePatch,
  type CodeRevertResult,
  revertLastCode,
} from './rsi/code/apply.js';
export { parsePatch } from './rsi/code/diff.js';
export {
  type SandboxOptions,
  type SandboxResult,
  verifyInSandbox,
} from './rsi/code/sandbox.js';
export type { CodeFileState, CodeJournal, CodePatch, CodeVerify } from './rsi/code/types.js';
export {
  buildEvidenceCorpus,
  type EvidenceCorpus,
  type EvidenceItem,
  type EvidenceOptions,
} from './rsi/evidence.js';
export { type HoldoutOptions, validateHoldout } from './rsi/holdout.js';
export { appendJournal, atomicWrite, liveAccepted } from './rsi/journal.js';
export { type LedgerEntry, lessonsOf, readLedger } from './rsi/ledger.js';
export { type CycleOptions, cyclesDir, runCycle, writeCycle } from './rsi/loop.js';
export { type ChangeManifest, manifestFor, validateManifest } from './rsi/manifest.js';
export { readProposal, writeProposal } from './rsi/manual.js';
export { LlmProposer, type ProposeContext, type Proposer } from './rsi/propose.js';
export {
  checkRegression,
  lastAccepted,
  type Regression,
  type RegressOptions,
  type RegressReport,
} from './rsi/regress.js';
export {
  type RoundStopReason,
  type RoundsReport,
  type RunRoundsOptions,
  runRounds,
} from './rsi/rounds.js';
export type {
  AssetPatch,
  CycleReport,
  FailureKind,
  FailureMode,
  FailureSample,
  HoldoutResult,
  JournalEntry,
  Proposal,
  ProposalStatus,
  TargetHint,
  VerifyOutcome,
} from './rsi/types.js';
// 运行时常量（外部提案校验要用），不能放进下面的 export type —— 那会被 TS 整段擦掉
export { FAILURE_KINDS } from './rsi/types.js';
export {
  applyPatch,
  isWorthAccepting,
  renderFile,
  type VerifyOptions,
  verifyProposal,
} from './rsi/verify.js';
export { type BuildAppOptions, type BuiltApp, buildApp, effectiveModel } from './run/app.js';
export {
  applyEndpointEnv,
  assertEndpointKey,
  type EndpointSummary,
  endpointSummary,
  unpricedHint,
} from './run/endpoint.js';
export {
  type CostNote,
  createRunner,
  Runner,
  type RunOptions,
  type RunOutcome,
} from './run/runner.js';
export { assertNoCycles, buildSkillTools, buildTools } from './run/tools.js';
export { mergeTraces, mergeUsage } from './run/trace-merge.js';
export { type CapabilityHits, capabilityHits } from './run/trace-read.js';
