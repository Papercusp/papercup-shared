/**
 * Unified agent turn-error taxonomy (agent-turn-robustness P-001).
 *
 * Every agent turn — an in-process meridian LLM call OR a spawned CLI agent
 * (claude/omp/codex) — fails in one of a small, fixed set of ways. Classifying the
 * failure into one `TurnErrorClass` lets a single policy layer (`runAgentTurn`) decide
 * how to react (wait for the rate-limit reset, back off, escalate, degrade) instead of
 * each call site reinventing ad-hoc retry logic. Pure + backend-agnostic: the HTTP path
 * (meridian/API) classifies from `{status, headers, message}`; the subprocess path (CLI
 * backends) classifies from `{exitCode, signal, stderr, stdout, timedOut}`.
 */

export type TurnErrorClass =
  | 'rate_limited' // 429 / acceleration limit — wait for retry-after / reset
  | 'overloaded' // 529 / 5xx transient — back off + retry
  | 'timeout' // wall-clock / deadline exceeded
  | 'transient_io' // network blip (ECONNRESET, socket hang up, …)
  | 'auth' // 401/403 — NOT retryable without new creds
  | 'agent_crash' // subprocess nonzero exit / killed by signal
  | 'empty_output' // ran clean but produced nothing
  | 'malformed_output' // produced output the caller couldn't parse
  | 'permanent'; // non-retryable 4xx / unknown permanent failure

export type TurnBackend = 'meridian' | 'claude-code' | 'omp' | 'codex';
export type TurnProvider = 'anthropic' | 'openai' | 'unknown';

export interface TurnError {
  class: TurnErrorClass;
  message: string;
  /** From `retry-after` (rate_limited/overloaded), in ms. */
  retryAfterMs?: number;
  /** Epoch ms when the limiting bucket replenishes (from `*-reset`). */
  resetAt?: number;
  provider: TurnProvider;
  /** Convenience: is this class worth another attempt (with the right wait)? */
  retryable: boolean;
}

const RETRYABLE: ReadonlySet<TurnErrorClass> = new Set<TurnErrorClass>([
  'rate_limited',
  'overloaded',
  'timeout',
  'transient_io',
  'agent_crash',
  'empty_output',
  'malformed_output',
]);

function mk(cls: TurnErrorClass, message: string, provider: TurnProvider, extra?: Partial<TurnError>): TurnError {
  return { class: cls, message, provider, retryable: RETRYABLE.has(cls), ...extra };
}

/** `retry-after` is either delta-seconds or an HTTP-date. Returns ms, or undefined. */
export function parseRetryAfterMs(retryAfter: string | number | undefined, now: number = Date.now()): number | undefined {
  if (retryAfter === undefined || retryAfter === null || retryAfter === '') return undefined;
  if (typeof retryAfter === 'number') return retryAfter > 0 ? Math.round(retryAfter * 1000) : 0;
  const s = retryAfter.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 1000);
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return Math.max(0, t - now);
  return undefined;
}

/** An `anthropic-ratelimit-*-reset` (RFC-3339) → epoch ms. */
export function parseResetAt(reset: string | undefined): number | undefined {
  if (!reset) return undefined;
  const t = Date.parse(reset);
  return Number.isNaN(t) ? undefined : t;
}

// Header keys that carry a reset timestamp, most-restrictive first.
const RESET_HEADERS = [
  'anthropic-ratelimit-output-tokens-reset',
  'anthropic-ratelimit-input-tokens-reset',
  'anthropic-ratelimit-tokens-reset',
  'anthropic-ratelimit-requests-reset',
  'x-ratelimit-reset-tokens',
  'x-ratelimit-reset-requests',
];

function resetFromHeaders(headers: Record<string, string | undefined> | undefined, now: number): number | undefined {
  if (!headers) return undefined;
  const lc: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) lc[k.toLowerCase()] = v;
  for (const key of RESET_HEADERS) {
    const v = lc[key];
    if (!v) continue;
    // OpenAI's x-ratelimit-reset-* are durations like "1.5s"/"60s"; Anthropic's are RFC-3339.
    const dur = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(v.trim());
    if (dur) {
      const n = parseFloat(dur[1]);
      const mult = dur[2] === 'ms' ? 1 : dur[2] === 'm' ? 60_000 : 1000;
      return now + n * mult;
    }
    const t = parseResetAt(v);
    if (t) return t;
  }
  return undefined;
}

// `session limit` / `hit your … limit` cover the Claude Code SUBSCRIPTION lockout
// ("You've hit your session limit · resets 4:20am") — a transient, reset-at-a-time cap, NOT
// an agent crash. Without these it fell through to `agent_crash`, so the gym's RB-006 rate-pause
// rethrew instead of pausing/skipping → an unattended loop hard-failed on a session lockout.
const RATE_RE = /(\b429\b|rate.?limit|too many requests|quota|usage limit|session limit|\d+-?hour limit|hit your (?:session|usage|weekly|monthly) limit)/i;
const OVERLOAD_RE = /(\b529\b|overloaded|service unavailable|\b50[0234]\b)/i;
const AUTH_RE = /(\b401\b|\b403\b|unauthorized|forbidden|invalid api key|authentication)/i;
const IO_RE = /(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|network|fetch failed)/i;
const TIMEOUT_RE = /(\b408\b|timed? ?out|deadline exceeded)/i;

/** Classify an HTTP-style failure (meridian in-process call, or an API error). */
export function classifyHttpError(
  input: { status?: number; headers?: Record<string, string | undefined>; message?: string },
  provider: TurnProvider = 'unknown',
  now: number = Date.now(),
): TurnError {
  const msg = input.message ?? (input.status ? `HTTP ${input.status}` : 'unknown error');
  const headers = input.headers;
  const retryAfterMs = parseRetryAfterMs(headers?.['retry-after'] ?? headers?.['Retry-After'], now);
  const resetAt = resetFromHeaders(headers, now);
  const st = input.status;

  if (st === 429 || (st === undefined && RATE_RE.test(msg))) {
    return mk('rate_limited', msg, provider, { retryAfterMs, resetAt });
  }
  if (st === 529 || st === 503 || st === 502 || st === 500 || st === 504 || (st === undefined && OVERLOAD_RE.test(msg))) {
    return mk('overloaded', msg, provider, { retryAfterMs });
  }
  if (st === 408 || (st === undefined && TIMEOUT_RE.test(msg))) return mk('timeout', msg, provider);
  if (st === 401 || st === 403 || (st === undefined && AUTH_RE.test(msg))) return mk('auth', msg, provider);
  if (st === undefined && IO_RE.test(msg)) return mk('transient_io', msg, provider);
  if (st !== undefined && st >= 400 && st < 500) return mk('permanent', msg, provider);
  if (st === undefined) return mk('transient_io', msg, provider); // unknown w/ no status: treat as a retryable blip
  return mk('permanent', msg, provider);
}

/** Classify a finished CLI-agent subprocess (claude/omp/codex). */
export function classifySubprocessResult(
  input: { exitCode: number | null; signal?: string | null; stderr?: string; stdout?: string; timedOut?: boolean },
  provider: TurnProvider = 'unknown',
  now: number = Date.now(),
): TurnError {
  const stderr = input.stderr ?? '';
  if (input.timedOut) return mk('timeout', 'subprocess timed out', provider);
  if (RATE_RE.test(stderr)) {
    // Some CLIs print "retry after 30s" / "try again in 12 seconds".
    const m = /(?:retry after|try again in|wait)\s+(\d+(?:\.\d+)?)\s*(s|sec|seconds|m|min|minutes|ms)?/i.exec(stderr);
    let retryAfterMs: number | undefined;
    if (m) {
      const n = parseFloat(m[1]);
      const unit = (m[2] ?? 's').toLowerCase();
      retryAfterMs = unit.startsWith('ms') ? n : unit.startsWith('m') ? n * 60_000 : n * 1000;
    }
    return mk('rate_limited', stderr.slice(0, 200) || 'rate limited', provider, { retryAfterMs });
  }
  if (OVERLOAD_RE.test(stderr)) return mk('overloaded', stderr.slice(0, 200), provider);
  if (AUTH_RE.test(stderr)) return mk('auth', stderr.slice(0, 200), provider);
  if (IO_RE.test(stderr)) return mk('transient_io', stderr.slice(0, 200), provider);
  if (input.signal) return mk('agent_crash', `killed by ${input.signal}`, provider);
  if (input.exitCode !== 0 && input.exitCode !== null) {
    return mk('agent_crash', stderr.slice(0, 200) || `exit ${input.exitCode}`, provider);
  }
  // Exit 0 (or null with no signal): success-ish — only empty output is a failure here.
  if (!input.stdout || !input.stdout.trim()) return mk('empty_output', 'agent produced no output', provider);
  return mk('permanent', 'unclassified clean exit', provider); // shouldn't happen; caller treats stdout as success
}

interface MeridianRaw {
  status?: number;
  headers?: Record<string, string | undefined>;
  message?: string;
}
interface SubprocessRaw {
  exitCode: number | null;
  signal?: string | null;
  stderr?: string;
  stdout?: string;
  timedOut?: boolean;
}

const PROVIDER_BY_BACKEND: Record<TurnBackend, TurnProvider> = {
  meridian: 'anthropic',
  'claude-code': 'anthropic',
  omp: 'unknown', // model-agnostic / multi-provider
  codex: 'openai',
};

/** Top-level dispatch: meridian → HTTP-shape; CLI backends → subprocess-shape. */
export function classifyTurnError(
  backend: TurnBackend,
  raw: MeridianRaw | SubprocessRaw,
  now: number = Date.now(),
): TurnError {
  const provider = PROVIDER_BY_BACKEND[backend];
  if (backend === 'meridian') return classifyHttpError(raw as MeridianRaw, provider, now);
  return classifySubprocessResult(raw as SubprocessRaw, provider, now);
}
