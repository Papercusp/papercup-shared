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
  type GovernorState,
  type GovernorLimits,
  type GlobalConcurrencyGate,
} from './governor';

const MIN = 60_000;

/** A tiny in-memory fleet-wide gate for the D-004 tests. */
function fakeGate(cap: number): GlobalConcurrencyGate {
  let inFlight = 0;
  return {
    tryAcquire() {
      if (inFlight >= cap) return false;
      inFlight += 1;
      return true;
    },
    release() {
      inFlight = Math.max(0, inFlight - 1);
    },
  };
}

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

// --- slow as remaining drops (review #7/#8): pre-emptive pacing, not all-or-nothing ---
test('recordHeaders — sets a pace gap when remaining is low; decideAcquire holds the gap', () => {
  const base = Date.parse('2026-06-02T00:00:00Z');
  const s = initGovernorState({ maxConcurrent: 10 });
  // limit 100 req, only 5 remaining (5% < 20% watermark), resets in 10s → spread 10s/5 = 2s gap
  recordHeaders(
    s,
    {
      'anthropic-ratelimit-requests-limit': '100',
      'anthropic-ratelimit-requests-remaining': '5',
      'anthropic-ratelimit-requests-reset': '2026-06-02T00:00:10Z',
    },
    base,
  );
  assert.equal(s.paceDelayMs, 2_000);
  // first acquire is allowed; it stamps lastAcquireAt
  assert.equal(decideAcquire(s, base, {}).allowed, true);
  recordAcquire(s, base, {});
  // a follow-up 1s later is held by the 2s pace gap
  const d = decideAcquire(s, base + 1_000, {});
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'pace');
  assert.equal(d.waitMs, 1_000);
  // once the gap elapses, allowed again
  assert.equal(decideAcquire(s, base + 2_000, {}).allowed, true);
});

test('recordHeaders — healthy remaining decays the pace gap back to 0 (no needless throttle)', () => {
  const base = Date.parse('2026-06-02T00:00:00Z');
  const s = initGovernorState({ maxConcurrent: 10 });
  recordHeaders(s, { 'anthropic-ratelimit-requests-limit': '100', 'anthropic-ratelimit-requests-remaining': '2', 'anthropic-ratelimit-requests-reset': '2026-06-02T00:00:10Z' }, base);
  assert.ok(s.paceDelayMs > 0);
  // next response shows headroom recovered (80 remaining = 80% > watermark) → no pacing
  recordHeaders(s, { 'anthropic-ratelimit-requests-limit': '100', 'anthropic-ratelimit-requests-remaining': '80', 'anthropic-ratelimit-requests-reset': '2026-06-02T00:01:00Z' }, base);
  assert.equal(s.paceDelayMs, 0);
});

test('recordHeaders — the pace gap is capped (soft pacing never becomes a long pause)', () => {
  const base = Date.parse('2026-06-02T00:00:00Z');
  const s = initGovernorState({ maxConcurrent: 10 });
  // 1 remaining, resets in 1 hour → raw spread 3.6e6ms, but capped at MAX_PACE_DELAY_MS (5s)
  recordHeaders(s, { 'anthropic-ratelimit-requests-limit': '100', 'anthropic-ratelimit-requests-remaining': '1', 'anthropic-ratelimit-requests-reset': '2026-06-02T01:00:00Z' }, base);
  assert.equal(s.paceDelayMs, 5_000);
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

// --- D-004: fleet-wide global concurrency gate (the user's live maxSimultaneousAgents) ---
test('RateLimitGovernor.acquire — globalGate caps total in-flight BELOW the bucket maxConcurrent', async () => {
  let clock = 0;
  const gate = fakeGate(2);
  const g = new RateLimitGovernor({ maxConcurrent: 10 }, { now: () => clock, sleep: async (ms) => { clock += ms; }, globalGate: gate });
  const r1 = await g.acquire({});
  const r2 = await g.acquire({});
  assert.ok(r1 && r2);
  let third = false;
  const p = g.acquire({}).then((r) => { third = true; return r; });
  await Promise.resolve();
  assert.equal(third, false); // fleet cap (2) reached even though the bucket allows 10
  r1!();
  const r3 = await p;
  assert.equal(third, true); // a release frees a fleet slot
  if (r3) r3();
});
test('RateLimitGovernor.acquire — two buckets SHARE one globalGate → cross-bucket fleet cap', async () => {
  let clock = 0;
  const gate = fakeGate(2);
  const mk = () => new RateLimitGovernor({ maxConcurrent: 10 }, { now: () => clock, sleep: async (ms) => { clock += ms; }, globalGate: gate });
  const a = mk();
  const b = mk();
  const r1 = await a.acquire({}); // bucket A
  const r2 = await b.acquire({}); // bucket B → 2 total across buckets
  assert.ok(r1 && r2);
  let third = false;
  const p = a.acquire({}).then((r) => { third = true; return r; });
  await Promise.resolve();
  assert.equal(third, false); // the fleet total (2) is reached regardless of which bucket
  r2!(); // releasing in bucket B frees a global slot for bucket A
  const r3 = await p;
  assert.equal(third, true);
  if (r3) r3();
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

// --- onPause observability (RB-009) ---
test('RateLimitGovernor — onPause fires only when a pause is newly set or extended', () => {
  const evs: Array<{ pausedUntil: number; source: string }> = [];
  let clock = 1000;
  const g = new RateLimitGovernor({ maxConcurrent: 5 }, { now: () => clock, onPause: (e) => evs.push(e) });
  g.penalize({ retryAfterMs: 30_000 }); // set → fires (pausedUntil 31_000)
  g.penalize({ retryAfterMs: 1_000 }); // shorter → no extend → no fire
  g.penalize({ retryAfterMs: 60_000 }); // extends → fires
  assert.equal(evs.length, 2);
  assert.equal(evs[0].source, 'penalty');
  assert.equal(evs[0].pausedUntil, 31_000);
  assert.equal(evs[1].pausedUntil, 61_000);
});

test('RateLimitGovernor — onPause fires on a header-driven exhaustion (remaining 0 + reset)', () => {
  const evs: Array<{ source: string }> = [];
  const base = Date.parse('2026-06-02T00:00:00Z');
  const g = new RateLimitGovernor({ maxConcurrent: 5 }, { now: () => base, onPause: (e) => evs.push(e) });
  g.recordResponse({ 'anthropic-ratelimit-output-tokens-remaining': '0', 'anthropic-ratelimit-output-tokens-reset': '2026-06-02T00:00:30Z' });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].source, 'headers');
});

// --- RB-007: cross-process store seam — two governors sharing ONE budget row -------------

/** A trivial in-process GovernorStore that mimics PG: one shared state per key, mutated under a
    (synchronous, single-threaded) transact — proves the seam wires correctly. */
function makeMemStore() {
  const rows = new Map<string, GovernorState>();
  return {
    rows,
    async transact(key: string, floor: GovernorLimits, mutate: (s: GovernorState) => void): Promise<GovernorState> {
      let s = rows.get(key);
      if (!s) { s = initGovernorState(floor); rows.set(key, s); }
      mutate(s);
      return { ...s, limits: { ...s.limits } };
    },
  };
}

test('RateLimitGovernor[store] — a 429 penalty on ONE governor pauses the OTHER (shared budget)', async () => {
  let clock = 1000;
  const store = makeMemStore();
  const deps = { now: () => clock, sleep: async (ms: number) => { clock += ms; }, store, storeKey: 'anthropic:opus' };
  const a = new RateLimitGovernor({ maxConcurrent: 5 }, deps);
  const b = new RateLimitGovernor({ maxConcurrent: 5 }, deps);
  // A hits a 429 → penalizes the SHARED row.
  a.penalize({ retryAfterMs: 30_000 });
  await Promise.resolve(); // let the fire-and-forget store write settle
  // B must now see the pause via the shared store: its acquire bails under a tight maxWait.
  const r = await b.acquire({}, { maxWaitMs: 1000 });
  assert.equal(r, null, 'B should inherit the shared pause set by A');
  // past the reset, B proceeds again
  clock += 30_001;
  const r2 = await b.acquire({}, { maxWaitMs: 1000 });
  assert.ok(r2);
  r2!();
});

test('RateLimitGovernor[store] — the shared RPM window is enforced across both governors', async () => {
  let clock = 0;
  const store = makeMemStore();
  const deps = { now: () => clock, sleep: async (ms: number) => { clock += ms; }, store, storeKey: 'anthropic:sonnet' };
  const a = new RateLimitGovernor({ maxConcurrent: 5, rpm: 2 }, deps);
  const b = new RateLimitGovernor({ maxConcurrent: 5, rpm: 2 }, deps);
  // Two requests (one each) fill the shared rpm=2 window…
  (await a.acquire({}))!();
  (await b.acquire({}))!();
  assert.equal(store.rows.get('anthropic:sonnet')!.reqInWindow, 2); // shared counter, not per-process
  // …so the 3rd (from A) must wait for the window reset, not slip through on A's own fresh count.
  const start = clock;
  (await a.acquire({}))!();
  assert.ok(clock - start >= MIN - 1, `expected to wait ~a window, waited ${clock - start}ms`);
});

test('RateLimitGovernor.snapshot — returns an independent copy of the state', () => {
  const g = new RateLimitGovernor({ maxConcurrent: 2, rpm: 10 }, { now: () => 0 });
  g.penalize({ retryAfterMs: 5_000 });
  const snap = g.snapshot();
  assert.equal(snap.pausedUntil, 5_000);
  assert.equal(snap.limits.rpm, 10);
  snap.limits.rpm = 999; // mutating the copy must not affect the live state
  assert.equal(g.state.limits.rpm, 10);
});
