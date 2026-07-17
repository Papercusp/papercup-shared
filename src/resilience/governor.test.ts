/**
 * Tests for the RateLimitGovernor pure decision-core (agent-turn-robustness P-002).
 * Run: npx vitest run libs/papercusp-shared/src/agent/governor.test.ts
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  initGovernorState,
  decideAcquire,
  decideRate,
  recordAcquire,
  recordRate,
  recordRelease,
  recordPenalty,
  recordHeaders,
  effectiveRpmFactor,
  effectiveRpm,
  effectivePaceMs,
  RateLimitGovernor,
  ROLLING_WINDOW_REPROBE_MS,
  ROLLING_WINDOW_REPROBE_MAX_MS,
  type GovernorState,
  type GovernorLimits,
  type GlobalConcurrencyGate,
  type GovernorPauseEvent,
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
test('recordPenalty — maxPauseMs caps a far-future rolling-window reset to a bounded re-probe (D-003)', () => {
  const s = initGovernorState({ maxConcurrent: 10 });
  // A Claude Max usage cap reports a reset hours out, but the rolling window recovers continuously —
  // maxPauseMs bounds the pause so the bucket re-probes instead of sitting stale for hours.
  recordPenalty(s, 1000, { resetAt: 1000 + 5 * 60 * 60_000, maxPauseMs: ROLLING_WINDOW_REPROBE_MS });
  assert.equal(s.pausedUntil, 1000 + ROLLING_WINDOW_REPROBE_MS, 'capped to the re-probe interval');
  // Without maxPauseMs the precise (short) reset is still honored fully.
  const s2 = initGovernorState({ maxConcurrent: 10 });
  recordPenalty(s2, 0, { retryAfterMs: 30_000 });
  assert.equal(s2.pausedUntil, 30_000);
});

test('SOFT (predictive) pause is serviceable — acquire({allowSoftPaused}) admits it; a HARD rejected pause never is (2026-06-21)', async () => {
  const clock = 2_000_000;
  const resetSec = Math.round((clock + 5 * 60 * 60_000) / 1000);
  // SOFT: util 0.97 but the window is still ALLOWED → predictive pause, yet Anthropic would serve it.
  const g = new RateLimitGovernor({ maxConcurrent: 5 }, { now: () => clock });
  g.recordResponse({
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.97',
    'anthropic-ratelimit-unified-5h-reset': String(resetSec),
  });
  assert.ok(g.state.pausedUntil > clock, 'predictively paused (routes around it when a healthier account exists)');
  assert.equal(g.softPaused(clock), true, 'allowed-but-paused = SOFT / serviceable');
  assert.equal(await g.acquire({}, { maxWaitMs: 0 }), null, 'a normal acquire is blocked by the pause');
  const rel = await g.acquire({}, { maxWaitMs: 0, allowSoftPaused: true });
  assert.ok(rel, 'allowSoftPaused ADMITS the serviceable soft-paused account (serve residual, do not shed)');
  rel?.();

  // HARD: status rejected → genuinely down → allowSoftPaused must NOT admit it.
  const g2 = new RateLimitGovernor({ maxConcurrent: 5 }, { now: () => clock });
  g2.recordResponse({
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-utilization': '1.01',
    'anthropic-ratelimit-unified-5h-reset': String(resetSec),
  });
  assert.ok(g2.state.pausedUntil > clock, 'hard-paused');
  assert.equal(g2.softPaused(clock), false, 'rejected = HARD, not serviceable');
  assert.equal(await g2.acquire({}, { maxWaitMs: 0, allowSoftPaused: true }), null, 'allowSoftPaused does NOT admit a hard-rejected account');

  // EDGE: util EXACTLY 1.0 but status STILL allowed (rejected:false) → Anthropic would still serve it, so it
  // is SERVICEABLE (trust `rejected`, not the fraction). The old `util < 1` guard shed this (owner 2026-06-21).
  const g3 = new RateLimitGovernor({ maxConcurrent: 5 }, { now: () => clock });
  g3.recordResponse({
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-unified-7d-utilization': '1',
    'anthropic-ratelimit-unified-7d-reset': String(resetSec),
  });
  assert.ok(g3.state.pausedUntil > clock, 'predictively paused at the cap');
  assert.equal(g3.softPaused(clock), true, 'util 1.0 but allowed = SERVICEABLE (rejected is authoritative, not the fraction)');
  assert.ok(await g3.acquire({}, { maxWaitMs: 0, allowSoftPaused: true }), 'allowSoftPaused serves the at-cap-but-allowed account instead of shedding');
});

test('liftTransportPause — clears an egress-circuit transport pause on proxy recovery, but NEVER a longer real 429 pause (2026-06-21)', () => {
  const clock = 1_000_000;
  // Case 1: the egress circuit set a transport pause; the proxy recovers → lift it exactly → account readmits NOW.
  const g = new RateLimitGovernor({ maxConcurrent: 5 }, { now: () => clock });
  g.penalize({ resetAt: clock + 10_000 }); // transport pause (10s, under the fleet re-probe cap)
  assert.equal(g.state.pausedUntil, clock + 10_000, 'transport pause set');
  g.liftTransportPause(clock + 10_000);
  assert.equal(g.state.pausedUntil, clock, 'transport pause lifted on recovery → readmit immediately');

  // Case 2: a LONGER real 429 pause was set AFTER the transport one → transport recovery must NOT shorten it.
  const g2 = new RateLimitGovernor({ maxConcurrent: 5 }, { now: () => clock });
  g2.penalize({ resetAt: clock + 10_000 }); // transport pause (10s)
  g2.penalize({ resetAt: clock + 100_000 }); // a later, longer real 429 (100s, under the 2-min fleet cap → kept)
  const after429 = g2.state.pausedUntil;
  assert.equal(after429, clock + 100_000, 'the longer 429 pause is the binding one');
  g2.liftTransportPause(clock + 10_000); // try to lift the OLD (shorter) transport pause
  assert.equal(g2.state.pausedUntil, after429, 'a longer real 429 pause set since is NOT shortened by transport recovery');

  // Case 3: already expired → no-op (never pushes the pause backwards / negative).
  const g3 = new RateLimitGovernor({ maxConcurrent: 5 }, { now: () => clock });
  g3.liftTransportPause(clock + 10_000);
  assert.ok(g3.state.pausedUntil <= clock, 'no pause to lift → no-op');
});

test('USAGE-CAP re-probe cap (2026-06-23 aviynw 12h over-park fix): an account-keyed usage-cap 429 PARKS for the SLOW re-probe (30min), not the full multi-hour reset', () => {
  const clock = 1_000_000;
  const FAR = clock + 12 * 60 * 60_000; // a 12h reset (the aviynw over-park)
  // Account-keyed governor (storeKey carries '@<accountId>') = ONE account's bucket. A USAGE-CAP 429 (NOT
  // rateLimited) used to park it UNCAPPED to the full reset → stranded a since-recovered account up to 12h.
  // Now bounded to the SLOW re-probe (ROLLING_WINDOW_REPROBE_MAX_MS) so it re-probes + rejoins within ~30min.
  const usageCap = new RateLimitGovernor({ maxConcurrent: 5 }, { now: () => clock, storeKey: 'anthropic:opus@aviynw' });
  usageCap.penalize({ resetAt: FAR });
  assert.equal(
    usageCap.state.pausedUntil,
    clock + ROLLING_WINDOW_REPROBE_MAX_MS,
    'account-keyed usage-cap park bounded to the 30min slow re-probe, not the 12h reset',
  );
  // A TRANSIENT rate-429 on the same account still caps to the FAST re-probe (2min) — unchanged.
  const rate = new RateLimitGovernor({ maxConcurrent: 5 }, { now: () => clock, storeKey: 'anthropic:opus@aviynw' });
  rate.penalize({ resetAt: FAR, rateLimited: true });
  assert.equal(rate.state.pausedUntil, clock + ROLLING_WINDOW_REPROBE_MS, 'a transient rate-429 still re-probes fast (2min)');
  // A genuine cap simply re-penalizes on the re-probe (it 429s again) — penaltyCount still accrues, so the
  // sustained-exhaustion scale-out signal the account-pool observer keys on is preserved.
  usageCap.penalize({ resetAt: FAR });
  assert.equal(usageCap.state.pausedUntil, clock + ROLLING_WINDOW_REPROBE_MAX_MS, 're-penalize re-parks to the bounded re-probe');
});

test('ADAPTIVE rpm — a RATE 429 multiplicatively decreases the learned factor; usage-cap + transport do NOT (2026-06-22)', () => {
  let clock = 1_000_000;
  const mk = () => new RateLimitGovernor({ maxConcurrent: 100, rpm: 40 }, { now: () => clock });
  // A rate-429 halves the factor (1 → 0.5 → 0.25), floored at the min (default 0.1).
  const g = mk();
  g.penalize({ retryAfterMs: 1, rateLimited: true });
  assert.equal(g.state.rpmFactor, 0.5, 'first rate-429 halves the factor');
  g.penalize({ retryAfterMs: 1, rateLimited: true });
  assert.equal(g.state.rpmFactor, 0.25, 'repeated rate-429s keep halving (learning the real rate down)');
  for (let i = 0; i < 12; i++) g.penalize({ retryAfterMs: 1, rateLimited: true });
  assert.ok(Math.abs((g.state.rpmFactor ?? 0) - 0.1) < 1e-9, 'floored at the min factor (never fully stalls)');
  // A usage-cap 429 (no rateLimited) is a token-budget dimension → must NOT touch the rpm factor.
  const g2 = mk();
  g2.penalize({ resetAt: clock + 5 * 3600_000 });
  assert.equal(g2.state.rpmFactor, undefined, 'a 5h/7d usage cap does not adapt rpm');
  // A transport stall (proxy fault) never adapts rpm — even if rateLimited is also set.
  const g3 = mk();
  g3.penalize({ retryAfterMs: 1, transport: true, rateLimited: true });
  assert.equal(g3.state.rpmFactor, undefined, 'a transport stall never adapts rpm');
});

test('ADAPTIVE rpm cross-process (C1, 2026-06-23): a rate-429 writes the decreased rpmFactor onto the SHARED store row, so the gate survives the PG round-trip', async () => {
  const clock = 1_000_000;
  // A fake store holding ONE shared state + running the mutate against it (mirrors PgGovernorStore.transact).
  const shared = initGovernorState({ maxConcurrent: 100, rpm: 40 });
  const store = {
    async transact(_k: string, _f: GovernorLimits, mutate: (s: GovernorState) => void) {
      mutate(shared);
      return shared;
    },
  };
  const g = new RateLimitGovernor({ maxConcurrent: 100, rpm: 40 }, { now: () => clock, store, storeKey: 'anthropic:sonnet@aviynw' });
  g.penalize({ retryAfterMs: 1, rateLimited: true });
  await Promise.resolve(); // flush the fire-and-forget store.transact
  // BEFORE C1 the rpmFactor decrease hit ONLY this.state, never the store row → a PEER process reloading the
  // row saw factor 1 and re-walked into the same 429 (adaptive-RPM dead in PG mode). Now the SHARED row carries
  // the learned factor + its anchor, so decideRate paces at the learned rate across processes.
  assert.equal(shared.rpmFactor, 0.5, 'the shared store row carries the decreased rpmFactor');
  assert.equal(shared.rpmFactorAt, clock, 'and its decrease anchor (the pair moves together)');
  // A usage-cap penalize must NOT touch the shared rpm factor (a token-budget dimension, not a rate signal).
  const shared2 = initGovernorState({ maxConcurrent: 100, rpm: 40 });
  const store2 = {
    async transact(_k: string, _f: GovernorLimits, m: (s: GovernorState) => void) {
      m(shared2);
      return shared2;
    },
  };
  const g2 = new RateLimitGovernor({ maxConcurrent: 100, rpm: 40 }, { now: () => clock, store: store2, storeKey: 'anthropic:sonnet@aviynw' });
  g2.penalize({ resetAt: clock + 5 * 3600_000 });
  await Promise.resolve();
  assert.equal(shared2.rpmFactor, undefined, 'a usage cap does not adapt the shared rpm factor');
});

test('ADAPTIVE rpm — decideRate paces to floor×factor (a learned-down account is held under its real rate, 2026-06-22)', () => {
  const now = 1_000_000;
  const s = initGovernorState({ maxConcurrent: 100, rpm: 40 });
  for (let i = 0; i < 20; i++) recordRate(s, now); // 20 requests this 60s window
  assert.equal(decideRate(s, now).allowed, true, 'at the full floor (40rpm) 20 requests leave headroom');
  // Learn the factor down to 0.5 → effective 20rpm → the same 20 requests are now AT the learned cap.
  s.rpmFactor = 0.5;
  s.rpmFactorAt = now;
  const d = decideRate(s, now);
  assert.equal(d.allowed, false, 'at factor 0.5 the same load hits the learned 20rpm cap');
  assert.equal(d.reason, 'rpm', 'and it is the rpm gate that holds it (paced, not failed)');
});

test('ADAPTIVE rpm — the factor recovers linearly toward 1 (a transient throttle does not permanently cap, 2026-06-22)', () => {
  const s = initGovernorState({ maxConcurrent: 100, rpm: 40 });
  s.rpmFactor = 0.1;
  s.rpmFactorAt = 0;
  assert.equal(effectiveRpmFactor(s, 0), 0.1, 'starts at the decreased factor');
  // Recovers +1.0 per RPM_AIMD_RECOVER_MS (default 300_000ms): +150_000ms → 0.1 + 0.5 = 0.6.
  assert.ok(Math.abs(effectiveRpmFactor(s, 150_000) - 0.6) < 1e-9, 'recovers linearly with elapsed time');
  assert.equal(effectiveRpmFactor(s, 300_000), 1, 'fully recovered to the floor after the recovery window');
  assert.equal(effectiveRpmFactor(initGovernorState({ maxConcurrent: 1 }), 999), 1, 'undefined factor reads as 1 (legacy)');
});

test('SMOOTHING (smoothRpm) — spaces the per-minute allowance so it cannot fire as a sub-minute BURST (bare-burst 429 fix, 2026-06-23)', () => {
  const now = 1_000_000;
  // Legacy (smoothRpm undefined): a subscription account has paceDelayMs=0, so a second request can fire
  // back-to-back with the first — the whole rpm allowance bursts at window start (what trips Anthropic's
  // sub-minute burst limit → the x-should-retry:true bare-burst 429 storm).
  const burst = initGovernorState({ maxConcurrent: 100, rpm: 60 }); // 60rpm → 1000ms/req when smoothed
  recordRate(burst, now); // one request just went out (lastAcquireAt = now)
  assert.equal(decideRate(burst, now + 1).allowed, true, 'legacy: a back-to-back request is allowed — bursts freely');

  // With smoothRpm: the same allowance is SPREAD to WINDOW_MS/effRpm spacing — a back-to-back request is paced.
  const smooth = initGovernorState({ maxConcurrent: 100, rpm: 60 });
  smooth.smoothRpm = true;
  recordRate(smooth, now);
  const d = decideRate(smooth, now + 1);
  assert.equal(d.allowed, false, 'smoothRpm: a back-to-back request is PACED, not bursted');
  assert.equal(d.reason, 'pace', 'held by the pace gate (not the count cap)');
  assert.ok(d.waitMs >= 900 && d.waitMs <= 1000, `paced ~WINDOW/effRpm = 1000ms apart (got ${d.waitMs})`);
  // THROUGHPUT-NEUTRAL: once the pace gap elapses the request proceeds — the allowance is spread, not reduced.
  assert.equal(decideRate(smooth, now + 1000).allowed, true, 'after the pace gap the request proceeds — same per-minute throughput, just evenly spaced');
  // The learned rpmFactor tightens the spacing too: factor 0.5 → effective 30rpm → 2000ms spacing.
  smooth.rpmFactor = 0.5;
  smooth.rpmFactorAt = now;
  recordRate(smooth, now + 1000);
  const d2 = decideRate(smooth, now + 1001);
  assert.ok(d2.waitMs >= 1900 && d2.waitMs <= 2000, `a learned-down account paces wider (~2000ms; got ${d2.waitMs})`);
});

// P-005 — effectiveRpm + effectivePaceMs are the SINGLE SOURCE OF TRUTH the rate gate enforces AND
// /stats surfaces, so "is smoothing actually working" is data, not inference.
test('effectiveRpm — floor(rpm × time-decayed factor); null when no rpm floor', () => {
  const now = 1_000_000;
  assert.equal(effectiveRpm(initGovernorState({ maxConcurrent: 10, rpm: 60 }), now), 60, 'at the full floor');
  assert.equal(effectiveRpm(initGovernorState({ maxConcurrent: 10 }), now), null, 'no rpm floor → null');
  const learned = initGovernorState({ maxConcurrent: 10, rpm: 60 });
  learned.rpmFactor = 0.5;
  learned.rpmFactorAt = now;
  assert.equal(effectiveRpm(learned, now), 30, 'a learned-down account → floor×factor (60×0.5)');
});

test('effectivePaceMs — 0 when not smoothing; WINDOW/effRpm once smoothRpm is engaged; matches the gate', () => {
  const now = 1_000_000;
  const off = initGovernorState({ maxConcurrent: 100, rpm: 60 });
  assert.equal(effectivePaceMs(off, now), 0, 'no smoothing, no header pace → 0 (free burst)');
  const on = initGovernorState({ maxConcurrent: 100, rpm: 60 });
  on.smoothRpm = true;
  assert.equal(effectivePaceMs(on, now), 1000, '60rpm smoothed → 1000ms between requests');
  on.rpmFactor = 0.5;
  on.rpmFactorAt = now;
  assert.equal(effectivePaceMs(on, now), 2000, 'learned-down to 30rpm → 2000ms — 429-learning tightens the pace');
  // The helper IS what decideRate gates on: after a request, a back-to-back call is held by exactly this pace.
  recordRate(on, now);
  assert.equal(decideRate(on, now + 1).waitMs, 2000 - 1, 'the gate enforces the same effectivePaceMs value');
  // A non-smoothing header pace is honored unchanged (the floor only RAISES, never lowers, the pace).
  const hdr = initGovernorState({ maxConcurrent: 100, rpm: 60 });
  hdr.paceDelayMs = 250;
  assert.equal(effectivePaceMs(hdr, now), 250, 'header pace passes through when smoothing is off');
});

test('penalize({transport:true}) — tags the pause source "transport" and does NOT shrink fleet AIMD (a flaky proxy ≠ rate pressure, 2026-06-22)', () => {
  let clock = 1_000_000;
  const sources: GovernorPauseEvent['source'][] = [];
  let notePenaltyCalls = 0;
  const gate: GlobalConcurrencyGate = {
    tryAcquire: () => true,
    release: () => {},
    noteClean: () => {},
    notePenalty: () => {
      notePenaltyCalls += 1;
    },
  };
  const g = new RateLimitGovernor(
    { maxConcurrent: 10 },
    { now: () => clock, globalGate: gate, onPause: (ev) => sources.push(ev.source) },
  );
  // A REAL rate penalty: source 'penalty' + the AIMD multiplicative-decrease fires.
  g.penalize({ retryAfterMs: 30_000 });
  assert.deepEqual(sources, ['penalty']);
  assert.equal(notePenaltyCalls, 1, 'a real 429 shrinks fleet concurrency');
  // A TRANSPORT penalty that EXTENDS the pause (60s > 30s) → onPause fires with source 'transport',
  // but the fleet AIMD must NOT shrink (one account's bad egress proxy is not provider rate pressure).
  g.penalize({ retryAfterMs: 60_000, transport: true });
  assert.deepEqual(sources, ['penalty', 'transport'], 'the transport pause is tagged source:transport');
  assert.equal(notePenaltyCalls, 1, 'a transport pause does NOT trigger the AIMD penalty');
  assert.equal(g.state.pausedUntil, clock + 60_000, 'the pause is still SET (so the gateway routes around the proxy)');
});

test('RateLimitGovernor.penalize — UNCONDITIONALLY caps a far-future reset to the re-probe window (fleet-wide false-pause fix, 2026-06-17)', () => {
  const clock = 1_000_000;
  // FRESH process (no unified header seen yet — state.unified undefined): this is the edge that made the
  // false-pause RECUR under a narrower s.unified-gated fix. A transient 429 carrying the 7d reset boundary
  // (~16h out) must STILL be capped to the re-probe interval, not pin the bucket for 16h.
  const g = new RateLimitGovernor({ maxConcurrent: 5 }, { now: () => clock });
  assert.equal(g.state.unified, undefined, 'fresh process: no unified dialect recorded yet');
  g.penalize({ retryAfterMs: 16 * 60 * 60_000, resetAt: clock + 16 * 60 * 60_000 });
  assert.equal(g.state.pausedUntil, clock + ROLLING_WINDOW_REPROBE_MS, 'far-future reset capped to the re-probe interval even with no unified header');

  // A SHORT (per-minute / API-key) reset is still honored fully — it is below the re-probe window, so the
  // cap never bites and the precise reset wins.
  const g2 = new RateLimitGovernor({ maxConcurrent: 5 }, { now: () => clock });
  g2.penalize({ retryAfterMs: 30_000 });
  assert.equal(g2.state.pausedUntil, clock + 30_000, 'short per-minute reset honored fully (under the cap)');

  // A caller's own TIGHTER cap still wins over the default re-probe ceiling.
  const g3 = new RateLimitGovernor({ maxConcurrent: 5 }, { now: () => clock });
  g3.penalize({ resetAt: clock + 16 * 60 * 60_000, maxPauseMs: 10_000 });
  assert.equal(g3.state.pausedUntil, clock + 10_000, 'tighter caller maxPauseMs wins');

  // ACCOUNT-KEYED bucket (storeKey carries '@<account>') is NOT capped — a sustained per-account 429
  // pattern is the scale-out exhaustion signal (account-pool-store P-019/P-021), and a per-account pause
  // only gates that account (failover routes around it). The cap is fleet-wide-bucket-only.
  const gAcct = new RateLimitGovernor({ maxConcurrent: 5 }, { now: () => clock, storeKey: 'anthropic:opus@acct-1' });
  gAcct.penalize({ retryAfterMs: 15 * 60_000, resetAt: clock + 15 * 60_000 });
  assert.equal(gAcct.state.pausedUntil, clock + 15 * 60_000, 'account-keyed pause left intact (scale-out signal), NOT capped');

  // 2026-06-22 over-park fix: a TRANSIENT rate-429 (rateLimited, x-should-retry:true = "retry, capacity exists")
  // on an account-keyed bucket IS capped to the re-probe window — it must NOT park the account on a far-future
  // reset it carried (the aviynw 7h over-park while its live 429 was x-should-retry:true).
  const gTransient = new RateLimitGovernor({ maxConcurrent: 5 }, { now: () => clock, storeKey: 'anthropic:opus@acct-2' });
  gTransient.penalize({ resetAt: clock + 7 * 3600_000, rateLimited: true });
  assert.equal(gTransient.state.pausedUntil, clock + ROLLING_WINDOW_REPROBE_MS, 'a transient account-keyed rate-429 is bounded to the re-probe window, NOT parked 7h');
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
test('RateLimitGovernor.acquire — bounded denial carries a typed admission reason', async () => {
  const g = new RateLimitGovernor({ maxConcurrent: 1 });
  const held = await g.acquire({});
  let denial: import('./governor').AdmissionDenial | undefined;
  const r = await g.acquire({}, { maxWaitMs: 0, onDenied: (d) => (denial = d) });
  assert.equal(r, null);
  assert.deepEqual(denial, { reason: 'no-free-slot', freeSlots: 0 });
  held!();
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

test('RateLimitGovernor[store] — local smoothRpm is enforced inside the shared-row decision', async () => {
  let clock = 1_000;
  const store = makeMemStore();
  const deps = { now: () => clock, sleep: async (ms: number) => { clock += ms; }, store, storeKey: 'anthropic:opus@acct' };
  const g = new RateLimitGovernor({ maxConcurrent: 5, rpm: 60 }, deps);
  g.state.smoothRpm = true;

  (await g.acquire({}))!();
  const start = clock;
  (await g.acquire({}))!();

  assert.ok(clock - start >= 1_000, `smoothRpm should pace the shared acquire by ~1000ms, waited ${clock - start}ms`);
  assert.equal(store.rows.get('anthropic:opus@acct')!.smoothRpm, true, 'shared decision row carries the runtime smoothing flag');
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

// --- Cascade-aware staggered resume (rate-limit-layer-v2 D-006 / P-018..P-019) -----------------
// Waiters parked on ONE pause wake with ORDERED per-waiter offsets (ticket × 250ms, ≤ 5s) so the
// fleet re-enters spread over a bounded window instead of re-stampeding the limit at the reset
// instant. Virtual-clock scheduler: sleepers wake only when time is advanced past their deadline.

function virtualClock() {
  let t = 0;
  const sleepers: Array<{ until: number; resolve: () => void }> = [];
  const drain = async () => {
    // Let woken promises run their continuations (a few microtask turns + a macrotask).
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };
  return {
    now: () => t,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        sleepers.push({ until: t + ms, resolve });
      }),
    /** All currently-parked wake deadlines (epoch ms), in arrival order. */
    pending: () => sleepers.map((s) => s.until),
    async advanceTo(to: number) {
      t = to;
      for (let i = sleepers.length - 1; i >= 0; i--) {
        if (sleepers[i].until <= t) {
          const [s] = sleepers.splice(i, 1);
          s.resolve();
        }
      }
      await drain();
    },
    drain,
  };
}

test('staggered resume — N waiters on one pause wake SPREAD OUT and ordered, not simultaneously (D-006)', async () => {
  const vc = virtualClock();
  const g = new RateLimitGovernor({ maxConcurrent: 10 }, { now: vc.now, sleep: vc.sleep });
  g.penalize({ retryAfterMs: 10_000 }); // bucket paused until t=10000

  const grantedAt: number[] = [];
  const mk = () =>
    g.acquire({}).then((release) => {
      grantedAt.push(vc.now());
      release?.();
    });
  const p1 = mk();
  await vc.drain(); // let waiter 1 park (ticket 0)
  const p2 = mk();
  await vc.drain(); // ticket 1
  const p3 = mk();
  await vc.drain(); // ticket 2

  // Each waiter parked with a DISTINCT ordered deadline: reset + ticket×250ms.
  const parked = vc.pending().slice().sort((a, b) => a - b);
  assert.deepEqual(parked, [10_000, 10_250, 10_500]);
  assert.ok(parked[parked.length - 1] - parked[0] <= 5_000, 'spread stays within the bounded window');

  await vc.advanceTo(10_000);
  await vc.advanceTo(10_250);
  await vc.advanceTo(10_500);
  await Promise.all([p1, p2, p3]);
  assert.equal(grantedAt.length, 3); // everyone got in — staggered, none starved
  assert.ok(new Set(grantedAt).size > 1, `wakes must not all land on one instant: ${grantedAt.join(',')}`);
});

test('staggered resume — a NEW pause epoch resets the tickets (no unbounded drift)', async () => {
  const vc = virtualClock();
  const g = new RateLimitGovernor({ maxConcurrent: 10 }, { now: vc.now, sleep: vc.sleep });
  g.penalize({ retryAfterMs: 1_000 });
  const p1 = g.acquire({}).then((r) => r?.());
  await vc.drain();
  assert.deepEqual(vc.pending(), [1_000]); // first epoch, ticket 0 → no offset
  await vc.advanceTo(1_000);
  await p1;

  g.penalize({ retryAfterMs: 1_000 }); // SECOND distinct pause (until t=2000)
  const p2 = g.acquire({}).then((r) => r?.());
  await vc.drain();
  assert.deepEqual(vc.pending(), [2_000]); // tickets restarted → first waiter again has no offset
  await vc.advanceTo(2_000);
  await p2;
});

// --- AIMD turn-health feedback (D-005): the governor reports clean releases + distinct penalties
test('AIMD hooks — clean release fires noteClean; an in-flight penalty suppresses it; notePenalty once per distinct event', async () => {
  let clean = 0;
  let penalty = 0;
  let inFlight = 0;
  const gate: GlobalConcurrencyGate = {
    tryAcquire() {
      inFlight += 1;
      return true;
    },
    release() {
      inFlight -= 1;
    },
    noteClean() {
      clean += 1;
    },
    notePenalty() {
      penalty += 1;
    },
  };
  let clock = 0;
  const g = new RateLimitGovernor(
    { maxConcurrent: 5 },
    { now: () => clock, sleep: async (ms) => { clock += ms; }, globalGate: gate },
  );

  (await g.acquire({}))!(); // clean turn
  assert.equal(clean, 1);

  const r = await g.acquire({});
  g.penalize({ retryAfterMs: 1_000 }); // penalty lands while the turn is in flight
  r!();
  assert.equal(clean, 1, 'a turn overlapping a penalty is NOT clean');
  assert.equal(penalty, 1);

  g.penalize({ retryAfterMs: 1 }); // does not extend the standing pause → same event, no re-halve
  assert.equal(penalty, 1);

  clock = 60_000; // pause long expired
  (await g.acquire({}))!(); // healthy again → clean turns resume
  assert.equal(clean, 2);
  assert.equal(inFlight, 0); // all global slots returned
});

// --- unified (subscription) dialect: rolling-utilization windows (hive-inference-gateway D-009) ---
test('recordHeaders — unified 5h rejected pauses a BOUNDED re-probe interval, not the full reset (D-003)', () => {
  const s = initGovernorState({ maxConcurrent: 10 });
  const now = 1_000;
  const resetSec = 1_781_076_000; // unix seconds — hours out
  recordHeaders(
    s,
    {
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-utilization': '1.01',
      'anthropic-ratelimit-unified-5h-reset': String(resetSec),
      'anthropic-ratelimit-unified-7d-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.2',
      'anthropic-ratelimit-unified-7d-reset': String(resetSec + 330_000),
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-reset': String(resetSec),
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    },
    now,
  );
  // Rolling-utilization windows recover continuously → a bounded re-probe, NOT the multi-hour reset
  // (which would go stale: "paused until <reset> with zero pressure" = the false-exhaustion bug). The
  // re-probe is SCALED to the window's recovery (2026-06-21): with a far reset like this one the scale
  // saturates at ROLLING_WINDOW_REPROBE_MAX_MS — still bounded, still far below the full reset.
  assert.equal(s.pausedUntil, now + ROLLING_WINDOW_REPROBE_MAX_MS, 'bounded, scaled re-probe (capped at the max for a far reset)');
  assert.ok(s.pausedUntil < resetSec * 1000, 'far below the full reset');
  assert.ok(s.unified, 'unified state recorded');
  assert.equal(s.unified!.rejected, true);
  assert.equal(s.unified!.window, '5h'); // 5h binds over the allowed 7d
  assert.equal(s.unified!.utilization, 1.01);
  assert.equal(s.unified!.resetAt, resetSec * 1000, 'real reset kept for observability + failover rejoin');
  assert.equal(s.unified!.observedAt, now, 'EI-535: stamped with WHEN this reading was taken, so a consumer can tell a fresh reading from a frozen one once traffic goes idle');
  assert.equal(decideAcquire(s, now, {}).allowed, false); // blocked during the re-probe pause
  assert.equal(decideAcquire(s, now + ROLLING_WINDOW_REPROBE_MAX_MS + 1, {}).allowed, true); // then re-probes
});

test('recordHeaders — unified.observedAt only advances on a FRESH response, so it stays a true staleness clock across an idle stretch (EI-535)', () => {
  const s = initGovernorState({ maxConcurrent: 10 });
  const t0 = 1_000;
  const resetSec = 1_781_076_000;
  recordHeaders(
    s,
    {
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-utilization': '1.01',
      'anthropic-ratelimit-unified-5h-reset': String(resetSec),
    },
    t0,
  );
  assert.equal(s.unified!.observedAt, t0);
  // No traffic for hours (the idle-fleet scenario the bug report described) — nothing calls recordHeaders,
  // so the reading (rejected/utilization/resetAt/observedAt) simply never changes. A caller comparing
  // `observedAt` against the current wall clock (or `resetAt` against it) can tell this is a STALE reading;
  // one that only inspects `rejected` cannot.
  assert.equal(s.unified!.rejected, true, 'frozen at the last-observed verdict — this is the bug the fix makes legible, not a regression');
  assert.equal(s.unified!.observedAt, t0, 'observedAt stays put — it is not a live clock, it is the last-write timestamp');
});

test('recordHeaders — a 7d-exhausted window parks FAR longer than the flat 2-min re-probe (owner 2026-06-21: agents pinned to a 97%-7d account 429ing while its 5h read empty)', () => {
  const s = initGovernorState({ maxConcurrent: 10 });
  const now = 1_700_000_000_000;
  const reset7dSec = Math.round((now + 27 * 60 * 60_000) / 1000); // ~27h out — like the reported aviynw8/aviynw
  const reset5hSec = Math.round((now + 3 * 60 * 60_000) / 1000);
  recordHeaders(
    s,
    {
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.0', // the 5h window reads EMPTY — the misleading "current usage"
      'anthropic-ratelimit-unified-5h-reset': String(reset5hSec),
      'anthropic-ratelimit-unified-7d-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.97', // …but the 7-DAY budget is spent → predictive-pause
      'anthropic-ratelimit-unified-7d-reset': String(reset7dSec),
    },
    now,
  );
  const pausedFor = s.pausedUntil - now;
  // The fix: a 7d-exhausted account is parked ~its real recovery (tens of minutes), NOT re-probed every 2 min
  // (which re-lured pinned agents back onto it into a 429 every 2 min). Bounded by the max so it re-checks.
  assert.ok(pausedFor > ROLLING_WINDOW_REPROBE_MS, `parked far longer than the flat 2-min re-probe (got ${Math.round(pausedFor / 1000)}s)`);
  assert.ok(pausedFor <= ROLLING_WINDOW_REPROBE_MAX_MS, 'still bounded by the max re-probe (never the full multi-day reset)');
  assert.equal(s.unified!.window, '7d', 'the 7-day window binds (the 5h reads empty)');
  assert.equal(s.unified!.utilization, 0.97);
});

test('recordHeaders — unified high utilization (allowed) sets pre-emptive pace, not a pause', () => {
  const s = initGovernorState({ maxConcurrent: 10 });
  const now = 1_000;
  const resetMs = now + 3_600_000;
  recordHeaders(
    s,
    {
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.9', // halfway from watermark 0.8 → 1.0
      'anthropic-ratelimit-unified-5h-reset': String(Math.round(resetMs / 1000)),
    },
    now,
  );
  assert.equal(s.pausedUntil, 0, 'allowed window does not pause');
  // gap = 5000 * (0.9 - 0.8)/(1 - 0.8) = 5000 * 0.5 = 2500
  assert.equal(s.paceDelayMs, 2500);
  assert.equal(s.unified!.rejected, false);
  assert.equal(s.unified!.utilization, 0.9);
});

test('recordHeaders — unified utilization below the watermark paces 0 (healthy)', () => {
  const s = initGovernorState({ maxConcurrent: 10 });
  recordHeaders(
    s,
    {
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.2',
      'anthropic-ratelimit-unified-5h-reset': '1781076000',
    },
    1_000,
  );
  assert.equal(s.paceDelayMs, 0);
  assert.equal(s.pausedUntil, 0);
  assert.equal(s.unified!.utilization, 0.2);
});

// --- PREDICTIVE pre-emptive pause (owner-requested 2026-06-18, UNIFIED_PREDICT_PAUSE_WATERMARK 0.95) ---
// A rolling window at/over 0.95 utilization will almost certainly 429 the NEXT request even though THIS
// response was `allowed` — so the governor proactively pauses the account for the bounded re-probe so
// routing/failover SKIPS it before it 429s, then re-probes once the window ages back below the cap.
test('recordHeaders — unified util ≥ 0.95 (allowed, future reset) PROACTIVELY pauses the re-probe window before it 429s', () => {
  const s = initGovernorState({ maxConcurrent: 10 });
  const now = 1_000;
  const resetSec = Math.round(now / 1000) + 3_600; // a FUTURE reset (window still live)
  recordHeaders(
    s,
    {
      // 7-day Claude Max budget effectively spent (0.97 ≥ 0.95) but NOT yet rejected — the next request
      // would tip it over. The governor predicts the 429 and backs off NOW rather than routing into it.
      'anthropic-ratelimit-unified-7d-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.97',
      'anthropic-ratelimit-unified-7d-reset': String(resetSec),
    },
    now,
  );
  assert.equal(s.pausedUntil, now + ROLLING_WINDOW_REPROBE_MS, 'predictive pause = bounded re-probe interval, not the multi-hour reset');
  assert.ok(s.pausedUntil < resetSec * 1000, 'far below the full window reset (re-probe, not hard-pause to reset)');
  assert.equal(s.unified!.rejected, false, 'the window was ALLOWED — the pause is predictive, not a rejection');
  assert.equal(s.unified!.utilization, 0.97);
  // The account is skipped during the predictive pause, then re-probes once it elapses.
  assert.equal(decideAcquire(s, now, {}).allowed, false, 'blocked during the predictive pause');
  assert.equal(decideAcquire(s, now + ROLLING_WINDOW_REPROBE_MS + 1, {}).allowed, true, 'then re-probes the freed window');
});

test('recordHeaders — unified util 0.85 (below the 0.95 predict watermark, allowed) PACES but does NOT pause', () => {
  const s = initGovernorState({ maxConcurrent: 10 });
  const now = 1_000;
  const resetSec = Math.round(now / 1000) + 3_600;
  recordHeaders(
    s,
    {
      // Above the 0.8 pace watermark but below the 0.95 predict watermark → still serve, just slow.
      'anthropic-ratelimit-unified-7d-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.85',
      'anthropic-ratelimit-unified-7d-reset': String(resetSec),
    },
    now,
  );
  assert.equal(s.pausedUntil, 0, 'below the predict watermark → no proactive pause (it only paces)');
  assert.ok(s.paceDelayMs > 0, 'still over the pace watermark → a soft pace gap is set (not a pause)');
  // The decideAcquire denial here would be reason:'pace' (the soft gap), never reason:'paused' — the
  // distinction the test guards: a 0.85 window slows the account, it does not skip it out of rotation.
  assert.notEqual(decideAcquire(s, now, {}).reason, 'paused', 'not paused (at most paced)');
  assert.equal(s.unified!.utilization, 0.85);
});

test('recordHeaders — classic and unified dialects are independent; absent unified leaves s.unified undefined', () => {
  const s = initGovernorState({ maxConcurrent: 10 });
  recordHeaders(s, { 'anthropic-ratelimit-requests-limit': '1000' }, 1_000);
  assert.equal(s.limits.rpm, 1000);
  assert.equal(s.unified, undefined, 'no unified headers → no unified state');
});
