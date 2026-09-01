/**
 * Tests for chat-stream pure helpers.
 * Run with: npx vitest run libs/papercusp-shared/src/agent/chat-stream.test.ts
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { normalizeModelForClaude, splitCliModelSpec, claudeModelSelectionArgs, codexModelSelectionArgs, headersToRecord, buildSystemParam, CLAUDE_CODE_IDENTIFIER, promptCacheEnabled, claudeSpawnEnvOverrides, parseClaudeResultEvent, codexMcpConfigToml, codexGatewayConfigToml, priorityTierHeaders, ownerHeaders, routeAccountHeaders, GATEWAY_PRIORITY_HEADER, GATEWAY_OWNER_HEADER, ROUTE_ACCOUNT_HEADER, retryLadderDeadlineExceeded, governorForStatelessTransport } from './chat-stream';

// EI-20394554339706750: the local inference gateway is already the pooled admission authority.
// The process-local provider singleton used to sit in front of it with maxConcurrent=3, so three
// unrelated stateless calls could manufacture a no-free-slot denial while the gateway had spare
// accounts. Gateway calls must get isolated retry governors; direct provider calls still share.
test('governorForStatelessTransport — four local pooled-gateway calls do not share the 3-slot provider bucket', async () => {
  const governors = Array.from({ length: 4 }, () =>
    governorForStatelessTransport({ baseURL: 'http://127.0.0.1:8788' }, 'claude-opus-4-8'),
  );
  assert.equal(new Set(governors).size, 4);

  const releases = await Promise.all(governors.map((governor) => governor.acquire({}, { maxWaitMs: 0 })));
  try {
    assert.ok(releases.every((release) => release !== null));
  } finally {
    for (const release of releases) release?.();
  }
});

test('governorForStatelessTransport — remote direct-provider calls retain the shared provider governor', () => {
  const a = governorForStatelessTransport({ baseURL: 'https://api.anthropic.com' }, 'claude-opus-4-8');
  const b = governorForStatelessTransport({ baseURL: 'https://api.anthropic.com' }, 'claude-opus-4-8');
  assert.strictEqual(a, b);
});

// retryLadderDeadlineExceeded (WI-5391): the anthropic-direct transient-retry ladder must
// never start a backoff sleep that crosses the caller's absolute retry deadline — a
// deadline-bounded caller (a scout cycle) has to receive the last CLASSIFIED transport
// error (a capacity-classifiable 429/529) while its own timer still has room, instead of
// the ladder outliving that timer and the failure being mislabeled a generic cycle timeout.
test('retryLadderDeadlineExceeded — no deadline → ladder unchanged (never exceeded)', () => {
  assert.equal(retryLadderDeadlineExceeded(undefined, 60_000, 1_000_000), false);
  assert.equal(retryLadderDeadlineExceeded(undefined, 0, Number.MAX_SAFE_INTEGER), false);
});
test('retryLadderDeadlineExceeded — sleep fits before the deadline → keep retrying', () => {
  assert.equal(retryLadderDeadlineExceeded(1_000_000, 2_000, 990_000), false);
});
test('retryLadderDeadlineExceeded — sleep would cross (or exactly meet) the deadline → bail', () => {
  assert.equal(retryLadderDeadlineExceeded(1_000_000, 2_000, 999_000), true);
  assert.equal(retryLadderDeadlineExceeded(1_000_000, 2_000, 998_000), true); // exact boundary
  assert.equal(retryLadderDeadlineExceeded(1_000_000, 60_000, 999_999), true);
});
test('retryLadderDeadlineExceeded — already past the deadline → bail regardless of backoff', () => {
  assert.equal(retryLadderDeadlineExceeded(1_000_000, 0, 1_000_000), true);
  assert.equal(retryLadderDeadlineExceeded(1_000_000, 0, 2_000_000), true);
});

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

test('ownerHeaders — a stable owner id becomes the x-papercusp-owner header', () => {
  assert.deepEqual(ownerHeaders('bulk-dedup:run-1'), { [GATEWAY_OWNER_HEADER]: 'bulk-dedup:run-1' });
  assert.deepEqual(ownerHeaders('  run-2  '), { 'x-papercusp-owner': 'run-2' });
  assert.deepEqual(ownerHeaders(undefined), {});
  assert.deepEqual(ownerHeaders('   '), {});
});

test('routeAccountHeaders — a concrete account pins one request; blank keeps auto-routing', () => {
  assert.deepEqual(routeAccountHeaders(' acct-7 '), { [ROUTE_ACCOUNT_HEADER]: 'acct-7' });
  assert.deepEqual(routeAccountHeaders(undefined), {});
  assert.deepEqual(routeAccountHeaders('   '), {});
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

// EI-10795: the SPAWN-side twin of priorityTierHeaders above. priorityTierHeaders only
// tiers the in-process `anthropic-direct` backend; a SPAWNED claude brain carries its
// admission tier in ANTHROPIC_CUSTOM_HEADERS, and nothing was setting it — so the owner's
// interactive voice reply spawned UNTIERED, fell to the gateway's lowest default band, and
// queued behind ~30 background fleet agents during an account-pool crunch until it hung
// ("processing forever"). Same bug class as the scout's 12-day outage, on the other path.
test('claudeSpawnEnvOverrides — priority becomes an x-papercusp-priority ANTHROPIC_CUSTOM_HEADERS line', () => {
  assert.deepEqual(claudeSpawnEnvOverrides({ priority: 'interactive' }), {
    ANTHROPIC_CUSTOM_HEADERS: 'x-papercusp-priority: interactive',
  });
  assert.deepEqual(claudeSpawnEnvOverrides({ priority: '  queen  ' }), {
    ANTHROPIC_CUSTOM_HEADERS: `${GATEWAY_PRIORITY_HEADER}: queen`,
  });
  // Composes with the tool-search toggle — neither override displaces the other.
  assert.deepEqual(claudeSpawnEnvOverrides({ priority: 'interactive', disableToolSearch: true }), {
    ENABLE_TOOL_SEARCH: 'false',
    ANTHROPIC_CUSTOM_HEADERS: 'x-papercusp-priority: interactive',
  });
});

// Discrimination — the stamp must NOT fire when there's no label, or the header would be
// meaningless (every spawn "interactive" is the same as none being tiered).
test('claudeSpawnEnvOverrides — absent/blank priority → NO custom-headers stamp (untiered, unchanged)', () => {
  assert.deepEqual(claudeSpawnEnvOverrides({ priority: undefined }), {});
  assert.deepEqual(claudeSpawnEnvOverrides({ priority: '' }), {});
  assert.deepEqual(claudeSpawnEnvOverrides({ priority: '   ' }), {});
  // A pre-existing header on the env is untouched when we have no label to add.
  assert.deepEqual(claudeSpawnEnvOverrides({}, 'x-trace-id: abc'), {});
});

// The inherited env's custom headers must SURVIVE — clobbering them would silently drop a
// caller's forwarded headers (trading one bug for another).
test('claudeSpawnEnvOverrides — priority APPENDS to inherited custom headers, never clobbers', () => {
  assert.deepEqual(claudeSpawnEnvOverrides({ priority: 'interactive' }, 'x-trace-id: abc'), {
    ANTHROPIC_CUSTOM_HEADERS: 'x-trace-id: abc\nx-papercusp-priority: interactive',
  });
});

// Idempotent: an env that ALREADY carries a priority line is left alone rather than
// stamped twice — two conflicting priority headers is an ambiguous tier at the gateway.
test('claudeSpawnEnvOverrides — an inherited priority line is not double-stamped', () => {
  assert.deepEqual(
    claudeSpawnEnvOverrides({ priority: 'interactive' }, 'x-papercusp-priority: queen'),
    { ANTHROPIC_CUSTOM_HEADERS: 'x-papercusp-priority: queen' },
  );
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

// EI-10795 (codex twin): all three backends must tier identically, or the starvation bug
// simply moves to whichever backend happens to be configured. A codex brain with no tier
// label admits in the gateway's lowest default band — the same band that left the owner's
// interactive voice queued behind the background fleet until it hung.
test('codexGatewayConfigToml — priority adds x-papercusp-priority beside the account route header', () => {
  process.env.PAPERCUSP_GATEWAY_PORT = '9898';
  const toml = codexGatewayConfigToml('codex-main', 'interactive');
  assert.match(
    toml,
    /http_headers = \{ "x-papercusp-account" = "codex-main", "x-papercusp-priority" = "interactive" \}/,
  );
});
test('codexGatewayConfigToml — absent/blank priority → account header only (untiered, byte-identical to before)', () => {
  process.env.PAPERCUSP_GATEWAY_PORT = '9898';
  assert.equal(codexGatewayConfigToml('codex-main', '  '), codexGatewayConfigToml('codex-main'));
  assert.ok(!codexGatewayConfigToml('codex-main').includes('x-papercusp-priority'));
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

test('splitCliModelSpec — recognizes only a registered reasoning suffix', () => {
  assert.deepEqual(splitCliModelSpec('gpt-5.6-luna:low'), { model: 'gpt-5.6-luna', effort: 'low' });
  assert.deepEqual(splitCliModelSpec('openai-codex/gpt-5.6-luna:XHIGH'), {
    model: 'gpt-5.6-luna',
    effort: 'xhigh',
  });
  // A colon-bearing model id whose tail is not an effort remains one model id.
  assert.deepEqual(splitCliModelSpec('chatgpt:5.4'), { model: 'chatgpt:5.4' });
});

test('claudeModelSelectionArgs — sends effort through Claude Code\'s own flag', () => {
  assert.deepEqual(claudeModelSelectionArgs('sonnet[1m]:high'), [
    '--model',
    'sonnet[1m]',
    '--effort',
    'high',
  ]);
  assert.deepEqual(claudeModelSelectionArgs('sonnet[1m]'), ['--model', 'sonnet[1m]']);
});

test('codexModelSelectionArgs — sends luna:low as a bare model plus reasoning config', () => {
  assert.deepEqual(codexModelSelectionArgs('gpt-5.6-luna:low'), [
    '-m',
    'gpt-5.6-luna',
    '-c',
    'model_reasoning_effort="low"',
  ]);
  assert.deepEqual(codexModelSelectionArgs('gpt-5.6-luna'), ['-m', 'gpt-5.6-luna']);
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

test('parseClaudeResultEvent — preserves reported values and marks incomplete usage evidence', () => {
  // A minimal result event returns what it carried and marks the missing token
  // evidence, so callers cannot mistake an absent measurement for a measured 0.
  assert.deepEqual(parseClaudeResultEvent({ type: 'result', total_cost_usd: 0.01 }), {
    costUsd: 0.01,
    unreportedFrames: 1,
  });
  // A partial usage block surfaces only the present token fields and marks the
  // missing cost measurement.
  assert.deepEqual(
    parseClaudeResultEvent({ type: 'result', usage: { input_tokens: 10, output_tokens: 20 } }),
    { tokensIn: 10, tokensOut: 20, unreportedFrames: 1 },
  );
  // Non-numeric / missing values are never coerced to 0, but the missing
  // terminal measurement remains explicit.
  assert.deepEqual(parseClaudeResultEvent({ type: 'result', num_turns: 'x', usage: {} }), {
    unreportedFrames: 1,
  });
  assert.deepEqual(parseClaudeResultEvent({}), { unreportedFrames: 1 });
});
