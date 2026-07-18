/**
 * Unified agent turn-error taxonomy (agent-turn-robustness P-001).
 *
 * Every agent turn — an in-process anthropic-direct LLM call OR a spawned CLI agent
 * (claude/omp/codex) — fails in one of a small, fixed set of ways. Classifying the
 * failure into one `TurnErrorClass` lets a single policy layer (`runAgentTurn`) decide
 * how to react (wait for the rate-limit reset, back off, escalate, degrade) instead of
 * each call site reinventing ad-hoc retry logic. Pure + backend-agnostic: the HTTP path
 * (anthropic-direct/API) classifies from `{status, headers, message}`; the subprocess path (CLI
 * backends) classifies from `{exitCode, signal, stderr, stdout, timedOut}`.
 */

import type { AdmissionDenial } from '../resilience/governor';

export type TurnErrorClass =
  | 'rate_limited' // 429 / acceleration (RPM) limit — transient: back off the fleet briefly + retry
  | 'usage_limit' // plan/subscription CAP (Max/ChatGPT daily-weekly-session, insufficient_quota) — capped until a reset window (often hours): pause the fleet + surface, do NOT retry into the wall
  | 'overloaded' // 529 / 5xx transient — back off + retry
  | 'timeout' // wall-clock / deadline exceeded
  | 'transient_io' // network blip (ECONNRESET, socket hang up, …)
  | 'auth' // 401/403 — NOT retryable without new creds
  | 'agent_crash' // subprocess nonzero exit / killed by signal
  | 'empty_output' // ran clean but produced nothing
  | 'malformed_output' // produced output the caller couldn't parse
  | 'permanent'; // non-retryable 4xx / unknown permanent failure

export type TurnBackend = 'anthropic-direct' | 'claude-code' | 'omp' | 'codex';
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
  /**
   * Should the operator surface this to the human (vs absorb + auto-handle)? True for the
   * classes the user must know about — a plan/usage cap they're hitting (`usage_limit`), an
   * auth failure that needs new creds (`auth`), and unexpected permanent failures. False for
   * transient classes the governor handles silently (`rate_limited`/`overloaded`/`timeout`/…).
   */
  surfaceToUser?: boolean;
  /** Structured admission fact from the governor/gateway; never infer this from message text. */
  admissionDenial?: AdmissionDenial;
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

// Classes the human should see (vs the governor handling them silently). `usage_limit` is the
// load-bearing one — retrying is futile, so the user must know the fleet is parked until reset.
const SURFACE_TO_USER: ReadonlySet<TurnErrorClass> = new Set<TurnErrorClass>(['usage_limit', 'auth', 'permanent']);

/**
 * Classes that back off the SHARED account-wide budget — every agent on the account pauses
 * together, not just the one that tripped. `rate_limited` (transient RPM) and `overloaded`
 * (5xx) pause-and-retry; `usage_limit` (plan cap) pauses-until-reset without retrying. The
 * single predicate every penalize/pause call site consults, so adding a class is one edit.
 */
export function isAccountWide(cls: TurnErrorClass): boolean {
  return cls === 'rate_limited' || cls === 'overloaded' || cls === 'usage_limit';
}

function mk(cls: TurnErrorClass, message: string, provider: TurnProvider, extra?: Partial<TurnError>): TurnError {
  return { class: cls, message, provider, retryable: RETRYABLE.has(cls), surfaceToUser: SURFACE_TO_USER.has(cls), ...extra };
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

// Plan / subscription CAP — the account is capped until a reset window (often hours away), so
// retrying is futile: pause the fleet + surface the reset, don't hammer the wall. Covers the
// Claude Code subscription lockout ("You've hit your usage limit · resets 4:20am" / "session
// limit" / "5-hour limit") AND OpenAI/codex hard quota ("insufficient_quota"). Kept DISTINCT
// from a transient RPM 429 (`RATE_RE`) because the disposition is opposite (D-001, Brief 20).
const USAGE_LIMIT_RE =
  /(usage limit|session limit|weekly limit|monthly limit|daily limit|\d+-?hour limit|hit your (?:session|usage|weekly|monthly|daily) limit|insufficient_quota|quota exceeded|exceeded your (?:current )?quota|out of (?:credits|quota))/i;
// Transient acceleration / requests-per-minute 429 — back off the fleet briefly + retry. The
// usage-cap phrases were SPLIT OUT into USAGE_LIMIT_RE above (D-001).
const RATE_RE = /(\b429\b|rate.?limit|too many requests|slow down|temporarily limiting)/i;
// Anthropic's TRANSIENT-overload line — "Server is temporarily limiting requests (not your usage
// limit) · Rate limited" — contains the substring "usage limit", which would otherwise trip
// USAGE_LIMIT_RE (a plan CAP: pause-until-far-reset, no retry) — the OPPOSITE disposition to the
// transient 429 it actually is. This guard forces such text down the rate_limited (retry) path.
const TRANSIENT_OVERRIDE_RE = /temporarily limiting|not (?:your|a) (?:usage|session|weekly|monthly|daily) limit/i;
const OVERLOAD_RE = /(\b529\b|overloaded|service unavailable|\b50[0234]\b)/i;
const AUTH_RE = /(\b401\b|\b403\b|unauthorized|forbidden|invalid api key|authentication)/i;
const IO_RE = /(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|network|fetch failed)/i;
const TIMEOUT_RE = /(\b408\b|timed? ?out|deadline exceeded)/i;

/**
 * Best-effort reset extraction from a subscription usage-limit MESSAGE (the subprocess path,
 * where structured `*-reset` headers aren't visible). Handles the relative form
 * ("resets in 2h 30m", "try again in 90 minutes") and the absolute clock form Claude prints
 * ("resets 4:20am", "resets at 11 pm", "resets 16:00"). Returns epoch ms, or undefined when no
 * reset is parseable (the caller still pauses + surfaces, just without a precise time). Pure:
 * `now` is injected so the absolute-clock "next occurrence" math is testable.
 */
export function parseUsageResetMs(text: string, now: number = Date.now()): number | undefined {
  // Relative: "resets in 2h", "try again in 90 minutes", "in 2h 30m", "in 45s".
  const rel = /(?:resets?|try again|again|wait)\b[^0-9]{0,12}((?:\d+\s*(?:h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)\b\s*)+)/i.exec(text);
  if (rel) {
    let ms = 0;
    let matched = false;
    const re = /(\d+)\s*(h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)\b/gi;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(rel[1])) !== null) {
      matched = true;
      const n = parseInt(mm[1], 10);
      const u = mm[2].toLowerCase();
      ms += u.startsWith('h') ? n * 3_600_000 : u.startsWith('m') ? n * 60_000 : n * 1000;
    }
    if (matched && ms > 0) return now + ms;
  }
  // Absolute clock: "resets 4:20am", "resets at 11 pm", "resets 16:00" → the NEXT occurrence.
  const abs = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (abs) {
    let h = parseInt(abs[1], 10);
    const min = abs[2] ? parseInt(abs[2], 10) : 0;
    const ap = abs[3]?.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h <= 23 && min <= 59) {
      const d = new Date(now);
      d.setHours(h, min, 0, 0);
      let t = d.getTime();
      if (t <= now) t += 86_400_000; // already passed today → tomorrow
      return t;
    }
  }
  return undefined;
}

/** Classify an HTTP-style failure (anthropic-direct in-process call, or an API error). */
export function classifyHttpError(
  input: { status?: number; headers?: Record<string, string | undefined>; message?: string; admissionDenial?: AdmissionDenial },
  provider: TurnProvider = 'unknown',
  now: number = Date.now(),
): TurnError {
  const msg = input.message ?? (input.status ? `HTTP ${input.status}` : 'unknown error');
  const headers = input.headers;
  const retryAfterMs = parseRetryAfterMs(headers?.['retry-after'] ?? headers?.['Retry-After'], now);
  const resetAt = resetFromHeaders(headers, now);
  const st = input.status;

  // A plan/usage CAP (429 w/ insufficient_quota, or a no-status message naming a usage cap) →
  // pause-until-reset + surface, do NOT retry. Checked before the transient-429 branch since the
  // disposition is opposite (D-001). The header reset (if any) IS the cap's reset time.
  if (USAGE_LIMIT_RE.test(msg) && !TRANSIENT_OVERRIDE_RE.test(msg) && (st === 429 || st === undefined)) {
    return mk('usage_limit', msg, provider, { retryAfterMs, resetAt, ...(input.admissionDenial ? { admissionDenial: input.admissionDenial } : {}) });
  }
  if (st === 429 || (st === undefined && (RATE_RE.test(msg) || TRANSIENT_OVERRIDE_RE.test(msg)))) {
    // Fail-closed mint discipline (WI-5391 Part B): only a REAL HTTP 429 status attests a
    // capacity denial (`via:'http-429'`). The prose branch (no status, message merely LOOKS
    // rate-limity) mints NOTHING — that shape is indistinguishable from an admission-path
    // defect (WI-4541), and an evidence-free denial would let the defect vanish into the
    // capacity bucket of the very error metric that should catch it. Prose failures stay
    // 'rate_limited' for retry policy but COUNT as errors unless the governor attached a
    // typed denial itself.
    return mk('rate_limited', msg, provider, {
      retryAfterMs,
      resetAt,
      ...(input.admissionDenial
        ? { admissionDenial: input.admissionDenial }
        : st === 429
          ? { admissionDenial: { reason: 'provider-429', via: 'http-429' } as AdmissionDenial }
          : {}),
    });
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
  // The claude/codex CLIs print API errors (rate limit, overload, auth) to STDOUT, not stderr —
  // e.g. "API Error: Server is temporarily limiting requests … · Rate limited" with EMPTY stderr.
  // Fold stdout into the pattern scan ON A FAILED EXIT so such a bee is classified `rate_limited`
  // (→ the fleet governor's 429 backoff / AIMD) instead of a generic `agent_crash`. Gated on
  // failure so a SUCCESSFUL bee whose output merely mentions "rate limit" isn't misclassified.
  const failed = !!input.signal || (input.exitCode !== 0 && input.exitCode !== null);
  const scan = failed ? `${stderr}\n${input.stdout ?? ''}` : stderr;
  const errText = stderr.trim() ? stderr : failed ? input.stdout ?? '' : '';
  // Plan/usage CAP first (opposite disposition to a transient 429): pause-until-reset + surface,
  // no retry. The CLI prints the reset in the message ("resets 4:20am"), so parse it best-effort.
  if (USAGE_LIMIT_RE.test(scan) && !TRANSIENT_OVERRIDE_RE.test(scan)) {
    const resetAt = parseUsageResetMs(scan, now);
    return mk('usage_limit', errText.slice(0, 200) || 'usage limit reached', provider, resetAt !== undefined ? { resetAt } : undefined);
  }
  if (RATE_RE.test(scan)) {
    // Some CLIs print "retry after 30s" / "try again in 12 seconds".
    const m = /(?:retry after|try again in|wait)\s+(\d+(?:\.\d+)?)\s*(s|sec|seconds|m|min|minutes|ms)?/i.exec(scan);
    let retryAfterMs: number | undefined;
    if (m) {
      const n = parseFloat(m[1]);
      const unit = (m[2] ?? 's').toLowerCase();
      retryAfterMs = unit.startsWith('ms') ? n : unit.startsWith('m') ? n * 60_000 : n * 1000;
    }
    return mk('rate_limited', errText.slice(0, 200) || 'rate limited', provider, { retryAfterMs });
  }
  if (OVERLOAD_RE.test(scan)) return mk('overloaded', errText.slice(0, 200), provider);
  if (AUTH_RE.test(scan)) return mk('auth', errText.slice(0, 200), provider);
  if (IO_RE.test(scan)) return mk('transient_io', errText.slice(0, 200), provider);
  if (input.signal) return mk('agent_crash', `killed by ${input.signal}`, provider);
  if (input.exitCode !== 0 && input.exitCode !== null) {
    return mk('agent_crash', errText.slice(0, 200) || `exit ${input.exitCode}`, provider);
  }
  // Exit 0 (or null with no signal): success-ish — only empty output is a failure here.
  if (!input.stdout || !input.stdout.trim()) return mk('empty_output', 'agent produced no output', provider);
  return mk('permanent', 'unclassified clean exit', provider); // shouldn't happen; caller treats stdout as success
}

interface HttpRaw {
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
  'anthropic-direct': 'anthropic',
  'claude-code': 'anthropic',
  omp: 'unknown', // model-agnostic / multi-provider
  codex: 'openai',
};

/** Top-level dispatch: anthropic-direct → HTTP-shape; CLI backends → subprocess-shape. */
export function classifyTurnError(
  backend: TurnBackend,
  raw: HttpRaw | SubprocessRaw,
  now: number = Date.now(),
): TurnError {
  const provider = PROVIDER_BY_BACKEND[backend];
  if (backend === 'anthropic-direct') return classifyHttpError(raw as HttpRaw, provider, now);
  return classifySubprocessResult(raw as SubprocessRaw, provider, now);
}
