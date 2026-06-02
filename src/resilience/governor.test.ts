/**
 * Tests for the RateLimitGovernor pure decision-core (agent-turn-robustness P-002).
 * Run: npx vitest run libs/papercup-shared/src/agent/governor.test.ts
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  initGovernorState,
  decideAcquire,
  recordAcquire,
  recordRelease,
  recordPenalty,
  recordHeaders,
  RateLimitGovernor,
} from './governor';

const MIN = 60_000;

// --- concurrency cap ---
test('decideAcquire — denies once at maxConcurrent, allows after release', () => {
  const s = initGovernorState({ maxConcurrent: 2 });
  recordAcquire(s, 0, {});
  recordAcquire(s, 0, {});
  assert.equal(decideAcquire(s, 0, {}).allowed, false); // 2 in flight, cap 2
  recordRelease(s);
  assert.equal(decideAcquire(s, 0, {}).allowed, true);
});

// --- RPM window ---
test('decideAcquire — denies when RPM exhausted, waits until window reset', () => {
  const s = initGovernorState({ maxConcurrent: 10, rpm: 2 });
  recordAcquire(s, 1000, {});
  recordAcquire(s, 1000, {});
  const d = decideAcquire(s, 1000, {});
  assert.equal(d.allowed, false);
  assert.ok(d.waitMs > 0 && d.waitMs <= MIN);
  // after the minute window elapses, allowed again
  assert.equal(decideAcquire(s, 1000 + MIN + 1, {}).allowed, true);
});

// --- token budgets (ITPM/OTPM) ---
test('decideAcquire — denies when the estimated tokens would exceed ITPM/OTPM', () => {
  const s = initGovernorState({ maxConcurrent: 10, itpm: 1000, otpm: 500 });
  recordAcquire(s, 0, { inTok: 900, outTok: 100 });
  assert.equal(decideAcquire(s, 0, { inTok: 200 }).allowed, false); // 900+200 > 1000 ITPM
  assert.equal(decideAcquire(s, 0, { inTok: 50, outTok: 450 }).allowed, false); // 100+450 > 500 OTPM
  assert.equal(decideAcquire(s, 0, { inTok: 50, outTok: 50 }).allowed, true);
});

// --- penalty / pause (the 429 path) ---
test('recordPenalty — pauses all acquisition until retry-after / reset', () => {
  const s = initGovernorState({ maxConcurrent: 10 });
  recordPenalty(s, 1000, { retryAfterMs: 30_000 });
  const d = decideAcquire(s, 1000, {});
  assert.equal(d.allowed, false);
  assert.equal(d.waitMs, 30_000);
  assert.equal(decideAcquire(s, 1000 + 30_001, {}).allowed, true);
});
test('recordPenalty — resetAt wins when later than retryAfter; never shrinks an existing pause', () => {
  const s = initGovernorState({ maxConcurrent: 10 });
  recordPenalty(s, 0, { resetAt: 50_000 });
  recordPenalty(s, 0, { retryAfterMs: 1000 }); // shorter — must NOT shrink the pause
  assert.equal(decideAcquire(s, 0, {}).waitMs, 50_000);
});

// --- header-driven sync ---
test('recordHeaders — adopts the server RPM limit + pauses when remaining hits 0', () => {
  const s = initGovernorState({ maxConcurrent: 10 });
  recordHeaders(s, { 'anthropic-ratelimit-requests-limit': '50' }, 0);
  assert.equal(s.limits.rpm, 50);
  recordHeaders(s, { 'anthropic-ratelimit-output-tokens-remaining': '0', 'anthropic-ratelimit-output-tokens-reset': '2026-06-02T00:00:30Z' }, Date.parse('2026-06-02T00:00:00Z'));
  // remaining 0 → paused until the reset (30s later)
  assert.equal(decideAcquire(s, Date.parse('2026-06-02T00:00:00Z'), {}).allowed, false);
});

// --- coarse mode: only concurrency applies when no rate limits known ---
test('decideAcquire — coarse mode (no rpm/itpm/otpm) gates on concurrency only', () => {
  const s = initGovernorState({ maxConcurrent: 1 });
  assert.equal(decideAcquire(s, 0, { inTok: 1e9, outTok: 1e9 }).allowed, true); // no token limits → allowed
  recordAcquire(s, 0, {});
  assert.equal(decideAcquire(s, 0, {}).allowed, false); // concurrency 1 reached
});

// --- async wrapper ---
test('RateLimitGovernor.acquire — serializes under maxConcurrent:1 with a fake clock', async () => {
  let clock = 0;
  const g = new RateLimitGovernor({ maxConcurrent: 1 }, { now: () => clock, sleep: async (ms) => { clock += ms; } });
  const release1 = await g.acquire({});
  if (!release1) throw new Error('expected a permit');
  let secondAcquired = false;
  const p = g.acquire({}).then((r) => { secondAcquired = true; return r; });
  // give the microtask queue a tick; the 2nd acquire must still be blocked
  await Promise.resolve();
  assert.equal(secondAcquired, false);
  release1();
  const release2 = await p;
  assert.equal(secondAcquired, true);
  if (release2) release2();
});

// --- abortable / bounded acquire (reviewer #3 / D-002): an interactive caller bails
//     instead of inheriting a far-off shared pause. ---
test('RateLimitGovernor.acquire — returns null when the wait would exceed maxWaitMs', async () => {
  let clock = 0;
  const g = new RateLimitGovernor({ maxConcurrent: 1 }, { now: () => clock, sleep: async (ms) => { clock += ms; } });
  const held = await g.acquire({}); // take the only permit
  assert.ok(held);
  // a far-off pause (e.g. a 5-hour-limit penalty) — the 2nd caller must NOT freeze for hours
  g.penalize({ retryAfterMs: 5 * 60 * 60 * 1000 });
  const r = await g.acquire({}, { maxWaitMs: 1000 });
  assert.equal(r, null);
});
test('RateLimitGovernor.acquire — returns null when the abort signal is already aborted', async () => {
  const g = new RateLimitGovernor({ maxConcurrent: 1 }, { now: () => 0, sleep: async () => {} });
  await g.acquire({}); // exhaust concurrency so the next would wait
  const ac = new AbortController();
  ac.abort();
  const r = await g.acquire({}, { signal: ac.signal });
  assert.equal(r, null);
});

// --- RB-010: the "does pacing work" SLO — peak in-flight never exceeds maxConcurrent
//     under many concurrent callers contending for permits (the burst lever). ---
test('RateLimitGovernor.acquire — caps PEAK concurrency under many concurrent callers', async () => {
  const g = new RateLimitGovernor({ maxConcurrent: 3 }); // real now/sleep
  let active = 0;
  let peak = 0;
  let completed = 0;
  const work = async () => {
    const release = await g.acquire({});
    assert.ok(release);
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5)); // hold the permit briefly
    active--;
    completed++;
    release!();
  };
  await Promise.all(Array.from({ length: 9 }, () => work()));
  assert.equal(completed, 9); // every caller got through (none starved)
  assert.ok(peak <= 3, `peak in-flight ${peak} exceeded cap 3`);
  assert.ok(peak >= 2, `expected real contention (peak ${peak})`); // sanity: parallelism happened
  assert.equal(active, 0); // all permits released
});
