/**
 * RateLimitGovernor — generic, domain-independent rate-limit pacing (resilience lib).
 *
 * A shared choke point callers pass requests through to PROACTIVELY stay under a provider's
 * limits instead of bursting past them — usable by ANY rate-limited/flaky I/O (LLM calls,
 * external APIs, sync, …), not just agents. Two limit models in one:
 *   - header-driven (provider returns rate-limit headers): RPM + ITPM + OTPM budgets synced
 *     from the response, plus honor retry-after/reset.
 *   - coarse (no per-minute headroom visible, e.g. a subscription): concurrency cap + react
 *     to 429 penalties only.
 * The concurrency cap is also the lever for OPAQUE callers (e.g. subprocesses whose internal
 * calls we can't see) — capping how many run at once is the real burst fix.
 *
 * `recordHeaders` understands the common Anthropic (`anthropic-ratelimit-*`) and OpenAI
 * (`x-ratelimit-*`) header conventions. The decision logic is a PURE core (testable with a
 * fake clock); the async `acquire()` is a thin loop over it using injected `now`/`sleep`.
 *
 * WINDOW SEMANTICS: the RPM/ITPM/OTPM accounting is a TUMBLING 60s window (a window older than
 * 60s reads fresh), not a continuously-replenishing leaky bucket — so it can allow a burst right
 * after a window flips. That coarseness is intentional (cheap, fake-clock-testable); the smoother
 * controls are layered on top: a 429 `penalize()` pauses hard, and `paceDelayMs` (review #7/#8)
 * spreads requests pre-emptively as `*-remaining` drops, so we glide toward a reset rather than
 * slamming into remaining=0 and tripping the limit.
 */

export interface GovernorLimits {
  /** Max concurrent in-flight turns (the burst lever for subprocess agents). */
  maxConcurrent: number;
  /** Requests per minute (provider RPM); undefined = unknown/unlimited. */
  rpm?: number;
  /** Input tokens per minute. */
  itpm?: number;
  /** Output tokens per minute. */
  otpm?: number;
}

export interface GovernorState {
  limits: GovernorLimits;
  inFlight: number;
  windowStart: number; // epoch ms of the current 60s window
  reqInWindow: number;
  inTokInWindow: number;
  outTokInWindow: number;
  pausedUntil: number; // epoch ms; 0 = not paused
  /**
   * Pre-emptive pacing gap (ms) between acquisitions, derived from headers when a dimension's
   * `*-remaining` is running low (review #7/#8: "slow as remaining drops" rather than the
   * all-or-nothing slam into remaining=0). 0 = no soft pacing. Only set in header-driven mode.
   */
  paceDelayMs: number;
  lastAcquireAt: number; // epoch ms of the last granted acquire (anchors the pace gap)
}

export interface TokenEstimate {
  inTok?: number;
  outTok?: number;
}

export interface AcquireDecision {
  allowed: boolean;
  waitMs: number;
  reason?: 'paused' | 'concurrency' | 'rpm' | 'itpm' | 'otpm' | 'pace';
}

const WINDOW_MS = 60_000;
const CONCURRENCY_POLL_MS = 250; // we don't know when a peer releases → short re-poll
// "Slow as remaining drops" knobs (review #7/#8). Below this fraction of a dimension's limit we
// start spreading the remaining budget over the time-to-reset; the per-acquire gap is capped so
// soft pacing never becomes a de-facto long pause (that's what a 429 penalty is for).
const LOW_WATERMARK = 0.2;
const MAX_PACE_DELAY_MS = 5_000;

export function initGovernorState(limits: GovernorLimits): GovernorState {
  return {
    limits: { ...limits },
    inFlight: 0,
    windowStart: 0,
    reqInWindow: 0,
    inTokInWindow: 0,
    outTokInWindow: 0,
    pausedUntil: 0,
    paceDelayMs: 0,
    lastAcquireAt: 0,
  };
}

/** Effective window usage at `now` — a window older than 60s reads as fresh (0). */
function windowUsage(s: GovernorState, now: number): { req: number; inTok: number; outTok: number } {
  if (now - s.windowStart >= WINDOW_MS) return { req: 0, inTok: 0, outTok: 0 };
  return { req: s.reqInWindow, inTok: s.inTokInWindow, outTok: s.outTokInWindow };
}

/** PURE: may this turn proceed at `now`? If not, how long to wait before re-checking. */
export function decideAcquire(s: GovernorState, now: number, est: TokenEstimate = {}): AcquireDecision {
  if (now < s.pausedUntil) return { allowed: false, waitMs: s.pausedUntil - now, reason: 'paused' };
  if (s.inFlight >= s.limits.maxConcurrent) return { allowed: false, waitMs: CONCURRENCY_POLL_MS, reason: 'concurrency' };

  const u = windowUsage(s, now);
  const msToWindowReset = now - s.windowStart >= WINDOW_MS ? 0 : s.windowStart + WINDOW_MS - now;
  const inTok = est.inTok ?? 0;
  const outTok = est.outTok ?? 0;

  if (s.limits.rpm !== undefined && u.req + 1 > s.limits.rpm) {
    return { allowed: false, waitMs: Math.max(1, msToWindowReset), reason: 'rpm' };
  }
  if (s.limits.itpm !== undefined && u.inTok + inTok > s.limits.itpm) {
    return { allowed: false, waitMs: Math.max(1, msToWindowReset), reason: 'itpm' };
  }
  if (s.limits.otpm !== undefined && u.outTok + outTok > s.limits.otpm) {
    return { allowed: false, waitMs: Math.max(1, msToWindowReset), reason: 'otpm' };
  }
  // Pre-emptive pacing: when remaining is low (header-driven mode) we hold a small gap between
  // acquisitions so we glide to the reset instead of slamming into remaining=0 (review #7/#8).
  if (s.paceDelayMs > 0) {
    const nextAllowedAt = s.lastAcquireAt + s.paceDelayMs;
    if (now < nextAllowedAt) return { allowed: false, waitMs: nextAllowedAt - now, reason: 'pace' };
  }
  return { allowed: true, waitMs: 0 };
}

/** Commit an acquisition: roll the window if stale, then charge concurrency + usage. */
export function recordAcquire(s: GovernorState, now: number, est: TokenEstimate = {}): void {
  if (now - s.windowStart >= WINDOW_MS) {
    s.windowStart = now;
    s.reqInWindow = 0;
    s.inTokInWindow = 0;
    s.outTokInWindow = 0;
  }
  s.inFlight += 1;
  s.reqInWindow += 1;
  s.inTokInWindow += est.inTok ?? 0;
  s.outTokInWindow += est.outTok ?? 0;
  s.lastAcquireAt = now;
}

export function recordRelease(s: GovernorState): void {
  s.inFlight = Math.max(0, s.inFlight - 1);
}

/** On a 429: pause the bucket until the server's reset/retry-after. Never SHRINKS an
    existing pause (the most-conservative reset wins). */
export function recordPenalty(s: GovernorState, now: number, opts: { retryAfterMs?: number; resetAt?: number }): void {
  const until = Math.max(opts.resetAt ?? 0, opts.retryAfterMs !== undefined ? now + opts.retryAfterMs : 0);
  if (until > s.pausedUntil) s.pausedUntil = until;
}

const LC = (h: Record<string, string | undefined>): Record<string, string | undefined> => {
  const o: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h)) o[k.toLowerCase()] = v;
  return o;
};

/** Sync limits + pause from response headers (header-driven precise mode). */
export function recordHeaders(s: GovernorState, headers: Record<string, string | undefined>, now: number): void {
  const h = LC(headers);
  const num = (v: string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const rpm = num(h['anthropic-ratelimit-requests-limit'] ?? h['x-ratelimit-limit-requests']);
  if (rpm !== undefined) s.limits.rpm = rpm;
  const itpm = num(h['anthropic-ratelimit-input-tokens-limit']);
  if (itpm !== undefined) s.limits.itpm = itpm;
  const otpm = num(h['anthropic-ratelimit-output-tokens-limit']);
  if (otpm !== undefined) s.limits.otpm = otpm;

  // Per-dimension: remaining=0 → pause to reset; 0<remaining<watermark → pre-emptively pace
  // (spread the remaining budget over the time-to-reset). [remaining, reset, limit].
  const dims: Array<[string, string, number | undefined]> = [
    ['anthropic-ratelimit-requests-remaining', 'anthropic-ratelimit-requests-reset', rpm],
    ['anthropic-ratelimit-input-tokens-remaining', 'anthropic-ratelimit-input-tokens-reset', itpm],
    ['anthropic-ratelimit-output-tokens-remaining', 'anthropic-ratelimit-output-tokens-reset', otpm],
    ['anthropic-ratelimit-tokens-remaining', 'anthropic-ratelimit-tokens-reset', undefined],
  ];
  let pace = 0; // recomputed from THIS response — healthy headroom decays it back to 0
  for (const [remK, resetK, limit] of dims) {
    const rem = num(h[remK]);
    if (rem === undefined || !h[resetK]) continue;
    const t = Date.parse(h[resetK] as string);
    if (Number.isNaN(t)) continue;
    if (rem === 0) {
      if (t > s.pausedUntil) s.pausedUntil = t;
      continue;
    }
    // Soft pacing kicks in only once we know the dimension's ceiling and we're under the
    // low-watermark fraction of it: glide the remaining `rem` requests over `t - now`.
    if (limit !== undefined && limit > 0 && rem < limit * LOW_WATERMARK) {
      const msToReset = Math.max(0, t - now);
      const spread = Math.min(MAX_PACE_DELAY_MS, Math.floor(msToReset / rem));
      if (spread > pace) pace = spread;
    }
  }
  s.paceDelayMs = pace;
}

/** Fired when a pause is newly SET or EXTENDED (the 429/backpressure transition) — the hook a
    host uses to surface "rate-limited — paused until <reset>" to telemetry/UI (RB-009). Stays
    domain-free: the governor knows nothing about coord/PG/toasts; the host subscribes. */
export interface GovernorPauseEvent {
  pausedUntil: number;
  source: 'penalty' | 'headers';
}

export interface GovernorDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called (best-effort, synchronously) only when `pausedUntil` increases. Must not throw. */
  onPause?: (ev: GovernorPauseEvent) => void;
}

export interface AcquireOpts {
  /** Abort the wait (interactive callers) — acquire resolves to null. */
  signal?: AbortSignal;
  /** Give up (resolve null) rather than wait longer than this in total. */
  maxWaitMs?: number;
}

/** Async façade over the pure core: `acquire()` blocks until allowed, then returns a
    release fn. `recordResponse(headers)` and `penalize(opts)` feed the limiter. */
export class RateLimitGovernor {
  readonly state: GovernorState;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onPause?: (ev: GovernorPauseEvent) => void;

  constructor(limits: GovernorLimits, deps: GovernorDeps = {}) {
    this.state = initGovernorState(limits);
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onPause = deps.onPause;
  }

  /** A point-in-time copy of the state (for observability — RB-009). */
  snapshot(): GovernorState {
    return { ...this.state, limits: { ...this.state.limits } };
  }

  /** Fire onPause iff the pause moved later (a real new/extended backpressure transition). */
  private notifyPauseIfExtended(before: number, source: GovernorPauseEvent['source']): void {
    if (!this.onPause) return;
    const after = this.state.pausedUntil;
    if (after > before && after > this.now()) {
      try {
        this.onPause({ pausedUntil: after, source });
      } catch {
        /* observability must never break the limiter */
      }
    }
  }

  /**
   * Acquire a permit, blocking until allowed. Returns a release fn, or `null` if it GAVE
   * UP — the abort signal fired, or the cumulative wait would exceed `opts.maxWaitMs`. The
   * null path is what lets an INTERACTIVE caller bail (surface "rate-limited until <reset>"
   * + escalate) instead of inheriting a far-off shared pause (e.g. a 5-hour-limit penalty
   * set by the gym) and freezing for hours (reviewer #3 / D-002). Unattended callers pass a
   * large maxWaitMs (or none → Infinity) and just wait.
   */
  async acquire(est: TokenEstimate = {}, opts: AcquireOpts = {}): Promise<(() => void) | null> {
    const maxWait = opts.maxWaitMs ?? Infinity;
    let waited = 0;
    for (;;) {
      if (opts.signal?.aborted) return null;
      const d = decideAcquire(this.state, this.now(), est);
      if (d.allowed) {
        recordAcquire(this.state, this.now(), est);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          recordRelease(this.state);
        };
      }
      const w = Math.max(1, d.waitMs);
      if (waited + w > maxWait) return null; // would wait too long → give up, let the caller decide
      waited += w;
      await this.sleep(w);
    }
  }

  recordResponse(headers: Record<string, string | undefined>): void {
    const before = this.state.pausedUntil;
    recordHeaders(this.state, headers, this.now());
    this.notifyPauseIfExtended(before, 'headers');
  }

  penalize(opts: { retryAfterMs?: number; resetAt?: number }): void {
    const before = this.state.pausedUntil;
    recordPenalty(this.state, this.now(), opts);
    this.notifyPauseIfExtended(before, 'penalty');
  }
}
