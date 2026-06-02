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
}

export interface TokenEstimate {
  inTok?: number;
  outTok?: number;
}

export interface AcquireDecision {
  allowed: boolean;
  waitMs: number;
  reason?: 'paused' | 'concurrency' | 'rpm' | 'itpm' | 'otpm';
}

const WINDOW_MS = 60_000;
const CONCURRENCY_POLL_MS = 250; // we don't know when a peer releases → short re-poll

export function initGovernorState(limits: GovernorLimits): GovernorState {
  return {
    limits: { ...limits },
    inFlight: 0,
    windowStart: 0,
    reqInWindow: 0,
    inTokInWindow: 0,
    outTokInWindow: 0,
    pausedUntil: 0,
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

  // If any dimension is exhausted (remaining 0) + a reset is given, pause until then.
  const pairs: Array<[string, string]> = [
    ['anthropic-ratelimit-requests-remaining', 'anthropic-ratelimit-requests-reset'],
    ['anthropic-ratelimit-input-tokens-remaining', 'anthropic-ratelimit-input-tokens-reset'],
    ['anthropic-ratelimit-output-tokens-remaining', 'anthropic-ratelimit-output-tokens-reset'],
    ['anthropic-ratelimit-tokens-remaining', 'anthropic-ratelimit-tokens-reset'],
  ];
  for (const [remK, resetK] of pairs) {
    const rem = num(h[remK]);
    if (rem === 0 && h[resetK]) {
      const t = Date.parse(h[resetK] as string);
      if (!Number.isNaN(t) && t > s.pausedUntil) s.pausedUntil = t;
    }
  }
}

export interface GovernorDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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

  constructor(limits: GovernorLimits, deps: GovernorDeps = {}) {
    this.state = initGovernorState(limits);
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
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
    recordHeaders(this.state, headers, this.now());
  }

  penalize(opts: { retryAfterMs?: number; resetAt?: number }): void {
    recordPenalty(this.state, this.now(), opts);
  }
}
