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
import { RateLimitGovernor, type GovernorLimits, type GovernorDeps, type GovernorState, type GovernorPauseEvent, type GovernorStore } from '../resilience/governor';

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

export function governorKey(provider: TurnProvider, modelClass: string): string {
  return `${provider}:${modelClass}`;
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

/** The singleton governor for a `(provider, modelClass)` bucket (created on first use). */
export function getGovernor(provider: TurnProvider, modelClass: string, deps?: GovernorDeps): RateLimitGovernor {
  const key = governorKey(provider, modelClass);
  let g = registry.get(key);
  if (!g) {
    g = new RateLimitGovernor(
      { ...DEFAULT_FLOORS[provider] },
      {
        ...deps,
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
  /** Runtime credential fact (D-006): precise apiKey bucket vs coarse subscription. */
  limitModel: LimitModel;
  state: GovernorState;
}

/** Point-in-time snapshot of every live bucket — the headroom + pause status the read tool
    (`dev:rate_governor_status`) surfaces (RB-009). */
export function snapshotGovernors(): GovernorSnapshot[] {
  const out: GovernorSnapshot[] = [];
  for (const [key, g] of registry) {
    const idx = key.indexOf(':');
    const provider = key.slice(0, idx) as TurnProvider;
    out.push({
      key,
      provider,
      modelClass: key.slice(idx + 1),
      limitModel: resolveProviderLimitModel(provider),
      state: g.snapshot(),
    });
  }
  return out;
}

/** Resolve the right shared governor for a backend + model: self-pacing backends (omp)
    collapse to a single concurrency-only bucket; others key by provider+model-class. */
export function governorForBackend(backend: TurnBackend, model: string, deps?: GovernorDeps): RateLimitGovernor {
  const p = BACKEND_PROFILES[backend];
  return getGovernor(p.provider, p.selfPacing ? 'self' : modelClassOf(model), deps);
}

/** Test hook — drop all singletons. */
export function resetGovernorRegistry(): void {
  registry.clear();
}
