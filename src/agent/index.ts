/**
 * Server-only entry point. Pull this from API routes / server modules
 * via `@papercusp/papercusp-shared/agent`. Don't import from a client
 * component — this module reaches `node:child_process` and Turbopack
 * will refuse to bundle it for the client. (We don't pull in the
 * `server-only` marker package since it isn't a workspace dep; the
 * sub-export boundary alone keeps it out of the client graph.)
 */
export {
  runAgentChat,
  setAgentConfigBootstrap,
  resolveBackend,
  resolveAgentBin,
  setStatelessUsageSink,
  readClaudeOauthToken,
  invalidateClaudeTokenCache,
  resolveAnthropicBaseUrl,
  probeStatelessTransport,
  type StatelessTransportProbe,
  // EI-18685386548651513 / WI-5391 — the delegated-gateway transport choice (EI-12940): a
  // caller with no local Claude OAuth session (every in-process bg-host/Scout ideator call —
  // register-scout-action.ts's FB-16 wiring) egresses via the LOCAL inference gateway's account
  // pool instead of failing. Exported so a cross-package test (operator-core's real
  // createInferenceGateway) can exercise this exact path end-to-end without duplicating its
  // header/token/URL construction — see gateway-scout-delegated-failover.test.ts.
  chooseStatelessTransport,
  resolveDelegatedGatewayUrl,
  GATEWAY_DELEGATED_AUTH_TOKEN,
  // default-deploy-account-2026-08-08 P-008: the marker operator-core publishes so the
  // in-process stateless family routes via the gateway (which starts on the owner's default
  // account) rather than this box's ~/.claude login.
  DEFAULT_ACCOUNT_ACTIVE_ENV,
  defaultAccountActive,
  AGENT_BACKENDS,
  SUBPROCESS_AGENT_BACKENDS,
  CLAUDE_BUILTIN_TOOLS,
  type AgentBackend,
  type ChatEvent,
  type RunAgentChatOptions,
  type StatelessUsageEvent,
  type StatelessUsageAttribution,
} from './chat-stream';

// Agent-turn robustness (RB-*): the turn-error taxonomy + classifier, the backend governor
// registry, and the agent runAgentTurn wrapper — so server modules (e.g. the DBOS
// orchestrator) can pace/classify agent spawns through the shared governor.
export {
  classifyTurnError,
  classifySubprocessResult,
  classifyHttpError,
  isAccountWide,
  parseUsageResetMs,
  type TurnError,
  type TurnBackend,
  type TurnProvider,
  type TurnErrorClass,
} from './turn-error';
export {
  governorForBackend,
  getGovernor,
  modelClassOf,
  BACKEND_PROFILES,
  resolveLimitModel,
  resolveProviderLimitModel,
  onGovernorPause,
  snapshotGovernors,
  governorKey,
  parseGovernorKey,
  resetGovernorRegistry,
  setGovernorStore,
  setGlobalConcurrencyCap,
  setGlobalConcurrencyFloor,
  setAimdTuning,
  getAimdTuning,
  setProviderFloorOverride,
  getProviderFloorOverrides,
  globalConcurrencySnapshot,
  effectiveConcurrencySnapshot,
  recordGlobalConcurrencyPenalty,
  recordGlobalConcurrencyClean,
  AIMD_CLEAN_TURNS_PER_STEP,
  type BackendProfile,
  type LimitModel,
  type GovernorSnapshot,
  type GovernorPauseListener,
} from './governor-registry';
export type {
  AdmissionDenial,
  AdmissionDenialReason,
  GovernorPauseEvent,
  GovernorState,
  GovernorStore,
  GovernorLimits,
  GlobalConcurrencyGate,
} from '../resilience/governor';
export { LEGACY_RATE_LIMIT_BLOCKED_REASON } from '../resilience/governor';
export {
  runAgentTurn,
  type TurnOutcome,
  type TurnRunResult,
  type RunAgentTurnSpec,
  type RunAgentTurnDeps,
} from './turn-runner';
// Generic resilience primitives (domain-independent) — re-exported for convenience.
export {
  RateLimitGovernor,
  runWithRetry,
  initGovernorState,
  effectiveRpmFactor,
  effectiveRpm,
  effectivePaceMs,
  PriorityAdmissionQueue,
  QueueFullError,
  priorityFromLabel,
  tierOf,
  tiersOfMap,
  defaultTierCaps,
  shedTierCaps,
  parsePriorityTierMap,
  DEFAULT_GATEWAY_PRIORITY_MAP,
  DEFAULT_TIER,
  AimdConcurrencyController,
} from '../resilience';
export type {
  AdmissionSnapshot,
  PriorityAdmissionOptions,
  UnifiedWindowState,
  AimdConcurrencyOptions,
  AimdSnapshot,
  TierAdmissionConfig,
  TierSnapshot,
  PriorityTierMap,
} from '../resilience';
