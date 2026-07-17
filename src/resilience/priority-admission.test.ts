/** Tests for the PriorityAdmissionQueue (hive-inference-gateway P-011). */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  PriorityAdmissionQueue,
  QueueFullError,
  priorityFromLabel,
  tierOf,
  tiersOfMap,
  defaultTierCaps,
  shedTierCaps,
  parsePriorityTierMap,
  DEFAULT_GATEWAY_PRIORITY_MAP,
  DEFAULT_TIER,
} from './priority-admission';

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

test('maintenance lane (deterministic-context-carry P-002): compaction/summarizer labels order above high, below interactive, and ride tier 1', () => {
  assert.equal(priorityFromLabel('maintenance'), 75);
  assert.equal(priorityFromLabel('compaction'), 75);
  assert.ok(priorityFromLabel('maintenance') > priorityFromLabel('high'));
  assert.ok(priorityFromLabel('maintenance') < priorityFromLabel('interactive'));
  // Tier 1 = never AIMD-shed + reserved floor — the "small reserved budget for maintenance calls".
  assert.equal(tierOf('maintenance'), 1);
  assert.equal(tierOf('compaction'), 1);
  assert.equal(DEFAULT_GATEWAY_PRIORITY_MAP.maintenance, 1);
  assert.equal(DEFAULT_GATEWAY_PRIORITY_MAP.compaction, 1);
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

// ── Priority TIER layer (gateway-priority-tiers-2026-06-22) ─────────────────────────────────────────

test('tier layer OMITTED → snapshot byte-identical to legacy (no byTier / tier1Reserve fields)', async () => {
  const q = new PriorityAdmissionQueue({ maxConcurrent: 1 });
  let release: () => void = () => {};
  const blocker = q.run(0, () => new Promise<void>((r) => { release = r; }));
  await tick();
  // a tier passed on run() is IGNORED with no tier config
  void q.run(0, async () => {}, { tier: 3 });
  const s = q.snapshot();
  assert.equal(s.byTier, undefined, 'no byTier without the tier layer');
  assert.equal(s.tier1Reserve, undefined, 'no tier1Reserve without the tier layer');
  release();
  await blocker;
});

test('tierOf — role map, numeric label, bare-numeric string, unknown → default', () => {
  assert.equal(tierOf('queen'), 1);
  assert.equal(tierOf('scout'), 1);
  assert.equal(tierOf('overwatch'), 1);
  assert.equal(tierOf('su'), 2);
  assert.equal(tierOf('bee'), 3);
  assert.equal(tierOf('gym'), 4);
  assert.equal(tierOf('benchmark'), 4);
  assert.equal(tierOf('llm-testing'), 4, 'EI-315: llm-testing shares the gym/benchmark batch band, not the bottom default');
  assert.equal(tierOf('worker'), DEFAULT_TIER, 'unknown role → default band');
  assert.equal(tierOf(undefined), DEFAULT_TIER);
  assert.equal(tierOf(''), DEFAULT_TIER);
  assert.equal(tierOf(2), 2, 'numeric label is the tier directly');
  assert.equal(tierOf('2'), 2, 'bare-numeric string is an explicit tier');
  assert.equal(tierOf(0), 1, 'tier clamped to ≥1');
  assert.equal(tierOf('QUEEN'), 1, 'case-insensitive');
});

test('parsePriorityTierMap — merges over defaults; ignores malformed / non-numeric', () => {
  assert.deepEqual(parsePriorityTierMap(undefined), { ...mapLower(DEFAULT_GATEWAY_PRIORITY_MAP) });
  const merged = parsePriorityTierMap('{"bee":4,"newrole":2}');
  assert.equal(merged.bee, 4, 'override applied');
  assert.equal(merged.newrole, 2, 'new key added');
  assert.equal(merged.queen, 1, 'untouched defaults remain');
  // malformed JSON → fall back to defaults (fail-safe)
  assert.deepEqual(parsePriorityTierMap('{not json'), mapLower(DEFAULT_GATEWAY_PRIORITY_MAP));
  // non-numeric / <1 entries ignored
  const bad = parsePriorityTierMap('{"bee":"x","scout":0}');
  assert.equal(bad.bee, 3, 'non-numeric ignored → default');
  assert.equal(bad.scout, 1, '<1 ignored → default');
});

function mapLower(m: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(m)) out[k.toLowerCase()] = v;
  return out;
}

test('tiersOfMap — distinct tiers incl. default, ascending', () => {
  assert.deepEqual(tiersOfMap(DEFAULT_GATEWAY_PRIORITY_MAP), [1, 2, 3, 4, 5]);
});

test('H11 (2026-06-23): setMaxConcurrent RESCALES the tier-1 reserve proportionally — the AIMD floor no longer starves tiers >1', () => {
  const q = new PriorityAdmissionQueue({ maxConcurrent: 24, tiers: { caps: { 1: 24, 2: 20, 3: 20, 4: 8 }, tier1Reserve: 4 } });
  assert.equal(q.snapshot().tier1Reserve, 4, 'full pool: the configured ~15% reserve = 4');
  // AIMD shrinks the cap to the floor. OLD bug: clampReserve(4) → maxConcurrent-1 = 3, i.e. 3-of-4 slots (75%)
  // reserved for tier 1, leaving su + every bee tier ONE shared slot. Now it rescales to round(4 × 4/24) = 1.
  q.setMaxConcurrent(4);
  assert.equal(q.snapshot().tier1Reserve, 1, 'floor: reserve rescaled to 1 → tiers >1 keep 3 of 4 slots, not 1');
  q.setMaxConcurrent(2);
  assert.equal(q.snapshot().tier1Reserve, 1, 'tiny live pool: reserve remains 1 so tier 1 still has a floor');
  q.setMaxConcurrent(24); // recovery restores the proportional reserve
  assert.equal(q.snapshot().tier1Reserve, 4, 'recovery: reserve scales back to 4');
});

test('defaultTierCaps — tier 1 gets the whole pool; implementation tiers share; benchmark/default bands are bounded', () => {
  const { caps, reserve } = defaultTierCaps(20, [1, 2, 3, 4, 5], 0.15);
  assert.equal(reserve, 3, 'ceil(20*0.15)=3');
  assert.equal(caps[1], 20, 'tier 1 may use the whole pool');
  assert.equal(caps[2], 17, 'tier 2 may use the shared pool');
  assert.equal(caps[3], 17);
  assert.equal(caps[4], 9, 'benchmark/gym tier gets a bounded frame');
  assert.equal(caps[5], 6, 'unlabeled/default traffic is more tightly bounded than benchmark/gym');
  // reserve floored at 1 even for a tiny pool / tiny frac
  assert.equal(defaultTierCaps(2, [1, 2], 0).reserve, 1, 'reserve never below 1');
  assert.equal(defaultTierCaps(2, [1, 2], 0).caps[2], 1, 'shared cap never below 1');
});

test('shedTierCaps — sheds the bottom band(s) first, holds tier 1, floor of 1', () => {
  const base = { 1: 20, 2: 17, 3: 17, 4: 9, 5: 6 };
  // shed 0 → unchanged
  assert.deepEqual(shedTierCaps(base, 0), base);
  // shed 5 → all from tier 5 (most sheddable) first
  assert.deepEqual(shedTierCaps(base, 5), { 1: 20, 2: 17, 3: 17, 4: 9, 5: 1 });
  // shed 12 → tier 5 to floor 1 (−5), then tier 4 (−7)
  assert.deepEqual(shedTierCaps(base, 12), { 1: 20, 2: 17, 3: 17, 4: 2, 5: 1 });
  // an extreme shed pins every non-tier-1 band at 1 but NEVER touches tier 1
  const extreme = shedTierCaps(base, 1000);
  assert.equal(extreme[1], 20, 'tier 1 is never reduced');
  assert.equal(extreme[2], 1);
  assert.equal(extreme[3], 1);
  assert.equal(extreme[4], 1);
  assert.equal(extreme[5], 1);
});

test('reserved tier-1 FLOOR holds — a saturated low tier cannot crowd out tier 1', async () => {
  // 4 slots, reserve 1 for tier 1. Fill 3 slots with tier-3 work (≤ maxConcurrent-reserve=3), then a
  // tier-1 request must still be admittable into the held-open 4th slot.
  const q = new PriorityAdmissionQueue({ maxConcurrent: 4, agingIntervalMs: 0, tiers: { tier1Reserve: 1 } });
  const releases: Array<() => void> = [];
  const block = (tier: number) => q.run(0, () => new Promise<void>((r) => releases.push(r)), { tier });
  void block(3); void block(3); void block(3);
  await tick();
  // a 4th tier-3 must NOT be admitted (reserve holds the last slot for tier 1)
  void block(3);
  await tick();
  assert.equal(q.inFlight, 3, 'tier>1 blocked at maxConcurrent - reserve');
  // tier 1 jumps straight into the reserved slot
  let t1ran = false;
  const t1 = q.run(0, async () => { t1ran = true; }, { tier: 1 });
  await tick();
  assert.equal(t1ran, true, 'tier 1 admitted into the reserved floor while tier 3 is held');
  releases.forEach((r) => r());
  await Promise.all([t1]);
});

test('tier 1 jumps ahead of a saturated tier 3 (un-starving core)', async () => {
  // 2 slots. Tier 3 is capped at 1 in-flight. A held tier-3 task SATURATES that cap, so the only
  // admissible band for the second free slot is the lower-seq tier-3 backlog *or* tier 1 — and because
  // tier 3's cap is full, ONLY tier 1 (and any uncapped band) can take that slot. Tier 1 wins even
  // though the tier-3 waiters arrived first (lower seq) — the un-starving guarantee.
  const q = new PriorityAdmissionQueue({ maxConcurrent: 2, agingIntervalMs: 0, tiers: { caps: { 3: 1 }, tier1Reserve: 0 } });
  const order: string[] = [];
  let releaseHeld: () => void = () => {};
  const held = q.run(0, () => new Promise<void>((r) => { releaseHeld = r; }), { tier: 3 }); // saturates tier-3 cap
  await tick();
  assert.equal(q.inFlight, 1, 'one tier-3 holds the cap; a slot is free');
  // queue a flood of tier-3 work (arriving FIRST) + one tier-1 at the SAME raw priority.
  const b1 = q.run(0, async () => { order.push('t3a'); }, { tier: 3 });
  const b2 = q.run(0, async () => { order.push('t3b'); }, { tier: 3 });
  const t1 = q.run(0, async () => { order.push('t1'); }, { tier: 1 });
  await tick();
  // the free slot went to tier 1 — the tier-3 backlog is blocked by its own saturated cap, NOT served
  // ahead of the higher band just because it enqueued earlier.
  assert.deepEqual(order, ['t1'], 'tier 1 served into the free slot; the capped tier-3 backlog waits');
  releaseHeld();
  await Promise.all([held, b1, b2, t1]);
  assert.equal(order[0], 't1', 'tier 1 served first, ahead of the earlier-arriving saturated tier-3 backlog');
});

// WI-4541 — SEMANTICS CHANGE (deliberate). This test previously asserted the OPPOSITE:
// `peak3 === 1` — "tier 3 never exceeded its cap of 1 despite 4 free slots". That hard-ceiling
// reading of the cap IS the bug: it makes the queue refuse work while the pool sits idle. The cap
// is now a GUARANTEED MINIMUM SHARE (the slots a tier may take without yielding to its betters),
// not an idle-capacity ceiling. The guarantees that actually matter — the tier-1 reserve, and
// yielding to an outranking waiter — are asserted in the tests below and still hold.
test('per-tier cap is a MINIMUM SHARE, not an idle-capacity ceiling — an unopposed tier borrows free slots (WI-4541)', async () => {
  const q = new PriorityAdmissionQueue({ maxConcurrent: 4, agingIntervalMs: 0, tiers: { caps: { 3: 1 }, tier1Reserve: 0 } });
  let peak3 = 0, cur3 = 0;
  const mk = (tier: number) => q.run(0, async () => {
    if (tier === 3) { cur3++; peak3 = Math.max(peak3, cur3); }
    await tick();
    if (tier === 3) cur3--;
  }, { tier });
  await Promise.all([mk(3), mk(3), mk(3), mk(3)]);
  // 3, not 4: borrowing leaves a headroom slot free (max(tier1Reserve,1)) so a tier-1 arrival is
  // still admitted instantly — a borrowed slot can't be preempted. The pool is USED (3 of 4) instead
  // of serialized to 1, without giving up the interactive lane's instant admission.
  assert.equal(peak3, 3, 'tier 3 borrowed the idle slots above its cap of 1, holding one back as tier-1 headroom');
});

// ── WI-4541 regression guard: the live pathology, reproduced exactly ────────────────────────────
// Measured on the running gateway 2026-07-13: maxConcurrent shed 24→12 by AIMD, tier1Reserve 2, and
// EVERY request untagged → DEFAULT_TIER 5, whose cap the shed had driven to its floor of 1. Result:
// t5[cap1 f1 q3] with tiers 2/3/4 EMPTY and 9-10 of 12 slots idle — the whole fleet single-file
// through ONE slot, which is what left the owner's voice turn "processing forever" (EI-10795).
// Pre-fix this asserts peak === 1; the fix must let the idle pool actually be used.
test('WI-4541 repro — a bottom-tier flood with an AIMD-shed cap of 1 must still USE the idle pool, not serialize', async () => {
  const q = new PriorityAdmissionQueue({
    maxConcurrent: 12,
    agingIntervalMs: 0,
    tiers: { caps: { 1: 24, 2: 20, 3: 20, 4: 4, 5: 1 }, tier1Reserve: 2 }, // the live shed caps
  });
  let peak = 0, cur = 0;
  const mk = () => q.run(0, async () => {
    cur++; peak = Math.max(peak, cur);
    await tick();
    cur--;
  }, { tier: 5 });
  await Promise.all(Array.from({ length: 8 }, mk));
  assert.ok(peak > 1, `the fleet must not serialize through one slot (peak was ${peak})`);
  assert.equal(peak, 8, 'all 8 untagged requests ran concurrently — bounded by maxConcurrent-reserve=10, not the shed cap of 1');
});

test('WI-4541 — borrowing NEVER erodes the reserved tier-1 floor, even under a bottom-tier flood', async () => {
  const q = new PriorityAdmissionQueue({
    maxConcurrent: 12,
    agingIntervalMs: 0,
    tiers: { caps: { 1: 24, 5: 1 }, tier1Reserve: 2 },
  });
  const releases: Array<() => void> = [];
  // 20 tier-5 tasks flood the queue and borrow every slot they are allowed to hold.
  for (let i = 0; i < 20; i++) void q.run(0, () => new Promise<void>((r) => releases.push(r)), { tier: 5 });
  await tick();
  assert.equal(q.inFlight, 10, 'tier>1 borrowing stops at maxConcurrent - tier1Reserve (12-2), never inside the reserve');
  // A tier-1 (interactive) arrival still gets a slot IMMEDIATELY out of the reserve.
  let interactiveRan = false;
  void q.run(100, async () => { interactiveRan = true; }, { tier: 1 });
  await tick();
  assert.equal(interactiveRan, true, 'the interactive lane admits instantly into its reserved floor despite the flood');
  releases.forEach((r) => r());
});

test('WI-4541 — a tier at its cap YIELDS to an outranking waiter (tiers break the priority tie)', async () => {
  // Both bands carry raw priority 0 (priorityFromLabel scores su/scout/bee/untagged alike), so the
  // TIER — not the numeric priority — is what must decide. The at-cap tier must not borrow over the
  // head of a better waiter that arrived later.
  const q = new PriorityAdmissionQueue({ maxConcurrent: 2, agingIntervalMs: 0, tiers: { caps: { 5: 1 }, tier1Reserve: 0 } });
  const order: string[] = [];
  let releaseHeld: () => void = () => {};
  void q.run(0, () => new Promise<void>((r) => { releaseHeld = r; }), { tier: 5 }); // saturates tier-5's cap
  await tick();
  assert.equal(q.inFlight, 1, 'one tier-5 in flight; one slot free');
  const t5 = q.run(0, async () => { order.push('t5'); }, { tier: 5 }); // arrives FIRST
  const t2 = q.run(0, async () => { order.push('t2'); }, { tier: 2 }); // arrives SECOND, outranks
  await tick();
  assert.deepEqual(order, ['t2'], 'the free slot went to the outranking tier-2 — the at-cap tier-5 yielded despite arriving first');
  releaseHeld();
  await Promise.all([t5, t2]);
});

test('snapshot byTier — {cap, inFlight, queued} per tier + tier1Reserve', async () => {
  const q = new PriorityAdmissionQueue({ maxConcurrent: 2, agingIntervalMs: 0, tiers: { caps: { 1: 2, 3: 1 }, tier1Reserve: 1 } });
  const releases: Array<() => void> = [];
  const block = (tier: number) => q.run(0, () => new Promise<void>((r) => releases.push(r)), { tier });
  void block(3); // runs (1 in-flight, ≤ maxConcurrent-reserve=1)
  await tick();
  void block(3); // queued (tier-3 cap=1 reached)
  void block(1); // runs into the reserved tier-1 slot
  await tick();
  const s = q.snapshot();
  assert.ok(s.byTier, 'byTier present with the tier layer');
  assert.equal(s.tier1Reserve, 1);
  const t1 = s.byTier!.find((t) => t.tier === 1)!;
  const t3 = s.byTier!.find((t) => t.tier === 3)!;
  assert.deepEqual({ cap: t1.cap, inFlight: t1.inFlight }, { cap: 2, inFlight: 1 });
  assert.deepEqual({ cap: t3.cap, inFlight: t3.inFlight, queued: t3.queued }, { cap: 1, inFlight: 1, queued: 1 });
  releases.forEach((r) => r());
});

// WI-4541 — SEMANTICS CHANGE (deliberate). This test previously asserted that a tier-3 cap of 1
// "holds the second" tier-3 task *while 3 slots sat free*. That is exactly the pathology: refusing
// work into an idle pool. An unopposed tier now borrows, so a raised cap changes nothing when
// nothing is contending. setTierCap's real contract — the yield-free GUARANTEED SHARE a tier holds
// against an outranking waiter — is what this now pins.
test('setTierCap raises the yield-free guaranteed share (tier-aware un-shed)', async () => {
  // 4 slots, no reserve → borrowing may use up to maxConcurrent - max(reserve,1) = 3.
  const q = new PriorityAdmissionQueue({ maxConcurrent: 4, agingIntervalMs: 0, tiers: { caps: { 3: 1 }, tier1Reserve: 0 } });
  const releases: Array<() => void> = [];
  const hold = (tier: number) => q.run(0, () => new Promise<void>((r) => releases.push(r)), { tier });
  void hold(3); // t3 #1 → admitted UNDER its cap of 1
  void hold(3); // t3 #2 → BORROWS an idle slot (nobody outranks it)
  await tick();
  assert.equal(q.inFlight, 2, 'the idle pool is used — the second tier-3 borrowed rather than waiting');
  const snap = q.snapshot();
  assert.equal(snap.byTier!.find((t) => t.tier === 3)!.inFlight, 2, 'tier 3 borrowed above its cap of 1');
  q.setTierCap(3, 2); // raise the guaranteed share to match what it is actually holding
  assert.equal(q.snapshot().byTier!.find((t) => t.tier === 3)!.cap, 2, 'raised cap is live in the snapshot');
  releases.forEach((r) => r());
});

// ── P-005/W3 slot-leak recurrence guard (D-001): `running` must return to 0 after EVERY settle mode ──
// The gateway wraps each request forward inside `queue.run(...)`, so a leaked admission slot is a task
// promise that never settles. These pin down the queue's half of the invariant: whatever way a task
// settles (resolve / handler-error / abort / idle-timeout), its slot frees — and a genuinely stuck task
// holds exactly its slot (which the gateway's reconcile guard then surfaces), never a miscount.

test('P-005/W3: inFlight returns to 0 after every settle mode (resolve / handler-error / abort / idle-timeout)', async () => {
  const q = new PriorityAdmissionQueue({ maxConcurrent: 4 });
  const ac = new AbortController();
  // (1) normal resolve.
  const ok = q.run(0, async () => 'ok');
  // (2) handler-error — the task throws (a proxy handler crash).
  const boom = q.run(0, async () => {
    throw new Error('handler crashed');
  });
  // (3) abort-driven reject — client-disconnect / hard-ceiling. Mirrors the gateway's own already-aborted
  //     guard so the abort is race-free regardless of when the task body starts.
  const aborted = q.run(
    0,
    () =>
      new Promise<void>((_res, rej) => {
        const onAbort = () => rej(new Error('aborted'));
        if (ac.signal.aborted) onAbort();
        else ac.signal.addEventListener('abort', onAbort, { once: true });
      }),
  );
  // (4) idle-timeout — rejects after a short idle deadline.
  const idle = q.run(0, () => new Promise<void>((_res, rej) => { setTimeout(() => rej(new Error('idle timeout')), 5); }));

  // All four admitted synchronously (running bumped in pump); none has settled yet.
  assert.equal(q.inFlight, 4, 'four admitted tasks hold four slots');

  ac.abort(); // fire the client-disconnect / ceiling abort
  await Promise.allSettled([ok, boom, aborted, idle]);
  await tick(); // let the settle → onSettle → pump microtasks drain

  assert.equal(q.inFlight, 0, 'every settle mode frees its admission slot — no leak');
});

test('P-005/W3: a task that never settles holds exactly its slot (the real leak, correctly reflected); settling frees it', async () => {
  const q = new PriorityAdmissionQueue({ maxConcurrent: 2 });
  let release: () => void = () => {};
  const stuck = q.run(0, () => new Promise<void>((res) => { release = res; })); // never settles on its own
  await q.run(0, async () => 'done'); // a sibling completes cleanly
  await tick();
  assert.equal(q.inFlight, 1, 'the stuck task pins exactly one slot — running tracks true liveness, not a miscount');
  release();
  await stuck;
  await tick();
  assert.equal(q.inFlight, 0, 'once the stuck task settles, running returns to 0');
});
