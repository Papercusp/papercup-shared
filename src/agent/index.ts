/**
 * Server-only entry point. Pull this from API routes / server modules
 * via `@papercusp/papercup-shared/agent`. Don't import from a client
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
  AGENT_BACKENDS,
  SUBPROCESS_AGENT_BACKENDS,
  type AgentBackend,
  type ChatEvent,
  type RunAgentChatOptions,
} from './chat-stream';

// Agent-turn robustness (RB-*): the turn-error taxonomy + classifier, the backend governor
// registry, and the agent runAgentTurn wrapper — so server modules (e.g. the DBOS
// orchestrator) can pace/classify agent spawns through the shared governor.
export {
  classifyTurnError,
  classifySubprocessResult,
  classifyHttpError,
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
  resetGovernorRegistry,
  setGovernorStore,
  type BackendProfile,
  type LimitModel,
  type GovernorSnapshot,
  type GovernorPauseListener,
} from './governor-registry';
export type { GovernorPauseEvent, GovernorState, GovernorStore, GovernorLimits } from '../resilience/governor';
export {
  runAgentTurn,
  type TurnOutcome,
  type TurnRunResult,
  type RunAgentTurnSpec,
  type RunAgentTurnDeps,
} from './turn-runner';
// Generic resilience primitives (domain-independent) — re-exported for convenience.
export { RateLimitGovernor, runWithRetry } from '../resilience';
