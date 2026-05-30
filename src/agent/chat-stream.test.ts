/**
 * Tests for chat-stream pure helpers.
 * Run with: npx vitest run libs/papercup-shared/src/agent/chat-stream.test.ts
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { normalizeModelForClaude } from './chat-stream';

// claude's `--model` rejects omp/Meridian's `provider/model` form; the
// in-process claude branch normalizes before passing it through.

test('normalizeModelForClaude — strips a leading provider/ segment', () => {
  assert.equal(normalizeModelForClaude('anthropic/claude-opus-4-7'), 'claude-opus-4-7');
});

test('normalizeModelForClaude — leaves a bare id or alias untouched', () => {
  assert.equal(normalizeModelForClaude('claude-sonnet-4-6'), 'claude-sonnet-4-6');
  assert.equal(normalizeModelForClaude('sonnet'), 'sonnet');
});

test('normalizeModelForClaude — empty in → empty out', () => {
  assert.equal(normalizeModelForClaude(''), '');
});
