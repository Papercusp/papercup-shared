/**
 * P-009 (capless-inference-gateway-2026-08-28) — clause `capless-p009-provider-governor@3`.
 *
 * BEHAVIOR: "Provider and global rate observations contract only the causally affected
 * account/model lane and resume probing when the observed constraint expires."
 *
 * The two falsifier arms are encoded DIRECTLY, one test each:
 *   arm 1 — a provider fault shrinks unrelated accounts.
 *   arm 2 — a recovered account stays permanently below its prior probe window.
 *
 * Both arms are negative assertions ("the window did NOT move"), which pass just as happily when
 * the instrument is broken and no penalty was ever delivered. Each therefore carries a CALIBRATION
 * control in the same test: the identical penalty from an account-BLIND lane, which must still
 * contract the fleet. If the control stops firing, the arm fails instead of silently going vacuous.
 *
 * Run: npm run test:file -- libs/papercusp-shared/src/agent/governor-causal-lane-scoping.test.ts
 */
import { test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  getGovernor,
  resetGovernorRegistry,
  setGlobalConcurrencyCap,
  setGlobalConcurrencyFloor,
  setGlobalConcurrencySeed,
  setGlobalGateClock,
  effectiveConcurrencySnapshot,
  recordGlobalConcurrencyPenalty,
  GLOBAL_CONSTRAINT_TTL_MS,
  AIMD_CLEAN_TURNS_PER_STEP,
} from './governor-registry';

beforeEach(() => {
  resetGovernorRegistry();
  setGlobalConcurrencyCap(undefined);
  setGlobalConcurrencyFloor(undefined);
});

/** Fake clock for the per-governor pause budget (the same idiom governor-registry.test.ts uses). */
function aimdDeps() {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
}

test('FALSIFIER arm 1 — one account\'s 429 does NOT contract the fleet window (and a blind lane still does)', () => {
  setGlobalConcurrencyCap(8);
  setGlobalConcurrencyFloor(1);
  assert.equal(effectiveConcurrencySnapshot().effective, 8);

  // An ACCOUNT-KEYED lane (store key carries '@account'): its 429 is one account's budget fact.
  const scoped = getGovernor('anthropic', 'opus', aimdDeps(), 'account-a');
  scoped.penalize({ retryAfterMs: 1_000, rateLimited: true });
  assert.equal(
    effectiveConcurrencySnapshot().effective,
    8,
    'arm 1: an account-scoped provider fault contracted the fleet-wide window',
  );

  // CALIBRATION: the same penalty from an account-BLIND lane must still contract, which proves the
  // assertion above measured a real, delivered penalty rather than an inert instrument.
  const blind = getGovernor('anthropic', 'sonnet', aimdDeps());
  blind.penalize({ retryAfterMs: 1_000 });
  assert.equal(
    effectiveConcurrencySnapshot().effective,
    4,
    'calibration: an account-blind penalty no longer contracts, so arm 1 above proved nothing',
  );
});

test('arm 1 (recovery half) — an account-keyed lane\'s clean turns do NOT ramp the fleet window', async () => {
  setGlobalConcurrencyCap(8);
  setGlobalConcurrencyFloor(1);
  const blind = getGovernor('anthropic', 'sonnet', aimdDeps());
  blind.penalize({ retryAfterMs: 1_000 }); // 8 → 4, so there is headroom to ramp back into
  assert.equal(effectiveConcurrencySnapshot().effective, 4);

  // Recovery is scoped exactly like contraction: a lane that was refused the right to shrink the
  // fleet must not be allowed to grow it either, or the gate drifts upward on one account's health.
  const scoped = getGovernor('anthropic', 'opus', aimdDeps(), 'account-a');
  for (let i = 0; i < AIMD_CLEAN_TURNS_PER_STEP * 2; i++) (await scoped.acquire({}))!();
  assert.equal(
    effectiveConcurrencySnapshot().effective,
    4,
    'an account-scoped recovery ramped the fleet-wide window',
  );

  // CALIBRATION: the blind lane's clean turns DO ramp it, so the assertion above is not vacuous.
  for (let i = 0; i < AIMD_CLEAN_TURNS_PER_STEP; i++) (await blind.acquire({}))!();
  assert.equal(
    effectiveConcurrencySnapshot().effective,
    5,
    'calibration: an account-blind clean streak no longer ramps the window',
  );
});

test('FALSIFIER arm 2 — an expired constraint resumes probing at the prior peak, not the contracted floor', () => {
  let clock = 1_000_000;
  setGlobalGateClock(() => clock);
  // No user cap: the seed bootstraps the probe window and is explicitly NOT a ceiling.
  setGlobalConcurrencyCap(undefined);
  setGlobalConcurrencySeed(16);
  assert.equal(effectiveConcurrencySnapshot().effective, 16);

  recordGlobalConcurrencyPenalty(); // account-blind local saturation → a legitimate fleet contraction
  const contracted = effectiveConcurrencySnapshot();
  assert.ok(contracted.effective !== null && contracted.effective < 16, 'the contraction did not happen');
  assert.equal(contracted.peak, 16, 'the pre-contraction probe window was not remembered');
  assert.equal(contracted.constraintExpired, false);
  assert.equal(
    contracted.effectiveAfterExpiry,
    contracted.effective,
    'a FRESH constraint must still be enforced — expiry may not be retroactive',
  );

  // The observation that justified the contraction has aged out. Admission resumes at the prior
  // probe window; staying pinned at the contracted level is exactly falsifier arm 2.
  clock += GLOBAL_CONSTRAINT_TTL_MS;
  const expired = effectiveConcurrencySnapshot();
  assert.equal(expired.constraintExpired, true);
  assert.equal(
    expired.effectiveAfterExpiry,
    16,
    'arm 2: a recovered lane stayed permanently below its prior probe window',
  );
});

test('a seed bootstraps observation and is not a ceiling — with no user cap the window probes ABOVE it', async () => {
  setGlobalConcurrencyCap(undefined);
  setGlobalConcurrencySeed(4);
  assert.equal(effectiveConcurrencySnapshot().effective, 4);

  const g = getGovernor('anthropic', 'opus', aimdDeps());
  for (let i = 0; i < AIMD_CLEAN_TURNS_PER_STEP; i++) (await g.acquire({}))!();
  assert.equal(
    effectiveConcurrencySnapshot().effective,
    5,
    'the seed behaved as a maximum: healthy operation could not probe above it',
  );
});
