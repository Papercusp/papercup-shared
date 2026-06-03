/**
 * Tests for backend profiles + the shared governor registry (robustness P-011).
 * Run: npx vitest run libs/papercup-shared/src/agent/governor-registry.test.ts
 */
import { test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  BACKEND_PROFILES,
  modelClassOf,
  getGovernor,
  governorForBackend,
  resetGovernorRegistry,
  resolveLimitModel,
  resolveProviderLimitModel,
  onGovernorPause,
  snapshotGovernors,
} from './governor-registry';

beforeEach(() => resetGovernorRegistry());

test('BACKEND_PROFILES — provider + self-pacing per backend', () => {
  assert.equal(BACKEND_PROFILES.meridian.provider, 'anthropic');
  assert.equal(BACKEND_PROFILES['claude-code'].provider, 'anthropic');
  assert.equal(BACKEND_PROFILES.codex.provider, 'openai');
  assert.equal(BACKEND_PROFILES.omp.selfPacing, true); // model-agnostic + fallback chaining
  assert.equal(BACKEND_PROFILES.meridian.selfPacing, false);
});

// D-006: limitModel is a RUNTIME credential fact, not a compile-time const.
test('resolveLimitModel — subscription by default, apiKey when a provider key is set in env', () => {
  // No keys → coarse subscription mode (the Max/ChatGPT OAuth default on the dev box).
  assert.equal(resolveLimitModel('meridian', {}), 'subscription');
  assert.equal(resolveLimitModel('claude-code', {}), 'subscription');
  assert.equal(resolveLimitModel('codex', {}), 'subscription');
  // An Anthropic API key flips claude paths to precise header-driven mode.
  assert.equal(resolveLimitModel('meridian', { ANTHROPIC_API_KEY: 'sk-ant-x' }), 'apiKey');
  assert.equal(resolveProviderLimitModel('anthropic', { ANTHROPIC_API_KEY: 'sk-ant-x' }), 'apiKey');
  // An OpenAI API key flips codex to precise mode; anthropic key doesn't affect openai.
  assert.equal(resolveLimitModel('codex', { OPENAI_API_KEY: 'sk-oai-x' }), 'apiKey');
  assert.equal(resolveProviderLimitModel('openai', { ANTHROPIC_API_KEY: 'sk-ant-x' }), 'subscription');
  // omp self-paces → always coarse, regardless of any key in env.
  assert.equal(resolveLimitModel('omp', { ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-oai-x' }), 'subscription');
});

test('modelClassOf — buckets opus/sonnet/haiku separately (Anthropic limits are per-class)', () => {
  assert.equal(modelClassOf('claude-opus-4-8'), 'opus');
  assert.equal(modelClassOf('anthropic/claude-sonnet-4-6'), 'sonnet');
  assert.equal(modelClassOf('claude-haiku-4-5'), 'haiku');
  assert.equal(modelClassOf('gpt-5-codex'), 'default');
});

test('getGovernor — singleton per (provider, modelClass) key', () => {
  const a = getGovernor('anthropic', 'opus');
  const b = getGovernor('anthropic', 'opus');
  const c = getGovernor('anthropic', 'sonnet');
  const d = getGovernor('openai', 'default');
  assert.equal(a, b); // same key → same instance (so pacing is actually shared)
  assert.notEqual(a, c); // opus vs sonnet → separate buckets
  assert.notEqual(a, d); // anthropic vs openai → separate buckets
});

test('governorForBackend — omp is self-pacing (concurrency-only: no rpm/itpm/otpm)', () => {
  const omp = governorForBackend('omp', 'claude-sonnet-4-6');
  assert.equal(omp.state.limits.rpm, undefined); // self-pacing → no token/req budget
  assert.ok(omp.state.limits.maxConcurrent >= 1);
  const claude = governorForBackend('claude-code', 'claude-sonnet-4-6');
  assert.equal(typeof claude.state.limits.rpm, 'number'); // claude gets a conservative RPM floor
});

test('governorForBackend — claude (meridian + CLI) share the Anthropic bucket per model-class', () => {
  const mer = governorForBackend('meridian', 'claude-opus-4-8');
  const cli = governorForBackend('claude-code', 'claude-opus-4-8');
  assert.equal(mer, cli); // same provider+class → one shared budget (don't co-burst the account)
});

// RB-009 observability ------------------------------------------------------------------
test('onGovernorPause — fires (with the bucket key) when a governor is penalized', () => {
  const events: Array<{ key: string; pausedUntil: number; source: string }> = [];
  const off = onGovernorPause((ev) => events.push(ev));
  const g = governorForBackend('claude-code', 'claude-opus-4-8');
  g.penalize({ retryAfterMs: 30_000 });
  assert.equal(events.length, 1);
  assert.equal(events[0].key, 'anthropic:opus');
  assert.equal(events[0].source, 'penalty');
  assert.ok(events[0].pausedUntil > 0);
  off();
  g.penalize({ retryAfterMs: 999_000 }); // after unsubscribe → no more events
  assert.equal(events.length, 1);
});

test('onGovernorPause — does NOT fire when a penalty does not extend the pause', () => {
  const events: unknown[] = [];
  onGovernorPause((ev) => events.push(ev));
  const g = getGovernor('anthropic', 'sonnet');
  g.penalize({ resetAt: Date.now() + 60_000 });
  g.penalize({ retryAfterMs: 1 }); // shorter → must NOT re-fire (no new backpressure)
  assert.equal(events.length, 1);
});

test('snapshotGovernors — reports each live bucket with its pause + concurrency state', () => {
  const g = governorForBackend('claude-code', 'claude-opus-4-8');
  g.penalize({ retryAfterMs: 30_000 });
  const snap = snapshotGovernors();
  const opus = snap.find((s) => s.key === 'anthropic:opus');
  assert.ok(opus);
  assert.equal(opus!.provider, 'anthropic');
  assert.equal(opus!.modelClass, 'opus');
  assert.ok(opus!.state.pausedUntil > 0);
  assert.equal(typeof opus!.state.inFlight, 'number');
  assert.ok(opus!.limitModel === 'subscription' || opus!.limitModel === 'apiKey'); // D-006 runtime fact
});
