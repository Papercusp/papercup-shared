/**
 * @papercusp resilience primitives (generic, domain-independent).
 *
 * Rate-limit pacing + (soon) a retry-with-classification policy loop, reusable by ANY
 * rate-limited / flaky I/O — not just agents. The agent layer (`../agent/*`) layers its
 * backend-specific TurnError taxonomy + classifier on top of these. Promotable to a
 * standalone `libs/generic/@papercusp/resilience` later (BORROWABLE.md).
 */
export {
  RateLimitGovernor,
  initGovernorState,
  decideAcquire,
  recordAcquire,
  recordRelease,
  recordPenalty,
  recordHeaders,
  type GovernorLimits,
  type GovernorState,
  type GovernorDeps,
  type AcquireOpts,
  type AcquireDecision,
  type TokenEstimate,
} from './governor';
