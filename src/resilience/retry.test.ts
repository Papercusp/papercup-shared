/**
 * Tests for the generic runWithRetry policy loop (resilience, RB-013).
 * Run: npx vitest run libs/papercusp-shared/src/resilience/retry.test.ts
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { RateLimitGovernor, ROLLING_WINDOW_REPROBE_MAX_MS } from './governor';
import { runWithRetry, type AttemptOutcome } from './retry';

// storeKey: pass an ACCOUNT-KEYED key (contains '@<accountId>') to model a single
// account's bucket. A plan/usage cap is account-scoped, so those tests use an
// account-keyed governor. Per the 2026-06-23 "12h over-park" fix (governor.ts
// recordPenalty; covered authoritatively by governor.test.ts "USAGE-CAP re-probe cap"),
// an account-keyed USAGE-cap pause is BOUNDED to a ~30-min re-probe
// (ROLLING_WINDOW_REPROBE_MAX_MS) — NOT parked to the full multi-hour reset, which
// stranded a since-recovered account for up to 12h. The sustained-exhaustion scale-out
// signal is preserved by re-penalizing on each re-probe. A keyless/fleet-wide bucket
// caps even tighter (a 2-min re-probe) so one account's long reset can't lock out the fleet.
function gov(storeKey?: string) {
  let clock = 0;
  const sleep = async (ms: number) => { clock += ms; };
  const g = new RateLimitGovernor(
    { maxConcurrent: 4 },
    { now: () => clock, sleep, ...(storeKey ? { storeKey } : {}) },
  );
  return { g, sleep, now: () => clock, get clock() { return clock; } };
}

test('runWithRetry — returns value on success + records headers', async () => {
  const c = gov();
  const r = await runWithRetry<string>({}, {
    governor: c.g, now: c.now, sleep: c.sleep,
    attempt: async (): Promise<AttemptOutcome<string>> => ({ ok: true, value: 'v', headers: { 'anthropic-ratelimit-requests-limit': '50' } }),
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, 'v');
  assert.equal(c.g.state.limits.rpm, 50);
});

test('runWithRetry — account-wide retryable with NO hint backs off (no hot-loop) then succeeds', async () => {
  const c = gov();
  let n = 0;
  const r = await runWithRetry<string>({ maxAttempts: 4, baseBackoffMs: 1000 }, {
    governor: c.g, now: c.now, sleep: c.sleep,
    attempt: async (): Promise<AttemptOutcome<string>> => {
      n++;
      if (n < 3) return { ok: false, error: { retryable: true, accountWide: true } }; // no retryAfter
      return { ok: true, value: 'ok' };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(n, 3);
  assert.ok(c.clock >= 1000); // actually waited via the governor pause
  assert.ok(c.g.state.pausedUntil > 0);
});

test('runWithRetry — non-retryable returns the verdict immediately', async () => {
  const c = gov();
  let n = 0;
  const r = await runWithRetry<string>({ maxAttempts: 5 }, {
    governor: c.g, now: c.now, sleep: c.sleep,
    attempt: async (): Promise<AttemptOutcome<string>> => { n++; return { ok: false, error: { retryable: false, accountWide: false, message: 'auth' } }; },
  });
  assert.equal(r.ok, false);
  assert.equal(n, 1);
  if (!r.ok) assert.equal(r.error.message, 'auth');
});

test('runWithRetry — account-wide NON-retryable with a reset (usage cap) parks the FLEET, no retry (D-001)', async () => {
  const c = gov('acct@plan-cap'); // account-keyed: a plan cap is one account's bucket → honors the full reset
  let n = 0;
  const resetAt = c.now() + 3 * 60 * 60 * 1000; // 3h off (a plan cap)
  const r = await runWithRetry<string>({ maxAttempts: 5 }, {
    governor: c.g, now: c.now, sleep: c.sleep,
    attempt: async (): Promise<AttemptOutcome<string>> => {
      n++;
      return { ok: false, error: { retryable: false, accountWide: true, resetAt, message: 'usage limit' } };
    },
  });
  assert.equal(r.ok, false);
  assert.equal(n, 1); // did NOT retry into the wall
  // The over-park fix bounds an account-keyed usage-cap pause to the 30-min re-probe (NOT the
  // full 3h reset) so a since-recovered account isn't stranded; it still parks the bucket so the
  // fleet backs off, and re-penalizes on each re-probe to keep the scale-out signal (D-001).
  assert.equal(c.g.state.pausedUntil, c.now() + ROLLING_WINDOW_REPROBE_MAX_MS);
});

test('runWithRetry — per-call (not account-wide) retryable uses local backoff', async () => {
  const c = gov();
  let n = 0;
  const r = await runWithRetry<string>({ maxAttempts: 3, baseBackoffMs: 1000 }, {
    governor: c.g, now: c.now, sleep: c.sleep,
    attempt: async (): Promise<AttemptOutcome<string>> => { n++; if (n < 2) return { ok: false, error: { retryable: true, accountWide: false } }; return { ok: true, value: 'x' }; },
  });
  assert.equal(r.ok, true);
  assert.equal(n, 2);
  assert.ok(c.clock >= 1000); // local backoff happened
  assert.equal(c.g.state.pausedUntil, 0); // per-call → governor NOT paused
});

test('runWithRetry — bails (no hang) when a far-off governor pause exceeds maxWaitMs', async () => {
  const c = gov();
  c.g.penalize({ retryAfterMs: 5 * 60 * 60 * 1000 }); // 5h pause from another caller
  let n = 0;
  const r = await runWithRetry<string>({ maxWaitMs: 2000 }, {
    governor: c.g, now: c.now, sleep: c.sleep,
    attempt: async (): Promise<AttemptOutcome<string>> => { n++; return { ok: true, value: 'never' }; },
  });
  assert.equal(r.ok, false);
  assert.equal(n, 0); // bailed at acquire — never attempted
  if (!r.ok) assert.ok(r.error.resetAt && r.error.resetAt > 0);
});
