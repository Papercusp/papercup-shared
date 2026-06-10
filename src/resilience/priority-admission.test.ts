/** Tests for the PriorityAdmissionQueue (hive-inference-gateway P-011). */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { PriorityAdmissionQueue, priorityFromLabel } from './priority-admission';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

test('priorityFromLabel — known labels + numeric + default', () => {
  assert.equal(priorityFromLabel('interactive'), 100);
  assert.equal(priorityFromLabel('queen'), 100);
  assert.equal(priorityFromLabel('high'), 50);
  assert.equal(priorityFromLabel('batch'), 0);
  assert.equal(priorityFromLabel(undefined), 0);
  assert.equal(priorityFromLabel('7'), 7);
  assert.equal(priorityFromLabel('nonsense'), 0);
});

test('admits highest priority first when slots are scarce', async () => {
  const q = new PriorityAdmissionQueue({ maxConcurrent: 1 });
  const order: string[] = [];
  let releaseFirst: () => void = () => {};
  // occupy the single slot with a task we control
  const first = q.run(0, () => new Promise<void>((res) => { releaseFirst = res; }));
  await tick();
  // queue three at mixed priorities while the slot is busy
  const batch = q.run(0, async () => { order.push('batch'); });
  const interactive = q.run(100, async () => { order.push('interactive'); });
  const high = q.run(50, async () => { order.push('high'); });
  releaseFirst();
  await Promise.all([first, batch, interactive, high]);
  assert.deepEqual(order, ['interactive', 'high', 'batch'], 'served strictly by priority');
});

test('respects maxConcurrent (no more than N run at once)', async () => {
  const q = new PriorityAdmissionQueue({ maxConcurrent: 2 });
  let peak = 0;
  let cur = 0;
  const mk = () => q.run(0, async () => {
    cur++;
    peak = Math.max(peak, cur);
    await tick();
    cur--;
  });
  await Promise.all([mk(), mk(), mk(), mk(), mk()]);
  assert.ok(peak <= 2, `peak concurrency ${peak} must be ≤ 2`);
});

test('aging prevents starvation — a long-waiting low priority overtakes fresh high priority', async () => {
  let clock = 0;
  const q = new PriorityAdmissionQueue({ maxConcurrent: 1, agingIntervalMs: 100, now: () => clock });
  const order: string[] = [];
  let release: () => void = () => {};
  const blocker = q.run(0, () => new Promise<void>((r) => { release = r; }));
  await tick();
  // a low-priority item enqueued at t=0
  const low = q.run(1, async () => { order.push('low'); });
  // 1000ms later, a high-priority item arrives — but low has aged +10 (1000/100) → effective 11 > 10
  clock = 1000;
  const high = q.run(10, async () => { order.push('high'); });
  release();
  await Promise.all([blocker, low, high]);
  assert.deepEqual(order, ['low', 'high'], 'aged low-priority overtakes fresh high-priority');
});

test('a task that throws rejects its run() and frees the slot', async () => {
  const q = new PriorityAdmissionQueue({ maxConcurrent: 1 });
  await assert.rejects(q.run(0, async () => { throw new Error('boom'); }), /boom/);
  // slot freed → next task runs
  let ran = false;
  await q.run(0, async () => { ran = true; });
  assert.equal(ran, true);
});

test('snapshot reports running + queued by priority', async () => {
  const q = new PriorityAdmissionQueue({ maxConcurrent: 1 });
  let release: () => void = () => {};
  const blocker = q.run(0, () => new Promise<void>((r) => { release = r; }));
  await tick();
  void q.run(100, async () => {});
  void q.run(100, async () => {});
  void q.run(0, async () => {});
  const s = q.snapshot();
  assert.equal(s.running, 1);
  assert.equal(s.queued, 3);
  assert.deepEqual(s.byPriority, [{ priority: 100, count: 2 }, { priority: 0, count: 1 }]);
  release();
  await blocker;
});
