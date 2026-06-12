/**
 * RB-010 — fault-injection matrix + pacing SLO for the agent turn-robustness stack.
 *
 * Drives the FULL stack every backend shares — `runAgentTurn` → `RateLimitGovernor` →
 * `classifyTurnError` — with every fault class injected, per backend shape (anthropic-direct HTTP +
 * CLI subprocess). Two guarantees the plan demands:
 *   1. NEVER crash the parent: a handled fault returns a structured `TurnError`, never throws.
 *   2. Correct policy: rate_limited waits to reset + resumes; overloaded/timeout/crash/empty/
 *      malformed back off + retry; auth/permanent fail fast.
 * Plus the review's "does pacing actually work" SLO: under a server that 429s when you burst,
 * the GOVERNED caller keeps the 429-rate low AND still achieves throughput near the ceiling
 * (not needlessly throttled) — proven by contrast with an effectively-ungoverned caller.
 *
 * Zero-LLM, fake clock — deterministic. Run:
 *   npx vitest run libs/papercup-shared/src/agent/turn-robustness.fault-injection.test.ts
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { RateLimitGovernor } from '../resilience/governor';
import { runAgentTurn, type TurnOutcome } from './turn-runner';
import type { TurnBackend } from './turn-error';

/** A fake clock whose `sleep` advances time instantly — so governor pauses/backoff don't
    actually block the test, and we can measure simulated wall-clock. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    get t() {
      return t;
    },
  };
}

/** A governor wired to the fake clock with a generous concurrency cap (we test the error
    policy, not concurrency here). */
function govWith(clock: ReturnType<typeof fakeClock>, opts: { rpm?: number; maxConcurrent?: number } = {}) {
  return new RateLimitGovernor(
    { maxConcurrent: opts.maxConcurrent ?? 8, ...(opts.rpm !== undefined ? { rpm: opts.rpm } : {}) },
    { now: clock.now, sleep: clock.sleep },
  );
}

// --- 1) NEVER CRASH: every fault class returns a structured result, never throws ----------

test('runAgentTurn — a THROWN runOnce is caught + classified, never propagated', async () => {
  const clock = fakeClock();
  const res = await runAgentTurn<string>(
    { backend: 'anthropic-direct', maxAttempts: 1 },
    {
      governor: govWith(clock),
      now: clock.now,
      sleep: clock.sleep,
      runOnce: async () => {
        throw new Error('socket hang up'); // a raw network blow-up mid-call
      },
    },
  );
  assert.equal(res.ok, false);
  if (!res.ok) {
    // a thrown error with no status → transient_io (a retryable blip), and the PARENT survived
    assert.equal(res.error.class, 'transient_io');
  }
});

// anthropic-direct (HTTP-shape) fault matrix: [status, expected class, retryable].
const HTTP_FAULTS: Array<[number, string, boolean]> = [
  [429, 'rate_limited', true],
  [529, 'overloaded', true],
  [503, 'overloaded', true],
  [408, 'timeout', true],
  [401, 'auth', false],
  [400, 'permanent', false],
];
for (const [status, expected, retryable] of HTTP_FAULTS) {
  test(`runAgentTurn[anthropic-direct] — HTTP ${status} → ${expected} (retryable=${retryable}), no crash`, async () => {
    const clock = fakeClock();
    const res = await runAgentTurn<string>(
      { backend: 'anthropic-direct', maxAttempts: 1, maxWaitMs: 5_000 },
      {
        governor: govWith(clock),
        now: clock.now,
        sleep: clock.sleep,
        runOnce: async (): Promise<TurnOutcome<string>> => ({ ok: false, raw: { status, message: `HTTP ${status}` } }),
      },
    );
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error.class, expected);
      assert.equal(res.error.retryable, retryable);
    }
  });
}

// Subprocess (CLI-shape) fault matrix for a claude-code spawn.
const SUBPROC_FAULTS: Array<[Record<string, unknown>, string, boolean]> = [
  [{ exitCode: 1, stderr: 'Error: 429 rate limit exceeded, retry after 30s' }, 'rate_limited', true],
  [{ exitCode: 1, stderr: 'overloaded_error: the service is temporarily overloaded' }, 'overloaded', true],
  [{ exitCode: null, signal: 'SIGTERM', timedOut: true }, 'timeout', true],
  [{ exitCode: 137, signal: 'SIGKILL', stderr: 'killed' }, 'timeout', true], // timedOut wins
  [{ exitCode: 1, stderr: 'segfault' }, 'agent_crash', true],
  [{ exitCode: 0, stdout: '' }, 'empty_output', true],
  [{ exitCode: 1, stderr: 'invalid api key (401)' }, 'auth', false],
];
for (const [raw, expected, retryable] of SUBPROC_FAULTS) {
  const label = (raw.timedOut ? 'timedOut' : `exit ${raw.exitCode}`) + (raw.stderr ? `:${String(raw.stderr).slice(0, 18)}` : '');
  test(`runAgentTurn[claude-code] — ${label} → ${expected}, no crash`, async () => {
    const clock = fakeClock();
    const withTimeout = raw.exitCode === 137 ? { ...raw, timedOut: true } : raw;
    const res = await runAgentTurn<string>(
      { backend: 'claude-code', maxAttempts: 1, maxWaitMs: 5_000 },
      {
        governor: govWith(clock),
        now: clock.now,
        sleep: clock.sleep,
        runOnce: async (): Promise<TurnOutcome<string>> => ({ ok: false, raw: withTimeout as never }),
      },
    );
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error.class, expected);
      assert.equal(res.error.retryable, retryable);
    }
  });
}

// --- 2) CORRECT WAIT/RESUME: a rate_limited turn waits to the reset then succeeds ---------

test('runAgentTurn[anthropic-direct] — rate_limited (retry-after) waits, then RESUMES to success', async () => {
  const clock = fakeClock(1_000_000);
  let attempt = 0;
  const res = await runAgentTurn<string>(
    { backend: 'anthropic-direct', maxAttempts: 4 },
    {
      governor: govWith(clock),
      now: clock.now,
      sleep: clock.sleep,
      runOnce: async (): Promise<TurnOutcome<string>> => {
        attempt++;
        if (attempt === 1) {
          return { ok: false, raw: { status: 429, headers: { 'retry-after': '30' }, message: '429' } };
        }
        return { ok: true, value: 'recovered', headers: { 'anthropic-ratelimit-requests-limit': '50' } };
      },
    },
  );
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.value, 'recovered');
  assert.equal(attempt, 2); // failed once, resumed on the 2nd attempt
  // It honored the 30s retry-after (not a blind tiny backoff): simulated clock advanced ≥30s.
  assert.ok(clock.t - 1_000_000 >= 30_000, `expected ≥30s wait, got ${clock.t - 1_000_000}ms`);
});

test('runAgentTurn — an exhausted retryable fault returns the LAST error, still no crash', async () => {
  const clock = fakeClock();
  let attempts = 0;
  const res = await runAgentTurn<string>(
    { backend: 'anthropic-direct', maxAttempts: 3, baseBackoffMs: 10, maxWaitMs: 60_000 },
    {
      governor: govWith(clock),
      now: clock.now,
      sleep: clock.sleep,
      runOnce: async (): Promise<TurnOutcome<string>> => {
        attempts++;
        return { ok: false, raw: { status: 529, message: 'overloaded' } }; // always overloaded
      },
    },
  );
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.class, 'overloaded');
  assert.equal(attempts, 3); // tried up to maxAttempts, then surfaced — did NOT throw
});

test('runAgentTurn — auth fault fails FAST (no retry spent)', async () => {
  const clock = fakeClock();
  let attempts = 0;
  const res = await runAgentTurn<string>(
    { backend: 'anthropic-direct', maxAttempts: 6 },
    {
      governor: govWith(clock),
      now: clock.now,
      sleep: clock.sleep,
      runOnce: async (): Promise<TurnOutcome<string>> => {
        attempts++;
        return { ok: false, raw: { status: 401, message: 'unauthorized' } };
      },
    },
  );
  assert.equal(res.ok, false);
  assert.equal(attempts, 1); // non-retryable → bailed immediately despite maxAttempts:6
});

// --- 3) PACING SLO: governed keeps 429-rate low AND throughput near the ceiling -----------

/**
 * A fake provider that 429s when the caller bursts past `limit` requests in a 60s window
 * (tumbling, matching the governor's model). On success it returns the standard remaining/reset
 * headers so a header-driven governor can self-tune. Records every call for the SLO math.
 */
function fakeRateLimitedServer(limit: number, clockNow: () => number) {
  let windowStart = 0;
  let countInWindow = 0;
  let total = 0;
  let rejected = 0;
  return {
    call(): TurnOutcome<string> {
      const now = clockNow();
      if (now - windowStart >= 60_000) {
        windowStart = now;
        countInWindow = 0;
      }
      total++;
      countInWindow++;
      const resetIso = new Date(windowStart + 60_000).toISOString();
      if (countInWindow > limit) {
        rejected++;
        return {
          ok: false,
          raw: {
            status: 429,
            headers: { 'retry-after': String(Math.ceil((windowStart + 60_000 - now) / 1000)) },
            message: '429 too many requests',
          },
        };
      }
      return {
        ok: true,
        value: 'ok',
        headers: {
          'anthropic-ratelimit-requests-limit': String(limit),
          'anthropic-ratelimit-requests-remaining': String(limit - countInWindow),
          'anthropic-ratelimit-requests-reset': resetIso,
        },
      };
    },
    get stats() {
      return { total, rejected, rejectRate: total ? rejected / total : 0 };
    },
  };
}

async function runTurns(n: number, gov: RateLimitGovernor, clock: ReturnType<typeof fakeClock>, server: ReturnType<typeof fakeRateLimitedServer>) {
  let succeeded = 0;
  for (let i = 0; i < n; i++) {
    const res = await runAgentTurn<string>(
      { backend: 'anthropic-direct', maxAttempts: 8, maxWaitMs: 10 * 60_000 },
      { governor: gov, now: clock.now, sleep: clock.sleep, runOnce: async () => server.call() },
    );
    if (res.ok) succeeded++;
  }
  return succeeded;
}

test('RB-010 SLO — the GOVERNED caller keeps 429-rate low AND throughput near the ceiling', async () => {
  const LIMIT = 10; // provider ceiling: 10 req / 60s
  const N = 40;

  // Governed at the ceiling: the governor paces to rpm=LIMIT so it rarely over-sends.
  const gClock = fakeClock();
  const gServer = fakeRateLimitedServer(LIMIT, gClock.now);
  const governed = new RateLimitGovernor({ maxConcurrent: 8, rpm: LIMIT }, { now: gClock.now, sleep: gClock.sleep });
  const gSucceeded = await runTurns(N, governed, gClock, gServer);

  // Naive baseline: NO governor at all — just fire N requests back-to-back at the server (the
  // legacy "burst past the ceiling" behavior). The clock never advances, so everything lands in
  // one window and the server rejects every request past the limit.
  const nClock = fakeClock();
  const nServer = fakeRateLimitedServer(LIMIT, nClock.now);
  for (let i = 0; i < N; i++) nServer.call();

  // (a) every governed turn still completed (resume-on-429 means none are lost)
  assert.equal(gSucceeded, N);

  // (b) 429-RATE: the governor keeps it near zero; the naive burst trips constantly.
  assert.ok(
    gServer.stats.rejectRate < 0.1,
    `governed 429-rate ${(gServer.stats.rejectRate * 100).toFixed(1)}% should be < 10%`,
  );
  assert.ok(
    nServer.stats.rejectRate > 0.5,
    `naive-burst 429-rate ${(nServer.stats.rejectRate * 100).toFixed(1)}% should be high (>50%) — the problem we're fixing`,
  );
  assert.ok(
    gServer.stats.rejectRate < nServer.stats.rejectRate,
    `governed (${gServer.stats.rejectRate.toFixed(2)}) must beat naive burst (${nServer.stats.rejectRate.toFixed(2)})`,
  );

  // (c) THROUGHPUT within Y% of the ceiling: N turns at 10/60s ≈ N/LIMIT windows of wall-clock.
  //     Not needlessly throttled — simulated time should be close to the theoretical minimum.
  const idealMs = Math.ceil(N / LIMIT) * 60_000; // ~4 windows for 40 turns @ 10/window
  assert.ok(
    gClock.t <= idealMs * 1.5,
    `governed wall-clock ${gClock.t}ms should be within 50% of the ${idealMs}ms ceiling (not over-throttled)`,
  );

  // (d) header AUTO-TUNE works: the governor learned the real RPM from the success headers.
  assert.equal(governed.state.limits.rpm, LIMIT);
});

// --- ACCEPTANCE (rate-limit-layer-v2-2026-06-05 P-022) -----------------------------------------
// A simulated 429 backs off the FLEET, not just the tripping agent: two INDEPENDENT callers
// share one (provider, modelClass) bucket from the registry; caller A's 429 penalty parks the
// shared budget, so caller B — which never saw a 429 — waits out the same reset before its
// turn runs. The registry-level AIMD (D-005) also halves the fleet's effective concurrency.
import {
  getGovernor,
  resetGovernorRegistry,
  setGlobalConcurrencyCap,
  setGlobalConcurrencyFloor,
  effectiveConcurrencySnapshot,
} from './governor-registry';

test('ACCEPTANCE P-022 — a 429 on ONE agent backs off the WHOLE fleet via the shared bucket; AIMD halves eff', async () => {
  resetGovernorRegistry();
  setGlobalConcurrencyCap(8); // activates AIMD (eff starts at 8)
  setGlobalConcurrencyFloor(1);
  try {
    const clock = fakeClock(0);
    // BOTH callers resolve the SAME shared singleton bucket — the fleet path.
    const gov = getGovernor('anthropic', 'opus', { now: clock.now, sleep: clock.sleep });

    // Caller A trips a 429 with a 60s retry-after, recovers on retry.
    let aAttempts = 0;
    const a = await runAgentTurn<string>(
      { backend: 'anthropic-direct', maxAttempts: 3 }, // HTTP-shaped raw → the HTTP classifier
      {
        governor: gov,
        now: clock.now,
        sleep: clock.sleep,
        runOnce: async (): Promise<TurnOutcome<string>> => {
          aAttempts++;
          if (aAttempts === 1) {
            return { ok: false, raw: { status: 429, headers: { 'retry-after': '60' }, message: '429 too many requests' } };
          }
          return { ok: true, value: 'a-recovered' };
        },
      },
    );
    assert.equal(a.ok, true);
    assert.ok(clock.t >= 60_000, `A waited out its own retry-after (t=${clock.t})`);

    // AIMD: the account-wide penalty halved the fleet's effective concurrency (8 → 4).
    assert.equal(effectiveConcurrencySnapshot().effective, 4);

    // Caller B — a DIFFERENT agent that never saw a 429 — must also have been held by the
    // shared pause had it started during the penalty window. Re-penalize and prove it.
    gov.penalize({ retryAfterMs: 30_000 }); // a fresh fleet-wide pause at t≈60s+
    const pauseSetAt = clock.t;
    let bRan = 0;
    const b = await runAgentTurn<string>(
      { backend: 'anthropic-direct', maxAttempts: 2 },
      {
        governor: gov, // the SAME shared bucket
        now: clock.now,
        sleep: clock.sleep,
        runOnce: async (): Promise<TurnOutcome<string>> => {
          bRan = clock.t;
          return { ok: true, value: 'b-clean' };
        },
      },
    );
    assert.equal(b.ok, true);
    assert.ok(
      bRan - pauseSetAt >= 30_000,
      `B (clean caller) waited out the FLEET pause set by the other agent: waited ${bRan - pauseSetAt}ms`,
    );
    // The second distinct penalty halved eff again (4 → 2).
    assert.equal(effectiveConcurrencySnapshot().effective, 2);
  } finally {
    resetGovernorRegistry();
    setGlobalConcurrencyCap(undefined);
    setGlobalConcurrencyFloor(undefined);
  }
});
