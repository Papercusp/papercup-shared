/**
 * Tests for the unified agent turn-error taxonomy (agent-turn-robustness P-001).
 * Run: npx vitest run libs/papercusp-shared/src/agent/turn-error.test.ts
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  parseRetryAfterMs,
  parseResetAt,
  parseUsageResetMs,
  classifyHttpError,
  classifySubprocessResult,
  classifyTurnError,
  isAccountWide,
} from './turn-error';

// --- parseRetryAfterMs ---
test('parseRetryAfterMs — numeric seconds → ms', () => {
  assert.equal(parseRetryAfterMs('30'), 30_000);
  assert.equal(parseRetryAfterMs(45), 45_000);
});
test('parseRetryAfterMs — HTTP-date → ms from now', () => {
  const now = 1_000_000;
  const ms = parseRetryAfterMs(new Date(now + 20_000).toUTCString(), now);
  assert.ok(ms !== undefined && Math.abs(ms - 20_000) <= 1000);
});
test('parseRetryAfterMs — missing/garbage → undefined', () => {
  assert.equal(parseRetryAfterMs(undefined), undefined);
  assert.equal(parseRetryAfterMs('not-a-date'), undefined);
});

// --- parseResetAt (RFC-3339) ---
test('parseResetAt — RFC-3339 → epoch ms', () => {
  assert.equal(parseResetAt('2026-06-02T12:00:00Z'), Date.parse('2026-06-02T12:00:00Z'));
  assert.equal(parseResetAt(undefined), undefined);
});

// --- classifyHttpError (anthropic-direct / API) ---
test('classifyHttpError — 429 → rate_limited, honors retry-after + reset', () => {
  const e = classifyHttpError({
    status: 429,
    headers: { 'retry-after': '12', 'anthropic-ratelimit-output-tokens-reset': '2026-06-02T12:00:00Z' },
    message: 'rate_limit_error',
  }, 'anthropic');
  assert.equal(e.class, 'rate_limited');
  // A REAL HTTP 429 status attests the denial (WI-5391 fail-closed mint discipline).
  assert.deepEqual(e.admissionDenial, { reason: 'provider-429', via: 'http-429' });
  assert.equal(e.retryAfterMs, 12_000);
  assert.equal(e.resetAt, Date.parse('2026-06-02T12:00:00Z'));
  assert.equal(e.retryable, true);
  assert.equal(e.provider, 'anthropic');
});
test('classifyHttpError — preserves a typed gateway admission denial', () => {
  const e = classifyHttpError({
    status: 429,
    message: 'opaque gateway response',
    admissionDenial: { reason: 'rate-limit-blocked', pausedAccounts: 4, freeSlots: 0 },
  }, 'anthropic');
  assert.deepEqual(e.admissionDenial, { reason: 'rate-limit-blocked', pausedAccounts: 4, freeSlots: 0 });
});
test('classifyHttpError — 529 / 503 → overloaded (retryable)', () => {
  assert.equal(classifyHttpError({ status: 529, message: 'overloaded' }).class, 'overloaded');
  assert.equal(classifyHttpError({ status: 503 }).class, 'overloaded');
  assert.equal(classifyHttpError({ status: 503 }).retryable, true);
});
test('classifyHttpError — 401/403 → auth (NOT retryable)', () => {
  assert.equal(classifyHttpError({ status: 401 }).class, 'auth');
  assert.equal(classifyHttpError({ status: 403 }).retryable, false);
});
test('classifyHttpError — other 4xx → permanent (not retryable)', () => {
  const e = classifyHttpError({ status: 400, message: 'bad request' });
  assert.equal(e.class, 'permanent');
  assert.equal(e.retryable, false);
});
test('classifyHttpError — prompt overflow → context_overflow (surface, not retryable)', () => {
  const e = classifyHttpError({ status: 400, message: 'Prompt is too long: 210000 tokens > 200000 maximum' }, 'anthropic');
  assert.equal(e.class, 'context_overflow');
  assert.equal(e.retryable, false);
  assert.equal(e.surfaceToUser, true);
});
test('classifyHttpError — no status, message regex → rate_limited / overloaded / transient_io', () => {
  assert.equal(classifyHttpError({ message: '429 rate limit exceeded' }).class, 'rate_limited');
  assert.equal(classifyHttpError({ message: 'Overloaded' }).class, 'overloaded');
  assert.equal(classifyHttpError({ message: 'ECONNRESET socket hang up' }).class, 'transient_io');
});
test('classifyHttpError — prose-only rate-limit (no status) mints NO admission denial (fail-closed, WI-5391)', () => {
  // A message that merely LOOKS rate-limity is indistinguishable from an admission-path
  // defect (WI-4541). Without a real 429 status or a governor-attached denial there is no
  // evidence — the failure must stay a loud error, never a silently-excluded capacity event.
  const e = classifyHttpError({ message: '429 rate limit exceeded' });
  assert.equal(e.class, 'rate_limited');
  assert.equal(e.admissionDenial, undefined);
});

// --- classifySubprocessResult (claude/omp/codex CLI) ---
test('classifySubprocessResult — timedOut → timeout', () => {
  assert.equal(classifySubprocessResult({ exitCode: null, timedOut: true }).class, 'timeout');
});
test('classifySubprocessResult — transient RPM stderr → rate_limited (retryable, not surfaced)', () => {
  const e1 = classifySubprocessResult({ exitCode: 1, stderr: 'Error: 429 Too Many Requests' });
  assert.equal(e1.class, 'rate_limited');
  assert.equal(e1.retryable, true);
  assert.equal(e1.surfaceToUser, false);
  assert.equal(classifySubprocessResult({ exitCode: 1, stderr: 'rate limit exceeded, retry after 30s' }).class, 'rate_limited');
  assert.equal(classifySubprocessResult({ exitCode: 1, stderr: 'slow down — too many requests' }).class, 'rate_limited');
});
test('classifySubprocessResult — rate-limit in STDOUT on a FAILED exit → rate_limited (claude prints it there)', () => {
  // The claude CLI emits "API Error: Server is temporarily limiting requests … · Rate limited" to
  // STDOUT with EMPTY stderr (observed: bee exit 1, empty stderr, 507 stdout chars). Pre-fix this
  // fell through to agent_crash so the fleet governor never backed off. Now stdout is scanned on failure.
  const e = classifySubprocessResult({
    exitCode: 1,
    stderr: '',
    stdout: 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
  });
  assert.equal(e.class, 'rate_limited');
  assert.equal(e.retryable, true);
});
test('classifySubprocessResult — prompt overflow in STDOUT on a FAILED exit → context_overflow, not agent_crash', () => {
  const e = classifySubprocessResult({
    exitCode: 1,
    stderr: '',
    stdout: 'API Error: 400 invalid_request_error — Prompt is too long: 210000 tokens > 200000 maximum',
  }, 'anthropic');
  assert.equal(e.class, 'context_overflow');
  assert.equal(e.retryable, false);
  assert.equal(e.surfaceToUser, true);
});
test('classifySubprocessResult — "rate limit" in STDOUT on a CLEAN exit is NOT misclassified (false-positive guard)', () => {
  // A successful bee whose OUTPUT merely discusses rate limits must stay a success, not rate_limited.
  const e = classifySubprocessResult({ exitCode: 0, stderr: '', stdout: 'I added rate limit handling to the governor. Done.' });
  assert.notEqual(e.class, 'rate_limited');
});
// D-001: the Claude/OpenAI subscription/plan CAP is a DISTINCT class from a transient 429 — it is
// capped until a (often hours-off) reset, so retrying is futile: NOT retryable, surfaced, paused.
test('classifySubprocessResult — plan/usage cap stderr → usage_limit (not retryable, surfaced)', () => {
  for (const stderr of [
    'You have hit your 5-hour limit',
    "You've hit your session limit · resets 4:20am (America/New_York)",
    'session limit reached',
    'You have reached your weekly limit',
    'Error: insufficient_quota — you have exceeded your current quota',
  ]) {
    const e = classifySubprocessResult({ exitCode: 1, stderr }, 'anthropic');
    assert.equal(e.class, 'usage_limit', stderr);
    assert.equal(e.retryable, false, stderr);
    assert.equal(e.surfaceToUser, true, stderr);
  }
});
test('classifySubprocessResult — usage_limit parses a reset time from the message', () => {
  const now = Date.parse('2026-06-05T08:00:00Z');
  // Relative reset.
  const rel = classifySubprocessResult({ exitCode: 1, stderr: 'usage limit reached — try again in 2h 30m' }, 'anthropic', now);
  assert.equal(rel.class, 'usage_limit');
  assert.equal(rel.resetAt, now + (2 * 3_600_000 + 30 * 60_000));
  // Absolute clock reset → next occurrence, with the right local hour.
  const abs = classifySubprocessResult({ exitCode: 1, stderr: "You've hit your usage limit · resets 4:20am" }, 'anthropic', now);
  assert.equal(abs.class, 'usage_limit');
  assert.ok(abs.resetAt !== undefined && abs.resetAt > now);
  assert.equal(new Date(abs.resetAt as number).getHours(), 4);
  assert.equal(new Date(abs.resetAt as number).getMinutes(), 20);
});
test('classifySubprocessResult — stderr overloaded → overloaded', () => {
  assert.equal(classifySubprocessResult({ exitCode: 1, stderr: '529 overloaded_error' }).class, 'overloaded');
});
test('classifySubprocessResult — Codex authorization-header UTF-8 failure → auth', () => {
  const e = classifySubprocessResult({
    exitCode: 1,
    stderr:
      "codex_api::endpoint::responses_websocket: failed to connect to websocket: UTF-8 encoding error: failed to convert header to a str for header name 'authorization'",
  }, 'openai');
  assert.equal(e.class, 'auth');
  assert.equal(e.provider, 'openai');
  assert.equal(e.retryable, false);
  assert.equal(e.surfaceToUser, true);
});
test('classifySubprocessResult — nonzero exit, no known pattern → agent_crash', () => {
  const e = classifySubprocessResult({ exitCode: 2, stderr: 'TypeError: boom' });
  assert.equal(e.class, 'agent_crash');
  assert.equal(e.retryable, true); // a crash is retryable once
});
test('classifySubprocessResult — exit 0 but empty stdout → empty_output', () => {
  assert.equal(classifySubprocessResult({ exitCode: 0, stdout: '   ' }).class, 'empty_output');
});
test('classifySubprocessResult — killed by signal → agent_crash', () => {
  assert.equal(classifySubprocessResult({ exitCode: null, signal: 'SIGKILL' }).class, 'agent_crash');
});

// --- classifyHttpError usage_limit (D-001) ---
test('classifyHttpError — bare 429 → rate_limited (transient, not surfaced)', () => {
  const e = classifyHttpError({ status: 429, message: 'rate_limit_error' }, 'anthropic');
  assert.equal(e.class, 'rate_limited');
  assert.equal(e.surfaceToUser, false);
});
test('classifyHttpError — 429 insufficient_quota (codex/OpenAI hard cap) → usage_limit', () => {
  const e = classifyHttpError({ status: 429, message: 'You exceeded your current quota — insufficient_quota' }, 'openai');
  assert.equal(e.class, 'usage_limit');
  assert.equal(e.retryable, false);
  assert.equal(e.surfaceToUser, true);
});
test('classifyHttpError — no-status usage-cap message → usage_limit with header reset', () => {
  const e = classifyHttpError(
    { headers: { 'anthropic-ratelimit-requests-reset': '2026-06-05T12:00:00Z' }, message: 'You have hit your weekly limit' },
    'anthropic',
  );
  assert.equal(e.class, 'usage_limit');
  assert.equal(e.resetAt, Date.parse('2026-06-05T12:00:00Z'));
});

// --- isAccountWide (D-001) — the single fleet-pause predicate ---
test('isAccountWide — rate_limited / overloaded / usage_limit pause the fleet; others do not', () => {
  assert.equal(isAccountWide('rate_limited'), true);
  assert.equal(isAccountWide('overloaded'), true);
  assert.equal(isAccountWide('usage_limit'), true);
  for (const c of ['timeout', 'transient_io', 'auth', 'agent_crash', 'empty_output', 'malformed_output', 'permanent'] as const) {
    assert.equal(isAccountWide(c), false, c);
  }
});

// --- parseUsageResetMs (D-001) ---
test('parseUsageResetMs — relative durations', () => {
  const now = 1_000_000;
  assert.equal(parseUsageResetMs('resets in 90 minutes', now), now + 90 * 60_000);
  assert.equal(parseUsageResetMs('try again in 2h 30m', now), now + (2 * 3_600_000 + 30 * 60_000));
  assert.equal(parseUsageResetMs('wait 45s and retry', now), now + 45_000);
  assert.equal(parseUsageResetMs('no time here', now), undefined);
});
test('parseUsageResetMs — absolute clock → next occurrence, local hour preserved', () => {
  const now = Date.parse('2026-06-05T20:00:00Z');
  const t = parseUsageResetMs('resets at 11pm', now);
  assert.ok(t !== undefined && t > now);
  assert.equal(new Date(t as number).getHours(), 23);
});

// --- date-qualified weekly wall (EI-20542327908037306) ---
// The WEEKLY limit message is date-qualified ("resets Aug 20, 7am"), and both older branches
// required a digit immediately after "resets" — so the ONE form that fails was the multi-day one,
// where a correct hold matters most. A loop that got no hold re-fired into the closed window every
// ~90min, each COLD fire burning a context reset for zero work.
test('parseUsageResetMs — date-qualified weekly wall resolves to that DATE, not tomorrow', () => {
  const now = Date.parse('2026-08-15T17:47:00Z'); // Sat Aug 15, 1:47pm EDT
  const t = parseUsageResetMs("You've hit your weekly limit · resets Aug 20, 7am (America/New_York)", now);
  assert.ok(t !== undefined, 'date-qualified reset must parse');
  const d = new Date(t as number);
  assert.equal(d.getMonth(), 7, 'August');
  assert.equal(d.getDate(), 20);
  assert.equal(d.getHours(), 7);
  // The whole point: ~5 days out, NOT the ~17h that a bare-clock read of "7am" would give.
  assert.ok(t as number > now + 4 * 86_400_000, 'must be days out, not next-morning');
});
test('parseUsageResetMs — date-qualified variants', () => {
  const now = Date.parse('2026-08-15T17:47:00Z');
  const sep = parseUsageResetMs('resets Sep 3, 16:00', now); // 24h clock
  assert.equal(new Date(sep as number).getDate(), 3);
  assert.equal(new Date(sep as number).getHours(), 16);
  const ord = parseUsageResetMs('resets Aug 21st, 7am', now); // ordinal suffix
  assert.equal(new Date(ord as number).getDate(), 21);
  const nc = parseUsageResetMs('resets Aug 18 7:30pm', now); // no comma
  assert.equal(new Date(nc as number).getHours(), 19);
  assert.equal(new Date(nc as number).getMinutes(), 30);
});
test('parseUsageResetMs — a month-name read is bounded, and non-months fall through', () => {
  const now = Date.parse('2026-08-15T17:47:00Z');
  // A PAST month names no year, so it would roll to the next one — ~10 months out. That is a
  // misread, not a long wall, and gateway.ts takes this instant as an uncapped pause, so it must
  // degrade to undefined rather than pausing inference for months.
  assert.equal(parseUsageResetMs('resets Jun 18, 7:30pm', now), undefined);
  // A non-month word must not be mistaken for one.
  assert.equal(parseUsageResetMs('resets tomorrow at 7am', now), undefined);
  // Bare-clock and relative forms are untouched by the new branch.
  const bare = parseUsageResetMs("You've hit your session limit · resets 4am (America/New_York)", now);
  assert.equal(new Date(bare as number).getHours(), 4);
  assert.equal(parseUsageResetMs('resets in 2h 30m', now), now + 2.5 * 3_600_000);
});

// --- classifyTurnError dispatch ---
test('classifyTurnError — dispatches by backend shape', () => {
  assert.equal(classifyTurnError('anthropic-direct', { status: 429, headers: { 'retry-after': '5' } }).class, 'rate_limited');
  assert.equal(classifyTurnError('claude-code', { exitCode: 1, stderr: '429 rate limit' }).class, 'rate_limited');
  assert.equal(classifyTurnError('claude-code', { exitCode: 1, stderr: "You've hit your usage limit" }).class, 'usage_limit');
  assert.equal(classifyTurnError('omp', { exitCode: 0, stdout: '' }).class, 'empty_output');
  assert.equal(classifyTurnError('codex', { exitCode: 137, signal: 'SIGKILL' }).class, 'agent_crash');
});
