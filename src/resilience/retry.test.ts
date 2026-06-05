/**
 * Tests for the generic runWithRetry policy loop (resilience, RB-013).
 * Run: npx vitest run libs/papercup-shared/src/resilience/retry.test.ts
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { RateLimitGovernor } from './governor';
import { runWithRetry, type AttemptOutcome } from './retry';

function gov() {
  let clock = 0;
  const sleep = async (ms: number) => { clock += ms; };
  const g = new RateLimitGovernor({ maxConcurrent: 4 }, { now: () => clock, sleep });
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
  const c = gov();
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
  assert.equal(c.g.state.pausedUntil, resetAt); // but DID pause the shared bucket so the fleet backs off
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
