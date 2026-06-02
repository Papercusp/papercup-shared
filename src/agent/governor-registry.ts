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
import { RateLimitGovernor, type GovernorLimits, type GovernorDeps } from '../resilience/governor';

export interface BackendProfile {
  provider: TurnProvider;
  /** subscription = coarse (no per-minute headroom); apiKey = header-driven precise. */
  limitModel: 'subscription' | 'apiKey';
  /** omp self-paces via fallback chaining → we only cap its concurrency. */
  selfPacing: boolean;
}

export const BACKEND_PROFILES: Record<TurnBackend, BackendProfile> = {
  meridian: { provider: 'anthropic', limitModel: 'subscription', selfPacing: false },
  'claude-code': { provider: 'anthropic', limitModel: 'subscription', selfPacing: false },
  omp: { provider: 'unknown', limitModel: 'subscription', selfPacing: true },
  codex: { provider: 'openai', limitModel: 'subscription', selfPacing: false },
};

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

export function governorKey(provider: TurnProvider, modelClass: string): string {
  return `${provider}:${modelClass}`;
}

/** The singleton governor for a `(provider, modelClass)` bucket (created on first use). */
export function getGovernor(provider: TurnProvider, modelClass: string, deps?: GovernorDeps): RateLimitGovernor {
  const key = governorKey(provider, modelClass);
  let g = registry.get(key);
  if (!g) {
    g = new RateLimitGovernor({ ...DEFAULT_FLOORS[provider] }, deps);
    registry.set(key, g);
  }
  return g;
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
