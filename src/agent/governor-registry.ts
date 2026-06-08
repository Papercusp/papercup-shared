/**
 * Backend provider profiles + the shared governor registry (agent-turn-robustness P-011).
 *
 * Declares, per backend, which provider/limit-model applies and whether the backend
 * self-paces — then hands out a SINGLETON `RateLimitGovernor` per `(provider, modelClass)`
 * so all callers that hit the same provider+model-class share ONE budget (otherwise the
 * gym + fleet co-burst the same account). Anthropic limits are per-model-class (opus vs
 * sonnet are separate buckets), so the key includes the class. omp is model-agnostic with
 * built-in fallback chaining → self-pacing → concurrency-cap only (no token budget; we
 * can't see which provider its internal calls hit).
 *
 * Cold-start floors are CONSERVATIVE (D-003); `governor.recordResponse(headers)` auto-tunes
 * them up from the provider's `*-ratelimit-*-limit` headers when available (API-key paths).
 */
import type { TurnBackend, TurnProvider } from './turn-error';
import { RateLimitGovernor, type GovernorLimits, type GovernorDeps, type GovernorState, type GovernorPauseEvent, type GovernorStore, type GlobalConcurrencyGate } from '../resilience/governor';

export type LimitModel = 'subscription' | 'apiKey';

export interface BackendProfile {
  provider: TurnProvider;
  /** omp self-paces via fallback chaining → we only cap its concurrency. */
  selfPacing: boolean;
}

export const BACKEND_PROFILES: Record<TurnBackend, BackendProfile> = {
  meridian: { provider: 'anthropic', selfPacing: false },
  'claude-code': { provider: 'anthropic', selfPacing: false },
  omp: { provider: 'unknown', selfPacing: true },
  codex: { provider: 'openai', selfPacing: false },
};

/**
 * Whether a provider runs on a precise header-driven API-key bucket or a coarse subscription —
 * a RUNTIME credential fact (D-006), NOT a compile-time const. The ITPM/OTPM token-bucket is
 * only honest with an API key (which returns `*-ratelimit-*` per-minute headroom headers); a
 * subscription (Claude-Max / ChatGPT OAuth) exposes none, so it's concurrency + RPM +
 * honor-retry-after only. Resolved from env at call time so pointing a backend at an API key
 * (e.g. to dodge the Max rate window — D-006) flips it to precise mode without a code change.
 */
export function resolveProviderLimitModel(provider: TurnProvider, env: Record<string, string | undefined> = process.env): LimitModel {
  if (provider === 'anthropic') return env.ANTHROPIC_API_KEY ? 'apiKey' : 'subscription';
  if (provider === 'openai') return env.OPENAI_API_KEY ? 'apiKey' : 'subscription';
  return 'subscription'; // unknown / multi-provider (omp): no single bucket → coarse
}

/** The runtime limit model for a backend (omp self-paces → always coarse subscription mode). */
export function resolveLimitModel(backend: TurnBackend, env: Record<string, string | undefined> = process.env): LimitModel {
  const p = BACKEND_PROFILES[backend];
  if (p.selfPacing) return 'subscription';
  return resolveProviderLimitModel(p.provider, env);
}

/** Anthropic rate limits are per model class (opus/sonnet/haiku are separate buckets). */
export function modelClassOf(model: string): string {
  const m = model.toLowerCase();
  if (/opus/.test(m)) return 'opus';
  if (/sonnet/.test(m)) return 'sonnet';
  if (/haiku/.test(m)) return 'haiku';
  return 'default';
}

/** Conservative cold-start floors per provider (auto-tuned UP from headers). */
const DEFAULT_FLOORS: Record<TurnProvider, GovernorLimits> = {
  // Subscriptions don't expose per-minute headroom, so the floor is the safety: a low
  // concurrency cap (kills the burst) + a conservative RPM. A 429 penalty pauses
  // regardless if we're still too fast.
  anthropic: { maxConcurrent: 3, rpm: 45 },
  openai: { maxConcurrent: 3, rpm: 45 },
  // omp / unknown: self-pacing → concurrency-cap ONLY (no rpm/token budget — we don't
  // know which provider its internal call hit, and it self-heals via fallback chaining).
  unknown: { maxConcurrent: 3 },
};

const registry = new Map<string, RateLimitGovernor>();

// --- Fleet-wide concurrency cap (rate-limit-layer-v2 D-004) ------------------------------------
// A single shared counter + cap that EVERY governor consults on top of its own per-bucket
// maxConcurrent, so the TOTAL concurrent agents across all (provider,modelClass) buckets is
// bounded by the user's live `maxSimultaneousAgents`. The host (operator-core) pushes the live
// value via setGlobalConcurrencyCap() — read by the governor IMMEDIATELY (next acquire), no
// restart. Default Infinity = unbounded (legacy behavior; tests that don't set a cap are
// byte-identical). The gate object is shared by reference into every governor the registry makes.
let globalCap = Infinity;
let globalInFlight = 0;

// --- AIMD adaptive concurrency (rate-limit-layer-v2 D-005) -------------------------------------
// The user's cap is the HARD ceiling; the gate runs an EFFECTIVE concurrency `eff ≤ cap` that
// additively increases (+1 per N consecutive clean turns) and multiplicatively decreases (halve
// toward the floor) on an account-wide penalty — so the fleet self-throttles to the safe level
// under the user's max instead of slamming the cap into a 429 wall. Inactive (eff undefined,
// legacy-identical) until a finite cap is installed; headers govern RATE, this governs CONCURRENCY.
export const AIMD_CLEAN_TURNS_PER_STEP = 5;
let globalFloor = 1;
let aimdEff: number | undefined;
let aimdCleanStreak = 0;

const globalGate: GlobalConcurrencyGate = {
  tryAcquire() {
    const limit = Math.min(globalCap, aimdEff ?? Infinity);
    if (globalInFlight >= limit) return false;
    globalInFlight += 1;
    return true;
  },
  release() {
    globalInFlight = Math.max(0, globalInFlight - 1);
  },
  noteClean() {
    if (aimdEff === undefined) return; // AIMD inactive without a finite cap
    aimdCleanStreak += 1;
    if (aimdCleanStreak >= AIMD_CLEAN_TURNS_PER_STEP) {
      aimdCleanStreak = 0;
      if (aimdEff < globalCap) aimdEff += 1; // additive increase, never past the live cap
    }
  },
  notePenalty() {
    aimdCleanStreak = 0;
    if (aimdEff === undefined) return;
    aimdEff = Math.max(globalFloor, Math.floor(aimdEff / 2)); // multiplicative decrease to floor
  },
};

/** Set the fleet-wide concurrent-agent cap (the user's live `maxSimultaneousAgents`). `undefined`
    or ≤0 clears it (Infinity = unbounded, AIMD inactive). Honored by the very next `acquire`
    across all buckets; the AIMD effective concurrency starts at the cap and adapts under it. */
export function setGlobalConcurrencyCap(n: number | undefined): void {
  if (typeof n === 'number' && n > 0) {
    const prevCap = globalCap;
    globalCap = n;
    // The user's edit is honored LIVE: when eff is not adapted-down (fresh, or sitting at the old
    // cap) it follows the edit in both directions. Only a penalty-adapted eff (< old cap) holds
    // its safe level on a raise and ramps up via clean turns.
    if (aimdEff === undefined || !Number.isFinite(prevCap) || aimdEff >= prevCap) {
      aimdEff = n;
    } else {
      aimdEff = Math.min(aimdEff, n);
    }
    if (aimdEff < globalFloor) aimdEff = Math.min(globalFloor, globalCap);
  } else {
    globalCap = Infinity;
    aimdEff = undefined;
    aimdCleanStreak = 0;
  }
}

/** Set the AIMD floor (D-005) — the effective concurrency never adapts below it. */
export function setGlobalConcurrencyFloor(n: number | undefined): void {
  globalFloor = typeof n === 'number' && n >= 1 ? Math.floor(n) : 1;
  if (aimdEff !== undefined && aimdEff < globalFloor) aimdEff = Math.min(globalFloor, globalCap);
}

/** The live fleet-wide cap + current total in-flight — surfaced by the rate read-model / top-bar. */
export function globalConcurrencySnapshot(): { cap: number; inFlight: number } {
  return { cap: globalCap, inFlight: globalInFlight };
}

/** The AIMD view (D-005): the adapted effective concurrency under the cap (null = AIMD inactive,
    i.e. no finite cap installed), the floor it never drops below, and the current clean streak. */
export function effectiveConcurrencySnapshot(): { effective: number | null; floor: number; cleanStreak: number } {
  return { effective: aimdEff ?? null, floor: globalFloor, cleanStreak: aimdCleanStreak };
}

// Cross-process shared-budget store (RB-007). When set (by the operator at boot, behind a flag),
// every NEW governor routes its rate+pause budget through it so the whole fleet + gym + this dev
// session share ONE account budget. Concurrency stays per-process. Default unset = in-memory.
let sharedStore: GovernorStore | undefined;

/** Install (or clear) the cross-process budget store. Resets the registry so subsequent
    `getGovernor` calls bind the store. Call once at boot, before any agent turn. */
export function setGovernorStore(store: GovernorStore | undefined): void {
  sharedStore = store;
  registry.clear();
}

/**
 * The bucket key for a `(provider, modelClass)` — optionally scoped to a specific
 * ACCOUNT (`cloud-deployment-layer` Phase 7, P-019). With no `accountId` the key is
 * the global `<provider>:<modelClass>` (unchanged — shared across the fleet). With
 * one it is `<provider>:<modelClass>@<accountId>`, giving that Claude account its
 * OWN governor state + (under the PG store) its own budget row, so accounts with
 * separate subscriptions track their separate rate limits. The `@` delimiter never
 * appears in `provider`/`modelClass`; account ids are validated to exclude it.
 */
export function governorKey(provider: TurnProvider, modelClass: string, accountId?: string): string {
  return accountId ? `${provider}:${modelClass}@${accountId}` : `${provider}:${modelClass}`;
}

/** Inverse of `governorKey` — split a bucket key back into its parts. */
export function parseGovernorKey(key: string): { provider: TurnProvider; modelClass: string; accountId?: string } {
  const at = key.indexOf('@');
  const accountId = at >= 0 ? key.slice(at + 1) : undefined;
  const base = at >= 0 ? key.slice(0, at) : key;
  const idx = base.indexOf(':');
  return { provider: base.slice(0, idx) as TurnProvider, modelClass: base.slice(idx + 1), accountId };
}

// --- Pause observability (RB-009) -------------------------------------------------------
// Every governor in the registry routes its onPause through ONE module-level emitter, keyed by
// bucket, so a host (the operator) subscribes once and surfaces "rate-limited — paused until
// <reset>" to coord/telemetry — without the domain-free governor knowing about any of that.
export type GovernorPauseListener = (ev: GovernorPauseEvent & { key: string }) => void;
const pauseListeners = new Set<GovernorPauseListener>();

/** Subscribe to pause transitions across ALL buckets. Returns an unsubscribe fn. */
export function onGovernorPause(cb: GovernorPauseListener): () => void {
  pauseListeners.add(cb);
  return () => pauseListeners.delete(cb);
}

function emitGovernorPause(ev: GovernorPauseEvent & { key: string }): void {
  for (const cb of pauseListeners) {
    try {
      cb(ev);
    } catch {
      /* a listener must never break the limiter */
    }
  }
}

/** The singleton governor for a `(provider, modelClass[, accountId])` bucket (created on first use). */
export function getGovernor(provider: TurnProvider, modelClass: string, deps?: GovernorDeps, accountId?: string): RateLimitGovernor {
  const key = governorKey(provider, modelClass, accountId);
  let g = registry.get(key);
  if (!g) {
    g = new RateLimitGovernor(
      { ...DEFAULT_FLOORS[provider] },
      {
        ...deps,
        // Fleet-wide cap (D-004): share the registry's one global gate unless a test injects its own.
        globalGate: deps?.globalGate ?? globalGate,
        // Bind the cross-process store (RB-007) unless the caller injected its own (tests do).
        ...(deps?.store ? {} : sharedStore ? { store: sharedStore, storeKey: key } : {}),
        onPause: (ev) => {
          emitGovernorPause({ ...ev, key });
          deps?.onPause?.(ev);
        },
      },
    );
    registry.set(key, g);
  }
  return g;
}

export interface GovernorSnapshot {
  key: string;
  provider: TurnProvider;
  modelClass: string;
  /** Set when the bucket is scoped to a specific account (P-019); else global. */
  accountId?: string;
  /** Runtime credential fact (D-006): precise apiKey bucket vs coarse subscription. */
  limitModel: LimitModel;
  state: GovernorState;
}

/** Point-in-time snapshot of every live bucket — the headroom + pause status the read tool
    (`dev:rate_governor_status`) surfaces (RB-009). */
export function snapshotGovernors(): GovernorSnapshot[] {
  const out: GovernorSnapshot[] = [];
  for (const [key, g] of registry) {
    const { provider, modelClass, accountId } = parseGovernorKey(key);
    out.push({
      key,
      provider,
      modelClass,
      ...(accountId ? { accountId } : {}),
      limitModel: resolveProviderLimitModel(provider),
      state: g.snapshot(),
    });
  }
  return out;
}

/** Resolve the right shared governor for a backend + model: self-pacing backends (omp)
    collapse to a single concurrency-only bucket; others key by provider+model-class. An
    `accountId` (e.g. a frame's `PAPERCUSP_ACCOUNT_ID`) scopes the bucket to that account
    so its separate subscription tracks its separate rate limits (P-019). */
export function governorForBackend(backend: TurnBackend, model: string, deps?: GovernorDeps, accountId?: string): RateLimitGovernor {
  const p = BACKEND_PROFILES[backend];
  return getGovernor(p.provider, p.selfPacing ? 'self' : modelClassOf(model), deps, accountId);
}

/** Test hook — drop all singletons + reset the fleet-wide in-flight counter (cap is left as set;
    call setGlobalConcurrencyCap(undefined) to also clear the cap). */
export function resetGovernorRegistry(): void {
  registry.clear();
  globalInFlight = 0;
}
