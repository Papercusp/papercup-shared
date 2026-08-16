/**
 * external-concurrency-feedback.test.ts — P5-2.
 *
 * The global AIMD concurrency already adapts to provider 429s. P5-2 adds an
 * EXTERNAL seam so a non-429 signal (local event-loop saturation) can drive the
 * same multiplicative-decrease / clean-ramp. These pin that the seam halves toward
 * the floor, ramps back +1 per N clean signals, and is inert while AIMD is off.
 */
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  setGlobalConcurrencyCap,
  setGlobalConcurrencyFloor,
  effectiveConcurrencySnapshot,
  recordGlobalConcurrencyPenalty,
  recordGlobalConcurrencyClean,
  AIMD_CLEAN_TURNS_PER_STEP,
} from './governor-registry';

function reset(): void {
  setGlobalConcurrencyCap(undefined); // clears the cap + resets AIMD eff
  setGlobalConcurrencyFloor(undefined);
}
beforeEach(reset);
afterEach(reset);

test('recordGlobalConcurrencyPenalty halves eff toward the floor', () => {
  setGlobalConcurrencyCap(8);
  setGlobalConcurrencyFloor(1);
  expect(effectiveConcurrencySnapshot().effective).toBe(8);
  recordGlobalConcurrencyPenalty();
  expect(effectiveConcurrencySnapshot().effective).toBe(4);
  recordGlobalConcurrencyPenalty();
  expect(effectiveConcurrencySnapshot().effective).toBe(2);
});

test('recordGlobalConcurrencyPenalty never drops eff below the floor', () => {
  setGlobalConcurrencyCap(8);
  setGlobalConcurrencyFloor(3);
  recordGlobalConcurrencyPenalty(); // 8 → 4
  recordGlobalConcurrencyPenalty(); // 4 → max(3, 2) = 3
  recordGlobalConcurrencyPenalty(); // stays at the floor
  expect(effectiveConcurrencySnapshot().effective).toBe(3);
});

test('recordGlobalConcurrencyClean ramps eff back +1 per N clean signals', () => {
  setGlobalConcurrencyCap(4);
  setGlobalConcurrencyFloor(1);
  recordGlobalConcurrencyPenalty(); // 4 → 2
  expect(effectiveConcurrencySnapshot().effective).toBe(2);
  for (let i = 0; i < AIMD_CLEAN_TURNS_PER_STEP; i++) recordGlobalConcurrencyClean();
  expect(effectiveConcurrencySnapshot().effective).toBe(3);
});

test('both seams are no-ops while AIMD is inactive (no finite cap)', () => {
  expect(effectiveConcurrencySnapshot().effective).toBeNull();
  recordGlobalConcurrencyPenalty();
  recordGlobalConcurrencyClean();
  expect(effectiveConcurrencySnapshot().effective).toBeNull();
});
