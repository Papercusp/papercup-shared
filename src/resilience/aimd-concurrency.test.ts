/** Tests for AimdConcurrencyController — the gateway's adaptive admission-concurrency controller
 *  (inference-gateway-robustness-audit-2026-06-20 P1 / B-GW-1). Timer-free + deterministic, so these
 *  drive it purely with record* calls — no fake clock. */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AimdConcurrencyController } from './aimd-concurrency';

test('starts at the cap', () => {
  const c = new AimdConcurrencyController({ cap: 24 });
  assert.equal(c.current, 24);
  assert.equal(c.snapshot().effective, 24);
});

test('a LONE transient throttle does not shrink concurrency (needs sustained pressure)', () => {
  const changes: number[] = [];
  const c = new AimdConcurrencyController({ cap: 24, decreaseThreshold: 4, onChange: (n) => changes.push(n) });
  c.recordThrottle(); // pressure 1 < 4
  assert.equal(c.current, 24, 'one 429 must not move concurrency');
  assert.deepEqual(changes, []);
});

test('SUSTAINED throttle multiplicatively decreases (halve) toward the floor', () => {
  const changes: number[] = [];
  const c = new AimdConcurrencyController({ cap: 24, floor: 1, decreaseThreshold: 4, decreaseFactor: 0.5, onChange: (n) => changes.push(n) });
  for (let i = 0; i < 4; i++) c.recordThrottle(); // trip 1 → 12
  assert.equal(c.current, 12);
  for (let i = 0; i < 4; i++) c.recordThrottle(); // trip 2 → 6
  assert.equal(c.current, 6);
  for (let i = 0; i < 4; i++) c.recordThrottle(); // trip 3 → 3
  assert.equal(c.current, 3);
  for (let i = 0; i < 4; i++) c.recordThrottle(); // trip 4 → 1 (floor(3*0.5)=1)
  assert.equal(c.current, 1);
  assert.deepEqual(changes, [12, 6, 3, 1], 'each trip emits one halving onChange');
});

test('NEVER decreases below the floor under a relentless storm', () => {
  const c = new AimdConcurrencyController({ cap: 32, floor: 3, decreaseThreshold: 2 });
  for (let i = 0; i < 200; i++) c.recordThrottle();
  assert.equal(c.current, 3, 'effective concurrency is pinned at the floor, never lower');
  assert.ok(c.snapshot().decreases > 0);
});

test('additive-increases back toward the cap after a run of clean successes', () => {
  const changes: number[] = [];
  const c = new AimdConcurrencyController({ cap: 8, floor: 1, decreaseThreshold: 2, increaseEvery: 3, onChange: (n) => changes.push(n) });
  for (let i = 0; i < 2; i++) c.recordThrottle(); // 8 → 4
  for (let i = 0; i < 2; i++) c.recordThrottle(); // 4 → 2
  assert.equal(c.current, 2);
  // Now recover: every 3 clean successes earns +1.
  for (let i = 0; i < 3; i++) c.recordSuccess(); // → 3
  assert.equal(c.current, 3);
  for (let i = 0; i < 3; i++) c.recordSuccess(); // → 4
  assert.equal(c.current, 4);
  assert.equal(changes.at(-1), 4);
});

test('additive increase never exceeds the cap', () => {
  const c = new AimdConcurrencyController({ cap: 5, increaseEvery: 1 });
  for (let i = 0; i < 50; i++) c.recordSuccess();
  assert.equal(c.current, 5, 'recovery saturates at the cap');
});

test('successes DRAIN throttle pressure — a few transient 429s among many successes never trip a decrease', () => {
  const c = new AimdConcurrencyController({ cap: 16, decreaseThreshold: 4 });
  // Interleave: 1 throttle then 1 success, repeatedly. Pressure rises to 1 then drains to 0 each round.
  for (let i = 0; i < 50; i++) {
    c.recordThrottle();
    c.recordSuccess();
  }
  assert.equal(c.current, 16, 'a balanced trickle of 429s is not "sustained" — no shrink');
});

test('a throttle-DOMINANT mixed window still trips (robust to interleaved successes)', () => {
  const c = new AimdConcurrencyController({ cap: 16, floor: 1, decreaseThreshold: 4 });
  // 3 throttles per 1 success: net pressure climbs (+3 −1 = +2 per round) → trips.
  for (let round = 0; round < 3; round++) {
    c.recordThrottle();
    c.recordThrottle();
    c.recordThrottle();
    c.recordSuccess();
  }
  assert.ok(c.current < 16, 'a partial (throttle-dominant) storm still shrinks concurrency');
});

test('floor is clamped to ≥1 and to ≤cap', () => {
  assert.equal(new AimdConcurrencyController({ cap: 10, floor: 0 }).snapshot().floor, 1, 'floor ≥ 1');
  assert.equal(new AimdConcurrencyController({ cap: 4, floor: 99 }).snapshot().floor, 4, 'floor ≤ cap');
});

test('recovery resumes from the adapted level (does not jump straight back to cap)', () => {
  const c = new AimdConcurrencyController({ cap: 24, floor: 1, decreaseThreshold: 1, increaseEvery: 1 });
  c.recordThrottle(); // 24 → 12
  c.recordThrottle(); // 12 → 6
  assert.equal(c.current, 6);
  c.recordSuccess(); // 6 → 7 (additive, from the adapted level)
  assert.equal(c.current, 7);
});

test('onChange fires only on an actual change (idempotent at floor / cap)', () => {
  const changes: number[] = [];
  const c = new AimdConcurrencyController({ cap: 4, floor: 2, decreaseThreshold: 1, increaseEvery: 1, onChange: (n) => changes.push(n) });
  c.recordThrottle(); // 4 → 2 (floor)
  c.recordThrottle(); // already at floor → no change, no emit
  c.recordThrottle();
  assert.deepEqual(changes, [2], 'no duplicate onChange while pinned at the floor');
  for (let i = 0; i < 5; i++) c.recordSuccess(); // 2 → 3 → 4 (cap), then stays
  assert.deepEqual(changes, [2, 3, 4], 'no duplicate onChange while saturated at the cap');
});
