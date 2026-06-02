/**
 * Tests for the unified agent turn-error taxonomy (agent-turn-robustness P-001).
 * Run: npx vitest run libs/papercup-shared/src/agent/turn-error.test.ts
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  parseRetryAfterMs,
  parseResetAt,
  classifyHttpError,
  classifySubprocessResult,
  classifyTurnError,
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

// --- classifyHttpError (meridian / API) ---
test('classifyHttpError — 429 → rate_limited, honors retry-after + reset', () => {
  const e = classifyHttpError({
    status: 429,
    headers: { 'retry-after': '12', 'anthropic-ratelimit-output-tokens-reset': '2026-06-02T12:00:00Z' },
    message: 'rate_limit_error',
  }, 'anthropic');
  assert.equal(e.class, 'rate_limited');
  assert.equal(e.retryAfterMs, 12_000);
  assert.equal(e.resetAt, Date.parse('2026-06-02T12:00:00Z'));
  assert.equal(e.retryable, true);
  assert.equal(e.provider, 'anthropic');
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
test('classifyHttpError — no status, message regex → rate_limited / overloaded / transient_io', () => {
  assert.equal(classifyHttpError({ message: '429 rate limit exceeded' }).class, 'rate_limited');
  assert.equal(classifyHttpError({ message: 'Overloaded' }).class, 'overloaded');
  assert.equal(classifyHttpError({ message: 'ECONNRESET socket hang up' }).class, 'transient_io');
});

// --- classifySubprocessResult (claude/omp/codex CLI) ---
test('classifySubprocessResult — timedOut → timeout', () => {
  assert.equal(classifySubprocessResult({ exitCode: null, timedOut: true }).class, 'timeout');
});
test('classifySubprocessResult — stderr rate-limit patterns → rate_limited', () => {
  assert.equal(classifySubprocessResult({ exitCode: 1, stderr: 'Error: 429 Too Many Requests' }).class, 'rate_limited');
  assert.equal(classifySubprocessResult({ exitCode: 1, stderr: 'rate limit exceeded, retry after 30s' }).class, 'rate_limited');
  assert.equal(classifySubprocessResult({ exitCode: 1, stderr: 'You have hit your 5-hour limit' }).class, 'rate_limited');
});
test('classifySubprocessResult — stderr overloaded → overloaded', () => {
  assert.equal(classifySubprocessResult({ exitCode: 1, stderr: '529 overloaded_error' }).class, 'overloaded');
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

// --- classifyTurnError dispatch ---
test('classifyTurnError — dispatches by backend shape', () => {
  assert.equal(classifyTurnError('meridian', { status: 429, headers: { 'retry-after': '5' } }).class, 'rate_limited');
  assert.equal(classifyTurnError('claude-code', { exitCode: 1, stderr: '429 rate limit' }).class, 'rate_limited');
  assert.equal(classifyTurnError('omp', { exitCode: 0, stdout: '' }).class, 'empty_output');
  assert.equal(classifyTurnError('codex', { exitCode: 137, signal: 'SIGKILL' }).class, 'agent_crash');
});
