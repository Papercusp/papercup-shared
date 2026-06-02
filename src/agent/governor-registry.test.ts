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
} from './governor-registry';

beforeEach(() => resetGovernorRegistry());

test('BACKEND_PROFILES — provider + self-pacing per backend', () => {
  assert.equal(BACKEND_PROFILES.meridian.provider, 'anthropic');
  assert.equal(BACKEND_PROFILES['claude-code'].provider, 'anthropic');
  assert.equal(BACKEND_PROFILES.codex.provider, 'openai');
  assert.equal(BACKEND_PROFILES.omp.selfPacing, true); // model-agnostic + fallback chaining
  assert.equal(BACKEND_PROFILES.meridian.selfPacing, false);
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
