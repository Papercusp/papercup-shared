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
// Cascade-aware staggered resume (rate-limit-layer-v2 D-006): waiters parked on one pause get
// ORDERED per-waiter offsets so they wake spread over a bounded window instead of re-stampeding
// the limit at the same `pausedUntil` instant. Deterministic (ticket × step, capped) — testable
// with a fake clock and no Math.random.
const RESUME_STAGGER_STEP_MS = 250;
const RESUME_STAGGER_MAX_MS = 5_000;
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

/** PURE: the CONCURRENCY gate only (the per-process burst lever). Split out from `decideAcquire`
    so the cross-process store (RB-007) can run the RATE gate against the shared row while keeping
    concurrency local. */
export function decideConcurrency(s: GovernorState): AcquireDecision {
  if (s.inFlight >= s.limits.maxConcurrent) return { allowed: false, waitMs: CONCURRENCY_POLL_MS, reason: 'concurrency' };
  return { allowed: true, waitMs: 0 };
}

/** PURE: the RATE + PAUSE + pacing gate (everything except concurrency) — the account-wide
    budget that RB-007 shares cross-process. */
export function decideRate(s: GovernorState, now: number, est: TokenEstimate = {}): AcquireDecision {
  if (now < s.pausedUntil) return { allowed: false, waitMs: s.pausedUntil - now, reason: 'paused' };

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

/** PURE: may this turn proceed at `now`? Concurrency first, then the rate/pause budget. If not,
    how long to wait before re-checking. */
export function decideAcquire(s: GovernorState, now: number, est: TokenEstimate = {}): AcquireDecision {
  const c = decideConcurrency(s);
  if (!c.allowed) return c;
  return decideRate(s, now, est);
}

/** Commit the RATE side of an acquisition: roll the window if stale, then charge req/token usage
    + stamp the pace anchor. (Concurrency is charged separately so the store can keep it local.) */
export function recordRate(s: GovernorState, now: number, est: TokenEstimate = {}): void {
  if (now - s.windowStart >= WINDOW_MS) {
    s.windowStart = now;
    s.reqInWindow = 0;
    s.inTokInWindow = 0;
    s.outTokInWindow = 0;
  }
  s.reqInWindow += 1;
  s.inTokInWindow += est.inTok ?? 0;
  s.outTokInWindow += est.outTok ?? 0;
  s.lastAcquireAt = now;
}

/** Commit a full acquisition: charge the rate budget + take a concurrency slot. */
export function recordAcquire(s: GovernorState, now: number, est: TokenEstimate = {}): void {
  recordRate(s, now, est);
  s.inFlight += 1;
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

/**
 * Cross-process store seam (RB-007). The RATE + PAUSE budget (the account-wide part that causes
 * 429s when the fleet co-bursts) lives behind this so multiple processes share ONE budget;
 * CONCURRENCY stays per-process (a per-runner burst lever — cross-process concurrency would need
 * leasing, and the shared rate window already bounds aggregate request rate). `transact` does an
 * ATOMIC load→mutate→persist on the bucket's shared row (e.g. PG `SELECT … FOR UPDATE`); the
 * mutate runs the pure rate decision/record on the loaded state. Default = no store = pure
 * in-memory (the fast path, byte-identical to before).
 */
export interface GovernorStore {
  transact(key: string, floor: GovernorLimits, mutate: (s: GovernorState) => void): Promise<GovernorState>;
}

/**
 * Fleet-wide concurrency gate (rate-limit-layer-v2 D-004). A single shared counter+cap that
 * EVERY governor consults on top of its own per-bucket `maxConcurrent`, so the TOTAL in-flight
 * turns across all `(provider, modelClass)` buckets is bounded by the user's live
 * `maxSimultaneousAgents`. The same gate object is injected into every governor (by the
 * registry) so they share one counter. Domain-free: the governor knows only "ask before a slot,
 * give it back on release". Omit = no global cap (per-bucket behavior, byte-identical to before).
 */
export interface GlobalConcurrencyGate {
  /** Atomically take a global slot iff total in-flight < cap; false if the fleet cap is reached. */
  tryAcquire(): boolean;
  /** Return a global slot (paired 1:1 with a successful tryAcquire). */
  release(): void;
  /**
   * AIMD feedback (rate-limit-layer-v2 D-005). The governor reports each turn's health so the
   * gate can adapt its EFFECTIVE concurrency under the hard cap: `noteClean` after a release
   * whose turn saw no account-wide penalty (additive increase: +1 per N clean turns);
   * `notePenalty` on every account-wide penalize (multiplicative decrease: halve toward the
   * floor). Optional so a bare cap-only gate (tests, simple hosts) stays valid.
   */
  noteClean?(): void;
  notePenalty?(): void;
}

export interface GovernorDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called (best-effort, synchronously) only when `pausedUntil` increases. Must not throw. */
  onPause?: (ev: GovernorPauseEvent) => void;
  /** Cross-process shared-budget store (RB-007). Omit for in-memory (per-process) governance. */
  store?: GovernorStore;
  /** Bucket key for the store (e.g. "anthropic:opus"). Required when `store` is set. */
  storeKey?: string;
  /** Fleet-wide concurrency gate (D-004) shared across all buckets. Omit = no global cap. */
  globalGate?: GlobalConcurrencyGate;
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
  private readonly store?: GovernorStore;
  private readonly storeKey?: string;
  private readonly globalGate?: GlobalConcurrencyGate;
  private readonly floor: GovernorLimits;
  /** Bumped on every account-wide penalty — lets a release decide whether its turn was CLEAN
      (no penalty between acquire and release) for the AIMD feedback (D-005). */
  private penaltySeq = 0;
  /** Staggered-resume bookkeeping (D-006): one ordered ticket per waiter per pause epoch. */
  private pauseEpochUntil = 0;
  private pauseTickets = 0;

  constructor(limits: GovernorLimits, deps: GovernorDeps = {}) {
    this.state = initGovernorState(limits);
    this.floor = { ...limits };
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onPause = deps.onPause;
    this.store = deps.store;
    this.storeKey = deps.storeKey;
    this.globalGate = deps.globalGate;
    if (this.store && !this.storeKey) throw new Error('RateLimitGovernor: storeKey is required when a store is set');
  }

  /** Pull the shared RATE+PAUSE fields from a store-loaded state into the local snapshot (so
      `snapshot()` / observability reflect the shared budget; concurrency stays local). */
  private syncSharedInto(shared: GovernorState): void {
    const before = this.state.pausedUntil;
    this.state.windowStart = shared.windowStart;
    this.state.reqInWindow = shared.reqInWindow;
    this.state.inTokInWindow = shared.inTokInWindow;
    this.state.outTokInWindow = shared.outTokInWindow;
    this.state.pausedUntil = shared.pausedUntil;
    this.state.paceDelayMs = shared.paceDelayMs;
    this.state.lastAcquireAt = shared.lastAcquireAt;
    this.state.limits = { ...this.state.limits, ...shared.limits, maxConcurrent: this.state.limits.maxConcurrent };
    this.notifyPauseIfExtended(before, 'penalty');
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
    let pauseTicket: number | undefined; // staggered-resume ticket for THIS waiter (D-006)
    const mkRelease = (): (() => void) => {
      const seqAtAcquire = this.penaltySeq;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        recordRelease(this.state);
        // AIMD feedback (D-005): a turn with no account-wide penalty in between is CLEAN.
        if (this.penaltySeq === seqAtAcquire) this.globalGate?.noteClean?.();
        this.globalGate?.release(); // give the fleet-wide slot back too (D-004)
      };
    };
    for (;;) {
      if (opts.signal?.aborted) return null;
      let d: AcquireDecision;
      if (!this.store) {
        // IN-MEMORY fast path: decide + record SYNCHRONOUSLY (no await between the check and the
        // increment) so concurrency stays atomic under many interleaved callers.
        d = decideAcquire(this.state, this.now(), est);
        if (d.allowed) {
          // Fleet-wide cap (D-004): this bucket has room AND rate budget — now take a global slot.
          // If the fleet is at its cap, wait + re-poll (don't charge the bucket). Released in mkRelease.
          if (this.globalGate && !this.globalGate.tryAcquire()) {
            d = { allowed: false, waitMs: CONCURRENCY_POLL_MS, reason: 'concurrency' };
          } else {
            recordAcquire(this.state, this.now(), est);
            return mkRelease();
          }
        }
      } else {
        // CROSS-PROCESS path (RB-007): concurrency is local; reserve the slot atomically (right
        // after the sync check, before any await), then run the RATE gate against the shared row.
        const c = decideConcurrency(this.state);
        if (c.allowed && this.globalGate && !this.globalGate.tryAcquire()) {
          // Bucket has room but the fleet-wide cap is reached (D-004) → wait, charge nothing.
          d = { allowed: false, waitMs: CONCURRENCY_POLL_MS, reason: 'concurrency' };
        } else if (c.allowed) {
          this.state.inFlight += 1; // reserve the local concurrency slot now
          let rateAllowed = false;
          let rateWait = CONCURRENCY_POLL_MS;
          let rateReason: AcquireDecision['reason'];
          try {
            const shared = await this.store.transact(this.storeKey!, this.floor, (s) => {
              const rd = decideRate(s, this.now(), est);
              rateAllowed = rd.allowed;
              rateWait = rd.waitMs;
              rateReason = rd.reason;
              if (rd.allowed) recordRate(s, this.now(), est);
            });
            this.syncSharedInto(shared);
          } finally {
            if (!rateAllowed) {
              this.state.inFlight -= 1; // give the reservation back on a rate denial
              this.globalGate?.release(); // and the fleet-wide slot taken just above (D-004)
            }
          }
          if (rateAllowed) return mkRelease();
          d = { allowed: false, waitMs: rateWait, reason: rateReason };
        } else {
          d = c;
        }
      }
      let w = Math.max(1, d.waitMs);
      // Staggered resume (D-006): every waiter parked on the SAME pause takes one ordered ticket;
      // its wake is offset by ticket × step (capped) so the fleet re-enters spread over a bounded
      // window instead of re-stampeding (and re-tripping) the limit at the reset instant.
      if (d.reason === 'paused') {
        if (pauseTicket === undefined || this.state.pausedUntil !== this.pauseEpochUntil) {
          if (this.state.pausedUntil !== this.pauseEpochUntil) {
            this.pauseEpochUntil = this.state.pausedUntil;
            this.pauseTickets = 0;
          }
          pauseTicket = this.pauseTickets++;
        }
        w += Math.min(pauseTicket * RESUME_STAGGER_STEP_MS, RESUME_STAGGER_MAX_MS);
      }
      if (waited + w > maxWait) return null; // would wait too long → give up, let the caller decide
      waited += w;
      await this.sleep(w);
    }
  }

  recordResponse(headers: Record<string, string | undefined>): void {
    const before = this.state.pausedUntil;
    recordHeaders(this.state, headers, this.now());
    this.notifyPauseIfExtended(before, 'headers');
    // Converge the shared budget too (best-effort; the shared row is authoritative cross-process).
    if (this.store) void this.store.transact(this.storeKey!, this.floor, (s) => recordHeaders(s, headers, this.now())).catch(() => {});
  }

  penalize(opts: { retryAfterMs?: number; resetAt?: number }): void {
    const before = this.state.pausedUntil;
    this.penaltySeq += 1; // any in-flight turn that releases after this is NOT clean (D-005)
    recordPenalty(this.state, this.now(), opts);
    // AIMD multiplicative decrease (D-005) — once per DISTINCT backpressure event (a pause that
    // actually extends), so N agents co-failing on the same 429 halve the fleet once, not N times.
    if (this.state.pausedUntil > before) this.globalGate?.notePenalty?.();
    this.notifyPauseIfExtended(before, 'penalty');
    // A 429 anywhere pauses the WHOLE account → push to the shared row so every process backs off.
    if (this.store) void this.store.transact(this.storeKey!, this.floor, (s) => recordPenalty(s, this.now(), opts)).catch(() => {});
  }
}
