/**
 * AimdConcurrencyController — an AIMD (additive-increase / multiplicative-decrease) controller for a
 * concurrency limit, used to drive a `PriorityAdmissionQueue`'s effective `maxConcurrent` down under
 * sustained upstream throttling and back up when traffic is clean (the hive inference gateway,
 * inference-gateway-robustness-audit-2026-06-20 P1).
 *
 * The problem it solves: the gateway forwards at a FIXED admission concurrency. Under a sustained
 * pool-wide 429 storm every slot squats on the internal retry/wait budget AND each retry ADDS to the
 * per-IP RPM — a positive-feedback retry-storm that worsens the very throttle it reacts to. AIMD
 * breaks the loop: shrink the number of concurrent upstream calls when throttled (fewer calls = lower
 * per-IP RPM = the throttle eases) and grow it back additively when calls are succeeding.
 *
 * Semantics mirror the fleet AIMD gate (`agent/governor-registry.ts`, rate-limit-layer-v2 D-005):
 * multiplicative decrease (halve toward the floor) under sustained throttle, additive increase (+1
 * toward the cap) per run of clean successes, never below `floor` (≥1).
 *
 * Design choices that keep it robust + testable:
 *  - TIMER-FREE + deterministic: it adapts purely from the `recordThrottle()`/`recordSuccess()` event
 *    stream — no clock, no background interval — so there is no lifecycle to manage and a unit test
 *    drives it with plain calls (no fake clock needed).
 *  - "SUSTAINED", not a lone transient 429: a leaky-bucket of throttle pressure — each throttle adds
 *    1, each success drains 1 — so a few transient 429s scattered among successes never trip a
 *    decrease, but a throttle-DOMINANT window crosses `decreaseThreshold` and halves. Robust to MIXED
 *    traffic (a partial storm still trips), unlike a strict consecutive-streak which a single
 *    interleaved success would reset.
 *  - Domain-free (no LLM/account/HTTP knowledge): the caller decides what a "throttle" vs a "success"
 *    is and wires `onChange` to whatever applies the new limit (e.g. `queue.setMaxConcurrent`).
 */
export interface AimdConcurrencyOptions {
  /** The maximum / normal concurrency — the additive-increase ceiling AND the start value. */
  cap: number;
  /** Never decrease below this (clamped to ≥1, and to ≤cap). Default 1. */
  floor?: number;
  /** Multiplicative-decrease factor applied on a sustained-throttle trip (0 < f < 1). Default 0.5 (halve). */
  decreaseFactor?: number;
  /** Net throttle pressure (throttles minus successes, floored at 0) that trips ONE multiplicative
   *  decrease. Higher = more tolerant of transient 429s before shrinking. Default 4. */
  decreaseThreshold?: number;
  /** Consecutive clean successes that earn ONE additive +1 step back toward the cap. Default 5
   *  (mirrors the fleet AIMD's AIMD_CLEAN_TURNS_PER_STEP — a gentle recovery). */
  increaseEvery?: number;
  /** Called whenever the effective concurrency CHANGES. Wire to e.g. `queue.setMaxConcurrent`. Must
   *  not throw (it is called synchronously inside record*). */
  onChange?: (effective: number) => void;
}

/** Read-only view of an AIMD controller's state (observability — surfaced on the gateway `/stats`). */
export interface AimdSnapshot {
  /** The current effective concurrency (floor ≤ effective ≤ cap). */
  effective: number;
  cap: number;
  floor: number;
  /** Current leaky-bucket throttle pressure (resets to 0 each time it trips a decrease). */
  pressure: number;
  /** Clean-success progress toward the next additive increase since the last DECREASE. An absorbed
   *  (sub-threshold) throttle neither advances nor resets it — only a real decrease resets it — so a
   *  steady churn of transient 429s among successes cannot stall recovery (2026-06-21). */
  cleanStreak: number;
  /** Lifetime count of multiplicative decreases (a wedge/storm signal for the dashboard). */
  decreases: number;
  /** Lifetime count of additive increases. */
  increases: number;
}

export class AimdConcurrencyController {
  private readonly cap: number;
  private readonly floor: number;
  private readonly decreaseFactor: number;
  private readonly decreaseThreshold: number;
  private readonly increaseEvery: number;
  private readonly onChange?: (n: number) => void;
  private eff: number;
  private pressure = 0; // leaky-bucket of net throttle pressure (the "sustained" measure)
  private cleanStreak = 0;
  private decreases = 0;
  private increases = 0;

  constructor(opts: AimdConcurrencyOptions) {
    this.cap = Math.max(1, Math.floor(opts.cap));
    this.floor = Math.min(this.cap, Math.max(1, Math.floor(opts.floor ?? 1)));
    this.decreaseFactor =
      opts.decreaseFactor !== undefined && opts.decreaseFactor > 0 && opts.decreaseFactor < 1 ? opts.decreaseFactor : 0.5;
    this.decreaseThreshold = Math.max(1, Math.floor(opts.decreaseThreshold ?? 4));
    this.increaseEvery = Math.max(1, Math.floor(opts.increaseEvery ?? 5));
    this.onChange = opts.onChange;
    this.eff = this.cap;
  }

  /** The current effective concurrency (floor ≤ effective ≤ cap). */
  get current(): number {
    return this.eff;
  }

  /** Record an upstream THROTTLE (a 429). Adds to the pressure bucket; once net pressure reaches
   *  `decreaseThreshold` it trips a multiplicative decrease (halve toward the floor) and resets the
   *  bucket (the decrease itself sheds load, so re-evaluate fresh).
   *
   *  The clean-streak is reset ONLY on an actual decrease — NOT on every throttle (2026-06-21). A
   *  throttle the leaky bucket ABSORBS (stays below `decreaseThreshold`) is, by the bucket's own verdict,
   *  transient — so it must not also kill the recovery streak, or a steady CHURN of absorbed 429s among
   *  many successes would pin the effective concurrency low forever (it can never accumulate
   *  `increaseEvery` clean successes to climb). That churn is exactly the inference-gateway's steady state
   *  when a few accounts are maxed: the round-robin transiently hits them, the 429s route around to a
   *  healthy account (and are absorbed here), and the gateway must still recover its admission concurrency
   *  to use the healthy accounts' capacity. The bucket — not the raw throttle — decides "sustained". */
  recordThrottle(): void {
    this.pressure += 1;
    if (this.pressure >= this.decreaseThreshold) {
      this.pressure = 0;
      this.cleanStreak = 0; // an ACTUAL sustained-throttle decrease resets the recovery streak
      this.setEff(Math.max(this.floor, Math.floor(this.eff * this.decreaseFactor)), 'decrease');
    }
  }

  /** Record a clean upstream SUCCESS (a 2xx). Drains the pressure bucket; a run of `increaseEvery`
   *  clean successes earns ONE additive +1 step back toward the cap. */
  recordSuccess(): void {
    if (this.pressure > 0) this.pressure -= 1;
    this.cleanStreak += 1;
    if (this.cleanStreak >= this.increaseEvery) {
      this.cleanStreak = 0;
      if (this.eff < this.cap) this.setEff(this.eff + 1, 'increase');
    }
  }

  private setEff(next: number, kind: 'increase' | 'decrease'): void {
    const clamped = Math.min(this.cap, Math.max(this.floor, Math.floor(next)));
    if (clamped === this.eff) return;
    this.eff = clamped;
    if (kind === 'decrease') this.decreases += 1;
    else this.increases += 1;
    try {
      this.onChange?.(clamped);
    } catch {
      /* onChange must not break the controller; swallow (it's a best-effort apply) */
    }
  }

  snapshot(): AimdSnapshot {
    return {
      effective: this.eff,
      cap: this.cap,
      floor: this.floor,
      pressure: this.pressure,
      cleanStreak: this.cleanStreak,
      decreases: this.decreases,
      increases: this.increases,
    };
  }
}
