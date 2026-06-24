/**
 * Tests for the P-021 runtime governor dials (live-configurability-audit-2026-06-20):
 * per-provider FLOOR overrides (setProviderFloorOverride) + the AIMD response-curve tuning
 * (setAimdTuning). Run: npx vitest run libs/papercusp-shared/src/agent/governor-floor-aimd-overrides.test.ts
 */
import { test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  getGovernor,
  resetGovernorRegistry,
  setGlobalConcurrencyCap,
  setGlobalConcurrencyFloor,
  setProviderFloorOverride,
  getProviderFloorOverrides,
  setAimdTuning,
  getAimdTuning,
  effectiveConcurrencySnapshot,
  recordGlobalConcurrencyPenalty,
  recordGlobalConcurrencyClean,
} from './governor-registry';

beforeEach(() => {
  resetGovernorRegistry();
  setGlobalConcurrencyCap(undefined);
  setGlobalConcurrencyFloor(undefined);
});

// ── per-provider floor overrides ──────────────────────────────────────────────
test('default floors apply with no override (byte-identical)', () => {
  const g = getGovernor('anthropic', 'sonnet');
  assert.equal(g.snapshot().limits.maxConcurrent, 3);
  assert.equal(g.snapshot().limits.rpm, 45);
  assert.deepEqual(getProviderFloorOverrides(), {});
});

test('setProviderFloorOverride pushes the new floor into an EXISTING bucket (fully-live)', () => {
  const g = getGovernor('anthropic', 'sonnet'); // created with the baked floor
  setProviderFloorOverride('anthropic', { maxConcurrent: 1, rpm: 10 });
  assert.equal(g.snapshot().limits.maxConcurrent, 1);
  assert.equal(g.snapshot().limits.rpm, 10);
});

test('a NEW bucket created after the override uses the effective floor; other providers untouched', () => {
  setProviderFloorOverride('anthropic', { maxConcurrent: 1, rpm: 10 });
  const opus = getGovernor('anthropic', 'opus'); // new bucket
  assert.equal(opus.snapshot().limits.maxConcurrent, 1);
  assert.equal(opus.snapshot().limits.rpm, 10);
  const openai = getGovernor('openai', 'default'); // unaffected provider
  assert.equal(openai.snapshot().limits.maxConcurrent, 3);
  assert.equal(openai.snapshot().limits.rpm, 45);
});

test('partial override keeps the unspecified baked field', () => {
  const g = getGovernor('anthropic', 'sonnet');
  setProviderFloorOverride('anthropic', { rpm: 20 }); // only rpm
  assert.equal(g.snapshot().limits.rpm, 20);
  assert.equal(g.snapshot().limits.maxConcurrent, 3); // baked maxConcurrent preserved
});

test('the UNCHANGED guard preserves a header-learned rpm on a benign re-apply', () => {
  const g = getGovernor('anthropic', 'sonnet');
  setProviderFloorOverride('anthropic', { maxConcurrent: 1, rpm: 10 });
  // Simulate the header auto-tune raising rpm above the static floor (recordResponse would do this).
  g.state.limits.rpm = 99;
  // Re-apply the SAME override (e.g. a maxSimultaneousAgents-only edit re-runs applyCached):
  setProviderFloorOverride('anthropic', { maxConcurrent: 1, rpm: 10 });
  assert.equal(g.snapshot().limits.rpm, 99, 'a no-op re-apply must NOT re-seat the bucket to the static floor');
});

test('clearing an override restores the default floor for new buckets', () => {
  setProviderFloorOverride('anthropic', { maxConcurrent: 1, rpm: 10 });
  setProviderFloorOverride('anthropic', undefined); // clear
  assert.deepEqual(getProviderFloorOverrides(), {});
  const g = getGovernor('anthropic', 'haiku');
  assert.equal(g.snapshot().limits.maxConcurrent, 3);
  assert.equal(g.snapshot().limits.rpm, 45);
});

// ── AIMD response-curve tuning ────────────────────────────────────────────────
test('default AIMD curve: halve-toward-floor on a penalty, +1 per 5 clean turns', () => {
  assert.deepEqual(getAimdTuning(), { cleanTurnsPerStep: 5, decreaseFactor: 0.5 });
  setGlobalConcurrencyCap(8); // aimdEff starts at the cap
  setGlobalConcurrencyFloor(1);
  recordGlobalConcurrencyPenalty(); // floor(8 * 0.5) = 4
  assert.equal(effectiveConcurrencySnapshot().effective, 4);
});

test('setAimdTuning(decreaseFactor) reshapes the multiplicative backoff', () => {
  setAimdTuning({ decreaseFactor: 0.25 });
  assert.equal(getAimdTuning().decreaseFactor, 0.25);
  setGlobalConcurrencyCap(8);
  setGlobalConcurrencyFloor(1);
  recordGlobalConcurrencyPenalty(); // floor(8 * 0.25) = 2 (vs 4 at the default)
  assert.equal(effectiveConcurrencySnapshot().effective, 2);
});

test('setAimdTuning(cleanTurnsPerStep) reshapes the additive-increase cadence', () => {
  setAimdTuning({ cleanTurnsPerStep: 2 });
  setGlobalConcurrencyCap(8);
  setGlobalConcurrencyFloor(1);
  recordGlobalConcurrencyPenalty(); // eff = 4, now below cap so clean turns can ramp it
  recordGlobalConcurrencyClean();
  recordGlobalConcurrencyClean(); // 2 clean turns → +1
  assert.equal(effectiveConcurrencySnapshot().effective, 5);
});

test('setAimdTuning ignores invalid values (out-of-range decreaseFactor / cadence)', () => {
  setAimdTuning({ decreaseFactor: 1.5, cleanTurnsPerStep: 0 });
  assert.deepEqual(getAimdTuning(), { cleanTurnsPerStep: 5, decreaseFactor: 0.5 });
});
