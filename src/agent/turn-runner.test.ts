/**
 * Tests for runAgentTurn — the governed, retrying turn wrapper (robustness P-003).
 * Run: npx vitest run libs/papercup-shared/src/agent/turn-runner.test.ts
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { RateLimitGovernor } from '../resilience/governor';
import { runAgentTurn, type TurnOutcome } from './turn-runner';

function fakeGovernor() {
  let clock = 0;
  const g = new RateLimitGovernor({ maxConcurrent: 4 }, { now: () => clock, sleep: async (ms) => { clock += ms; } });
  return { g, advance: (ms: number) => { clock += ms; }, get clock() { return clock; } };
}
const deps = (g: RateLimitGovernor) => ({ governor: g, sleep: async () => {}, now: () => 0 });

test('runAgentTurn — returns the value on first success + records headers', async () => {
  const { g } = fakeGovernor();
  let headersSeen = false;
  const r = await runAgentTurn<string>(
    { backend: 'meridian' },
    { ...deps(g), runOnce: async (): Promise<TurnOutcome<string>> => ({ ok: true, value: 'hi', headers: { 'anthropic-ratelimit-requests-limit': '50' } }) },
  );
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, 'hi');
  // headers were fed to the governor
  assert.equal(g.state.limits.rpm, 50);
  headersSeen = g.state.limits.rpm === 50;
  assert.ok(headersSeen);
});

test('runAgentTurn — retries a rate_limited turn (penalizes governor) then succeeds', async () => {
  const { g } = fakeGovernor();
  let calls = 0;
  const r = await runAgentTurn<string>(
    { backend: 'meridian', maxAttempts: 4 },
    {
      ...deps(g),
      runOnce: async (): Promise<TurnOutcome<string>> => {
        calls++;
        if (calls === 1) return { ok: false, raw: { status: 429, headers: { 'retry-after': '5' } } };
        return { ok: true, value: 'ok' };
      },
    },
  );
  assert.equal(r.ok, true);
  assert.equal(calls, 2);
  // the 429 penalized the governor (pausedUntil advanced)
  assert.ok(g.state.pausedUntil > 0);
});

test('runAgentTurn — a non-retryable class (auth) returns the error immediately, no retry', async () => {
  const { g } = fakeGovernor();
  let calls = 0;
  const r = await runAgentTurn<string>(
    { backend: 'meridian', maxAttempts: 5 },
    { ...deps(g), runOnce: async (): Promise<TurnOutcome<string>> => { calls++; return { ok: false, raw: { status: 401 } }; } },
  );
  assert.equal(r.ok, false);
  assert.equal(calls, 1);
  if (!r.ok) assert.equal(r.error.class, 'auth');
});

test('runAgentTurn — usage_limit (plan cap) returns immediately, does NOT retry, parks the fleet (D-001)', async () => {
  const { g } = fakeGovernor();
  const resetAt = Date.parse('2026-06-05T12:00:00Z');
  let calls = 0;
  const r = await runAgentTurn<string>(
    { backend: 'meridian', maxAttempts: 5 },
    {
      ...deps(g),
      runOnce: async (): Promise<TurnOutcome<string>> => {
        calls++;
        return { ok: false, raw: { status: 429, message: 'You exceeded your current quota — insufficient_quota', headers: { 'anthropic-ratelimit-requests-reset': '2026-06-05T12:00:00Z' } } };
      },
    },
  );
  assert.equal(r.ok, false);
  assert.equal(calls, 1); // retrying a plan cap is futile — must not burn attempts
  if (!r.ok) {
    assert.equal(r.error.class, 'usage_limit');
    assert.equal(r.error.surfaceToUser, true);
    assert.equal(r.error.resetAt, resetAt);
  }
  assert.equal(g.state.pausedUntil, resetAt); // fleet parked until reset
});

test('runAgentTurn — exhausts maxAttempts and returns the last classified error', async () => {
  const { g } = fakeGovernor();
  let calls = 0;
  const r = await runAgentTurn<string>(
    { backend: 'claude-code', maxAttempts: 3 },
    { ...deps(g), runOnce: async (): Promise<TurnOutcome<string>> => { calls++; return { ok: false, raw: { exitCode: 1, stderr: '429 rate limit' } }; } },
  );
  assert.equal(r.ok, false);
  assert.equal(calls, 3);
  if (!r.ok) assert.equal(r.error.class, 'rate_limited');
});

test('runAgentTurn — rate_limited with NO retry-after backs off via the governor (no hot-loop)', async () => {
  // The exact subscription-429 case: bare rate_limit_error, no retry-after header. Must NOT
  // burn all attempts instantly — it must penalize the governor with an exponential backoff.
  let clock = 0;
  const sleep = async (ms: number) => { clock += ms; };
  const g = new RateLimitGovernor({ maxConcurrent: 4 }, { now: () => clock, sleep });
  let calls = 0;
  const r = await runAgentTurn<string>(
    { backend: 'meridian', maxAttempts: 4, baseBackoffMs: 1000 },
    {
      governor: g,
      now: () => clock,
      sleep,
      runOnce: async (): Promise<TurnOutcome<string>> => {
        calls++;
        if (calls < 3) return { ok: false, raw: { status: 429 } }; // no retry-after
        return { ok: true, value: 'ok' };
      },
    },
  );
  assert.equal(r.ok, true);
  assert.equal(calls, 3);
  assert.ok(clock >= 1000, `expected real backoff between attempts, clock=${clock}`); // not an instant burn
  assert.ok(g.state.pausedUntil > 0); // governor was paused (shared across callers)
});

test('runAgentTurn — overloaded (529) with no retry-after backs off (not penalize-0 hot-loop)', async () => {
  let clock = 0;
  const sleep = async (ms: number) => { clock += ms; };
  const g = new RateLimitGovernor({ maxConcurrent: 4 }, { now: () => clock, sleep });
  let calls = 0;
  const r = await runAgentTurn<string>(
    { backend: 'meridian', maxAttempts: 3, baseBackoffMs: 1000 },
    { governor: g, now: () => clock, sleep, runOnce: async (): Promise<TurnOutcome<string>> => { calls++; return { ok: false, raw: { status: 529 } }; } },
  );
  assert.equal(r.ok, false);
  assert.equal(calls, 3);
  assert.ok(clock >= 1000, `expected backoff, clock=${clock}`);
});

test('runAgentTurn — bails with a structured error when a far-off governor pause exceeds maxWaitMs (no hang)', async () => {
  // Interactive case: another caller penalized the shared governor for hours; a turn with a
  // small maxWaitMs must NOT freeze — it returns a rate_limited TurnError (with resetAt) so
  // the caller can surface/escalate (D-002).
  let clock = 0;
  const sleep = async (ms: number) => { clock += ms; };
  const g = new RateLimitGovernor({ maxConcurrent: 1 }, { now: () => clock, sleep });
  g.penalize({ retryAfterMs: 5 * 60 * 60 * 1000 });
  let calls = 0;
  const r = await runAgentTurn<string>(
    { backend: 'meridian', maxWaitMs: 2000 },
    { governor: g, now: () => clock, sleep, runOnce: async (): Promise<TurnOutcome<string>> => { calls++; return { ok: true, value: 'x' }; } },
  );
  assert.equal(r.ok, false);
  assert.equal(calls, 0); // bailed at acquire — never ran the backend
  if (!r.ok) {
    assert.equal(r.error.class, 'rate_limited');
    assert.ok(r.error.resetAt && r.error.resetAt > 0);
  }
});

test('runAgentTurn — never throws even if runOnce rejects (treated as transient_io, retried)', async () => {
  const { g } = fakeGovernor();
  let calls = 0;
  const r = await runAgentTurn<string>(
    { backend: 'meridian', maxAttempts: 3 },
    {
      ...deps(g),
      runOnce: async (): Promise<TurnOutcome<string>> => {
        calls++;
        if (calls < 2) throw new Error('ECONNRESET socket hang up');
        return { ok: true, value: 'recovered' };
      },
    },
  );
  assert.equal(r.ok, true);
  assert.equal(calls, 2);
});
