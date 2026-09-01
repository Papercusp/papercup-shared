/**
 * Tests for backend profiles + the shared governor registry (robustness P-011).
 * Run: npx vitest run libs/papercusp-shared/src/agent/governor-registry.test.ts
 */
import { test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  BACKEND_PROFILES,
  modelClassOf,
  getGovernor,
  governorForBackend,
  governorKey,
  parseGovernorKey,
  resetGovernorRegistry,
  resolveLimitModel,
  resolveProviderLimitModel,
  onGovernorPause,
  snapshotGovernors,
  setGlobalConcurrencyCap,
  setGlobalConcurrencyFloor,
  globalConcurrencySnapshot,
  effectiveConcurrencySnapshot,
  AIMD_CLEAN_TURNS_PER_STEP,
} from './governor-registry';

beforeEach(() => {
  resetGovernorRegistry();
  setGlobalConcurrencyCap(undefined); // clear any fleet cap a prior test set (also resets AIMD)
  setGlobalConcurrencyFloor(undefined);
});

test('BACKEND_PROFILES drives the actual governor bucket for every backend', () => {
  for (const [backend, profile] of Object.entries(BACKEND_PROFILES)) {
    const model = 'claude-opus-4-8';
    const actual = governorForBackend(backend as keyof typeof BACKEND_PROFILES, model);
    const expected = getGovernor(profile.provider, profile.selfPacing ? 'self' : modelClassOf(model));
    assert.equal(actual, expected);
  }
});

// D-006: limitModel is a RUNTIME credential fact, not a compile-time const.
test('resolveLimitModel — subscription by default, apiKey when a provider key is set in env', () => {
  // No keys → coarse subscription mode (the Max/ChatGPT OAuth default on the dev box).
  assert.equal(resolveLimitModel('anthropic-direct', {}), 'subscription');
  assert.equal(resolveLimitModel('claude-code', {}), 'subscription');
  assert.equal(resolveLimitModel('codex', {}), 'subscription');
  // An Anthropic API key flips claude paths to precise header-driven mode.
  assert.equal(resolveLimitModel('anthropic-direct', { ANTHROPIC_API_KEY: 'sk-ant-x' }), 'apiKey');
  assert.equal(resolveProviderLimitModel('anthropic', { ANTHROPIC_API_KEY: 'sk-ant-x' }), 'apiKey');
  // An OpenAI API key flips codex to precise mode; anthropic key doesn't affect openai.
  assert.equal(resolveLimitModel('codex', { OPENAI_API_KEY: 'sk-oai-x' }), 'apiKey');
  assert.equal(resolveProviderLimitModel('openai', { ANTHROPIC_API_KEY: 'sk-ant-x' }), 'subscription');
  // omp self-paces → always coarse, regardless of any key in env.
  assert.equal(resolveLimitModel('omp', { ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-oai-x' }), 'subscription');
});

test('modelClassOf — buckets opus/sonnet/haiku separately (Anthropic limits are per-class)', () => {
  assert.equal(modelClassOf('claude-opus-4-8'), 'opus');
  assert.equal(modelClassOf('anthropic/claude-sonnet-4-6'), 'sonnet');
  assert.equal(modelClassOf('claude-haiku-4-5'), 'haiku');
  assert.equal(modelClassOf('gpt-5-codex'), 'default');
});

test('getGovernor — singleton per (provider, modelClass) key', () => {
  const a = getGovernor('anthropic', 'opus');
  const b = getGovernor('anthropic', 'opus');
  const c = getGovernor('anthropic', 'sonnet');
  const d = getGovernor('openai', 'default');
  assert.equal(a, b); // same key → same instance (so pacing is actually shared)
  assert.notEqual(a, c); // opus vs sonnet → separate buckets
  assert.notEqual(a, d); // anthropic vs openai → separate buckets
});

test('governorForBackend — omp is self-pacing (concurrency-only: no rpm/itpm/otpm)', () => {
  const omp = governorForBackend('omp', 'claude-sonnet-4-6');
  assert.equal(omp.state.limits.rpm, undefined); // self-pacing → no token/req budget
  assert.ok(omp.state.limits.maxConcurrent >= 1);
  const claude = governorForBackend('claude-code', 'claude-sonnet-4-6');
  assert.equal(typeof claude.state.limits.rpm, 'number'); // claude gets a conservative RPM floor
});

test('governorForBackend — claude (anthropic-direct + CLI) share the Anthropic bucket per model-class', () => {
  const mer = governorForBackend('anthropic-direct', 'claude-opus-4-8');
  const cli = governorForBackend('claude-code', 'claude-opus-4-8');
  assert.equal(mer, cli); // same provider+class → one shared budget (don't co-burst the account)
});

// D-004: the fleet-wide concurrency cap is shared across every registry bucket -----------
test('setGlobalConcurrencyCap — bounds TOTAL in-flight across separate (provider,modelClass) buckets', async () => {
  setGlobalConcurrencyCap(2); // the user drops "maxSimultaneousAgents" to 2
  const opus = getGovernor('anthropic', 'opus');
  const codex = getGovernor('openai', 'default'); // a DIFFERENT bucket
  const r1 = await opus.acquire({});
  const r2 = await codex.acquire({}); // 1 in each bucket → 2 total, fleet cap reached
  assert.ok(r1 && r2);
  assert.equal(globalConcurrencySnapshot().inFlight, 2);
  let third = false;
  const p = opus.acquire({}).then((r) => { third = true; return r; });
  await Promise.resolve();
  assert.equal(third, false); // a 3rd agent (any bucket) is blocked by the fleet cap
  r2!(); // free a fleet slot from the codex bucket
  const r3 = await p;
  assert.equal(third, true); // now the opus acquire proceeds
  if (r3) r3();
  assert.equal(globalConcurrencySnapshot().cap, 2);
});
test('setGlobalConcurrencyCap — a live raise is honored on the NEXT acquire (no restart)', async () => {
  setGlobalConcurrencyCap(1);
  const g = getGovernor('anthropic', 'sonnet');
  const r1 = await g.acquire({});
  assert.ok(r1);
  let second = false;
  const p = g.acquire({}).then((r) => { second = true; return r; });
  await Promise.resolve();
  assert.equal(second, false); // cap 1 → blocked
  setGlobalConcurrencyCap(2); // user raises the cap live
  const r2 = await p; // the pending acquire now proceeds without a release
  assert.equal(second, true);
  if (r1) r1();
  if (r2) r2();
});

// RB-009 observability ------------------------------------------------------------------
test('onGovernorPause — fires (with the bucket key) when a governor is penalized', () => {
  const events: Array<{ key: string; pausedUntil: number; source: string }> = [];
  const off = onGovernorPause((ev) => events.push(ev));
  const g = governorForBackend('claude-code', 'claude-opus-4-8');
  g.penalize({ retryAfterMs: 30_000 });
  assert.equal(events.length, 1);
  assert.equal(events[0].key, 'anthropic:opus');
  assert.equal(events[0].source, 'penalty');
  assert.ok(events[0].pausedUntil > 0);
  off();
  g.penalize({ retryAfterMs: 999_000 }); // after unsubscribe → no more events
  assert.equal(events.length, 1);
});

test('onGovernorPause — does NOT fire when a penalty does not extend the pause', () => {
  const events: unknown[] = [];
  onGovernorPause((ev) => events.push(ev));
  const g = getGovernor('anthropic', 'sonnet');
  g.penalize({ resetAt: Date.now() + 60_000 });
  g.penalize({ retryAfterMs: 1 }); // shorter → must NOT re-fire (no new backpressure)
  assert.equal(events.length, 1);
});

test('snapshotGovernors — reports each live bucket with its pause + concurrency state', () => {
  const g = governorForBackend('claude-code', 'claude-opus-4-8');
  g.penalize({ retryAfterMs: 30_000 });
  const snap = snapshotGovernors();
  const opus = snap.find((s) => s.key === 'anthropic:opus');
  assert.ok(opus);
  assert.equal(opus!.provider, 'anthropic');
  assert.equal(opus!.modelClass, 'opus');
  assert.ok(opus!.state.pausedUntil > 0);
  assert.equal(typeof opus!.state.inFlight, 'number');
  assert.ok(opus!.limitModel === 'subscription' || opus!.limitModel === 'apiKey'); // D-006 runtime fact
});

// --- AIMD adaptive concurrency (rate-limit-layer-v2 D-005 / P-015..P-017) ---------------------
// The registry's global gate runs an effective concurrency eff ≤ cap: +1 per
// AIMD_CLEAN_TURNS_PER_STEP clean turns, halved toward the floor on a distinct account-wide
// penalty. Driven end-to-end through real governors (acquire/release/penalize), fake clock.

function aimdDeps() {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
}

test('AIMD — eff starts at the cap; a distinct 429 halves it; clean turns ramp it back +1 per N', async () => {
  setGlobalConcurrencyCap(4);
  setGlobalConcurrencyFloor(1);
  const deps = aimdDeps();
  const g = getGovernor('anthropic', 'opus', deps);
  assert.equal(effectiveConcurrencySnapshot().effective, 4); // starts at the cap

  g.penalize({ retryAfterMs: 1_000 }); // extends the pause → one multiplicative decrease
  assert.equal(effectiveConcurrencySnapshot().effective, 2);

  // 5 clean turns (fake clock skips the pause) → +1.
  for (let i = 0; i < AIMD_CLEAN_TURNS_PER_STEP; i++) (await g.acquire({}))!();
  assert.equal(effectiveConcurrencySnapshot().effective, 3);
  // 5 more → back at the cap; 5 more → NEVER exceeds the cap.
  for (let i = 0; i < AIMD_CLEAN_TURNS_PER_STEP * 2; i++) (await g.acquire({}))!();
  assert.equal(effectiveConcurrencySnapshot().effective, 4);
});

test('AIMD — eff never drops below the floor', () => {
  setGlobalConcurrencyCap(8);
  setGlobalConcurrencyFloor(3);
  const g = getGovernor('anthropic', 'sonnet', aimdDeps());
  g.penalize({ retryAfterMs: 1_000 }); // 8 → 4
  assert.equal(effectiveConcurrencySnapshot().effective, 4);
  g.penalize({ retryAfterMs: 5_000 }); // extends again: 4 → floor(2) → clamped to floor 3
  assert.equal(effectiveConcurrencySnapshot().effective, 3);
  g.penalize({ retryAfterMs: 60_000 }); // and stays at the floor
  assert.equal(effectiveConcurrencySnapshot().effective, 3);
});

test('AIMD — tier-1 Scout admission can use hard-cap headroom after ordinary traffic sheds to the floor', async () => {
  setGlobalConcurrencyCap(4);
  setGlobalConcurrencyFloor(1);
  const deps = aimdDeps();
  const ordinary = getGovernor('anthropic', 'opus', deps);
  ordinary.penalize({ retryAfterMs: 1_000 }); // 4 → 2
  ordinary.penalize({ retryAfterMs: 5_000 }); // 2 → floor 1
  assert.equal(effectiveConcurrencySnapshot().effective, 1);
  // Move beyond the synthetic pauses without recording clean turns (which would
  // increase the AIMD effective limit and make this test vacuous).
  await deps.sleep(6_000);

  const low = await ordinary.acquire({}, { priorityTier: 5 });
  assert.ok(low);
  let denial: import('../resilience/governor').AdmissionDenial | undefined;
  const anotherLow = await ordinary.acquire({}, {
    maxWaitMs: 0,
    priorityTier: 5,
    onDenied: (d) => (denial = d),
  });
  assert.equal(anotherLow, null);
  assert.equal(denial?.governorReason, 'concurrency');

  const scout = await ordinary.acquire({}, { maxWaitMs: 0, priorityTier: 1 });
  assert.ok(scout, 'tier 1 uses hard-cap headroom instead of inheriting the shed ordinary ceiling');
  assert.equal(globalConcurrencySnapshot().inFlight, 2);
  scout!();
  low!();
});

test('AIMD — duplicate penalties on the SAME backpressure event halve only once', () => {
  setGlobalConcurrencyCap(8);
  setGlobalConcurrencyFloor(1);
  const g = getGovernor('anthropic', 'haiku', aimdDeps());
  g.penalize({ resetAt: 60_000 }); // distinct event → 8 → 4
  g.penalize({ resetAt: 60_000 }); // same reset, no extension → NOT another halve
  g.penalize({ retryAfterMs: 1 }); // shorter than the standing pause → no extension either
  assert.equal(effectiveConcurrencySnapshot().effective, 4);
});

test('AIMD — reacts within one acquire to a lowered cap (eff clamps; the gate honors it now)', async () => {
  setGlobalConcurrencyCap(4);
  const deps = aimdDeps();
  const a = getGovernor('anthropic', 'opus', deps);
  const r1 = await a.acquire({});
  const r2 = await a.acquire({});
  assert.ok(r1 && r2);
  setGlobalConcurrencyCap(2); // the user drops the fleet cap mid-flight
  assert.equal(effectiveConcurrencySnapshot().effective, 2);
  let third = false;
  const p = a.acquire({}, { maxWaitMs: 2_000 }).then((r) => {
    third = r !== null;
    return r;
  });
  await Promise.resolve();
  const r3 = await p; // 2 already in flight ≥ new cap 2 → must NOT be granted before a release
  assert.equal(third, false);
  assert.equal(r3, null);
  r1!();
  r2!();
});

test('AIMD — inactive (effective null, no adaptation) until a finite cap is installed', async () => {
  assert.equal(effectiveConcurrencySnapshot().effective, null);
  const g = getGovernor('anthropic', 'opus', aimdDeps());
  g.penalize({ retryAfterMs: 1_000 }); // no cap → nothing to halve
  assert.equal(effectiveConcurrencySnapshot().effective, null);
  (await g.acquire({}))!(); // clean turn → still inactive, no crash
  assert.equal(effectiveConcurrencySnapshot().effective, null);
});

// ── Per-account bucket keying (cloud-deployment-layer Phase 7, P-019) ─────────

// WI-5391 item 3: the registry injects poolCounters so a governor-attested denial carries
// its pool's paused/total bucket counts — the retro-audit evidence for the governor leg.
test('getGovernor — registry poolCounters count same provider+modelClass siblings (paused vs total)', async () => {
  const a = getGovernor('anthropic', 'opus', undefined, 'acct-a');
  const b = getGovernor('anthropic', 'opus', undefined, 'acct-b');
  getGovernor('anthropic', 'haiku'); // different model class — must NOT count
  getGovernor('openai', 'opus'); // different provider — must NOT count
  b.penalize({ retryAfterMs: 60 * 60 * 1000 }); // wall one sibling
  // Exhaust a's only... concurrency is per-floor; deny via maxWaitMs:0 against a pause on a.
  a.penalize({ retryAfterMs: 60 * 60 * 1000 });
  let denial: import('../resilience/governor').AdmissionDenial | undefined;
  const r = await a.acquire({}, { maxWaitMs: 0, onDenied: (d) => (denial = d) });
  assert.equal(r, null);
  assert.equal(denial?.via, 'governor');
  assert.equal(denial?.totalAccounts, 2); // acct-a + acct-b (opus buckets only)
  assert.equal(denial?.pausedAccounts, 2); // both walled at denial time
});

test('governorKey — global without an account, account-scoped with one', () => {
  assert.equal(governorKey('anthropic', 'opus'), 'anthropic:opus');
  assert.equal(governorKey('anthropic', 'opus', 'acct-1'), 'anthropic:opus@acct-1');
});

test('parseGovernorKey — round-trips both forms', () => {
  assert.deepEqual(parseGovernorKey('anthropic:opus'), { provider: 'anthropic', modelClass: 'opus', accountId: undefined });
  assert.deepEqual(parseGovernorKey('anthropic:opus@acct-1'), { provider: 'anthropic', modelClass: 'opus', accountId: 'acct-1' });
});

test('getGovernor — distinct singletons per account; same account returns the same instance', () => {
  const global = getGovernor('anthropic', 'opus');
  const a1 = getGovernor('anthropic', 'opus', undefined, 'acct-1');
  const a2 = getGovernor('anthropic', 'opus', undefined, 'acct-2');
  assert.notEqual(a1, global);
  assert.notEqual(a1, a2);
  assert.equal(getGovernor('anthropic', 'opus', undefined, 'acct-1'), a1);
});

test('per-account pause does NOT pause another account or the global bucket', () => {
  const a1 = getGovernor('anthropic', 'opus', undefined, 'acct-1');
  const a2 = getGovernor('anthropic', 'opus', undefined, 'acct-2');
  const global = getGovernor('anthropic', 'opus');
  a1.penalize({ retryAfterMs: 60_000 });
  assert.ok(a1.snapshot().pausedUntil > Date.now()); // acct-1 paused
  assert.equal(a2.snapshot().pausedUntil, 0); // acct-2 untouched
  assert.equal(global.snapshot().pausedUntil, 0); // global untouched
});

test('snapshotGovernors — surfaces accountId for account-scoped buckets', () => {
  getGovernor('anthropic', 'opus'); // global
  getGovernor('anthropic', 'opus', undefined, 'acct-9'); // account-scoped
  const snaps = snapshotGovernors();
  const global = snaps.find((s) => s.key === 'anthropic:opus');
  const scoped = snaps.find((s) => s.key === 'anthropic:opus@acct-9');
  assert.equal(global?.accountId, undefined);
  assert.equal(scoped?.accountId, 'acct-9');
  assert.equal(scoped?.modelClass, 'opus');
});

test('governorForBackend — threads accountId into the bucket key', () => {
  const g = governorForBackend('claude-code', 'claude-opus-4-8', undefined, 'acct-7');
  const hit = snapshotGovernors().find((s) => s.accountId === 'acct-7');
  assert.ok(hit, 'an account-scoped bucket should exist');
  assert.equal(hit!.key, 'anthropic:opus@acct-7');
  assert.equal(g, getGovernor('anthropic', 'opus', undefined, 'acct-7'));
});
