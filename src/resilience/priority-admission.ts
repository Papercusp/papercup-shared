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
  enqueuedAt: number;
  task: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  seq: number;
}

export interface AdmissionSnapshot {
  running: number;
  queued: number;
  maxConcurrent: number;
  /** Queued counts bucketed by raw priority (highest first). */
  byPriority: { priority: number; count: number }[];
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

  constructor(opts: PriorityAdmissionOptions) {
    this.maxConcurrent = Math.max(1, opts.maxConcurrent);
    this.agingIntervalMs = opts.agingIntervalMs ?? 1000;
    this.maxQueued = opts.maxQueued && opts.maxQueued > 0 ? Math.floor(opts.maxQueued) : 0;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Effective priority at `t` — raw priority plus one point per aging interval waited. */
  private effective(w: Waiter<unknown>, t: number): number {
    if (this.agingIntervalMs <= 0) return w.priority;
    return w.priority + Math.floor((t - w.enqueuedAt) / this.agingIntervalMs);
  }

  /** Admit a task at `priority` (higher = sooner). Resolves/rejects with the task's result.
   *  Rejects synchronously with `QueueFullError` when all slots are busy AND the queue is at
   *  `maxQueued` (load-shed) — a free slot always runs the task regardless of the cap. */
  run<T>(priority: number, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.maxQueued > 0 && this.running >= this.maxConcurrent && this.waiters.length >= this.maxQueued) {
        reject(new QueueFullError(this.waiters.length, this.maxQueued));
        return;
      }
      this.waiters.push({ priority, enqueuedAt: this.now(), task, resolve, reject, seq: this.seq++ });
      this.pump();
    });
  }

  private pump(): void {
    while (this.running < this.maxConcurrent && this.waiters.length > 0) {
      const t = this.now();
      // Pick the highest effective priority; ties broken by earliest arrival (FIFO, stable).
      let bestIdx = 0;
      let bestEff = this.effective(this.waiters[0], t);
      for (let i = 1; i < this.waiters.length; i++) {
        const eff = this.effective(this.waiters[i], t);
        if (eff > bestEff || (eff === bestEff && this.waiters[i].seq < this.waiters[bestIdx].seq)) {
          bestEff = eff;
          bestIdx = i;
        }
      }
      const w = this.waiters.splice(bestIdx, 1)[0];
      this.running++;
      // Run outside the loop's sync frame; settle → free the slot → pump again.
      void Promise.resolve()
        .then(() => w.task())
        .then(
          (v) => {
            this.running--;
            w.resolve(v);
            this.pump();
          },
          (e) => {
            this.running--;
            w.reject(e);
            this.pump();
          },
        );
    }
  }

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, Math.floor(n));
    this.pump();
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
    return {
      running: this.running,
      queued: this.waiters.length,
      maxConcurrent: this.maxConcurrent,
      byPriority: [...byPriority.entries()].sort((a, b) => b[0] - a[0]).map(([priority, count]) => ({ priority, count })),
    };
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
