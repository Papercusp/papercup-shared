/**
 * runAgentTurn — the governed, retrying turn wrapper (agent-turn-robustness P-003).
 *
 * The single path every agent turn goes through: acquire a permit from the
 * RateLimitGovernor (which paces us under the provider's limits), run the backend once,
 * and on failure CLASSIFY it (TurnError taxonomy) and apply policy — penalize the
 * governor + wait for the reset on `rate_limited`/`overloaded`, exponential backoff on
 * other transient classes, fail fast on `auth`/`permanent`. Returns a STRUCTURED result
 * and NEVER throws on a handled class, so a turn failure can't crash the parent
 * pipeline/run/loop — the caller decides what to do with a returned `TurnError`
 * (re-queue / pause-the-loop / escalate / degrade).
 *
 * Backend-agnostic: `runOnce` is injected and returns a `TurnOutcome` (ok+value+headers,
 * or a raw failure to classify). A rejected `runOnce` is caught + treated as a transient
 * error, never propagated.
 */
import { classifyTurnError, type TurnBackend, type TurnError } from './turn-error';
import type { RateLimitGovernor, TokenEstimate } from './governor';

/** What one backend invocation returns: success (+headers) or a raw failure to classify. */
export type TurnOutcome<T> =
  | { ok: true; value: T; headers?: Record<string, string | undefined> }
  | { ok: false; raw: Parameters<typeof classifyTurnError>[1] };

export type TurnRunResult<T> = { ok: true; value: T } | { ok: false; error: TurnError };

export interface RunAgentTurnSpec {
  backend: TurnBackend;
  /** Estimated tokens for governor budgeting (in-process callers know these). */
  estTokens?: TokenEstimate;
  /** Max attempts before returning the last error. Default 6. */
  maxAttempts?: number;
  /** Cap on total backoff waited across attempts (ms). Default 10 min. */
  maxWaitMs?: number;
  /** Base for exponential backoff on non-rate transient classes (ms). Default 1000. */
  baseBackoffMs?: number;
  /** Abort the turn (interactive callers) — a pending governor wait bails to a TurnError. */
  signal?: AbortSignal;
}

export interface RunAgentTurnDeps<T> {
  governor: RateLimitGovernor;
  runOnce: () => Promise<TurnOutcome<T>>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function runAgentTurn<T>(spec: RunAgentTurnSpec, deps: RunAgentTurnDeps<T>): Promise<TurnRunResult<T>> {
  const maxAttempts = spec.maxAttempts ?? 6;
  const maxWaitMs = spec.maxWaitMs ?? 600_000;
  const baseBackoffMs = spec.baseBackoffMs ?? 1000;
  const RETRY_CAP_MS = 60_000; // cap a single backoff (matches the legacy meridian loop)
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let lastError: TurnError | undefined;
  let totalWaited = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Abortable, bounded acquire: an interactive caller (signal, or a small maxWaitMs) bails
    // to a structured TurnError instead of inheriting a far-off shared pause (reviewer #3 /
    // D-002). Unattended callers pass a large maxWaitMs and just wait.
    const release = await deps.governor.acquire(spec.estTokens, {
      signal: spec.signal,
      maxWaitMs: maxWaitMs - totalWaited,
    });
    if (!release) {
      const provider = spec.backend === 'codex' ? 'openai' : spec.backend === 'omp' ? 'unknown' : 'anthropic';
      const pausedUntil = deps.governor.state.pausedUntil;
      return {
        ok: false,
        error: {
          class: 'rate_limited',
          message: spec.signal?.aborted ? 'aborted while rate-limited' : 'rate-limit pause exceeds maxWait',
          provider,
          retryable: false,
          ...(pausedUntil > now() ? { resetAt: pausedUntil } : {}),
        },
      };
    }
    let backoffMs = 0;
    let err: TurnError | undefined;
    try {
      let outcome: TurnOutcome<T>;
      try {
        outcome = await deps.runOnce();
      } catch (e) {
        // A thrown/rejected runOnce — classify from the message (network blips, etc.)
        // rather than letting it escape and crash the parent.
        outcome = { ok: false, raw: { message: e instanceof Error ? e.message : String(e) } as never };
      }
      if (outcome.ok) {
        if (outcome.headers) deps.governor.recordResponse(outcome.headers);
        return { ok: true, value: outcome.value };
      }
      err = classifyTurnError(spec.backend, outcome.raw, now());
      lastError = err;
      if (!err.retryable || attempt === maxAttempts) return { ok: false, error: err };

      // Wait policy. rate_limited/overloaded are ACCOUNT-WIDE → pause the SHARED governor
      // (the next acquire across ALL callers waits). Other transient classes are per-call →
      // local backoff. CRITICAL: honor the server's hint when present, but fall back to
      // exponential backoff when there is none — subscription 429s and bare 529s carry NO
      // retry-after, so penalizing with an undefined hint would set pausedUntil=0 and
      // hot-loop through every attempt instantly (a regression vs the old blind-backoff loop).
      const accountWide = err.class === 'rate_limited' || err.class === 'overloaded';
      const hintMs = accountWide
        ? err.retryAfterMs ?? (err.resetAt !== undefined ? Math.max(0, err.resetAt - now()) : undefined)
        : undefined;
      const waitMs = hintMs ?? Math.min(RETRY_CAP_MS, baseBackoffMs * 2 ** (attempt - 1));
      if (totalWaited + waitMs > maxWaitMs) return { ok: false, error: err };
      totalWaited += waitMs;
      if (accountWide) {
        // Pause the shared governor; the wait happens on the next acquire() (no local sleep).
        deps.governor.penalize({ retryAfterMs: waitMs });
      } else {
        backoffMs = waitMs; // per-call → local sleep after releasing the permit
      }
    } finally {
      release();
    }
    if (backoffMs > 0) await sleep(backoffMs);
  }
  return { ok: false, error: lastError ?? fallbackError(spec.backend) };
}

function fallbackError(backend: TurnBackend): TurnError {
  return { class: 'permanent', message: 'exhausted attempts', provider: backend === 'codex' ? 'openai' : 'anthropic', retryable: false };
}
