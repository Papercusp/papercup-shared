/**
 * PriorityAdmissionQueue — a generic, starvation-free, priority + aging admission gate
 * (resilience lib; used by the hive inference gateway, P-011).
 *
 * Bounds how many tasks run at once (`maxConcurrent`) and, when more are waiting than there are
 * slots, admits the HIGHEST-priority waiter first — so an interactive/Queen request jumps the
 * batch-bee backlog. AGING keeps it starvation-free: a queued item's effective priority rises by
 * 1 every `agingIntervalMs` it waits, so a flood of high-priority work can't starve a low one
 * forever. Domain-free (no LLM/account knowledge): the gateway maps roles → numeric priorities and
 * runs the per-request forward inside `run()`; the rate/pause budget is the governor's job, layered
 * inside the task. Pure-ish + fake-clock-testable (`now` injected).
 */
/**
 * Optional PRIORITY-TIER admission layer (gateway-priority-tiers-2026-06-22), gated entirely by the
 * caller — when `tiers` is OMITTED the queue behaves EXACTLY as before (a flat priority+aging gate).
 *
 * A tier is a small integer where 1 is the HIGHEST band (the interactive/Queen lane) and larger
 * numbers are progressively more sheddable batch bands. The tier layer adds two starvation guarantees
 * a flat priority queue can't make:
 *  - a PER-TIER in-flight cap (`caps`): a flood of one tier can't consume every slot,
 *  - a RESERVED tier-1 FLOOR (`tier1Reserve`): a fixed number of slots only tier 1 may ever occupy,
 *    so the interactive lane is never fully crowded out by a saturated batch backlog — the
 *    un-starving piece. Tier > 1 admits only while `running < maxConcurrent - tier1Reserve`; tier 1
 *    may use all `maxConcurrent`.
 *
 * Aging still applies WITHIN the queue's priority ordering (its starvation guard for the FIFO pick);
 * the tier layer adds the cross-tier capacity guarantees on top. All domain-free: the gateway maps a
 * role → tier and passes it on `run()`.
 */
export interface TierAdmissionConfig {
  /** Max IN-FLIGHT tasks per tier (key = tier number). A tier absent from the map is uncapped
   *  (bounded only by `maxConcurrent` and the reserved-floor rule). Values are clamped to ≥1. */
  caps?: Record<number, number>;
  /** Slots RESERVED for tier 1 — tier > 1 is refused admission once `running` reaches
   *  `maxConcurrent - tier1Reserve`, holding that many slots open for the interactive lane even under
   *  a saturated batch backlog. Clamped to [0, maxConcurrent-1] so at least one slot is always shared.
   *  Default 0 (no reservation). */
  tier1Reserve?: number;
}

export interface PriorityAdmissionOptions {
  /** Max tasks running concurrently. */
  maxConcurrent: number;
  /** Each `agingIntervalMs` a waiter sits in the queue, its effective priority rises by 1.
      0/undefined disables aging (strict priority — can starve). Default 1000ms. */
  agingIntervalMs?: number;
  /** Max tasks allowed to WAIT (queue depth) when all slots are busy. Beyond this, `run()` rejects
   *  synchronously with `QueueFullError` so the caller can shed load (e.g. 429 + retry-after) instead
   *  of growing an unbounded backlog. A long-running task that squats its slot (e.g. the gateway
   *  waiting out a sustained upstream throttle) otherwise lets the queue grow without bound until the
   *  process is effectively wedged — load-shedding keeps it responsive + self-recovering.
   *  0/undefined = unbounded (legacy behavior). */
  maxQueued?: number;
  /** OPTIONAL priority-tier layer (per-tier caps + a reserved tier-1 floor). OMIT for the flat
   *  legacy behavior — when absent the queue is byte-identical to a plain priority+aging gate. */
  tiers?: TierAdmissionConfig;
  now?: () => number;
}

/** Thrown by `run()` when the queue is at `maxQueued` and all slots are busy — a load-shed signal,
 *  NOT a task failure. Carries a stable `code` so callers map it to a retryable response. */
export class QueueFullError extends Error {
  readonly code = 'ADMISSION_QUEUE_FULL';
  constructor(queued: number, maxQueued: number) {
    super(`admission queue full (${queued} waiting ≥ cap ${maxQueued})`);
    this.name = 'QueueFullError';
  }
}

interface Waiter<T> {
  priority: number;
  /** Tier band (1 = highest). Defaults to 1 when the caller omits it, so an untagged waiter is
   *  treated as the privileged lane (it competes on raw priority as before). */
  tier: number;
  enqueuedAt: number;
  task: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  seq: number;
}

/** Per-tier admission breakdown (priority-tiers /stats). */
export interface TierSnapshot {
  tier: number;
  /** Configured per-tier in-flight cap, or null when uncapped. */
  cap: number | null;
  /** Tasks of this tier running right now. */
  inFlight: number;
  /** Tasks of this tier waiting in the queue. */
  queued: number;
}

export interface AdmissionSnapshot {
  running: number;
  queued: number;
  maxConcurrent: number;
  /** Queued counts bucketed by raw priority (highest first). */
  byPriority: { priority: number; count: number }[];
  /** Per-tier {cap,inFlight,queued} — present only when the tier layer is configured (else undefined,
   *  so flag-OFF stats are byte-identical to the legacy snapshot). Ascending by tier. */
  byTier?: TierSnapshot[];
  /** Slots reserved for tier 1 (the un-starving floor). Present only with the tier layer. */
  tier1Reserve?: number;
}

export class PriorityAdmissionQueue {
  private maxConcurrent: number;
  private readonly agingIntervalMs: number;
  private readonly maxQueued: number;
  private readonly now: () => number;
  private running = 0;
  private seq = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly waiters: Waiter<any>[] = [];
  /** Tier layer (null when not configured → legacy flat behavior). */
  private readonly tierCaps: Map<number, number> | null;
  private tier1Reserve = 0;
  /** H11 (inference-gateway-audit-2026-06-23): the ORIGINAL tier-1 reserve FRACTION (reserve÷cap at construction)
   *  so setMaxConcurrent can rescale the reserve PROPORTIONALLY as the AIMD shrinks the live cap — instead of
   *  re-clamping the absolute reserve, which swelled a 15%-of-24 reserve to 75% of a 4-slot floor. */
  private reserveFrac = 0;
  /** Live in-flight count per tier (only maintained when the tier layer is on). */
  private readonly inFlightByTier = new Map<number, number>();

  constructor(opts: PriorityAdmissionOptions) {
    this.maxConcurrent = Math.max(1, opts.maxConcurrent);
    this.agingIntervalMs = opts.agingIntervalMs ?? 1000;
    this.maxQueued = opts.maxQueued && opts.maxQueued > 0 ? Math.floor(opts.maxQueued) : 0;
    this.now = opts.now ?? (() => Date.now());
    if (opts.tiers) {
      this.tierCaps = new Map();
      for (const [k, v] of Object.entries(opts.tiers.caps ?? {})) {
        const tier = Number(k);
        if (Number.isFinite(tier) && Number.isFinite(v)) this.tierCaps.set(tier, Math.max(1, Math.floor(v)));
      }
      this.tier1Reserve = this.clampReserve(opts.tiers.tier1Reserve ?? 0);
      this.reserveFrac = this.maxConcurrent > 0 ? (opts.tiers.tier1Reserve ?? 0) / this.maxConcurrent : 0;
    } else {
      this.tierCaps = null;
    }
  }

  /** A reserve must leave ≥1 shared slot, and never exceed the live cap. */
  private clampReserve(n: number): number {
    return Math.min(Math.max(0, Math.floor(n)), Math.max(0, this.maxConcurrent - 1));
  }

  /** Whether the tier layer is active (per-tier caps + reserved tier-1 floor). */
  private get tiered(): boolean {
    return this.tierCaps !== null;
  }

  /** Can a waiter of `tier` be admitted RIGHT NOW given live in-flight + the reserved floor + its cap?
   *  Only consulted when the tier layer is on. */
  private canAdmitTier(tier: number): boolean {
    // Per-tier in-flight cap.
    const cap = this.tierCaps!.get(tier);
    if (cap !== undefined && (this.inFlightByTier.get(tier) ?? 0) >= cap) return false;
    // Reserved tier-1 floor: tier > 1 may not occupy the slots held open for tier 1.
    if (tier > 1 && this.running >= this.maxConcurrent - this.tier1Reserve) return false;
    return true;
  }

  /** Effective priority at `t` — raw priority plus one point per aging interval waited. */
  private effective(w: Waiter<unknown>, t: number): number {
    if (this.agingIntervalMs <= 0) return w.priority;
    return w.priority + Math.floor((t - w.enqueuedAt) / this.agingIntervalMs);
  }

  /** Admit a task at `priority` (higher = sooner). Resolves/rejects with the task's result.
   *  Rejects synchronously with `QueueFullError` when all slots are busy AND the queue is at
   *  `maxQueued` (load-shed) — a free slot always runs the task regardless of the cap.
   *
   *  `opts.tier` (1 = highest band) drives the optional tier layer; it is IGNORED when the queue was
   *  constructed without `tiers` (legacy behavior). Omitting it ⇒ tier 1 (the privileged lane). */
  run<T>(priority: number, task: () => Promise<T>, opts?: { tier?: number }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.maxQueued > 0 && this.running >= this.maxConcurrent && this.waiters.length >= this.maxQueued) {
        reject(new QueueFullError(this.waiters.length, this.maxQueued));
        return;
      }
      const tier = this.tiered ? Math.max(1, Math.floor(opts?.tier ?? 1)) : 1;
      this.waiters.push({ priority, tier, enqueuedAt: this.now(), task, resolve, reject, seq: this.seq++ });
      this.pump();
    });
  }

  private pump(): void {
    while (this.running < this.maxConcurrent && this.waiters.length > 0) {
      const t = this.now();
      // Pick the highest effective priority; ties broken by earliest arrival (FIFO, stable). With the
      // tier layer on, ONLY consider waiters their tier can admit right now — so a saturated low tier
      // (or a tier > 1 blocked by the reserved tier-1 floor) is SKIPPED rather than head-of-line-
      // blocking an admissible higher tier behind it. When no waiter is admissible, stop (the slot is
      // held open — for tier 1, that is exactly the reserved-floor guarantee).
      let bestIdx = -1;
      let bestEff = -Infinity;
      for (let i = 0; i < this.waiters.length; i++) {
        const w = this.waiters[i];
        if (this.tiered && !this.canAdmitTier(w.tier)) continue;
        const eff = this.effective(w, t);
        if (bestIdx === -1 || eff > bestEff || (eff === bestEff && w.seq < this.waiters[bestIdx].seq)) {
          bestEff = eff;
          bestIdx = i;
        }
      }
      if (bestIdx === -1) break; // nothing admissible (e.g. only tier > 1 waiters left, reserve held)
      const w = this.waiters.splice(bestIdx, 1)[0];
      this.running++;
      if (this.tiered) this.inFlightByTier.set(w.tier, (this.inFlightByTier.get(w.tier) ?? 0) + 1);
      const onSettle = () => {
        this.running--;
        if (this.tiered) this.inFlightByTier.set(w.tier, Math.max(0, (this.inFlightByTier.get(w.tier) ?? 0) - 1));
      };
      // Run outside the loop's sync frame; settle → free the slot → pump again.
      void Promise.resolve()
        .then(() => w.task())
        .then(
          (v) => {
            onSettle();
            w.resolve(v);
            this.pump();
          },
          (e) => {
            onSettle();
            w.reject(e);
            this.pump();
          },
        );
    }
  }

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, Math.floor(n));
    // H11 (2026-06-23): RESCALE the reserve proportionally to the new live cap (round(cap × reserveFrac)), not
    // just re-clamp the absolute reserve — else when the AIMD shrinks the cap to the floor, a 15%-of-24 reserve
    // (=4) stays ~4 and becomes 3-of-4 live slots (75%), starving su + every bee tier to ONE shared slot exactly
    // when the fleet most needs throughput. clampReserve still guarantees ≥1 shared slot stays open.
    if (this.tiered) this.tier1Reserve = this.clampReserve(Math.round(this.maxConcurrent * this.reserveFrac));
    this.pump();
  }

  /** Adjust the reserved tier-1 floor live (tier-aware shedding shrinks/grows it). No-op without the
   *  tier layer. Clamped so ≥1 slot always stays shared. */
  setTier1Reserve(n: number): void {
    if (!this.tiered) return;
    this.tier1Reserve = this.clampReserve(n);
    this.pump();
  }

  /** Adjust a single tier's in-flight cap live (tier-aware shedding shrinks tier 4→3→2 under 429
   *  pressure, holding tier 1). No-op without the tier layer. `cap` is clamped to ≥1. */
  setTierCap(tier: number, cap: number): void {
    if (!this.tiered) return;
    this.tierCaps!.set(tier, Math.max(1, Math.floor(cap)));
    // A raised cap may newly admit; a lowered cap can't evict an already-running task (it only gates
    // future admission), so pump() is safe + sufficient.
    this.pump();
  }

  /** The configured cap for a tier, or null when uncapped / no tier layer. */
  tierCap(tier: number): number | null {
    return this.tierCaps?.get(tier) ?? null;
  }

  get reservedTier1(): number {
    return this.tiered ? this.tier1Reserve : 0;
  }

  get size(): number {
    return this.waiters.length;
  }
  get inFlight(): number {
    return this.running;
  }

  snapshot(): AdmissionSnapshot {
    const byPriority = new Map<number, number>();
    for (const w of this.waiters) byPriority.set(w.priority, (byPriority.get(w.priority) ?? 0) + 1);
    const base: AdmissionSnapshot = {
      running: this.running,
      queued: this.waiters.length,
      maxConcurrent: this.maxConcurrent,
      byPriority: [...byPriority.entries()].sort((a, b) => b[0] - a[0]).map(([priority, count]) => ({ priority, count })),
    };
    if (!this.tiered) return base; // flag-OFF: byte-identical to the legacy snapshot
    const queuedByTier = new Map<number, number>();
    for (const w of this.waiters) queuedByTier.set(w.tier, (queuedByTier.get(w.tier) ?? 0) + 1);
    // Union of every tier that has a cap, an in-flight task, or a waiter — so /stats shows a known
    // tier even at zero load.
    const tiers = new Set<number>([...this.tierCaps!.keys(), ...this.inFlightByTier.keys(), ...queuedByTier.keys()]);
    base.byTier = [...tiers]
      .sort((a, b) => a - b)
      .map((tier) => ({
        tier,
        cap: this.tierCaps!.get(tier) ?? null,
        inFlight: this.inFlightByTier.get(tier) ?? 0,
        queued: queuedByTier.get(tier) ?? 0,
      }));
    base.tier1Reserve = this.tier1Reserve;
    return base;
  }
}

/** Map a request priority label/number to a numeric admission priority (higher = sooner). */
export function priorityFromLabel(label: string | number | undefined): number {
  if (typeof label === 'number') return label;
  switch ((label ?? '').toLowerCase()) {
    case 'interactive':
    case 'operator':
    case 'queen':
      return 100;
    case 'high':
      return 50;
    case 'low':
    case 'batch':
    case 'bee':
    case '':
      return 0;
    default: {
      const n = Number(label);
      return Number.isFinite(n) ? n : 0;
    }
  }
}

// ── Priority TIER mapping (gateway-priority-tiers-2026-06-22) ───────────────────────────────────────
//
// A TIER is the small admission band a role belongs to (1 = the highest, most-protected interactive
// lane; larger = more sheddable batch). Distinct from the `priorityFromLabel` number, which still
// orders WITHIN the queue; the tier drives the per-tier caps + the reserved tier-1 floor. Lower tier
// number = higher protection — the inverse of the priority number's "higher = sooner".

/** A role/label → tier map. Lower tier = more protected. */
export type PriorityTierMap = Record<string, number>;

/** The fallback band for any role not named in the map (the most-sheddable lane). */
export const DEFAULT_TIER = 4;

/** Default role → tier map (gateway-priority-tiers-2026-06-22). Env-overridable via
 *  `GATEWAY_PRIORITY_MAP` (a JSON object of `role: tier`, merged over these defaults), parsed by
 *  `parsePriorityTierMap`. The `default` key sets the fallback band for unnamed roles. */
export const DEFAULT_GATEWAY_PRIORITY_MAP: PriorityTierMap = {
  queen: 1,
  scout: 1,
  overwatch: 1,
  operator: 1,
  interactive: 1,
  su: 2,
  bee: 3,
  default: DEFAULT_TIER,
};

/** Parse a `GATEWAY_PRIORITY_MAP` JSON env value, MERGED over the defaults. Invalid JSON / non-numeric
 *  entries are ignored (fail-safe to the defaults). Keys are lower-cased so the lookup is
 *  case-insensitive. */
export function parsePriorityTierMap(raw: string | undefined, base: PriorityTierMap = DEFAULT_GATEWAY_PRIORITY_MAP): PriorityTierMap {
  const map: PriorityTierMap = {};
  for (const [k, v] of Object.entries(base)) map[k.toLowerCase()] = v;
  if (!raw) return map;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [k, v] of Object.entries(parsed)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 1) map[k.toLowerCase()] = Math.floor(n);
    }
  } catch {
    /* malformed env → keep the defaults (fail-safe) */
  }
  return map;
}

/** Resolve the admission TIER for a request's priority label / caller role. `label` is the
 *  `x-papercusp-priority` header value (a role name like `queen`/`bee`/`su`, an interactive alias, or
 *  a bare tier number). A numeric label is taken as the tier directly (clamped to ≥1); an unknown
 *  label falls back to the map's `default` band. */
export function tierOf(label: string | number | undefined, map: PriorityTierMap = DEFAULT_GATEWAY_PRIORITY_MAP): number {
  const fallback = map.default ?? DEFAULT_TIER;
  if (typeof label === 'number') return Number.isFinite(label) ? Math.max(1, Math.floor(label)) : fallback;
  const key = (label ?? '').trim().toLowerCase();
  if (key === '') return fallback;
  if (key in map && key !== 'default') return map[key];
  // A bare numeric string ("2") is an explicit tier.
  const n = Number(key);
  if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  return fallback;
}

/** The set of distinct tiers a map can produce (every value + the `default` fallback), ascending. */
export function tiersOfMap(map: PriorityTierMap = DEFAULT_GATEWAY_PRIORITY_MAP): number[] {
  const tiers = new Set<number>();
  for (const [k, v] of Object.entries(map)) {
    if (Number.isFinite(v) && v >= 1) tiers.add(Math.floor(v));
    if (k === 'default' && Number.isFinite(v)) tiers.add(Math.floor(v));
  }
  if (tiers.size === 0) tiers.add(DEFAULT_TIER);
  return [...tiers].sort((a, b) => a - b);
}

/** Steady-state per-tier in-flight caps for a pool of `poolSlots`. Tier 1 may use the WHOLE pool (it is
 *  the protected interactive lane); every tier > 1 is capped at `poolSlots - reserve` so it can never
 *  consume the slots held open for tier 1. `reserve = max(1, ceil(poolSlots * reserveFrac))`. The caps
 *  are a *ceiling* — the reserved-floor rule in the queue is the hard tier-1 guarantee; these caps just
 *  stop a single non-tier-1 band from monopolising the shared pool. */
export function defaultTierCaps(poolSlots: number, tiers: number[], reserveFrac = 0.15): { caps: Record<number, number>; reserve: number } {
  const slots = Math.max(1, Math.floor(poolSlots));
  const reserve = Math.max(1, Math.ceil(slots * Math.max(0, reserveFrac)));
  const sharedCap = Math.max(1, slots - reserve);
  const caps: Record<number, number> = {};
  for (const t of tiers) caps[t] = t <= 1 ? slots : sharedCap;
  return { caps, reserve };
}

/** TIER-AWARE LOAD-SHEDDING (gateway-priority-tiers-2026-06-22, step 4). Given the steady-state `base`
 *  caps and how many concurrency slots have been lost (`shed = cap - effective`, the AIMD shrink),
 *  shrink the MOST-SHEDDABLE bands FIRST — the highest tier number down to (but never including) tier 1 —
 *  by removing `shed` units of headroom bottom-up. Tier 1 is NEVER reduced (the interactive lane is held
 *  whole even under a full storm); a band can be squeezed to a floor of 1. Returns the adjusted caps.
 *
 *  Bottom-up ordering ("4 → 3 → 2 first, hold tier 1") means a partial storm degrades batch throughput
 *  before it ever touches su (tier 2), and only an extreme storm pins every non-tier-1 band at 1 — tier 1
 *  still admits at full pool width. Pure + deterministic (no clock / no queue mutation): the gateway calls
 *  it on each AIMD change and applies the result via `queue.setTierCap`. */
export function shedTierCaps(base: Record<number, number>, shed: number): Record<number, number> {
  const out: Record<number, number> = { ...base };
  let remaining = Math.max(0, Math.floor(shed));
  if (remaining === 0) return out;
  // Most-sheddable first: highest tier number down to 2 (tier 1 is held).
  const order = Object.keys(out)
    .map(Number)
    .filter((t) => t > 1)
    .sort((a, b) => b - a);
  for (const t of order) {
    if (remaining <= 0) break;
    const headroom = Math.max(0, out[t] - 1); // never below 1
    const take = Math.min(headroom, remaining);
    out[t] -= take;
    remaining -= take;
  }
  return out;
}
