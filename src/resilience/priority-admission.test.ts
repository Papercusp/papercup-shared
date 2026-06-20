/** Tests for the PriorityAdmissionQueue (hive-inference-gateway P-011). */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { PriorityAdmissionQueue, QueueFullError, priorityFromLabel } from './priority-admission';

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

test('maxQueued — sheds load (QueueFullError) when slots busy AND queue at cap; frees up after drain', async () => {
  const q = new PriorityAdmissionQueue({ maxConcurrent: 1, maxQueued: 2 });
  let release: () => void = () => {};
  const blocker = q.run(0, () => new Promise<void>((r) => { release = r; })); // occupies the single slot
  await tick();
  const w1 = q.run(0, async () => 'w1'); // queued (1/2)
  const w2 = q.run(0, async () => 'w2'); // queued (2/2 — at cap)
  assert.equal(q.snapshot().queued, 2);
  // 3rd waiter exceeds the cap → synchronous load-shed, NOT a silent unbounded enqueue
  await assert.rejects(
    q.run(0, async () => 'w3'),
    (e: unknown) => e instanceof QueueFullError && (e as QueueFullError).code === 'ADMISSION_QUEUE_FULL',
  );
  assert.equal(q.snapshot().queued, 2, 'shed request was never enqueued');
  // draining the slot runs the queued ones and re-opens admission
  release();
  assert.equal(await w1, 'w1');
  assert.equal(await w2, 'w2');
  let ran = false;
  await q.run(0, async () => { ran = true; });
  assert.equal(ran, true);
});

test('maxQueued — a free slot always runs (the cap only sheds when every slot is busy)', async () => {
  const q = new PriorityAdmissionQueue({ maxConcurrent: 2, maxQueued: 1 });
  // 2 free slots → both admitted immediately even though maxQueued=1 (cap governs WAITERS, not runners)
  assert.equal(await q.run(0, async () => 'a'), 'a');
  assert.equal(await q.run(0, async () => 'b'), 'b');
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
