/**
 * Tests for runAgentTurn — the governed, retrying turn wrapper (robustness P-003).
 * Run: npx vitest run libs/papercup-shared/src/agent/turn-runner.test.ts
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { RateLimitGovernor } from './governor';
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
