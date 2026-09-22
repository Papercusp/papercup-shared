/**
 * Tests for the unified agent turn-error taxonomy (agent-turn-robustness P-001).
 * Run: npx vitest run libs/papercusp-shared/src/agent/turn-error.test.ts
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  parseRetryAfterMs,
  parseResetAt,
  parseUsageReset,
  usageRearmCapMs,
  clampUsageRearmDelayMs,
  USAGE_REARM_CAP_MS,
  USAGE_REARM_CAP_HIGH_CONFIDENCE_MS,
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
test('classifySubprocessResult — Codex selected-model capacity in FAILED STDOUT → one-minute rate_limited retry', () => {
  const e = classifySubprocessResult({
    exitCode: 1,
    stderr: '',
    stdout: 'Selected model is at capacity. Please try a different model.',
  }, 'openai');
  assert.equal(e.class, 'rate_limited');
  assert.equal(e.retryable, true);
  assert.equal(e.surfaceToUser, false);
  // The literal, not MODEL_CAPACITY_RETRY_AFTER_MS: comparing against the constant under test
  // passes for any value it holds, so a shortened window would go unnoticed.
  assert.equal(e.retryAfterMs, 60_000);
  assert.equal(e.provider, 'openai');
});
test('classifySubprocessResult — Codex capacity wording honors a longer inline retry hint', () => {
  const e = classifySubprocessResult({
    exitCode: 1,
    stderr: '',
    stdout: 'Selected model is at capacity. Please try again in 90 seconds.',
  }, 'openai');
  assert.equal(e.class, 'rate_limited');
  assert.equal(e.retryAfterMs, 90_000);
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
test('classifySubprocessResult — autocompact-thrashing death in STDOUT → context_overflow, not agent_crash (EI-20314829458383612)', () => {
  const e = classifySubprocessResult({
    exitCode: 1,
    stderr: '',
    stdout:
      'Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row.',
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
test('classifySubprocessResult — malformed Authorization diagnostics preserve safe shape and suffix without the bearer', () => {
  const bearer = 'Bearer abcDEF123456';
  const malformedValue = `${bearer} fired — WI-40086${String.fromCharCode(7)}`;
  const e = classifySubprocessResult({
    exitCode: 1,
    stderr:
      `codex_api::endpoint::responses_websocket: failed to connect to websocket: UTF-8 encoding error: ` +
      `failed to convert header to a str for header name 'authorization'\nwith value: "${malformedValue}"`,
  }, 'openai');

  assert.equal(e.class, 'auth');
  assert.match(e.message, /malformed Authorization header: value shape bytes=\d+, chars=\d+, classes=whitespace,non-ASCII,control/);
  assert.match(e.message, /redacted head=/);
  assert.match(e.message, /redacted tail=/);
  assert.match(e.message, /WI-40086/); // The post-token event suffix survives for root-cause tracing.
  assert.equal(e.message.includes(bearer), false);
  assert.equal(e.message.includes('abcDEF123456'), false);
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(e.message), false);
});
test('classifySubprocessResult — ordinary auth diagnostics retain their existing bounded message', () => {
  const stderr = '401 Unauthorized: Bearer ordinary-auth-marker';
  const e = classifySubprocessResult({ exitCode: 1, stderr }, 'openai');

  assert.equal(e.class, 'auth');
  assert.equal(e.message, stderr.slice(0, 200));
  assert.equal(e.message.includes('malformed Authorization header'), false);
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

// --- parseUsageReset (D-001) ---
test('parseUsageReset — relative durations', () => {
  const now = 1_000_000;
  assert.equal(parseUsageReset('resets in 90 minutes', now)?.atMs, now + 90 * 60_000);
  assert.equal(parseUsageReset('try again in 2h 30m', now)?.atMs, now + (2 * 3_600_000 + 30 * 60_000));
  assert.equal(parseUsageReset('wait 45s and retry', now)?.atMs, now + 45_000);
  assert.equal(parseUsageReset('no time here', now), undefined);
  assert.equal(parseUsageReset('resets in 90 minutes', now)?.precision, 'relative');
});
test('parseUsageReset — absolute clock → next occurrence, local hour preserved', () => {
  const now = Date.parse('2026-06-05T20:00:00Z');
  const r = parseUsageReset('resets at 11pm', now);
  assert.ok(r !== undefined && r.atMs > now);
  assert.equal(new Date(r.atMs).getHours(), 23);
  // 'clock', not 'dated': the DAY is our inference, and that is what keeps the tight re-arm rail.
  assert.equal(r.precision, 'clock');
});

// --- date-qualified weekly wall (EI-20542327908037306) ---
// The WEEKLY limit message is date-qualified ("resets Aug 20, 7am"), and both older branches
// required a digit immediately after "resets" — so the ONE form that fails was the multi-day one,
// where a correct hold matters most. A loop that got no hold re-fired into the closed window every
// ~90min, each COLD fire burning a context reset for zero work.
test('parseUsageReset — date-qualified weekly wall resolves to that DATE, not tomorrow', () => {
  const now = Date.parse('2026-08-15T17:47:00Z'); // Sat Aug 15, 1:47pm EDT
  const r = parseUsageReset("You've hit your weekly limit · resets Aug 20, 7am (America/New_York)", now);
  assert.ok(r !== undefined, 'date-qualified reset must parse');
  const d = new Date(r.atMs);
  assert.equal(d.getMonth(), 7, 'August');
  assert.equal(d.getDate(), 20);
  assert.equal(d.getHours(), 7);
  // The whole point: ~5 days out, NOT the ~17h that a bare-clock read of "7am" would give.
  assert.ok(r.atMs > now + 4 * 86_400_000, 'must be days out, not next-morning');
  assert.equal(r.precision, 'dated', 'an explicitly NAMED instant — earns the long re-arm ceiling');
});
test('parseUsageReset — date-qualified variants', () => {
  const now = Date.parse('2026-08-15T17:47:00Z');
  const sep = parseUsageReset('resets Sep 3, 16:00', now); // 24h clock
  assert.equal(new Date(sep!.atMs).getDate(), 3);
  assert.equal(new Date(sep!.atMs).getHours(), 16);
  const ord = parseUsageReset('resets Aug 21st, 7am', now); // ordinal suffix
  assert.equal(new Date(ord!.atMs).getDate(), 21);
  const nc = parseUsageReset('resets Aug 18 7:30pm', now); // no comma
  assert.equal(new Date(nc!.atMs).getHours(), 19);
  assert.equal(new Date(nc!.atMs).getMinutes(), 30);
  for (const r of [sep, ord, nc]) assert.equal(r?.precision, 'dated');
});
test('parseUsageReset — a month-name read is bounded, and non-months fall through', () => {
  const now = Date.parse('2026-08-15T17:47:00Z');
  // A PAST month names no year, so it would roll to the next one — ~10 months out. That is a
  // misread, not a long wall, and gateway.ts takes this instant as an uncapped pause, so it must
  // degrade to undefined rather than pausing inference for months.
  assert.equal(parseUsageReset('resets Jun 18, 7:30pm', now), undefined);
  // A non-month word must not be mistaken for one.
  assert.equal(parseUsageReset('resets tomorrow at 7am', now), undefined);
  // Bare-clock and relative forms are untouched by the new branch — and must NOT claim 'dated',
  // which would hand an INFERRED day the multi-day re-arm ceiling (EI-20544023385610622).
  const bare = parseUsageReset("You've hit your session limit · resets 4am (America/New_York)", now);
  assert.equal(new Date(bare!.atMs).getHours(), 4);
  assert.equal(bare!.precision, 'clock');
  assert.equal(parseUsageReset('resets in 2h 30m', now)?.atMs, now + 2.5 * 3_600_000);
  assert.equal(parseUsageReset('resets in 2h 30m', now)?.precision, 'relative');
});

// --- the two-tier re-arm ceiling (EI-20544023385610622) ---
// The parser learning the weekly form was only half the fix: the caller then clipped the
// correctly-parsed ~113h hold to a 6h cap tuned for DAILY walls, so a walled loop still re-fired
// ~4x/day into a window it already knew was closed. The ceiling now follows the CONFIDENCE of the
// instant rather than a single number for every case.
test('usageRearmCapMs — only a NAMED instant earns the long ceiling', () => {
  assert.equal(usageRearmCapMs('dated'), USAGE_REARM_CAP_HIGH_CONFIDENCE_MS);
  assert.equal(usageRearmCapMs('header'), USAGE_REARM_CAP_HIGH_CONFIDENCE_MS);
  // INFERRED or short-range → the tight sanity rail is unchanged.
  assert.equal(usageRearmCapMs('clock'), USAGE_REARM_CAP_MS);
  assert.equal(usageRearmCapMs('relative'), USAGE_REARM_CAP_MS);
  // Absent precision must FAIL CLOSED: a legacy/hand-built error that never set one must not
  // inherit the multi-day hold by omission.
  assert.equal(usageRearmCapMs(undefined), USAGE_REARM_CAP_MS);
  assert.ok(USAGE_REARM_CAP_HIGH_CONFIDENCE_MS > USAGE_REARM_CAP_MS);
});
test('clampUsageRearmDelayMs — a weekly wall is held in full; a bare-clock guess is still clipped', () => {
  const interval = 60_000;
  const weeklyMs = 113 * 3_600_000; // the real measured shape: ~4.7 days out
  // THE BUG: this used to come back as 6h.
  assert.equal(clampUsageRearmDelayMs(weeklyMs, interval, 'dated'), weeklyMs);
  assert.equal(clampUsageRearmDelayMs(weeklyMs, interval, 'clock'), USAGE_REARM_CAP_MS);
  assert.equal(clampUsageRearmDelayMs(weeklyMs, interval, undefined), USAGE_REARM_CAP_MS);
  // The rail still exists for a NAMED instant — it is widened, not removed. A garbled dated parse
  // (the parser admits up to 35d) is bounded to one week, not slept on for a month.
  assert.equal(clampUsageRearmDelayMs(30 * 86_400_000, interval, 'dated'), USAGE_REARM_CAP_HIGH_CONFIDENCE_MS);
  // The interval floor is unchanged: never fire sooner than the loop's own cadence.
  assert.equal(clampUsageRearmDelayMs(5, interval, 'dated'), interval);
  // A DAILY wall — the regime the 6h cap was tuned for — is unaffected either way.
  assert.equal(clampUsageRearmDelayMs(3 * 3_600_000, interval, 'clock'), 3 * 3_600_000);
});
test('classifySubprocessResult — a weekly wall carries BOTH the instant and its precision', () => {
  const now = Date.parse('2026-08-15T17:47:00Z');
  const err = classifySubprocessResult(
    { exitCode: 1, stdout: "You've hit your weekly limit · resets Aug 20, 7am (America/New_York)" },
    'anthropic',
    now,
  );
  assert.equal(err.class, 'usage_limit');
  assert.equal(err.resetPrecision, 'dated');
  // End-to-end: the precision must survive onto the TurnError, or the consumer silently falls back
  // to the tight rail and the fix is inert on the very path a walled loop dies on.
  assert.equal(clampUsageRearmDelayMs(err.resetAt! - now, 60_000, err.resetPrecision), err.resetAt! - now);
});
test('classifyHttpError — a provider *-reset header is high-confidence', () => {
  const now = Date.parse('2026-08-15T17:47:00Z');
  const err = classifyHttpError(
    {
      status: 429,
      message: 'usage limit reached',
      headers: { 'anthropic-ratelimit-requests-reset': new Date(now + 90 * 3_600_000).toISOString() },
    },
    'anthropic',
    now,
  );
  assert.equal(err.class, 'usage_limit');
  assert.equal(err.resetPrecision, 'header');
});

// --- classifyTurnError dispatch ---
test('classifyTurnError — dispatches by backend shape', () => {
  assert.equal(classifyTurnError('anthropic-direct', { status: 429, headers: { 'retry-after': '5' } }).class, 'rate_limited');
  assert.equal(classifyTurnError('claude-code', { exitCode: 1, stderr: '429 rate limit' }).class, 'rate_limited');
  assert.equal(classifyTurnError('claude-code', { exitCode: 1, stderr: "You've hit your usage limit" }).class, 'usage_limit');
  assert.equal(classifyTurnError('omp', { exitCode: 0, stdout: '' }).class, 'empty_output');
  assert.equal(classifyTurnError('codex', { exitCode: 137, signal: 'SIGKILL' }).class, 'agent_crash');
});

// --- classifiedOn: the class's own evidence (WI-2143683) ---
// `class` is decided by scanning stderr+stdout together; `message` is taken from stderr whenever
// stderr is non-empty. So on a failed exit whose provider wall went to STDOUT, the two come from
// different streams and the quoted message does not support the class printed beside it. Measured
// over the 191 `LOOP WEDGED` alerts loop-turn-outcome had filed: 41 of 59 `usage_limit` ones quoted
// a message with no usage-limit signature in it, which reads as a misclassification to the agent
// who claims the alert. `classifiedOn` carries the text the class actually rests on.

test('classifiedOn — usage wall on STDOUT with unrelated stderr: message and class disagree, classifiedOn resolves it', () => {
  // The exact shape behind EI-21914072944446087: a SessionEnd hook failure on stderr while the
  // provider wall printed to stdout (the normal case per classifySubprocessResult's own comment).
  const e = classifySubprocessResult({
    exitCode: 1,
    stderr: 'SessionEnd hook [/home/u/.papercusp/hooks/cc/lifecycle-report.sh] failed: Hook cancelled',
    stdout: "starting turn\nAPI Error: You've hit your usage limit · limit resets 4:20am\n",
  });
  assert.equal(e.class, 'usage_limit');
  // The message is the stderr text — and on its own it is NOT evidence for `usage_limit`.
  assert.match(e.message, /Hook cancelled/);
  assert.doesNotMatch(e.message, /usage limit/i);
  // classifiedOn carries what the class actually rests on.
  assert.equal(e.classifiedOn, "API Error: You've hit your usage limit · limit resets 4:20am");
});

test('classifiedOn — is the matched LINE only, never the surrounding output', () => {
  const e = classifySubprocessResult({
    exitCode: 1,
    stderr: 'hook failed',
    stdout: 'line before\n403 Forbidden: invalid api key\nline after\n',
  });
  assert.equal(e.class, 'auth');
  assert.equal(e.classifiedOn, '403 Forbidden: invalid api key');
});

test('classifiedOn — absent when the message ALREADY shows the evidence (no redundancy)', () => {
  // stderr empty ⇒ errText falls back to stdout ⇒ message already IS the matched text.
  const onStdout = classifySubprocessResult({ exitCode: 1, stderr: '', stdout: "You've hit your usage limit" });
  assert.equal(onStdout.class, 'usage_limit');
  assert.equal(onStdout.classifiedOn, undefined);
  // Wall on stderr ⇒ message is the stderr text, which contains the match.
  const onStderr = classifySubprocessResult({ exitCode: 1, stderr: 'Error: 429 Too Many Requests' });
  assert.equal(onStderr.class, 'rate_limited');
  assert.equal(onStderr.classifiedOn, undefined);
});

test('classifiedOn — never set on the malformed-Authorization branch (no raw credential echo)', () => {
  // That branch builds its own redacted diagnostic precisely so a live bearer is never persisted;
  // echoing a raw matched line there would reintroduce what the redaction exists to prevent.
  const e = classifySubprocessResult({
    exitCode: 1,
    stderr: 'unrelated stderr noise',
    stdout: 'failed to convert header to a str for header name "authorization": Bearer sk-ant-SECRET',
  });
  assert.equal(e.class, 'auth');
  assert.equal(e.classifiedOn, undefined);
  assert.doesNotMatch(JSON.stringify(e), /sk-ant-SECRET/);
});

test('classifiedOn — absent for classes decided without a pattern match', () => {
  assert.equal(classifySubprocessResult({ exitCode: null, timedOut: true }).classifiedOn, undefined);
  assert.equal(classifySubprocessResult({ exitCode: 137, signal: 'SIGKILL' }).classifiedOn, undefined);
  assert.equal(classifySubprocessResult({ exitCode: 3, stderr: 'some ordinary crash' }).classifiedOn, undefined);
});

test('classifiedOn — does not disturb resetAt/resetPrecision on the usage branch', () => {
  const now = Date.parse('2026-09-03T10:00:00Z');
  const e = classifySubprocessResult(
    { exitCode: 1, stderr: 'hook failed', stdout: "You've hit your usage limit · limit resets 4:20am" },
    'anthropic',
    now,
  );
  assert.equal(e.class, 'usage_limit');
  assert.ok(e.classifiedOn, 'classifiedOn should be populated');
  assert.ok(e.resetAt !== undefined, 'resetAt must still be parsed alongside classifiedOn');
});
