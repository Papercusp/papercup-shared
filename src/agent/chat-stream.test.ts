/**
 * Tests for chat-stream pure helpers.
 * Run with: npx vitest run libs/papercusp-shared/src/agent/chat-stream.test.ts
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { normalizeModelForClaude, headersToRecord, buildSystemParam, CLAUDE_CODE_IDENTIFIER, promptCacheEnabled, claudeSpawnEnvOverrides, parseClaudeResultEvent, codexMcpConfigToml, codexGatewayConfigToml, priorityTierHeaders, GATEWAY_PRIORITY_HEADER } from './chat-stream';

// priorityTierHeaders (gateway-priority-tiers): the in-process anthropic-direct call
// stamps `x-papercusp-priority: <role>` so the pacing gateway tiers it (scout/queen=1)
// instead of the lowest first-shed default band. A blank/absent label → no header
// (untiered). This is the seam that ended the scout's 12-day ideation outage.
test('priorityTierHeaders — a role label becomes the x-papercusp-priority header', () => {
  assert.deepEqual(priorityTierHeaders('scout'), { [GATEWAY_PRIORITY_HEADER]: 'scout' });
  assert.deepEqual(priorityTierHeaders('queen'), { 'x-papercusp-priority': 'queen' });
  assert.deepEqual(priorityTierHeaders('  bee  '), { 'x-papercusp-priority': 'bee' });
});
test('priorityTierHeaders — absent/blank label → no header (untiered call)', () => {
  assert.deepEqual(priorityTierHeaders(undefined), {});
  assert.deepEqual(priorityTierHeaders(''), {});
  assert.deepEqual(priorityTierHeaders('   '), {});
});

// claudeSpawnEnvOverrides (voice-persona P-009): disableToolSearch →
// ENABLE_TOOL_SEARCH=false so the operator brain's caller-shrunk MCP surface
// loads directly instead of deferring behind ToolSearch. Default: no override
// (every other spawn keeps the deferred default).
test('claudeSpawnEnvOverrides — disableToolSearch sets ENABLE_TOOL_SEARCH=false', () => {
  assert.deepEqual(claudeSpawnEnvOverrides({ disableToolSearch: true }), { ENABLE_TOOL_SEARCH: 'false' });
});
test('claudeSpawnEnvOverrides — default / false → no env override', () => {
  assert.deepEqual(claudeSpawnEnvOverrides({}), {});
  assert.deepEqual(claudeSpawnEnvOverrides({ disableToolSearch: false }), {});
});

test('codexMcpConfigToml — bakes HTTP MCP Authorization headers, never bearer_token_env_var', () => {
  const toml = codexMcpConfigToml({
    mcpServers: {
      'papercusp-su': {
        type: 'http',
        url: 'http://127.0.0.1:3070/api/mcp?superuser=1',
        headers: {
          Authorization: 'Bearer TESTBEARER',
          'x-extra': 'one',
        },
      },
    },
  });
  assert.match(toml, /\[mcp_servers\.papercusp-su\]/);
  assert.match(toml, /url = "http:\/\/127\.0\.0\.1:3070\/api\/mcp\?superuser=1"/);
  assert.match(toml, /http_headers = \{ "Authorization" = "Bearer TESTBEARER", "x-extra" = "one" \}/);
  assert.doesNotMatch(toml, /bearer_token_env_var/);
  assert.doesNotMatch(toml, /AGENTMCP_BEARER/);
});

test('codexGatewayConfigToml — routes Codex model traffic through the account-pinned gateway provider', () => {
  process.env.PAPERCUSP_GATEWAY_PORT = '9898';
  const toml = codexGatewayConfigToml('codex-main');
  assert.match(toml, /model_provider = "papercusp-codex-gateway"/);
  assert.match(toml, /\[model_providers\.papercusp-codex-gateway\]/);
  assert.match(toml, /base_url = "http:\/\/127\.0\.0\.1:9898\/v1"/);
  assert.match(toml, /wire_api = "responses"/);
  assert.match(toml, /http_headers = \{ "x-papercusp-account" = "codex-main" \}/);
});

// headersToRecord (P-004): SDK error `.headers` → a lowercased record so the TurnError
// classifier can read retry-after / anthropic-ratelimit-* off it.
test('headersToRecord — Headers-like object (forEach) → lowercased record', () => {
  const m = new Map<string, string>([['Retry-After', '12'], ['Anthropic-RateLimit-Requests-Reset', 'x']]);
  const headersLike = { forEach: (cb: (v: string, k: string) => void) => m.forEach((v, k) => cb(v, k)) };
  const r = headersToRecord(headersLike);
  assert.equal(r?.['retry-after'], '12');
  assert.equal(r?.['anthropic-ratelimit-requests-reset'], 'x');
});
test('headersToRecord — plain object → lowercased; nullish → undefined', () => {
  assert.equal(headersToRecord({ 'Retry-After': '5' })?.['retry-after'], '5');
  assert.equal(headersToRecord(undefined), undefined);
  assert.equal(headersToRecord(null), undefined);
});

// claude's `--model` rejects omp's `provider/model` form; the
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

// buildSystemParam (RB-008 + claude-code-system-framing 2026-06-30): the FIRST block is ALWAYS the
// Claude Code identifier (auth-bucket framing — a Max-OAuth request without it is 429-shunted, esp.
// opus), then the caller's stable prefix as a cache_control:ephemeral block so repeat calls cache-read
// it. Off-switch keeps the block-array form (no cache_control) — the identifier must still be present.
afterEach(() => {
  delete process.env.PAPERCUSP_PROMPT_CACHE;
  delete process.env.PAPERCUSP_PROMPT_CACHE_TTL;
});
const CC = { type: 'text', text: CLAUDE_CODE_IDENTIFIER };
test('buildSystemParam — caching on (default) → [Claude Code id, ephemeral prefix]', () => {
  assert.deepEqual(buildSystemParam('frozen rubric', true), [
    CC,
    { type: 'text', text: 'frozen rubric', cache_control: { type: 'ephemeral' } },
  ]);
});
test('buildSystemParam — caching off → [Claude Code id, bare prefix block] (no cache_control)', () => {
  assert.deepEqual(buildSystemParam('frozen rubric', false), [CC, { type: 'text', text: 'frozen rubric' }]);
});
test('buildSystemParam — empty prompt still frames as Claude Code (the headless-429 fix)', () => {
  assert.deepEqual(buildSystemParam(''), [CC]);
});
test('promptCacheEnabled — defaults ON, OFF only when PAPERCUSP_PROMPT_CACHE=0', () => {
  delete process.env.PAPERCUSP_PROMPT_CACHE;
  assert.equal(promptCacheEnabled(), true);
  process.env.PAPERCUSP_PROMPT_CACHE = '0';
  assert.equal(promptCacheEnabled(), false);
  process.env.PAPERCUSP_PROMPT_CACHE = '1';
  assert.equal(promptCacheEnabled(), true);
});
test('buildSystemParam — honors the env flag when no explicit arg', () => {
  process.env.PAPERCUSP_PROMPT_CACHE = '0';
  assert.deepEqual(buildSystemParam('x'), [CC, { type: 'text', text: 'x' }]);
  process.env.PAPERCUSP_PROMPT_CACHE = '1';
  assert.deepEqual(buildSystemParam('x'), [CC, { type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }]);
});
test('buildSystemParam — PAPERCUSP_PROMPT_CACHE_TTL=1h opts into the 1-hour cache window (P-006)', () => {
  // default (unset) = 5m, no ttl field on the caller block
  assert.deepEqual(buildSystemParam('frozen rubric', true), [
    CC,
    { type: 'text', text: 'frozen rubric', cache_control: { type: 'ephemeral' } },
  ]);
  process.env.PAPERCUSP_PROMPT_CACHE_TTL = '1h';
  assert.deepEqual(buildSystemParam('frozen rubric', true), [
    CC,
    { type: 'text', text: 'frozen rubric', cache_control: { type: 'ephemeral', ttl: '1h' } },
  ]);
});

// parseClaudeResultEvent (external-bench native arm, P-007): maps a claude-code
// `--output-format stream-json` terminal `result` event → the usage slice the
// subprocess loop folds in, and that the run-result `turns`/cache fields need.
test('parseClaudeResultEvent — full claude result event maps every reported field', () => {
  assert.deepEqual(
    parseClaudeResultEvent({
      type: 'result',
      subtype: 'success',
      num_turns: 14,
      total_cost_usd: 0.4231,
      result: 'done — patch applied',
      usage: {
        input_tokens: 1200,
        output_tokens: 3400,
        cache_read_input_tokens: 55000,
        cache_creation_input_tokens: 8000,
      },
    }),
    {
      tokensIn: 1200,
      tokensOut: 3400,
      cacheReadTokens: 55000,
      cacheCreationTokens: 8000,
      costUsd: 0.4231,
      numTurns: 14,
      resultText: 'done — patch applied',
    },
  );
});

test('parseClaudeResultEvent — omits unreported keys (no cache / no turns / no usage)', () => {
  // A minimal result event (no usage block, no num_turns) returns ONLY what it
  // carried, so the loop keeps prior streamed accumulators for absent fields.
  assert.deepEqual(parseClaudeResultEvent({ type: 'result', total_cost_usd: 0.01 }), {
    costUsd: 0.01,
  });
  // A partial usage block surfaces only the present token fields.
  assert.deepEqual(
    parseClaudeResultEvent({ type: 'result', usage: { input_tokens: 10, output_tokens: 20 } }),
    { tokensIn: 10, tokensOut: 20 },
  );
  // Non-numeric / missing → empty (never coerces a bogus 0).
  assert.deepEqual(parseClaudeResultEvent({ type: 'result', num_turns: 'x', usage: {} }), {});
  assert.deepEqual(parseClaudeResultEvent({}), {});
});
