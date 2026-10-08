/**
 * Tests for chat-stream pure helpers.
 * Run with: npx vitest run libs/papercusp-shared/src/agent/chat-stream.test.ts
 */
import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runAgentChat } from './chat-stream';
import { normalizeModelForClaude, splitCliModelSpec, claudeModelSelectionArgs, codexModelSelectionArgs, estimateCodexUsageCost, codexMcpToolFilterInput, codexMcpFailureDebugFields, headersToRecord, buildSystemParam, CLAUDE_CODE_IDENTIFIER, promptCacheEnabled, claudeSpawnEnvOverrides, parseClaudeResultEvent, codexMcpConfigToml, codexGatewayConfigToml, priorityTierHeaders, ownerHeaders, routeAccountHeaders, GATEWAY_PRIORITY_HEADER, GATEWAY_OWNER_HEADER, ROUTE_ACCOUNT_HEADER, retryLadderDeadlineExceeded, governorForStatelessTransport } from './chat-stream';

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

test('codexGatewayConfigToml — explicit gateway mode preserves unpinned auto-routing', () => {
  process.env.PAPERCUSP_GATEWAY_PORT = '9898';
  const toml = codexGatewayConfigToml(undefined, 'interactive', true);
  assert.match(toml, /model_provider = "papercusp-codex-gateway"/);
  assert.match(toml, /base_url = "http:\/\/127\.0\.0\.1:9898\/v1"/);
  assert.match(toml, /http_headers = \{ "x-papercusp-priority" = "interactive" \}/);
  assert.doesNotMatch(toml, /x-papercusp-account/);
});

test('codexGatewayConfigToml — gateway off without an account remains direct', () => {
  assert.equal(codexGatewayConfigToml(undefined, 'interactive'), '');
});

// WI-10007472: exercise the installed CLI's global AGENTS loader, not a guessed
// interpretation of project_doc_max_bytes. The provider is a local capture server
// that always rejects the request; it never forwards traffic or runs a model.
// Opt in on hosts with Codex installed; the fixture remains in the real test suite.
test('Codex spawn preserves a large UTF-8 global policy and configured tool routing', async () => {
  const prompt = '# Public policy\n' + 'Context for café readers.\n'.repeat(2800)
    + '\nExplain the product from the public FAQ first\n';
  const dir = mkdtempSync(join(tmpdir(), 'codex-prompt-stage-'));
  const cli = join(dir, 'capture.cjs');
  const promptSha256 = createHash('sha256').update(prompt).digest('hex');
  writeFileSync(cli, `const fs = require('node:fs');\nconst crypto = require('node:crypto');\n`
    + `process.stdin.resume();\nprocess.stdin.on('end', () => {\n`
    + ` const home = process.env.CODEX_HOME;\n`
    + ` const prompt = fs.readFileSync(home + '/AGENTS.md');\n`
    + ` const text = JSON.stringify({ promptSha256: crypto.createHash('sha256').update(prompt).digest('hex'), promptBytes: prompt.length,\n`
    + ` config: fs.readFileSync(home + '/config.toml', 'utf8') });\n`
    + ` console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));\n`
    + `});\n`);
  chmodSync(cli, 0o600);
  vi.stubEnv('PAPERCUSP_ACCOUNT_ID', 'capture-account');
  vi.stubEnv('PAPERCUSP_GATEWAY_PORT', '9898');
  vi.stubEnv('PAPERCUSP_AGENT_DEBUG', '');
  vi.stubEnv('PAPERCUSP_AGENT_GOVERNOR', '');
  try {
    let result = '';
    for await (const event of runAgentChat({ backend: 'codex',
      agentCmd: `${process.execPath} ${cli}`, cwd: dir, promptText: 'Fixture only',
      systemPromptText: prompt, priority: 'interactive', mcpConfig: { mcpServers: {
        public: { type: 'http', url: 'http://127.0.0.1:1/fixture-only' },
      } }, signal: AbortSignal.timeout(5000) })) {
      if (event.type === 'result') result = event.finalText;
    }
    const staged = JSON.parse(result);
    assert.equal(staged.promptSha256, promptSha256);
    assert.equal(staged.promptBytes, Buffer.byteLength(prompt));
    assert.ok(staged.promptBytes > 65536);
    assert.match(staged.config, /model_provider = "papercusp-codex-gateway"/);
    assert.match(staged.config, /\[mcp_servers.public\]/);
    assert.match(staged.config, /x-papercusp-priority.*interactive/);
  } finally {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});

test.runIf(process.env.PAPERCUSP_CODEX_PROMPT_CAPTURE === '1')(
  'Codex global prompt reaches the local provider beyond the project document limit',
  async () => {
    const marker = 'Explain the product from the public FAQ first';
    const retainedFile = process.env.PAPERCUSP_CODEX_PROMPT_CAPTURE_FILE;
    const prompt = retainedFile
      ? readFileSync(retainedFile, 'utf8')
      : '# Global instructions\n' + 'Synthetic policy context.\n'.repeat(2800) + '\n' + marker;
    assert.ok(Buffer.byteLength(prompt) > 32768);
    assert.ok(prompt.includes(marker), 'The captured fixture must contain the late FAQ policy control');
    const dir = mkdtempSync(join(tmpdir(), 'codex-prompt-capture-'));
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString('utf8');
      if (request.method === 'POST' && request.url === '/v1/responses') {
        requests.push({ path: request.url, body: JSON.parse(raw) });
      }
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: {
        type: 'invalid_request_error', code: 'local_prompt_capture',
        message: 'Local prompt capture only; no model was run.',
      } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const providerArgs = [
      '-c model_provider="prompt-capture"',
      '-c model_providers.prompt-capture.name="prompt-capture"',
      `-c model_providers.prompt-capture.base_url="http://127.0.0.1:${address.port}/v1"`,
      '-c model_providers.prompt-capture.wire_api="responses"',
      '-c model_providers.prompt-capture.requires_openai_auth=false',
      '-c model_providers.prompt-capture.request_max_retries=0',
      '-c model_providers.prompt-capture.stream_max_retries=0',
      '-c features.responses_websockets=false',
    ];
    // Remove inherited routing/debug settings; the command-line provider always
    // overrides the generated config, and no MCP server is supplied to the spawn.
    for (const key of ['PAPERCUSP_ACCOUNT_ID', 'PAPERCUSP_CODEX_GATEWAY',
      'PAPERCUSP_AGENT_GOVERNOR', 'PAPERCUSP_AGENT_DEBUG', 'OPENAI_API_KEY', 'CODEX_API_KEY']) {
      vi.stubEnv(key, '');
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const observations: Array<Record<string, unknown>> = [];
      for (const budget of [undefined, 131072]) {
        const start = requests.length;
        const events = [];
        const command = ['codex', ...providerArgs,
          ...(budget === undefined ? [] : [`-c project_doc_max_bytes=${budget}`])].join(' ');
        for await (const event of runAgentChat({ backend: 'codex', agentCmd: command,
          model: 'gpt-5.5', cwd: dir, promptText: 'Inspect the configured instruction context.',
          systemPromptText: prompt, signal: AbortSignal.timeout(20000) })) {
          events.push(event);
        }
        const captured = requests.slice(start);
        assert.ok(captured.length > 0, 'Codex must send a request to the local capture provider');
        const strings: string[] = [];
        const walk = (value: unknown) => {
          if (typeof value === 'string') strings.push(value);
          else if (Array.isArray(value)) value.forEach(walk);
          else if (value && typeof value === 'object') Object.values(value).forEach(walk);
        };
        walk(captured[0].body);
        const fullPrompt = strings.some(text => text.includes(prompt));
        observations.push({ budget: budget ?? 'default', requestCount: captured.length,
          promptBytes: Buffer.byteLength(prompt), promptSha256: createHash('sha256').update(prompt).digest('hex'),
          fullPrompt, lateMarkerPresent: strings.some(text => text.includes(marker)),
          terminalTypes: events.filter(event => event.type === 'error' || event.type === 'result').map(event => event.type),
          upstreamRequests: 0 });
      }
      console.info('CODEX_PROMPT_CAPTURE ' + JSON.stringify(observations));
      assert.ok(observations.every(observation => observation.fullPrompt === true),
        'The entire supplied global prompt must appear in the actual model request');
    } finally {
      errors.mockRestore();
      vi.unstubAllEnvs();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000,
);

// EI-25423532280490423: capture the native request, not just the generated TOML.
// A missing local capture fails containment: a terminal runner result alone
// cannot prove where model traffic went. Audit routing before another attempt.
test.runIf(process.env.PAPERCUSP_CODEX_PROMPT_CAPTURE === '1')(
  'Codex public manual MCP schemas reach the local provider with the scoped bearer',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-manual-capture-'));
    const requests: Record<string, unknown>[] = [];
    const mcpMethods: string[] = [];
    const httpRoutes: string[] = [];
    const terminalEvents: Array<{ type: string; message?: string }> = [];
    const bearer = 'local-manual-fixture-only';
    let unauthorized = 0;
    const server = createServer(async (request, response) => {
      httpRoutes.push(`${request.method} ${request.url}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString('utf8');
      if (request.url === '/mcp') {
        if (request.headers.authorization !== `Bearer ${bearer}`) {
          unauthorized++;
          response.writeHead(401).end();
          return;
        }
        if (request.method !== 'POST') {
          response.writeHead(405).end();
          return;
        }
        const message = JSON.parse(raw);
        mcpMethods.push(message.method);
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const result = message.method === 'initialize'
          ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
              serverInfo: { name: 'public-manual-fixture', version: '1' } }
          : { tools: ['docs:search', 'docs:get'].map(name => ({ name,
              description: 'Read the public manual fixture only',
              inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['public'] } },
                required: ['scope'], additionalProperties: false } })) };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/responses') requests.push(JSON.parse(raw));
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'invalid_request_error',
        code: 'local_manual_capture', message: 'Local request capture; no model was run.' } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const key of ['PAPERCUSP_ACCOUNT_ID', 'PAPERCUSP_CODEX_GATEWAY',
      'PAPERCUSP_AGENT_GOVERNOR', 'PAPERCUSP_AGENT_DEBUG', 'OPENAI_API_KEY', 'CODEX_API_KEY']) {
      vi.stubEnv(key, '');
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const command = ['codex', '-c model_provider="manual-capture"',
        '-c model_providers.manual-capture.name="manual-capture"',
        `-c model_providers.manual-capture.base_url="${origin}/v1"`,
        '-c model_providers.manual-capture.wire_api="responses"',
        '-c model_providers.manual-capture.requires_openai_auth=false',
        '-c model_providers.manual-capture.request_max_retries=0',
        '-c model_providers.manual-capture.stream_max_retries=0',
        '-c features.responses_websockets=false'].join(' ');
      for await (const event of runAgentChat({ backend: 'codex', agentCmd: command,
        model: 'gpt-5.6-luna:low', cwd: dir, promptText: 'Will agents stop when I close this browser tab?',
        systemPromptText: 'For product questions, retrieve the public FAQ and cite the retrieved heading.',
        permissionMode: 'bypassPermissions', allowedTools: ['mcp__agentmcp__docs:search', 'mcp__agentmcp__docs:get'],
        mcpConfig: { mcpServers: { agentmcp: { type: 'http', url: `${origin}/mcp`,
          headers: { Authorization: `Bearer ${bearer}` } } } }, signal: AbortSignal.timeout(20000) })) {
        if (event.type === 'error') terminalEvents.push({ type: event.type, message: event.message.slice(0, 1400) });
        else if (event.type === 'result') terminalEvents.push({ type: event.type });
      }
      console.info('CODEX_MANUAL_TOOL_CAPTURE ' + JSON.stringify({ mcpMethods, httpRoutes,
        localRequestCount: requests.length, unauthorized, terminalEvents, containmentVerified: requests.length > 0 }));
      assert.equal(unauthorized, 0);
      assert.ok(mcpMethods.includes('initialize'));
      assert.ok(mcpMethods.includes('tools/list'));
      assert.ok(requests.length > 0, 'The installed CLI must submit its native request locally');
      const tools = requests[0].tools as Array<Record<string, unknown>>;
      const names = tools.map(tool => String(tool.name));
      console.info('CODEX_MANUAL_TOOL_NAMES ' + JSON.stringify({ names,
        localRequestCount: requests.length, unauthorized }));
      for (const name of ['docs_search', 'docs_get']) {
        const tool = tools.find(tool => String(tool.name).endsWith(`__${name}`));
        assert.ok(tool, `${name} must appear in the native model request`);
        const parameters = tool.parameters as { properties: { scope: { enum: string[] } } };
        assert.deepEqual(parameters.properties.scope.enum, ['public']);
      }
    } finally {
      errors.mockRestore();
      vi.unstubAllEnvs();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000,
);

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

test('estimateCodexUsageCost — prices Luna separately from the Sol family alias', () => {
  assert.deepEqual(
    estimateCodexUsageCost('gpt-5.6-luna:low', 1_000_000, 1_000_000, 400_000),
    { usd: 1.328, priced: true },
  );
});

test('estimateCodexUsageCost — an unknown model is explicitly unpriced, never free', () => {
  assert.deepEqual(estimateCodexUsageCost('future-unknown-model', 1_000, 500), {
    usd: 0,
    priced: false,
  });
});

test('codexMcpToolFilterInput — reconstructs the shared qualified MCP name', () => {
  assert.equal(
    codexMcpToolFilterInput('agentmcp', 'plans_get'),
    'mcp__agentmcp__plans_get',
  );
  assert.equal(codexMcpToolFilterInput('', 'plans_get'), 'plans_get');
  assert.equal(
    codexMcpToolFilterInput('agentmcp', 'mcp__agentmcp__plans_get'),
    'mcp__agentmcp__plans_get',
  );
});

test('codexMcpFailureDebugFields — classifies structured MCP errors without exposing raw detail', () => {
  const fields = codexMcpFailureDebugFields({
    type: 'mcp_tool_call',
    status: 'failed',
    arguments: { Authorization: 'Bearer ARGUMENT_SECRET' },
    error: {
      code: -32602,
      message: 'Invalid params for token CREDENTIAL_SECRET',
      data: { details: 'schema rejected password=PASSWORD_SECRET' },
    },
  });
  assert.deepEqual(fields, {
    failureClass: 'invalid_request',
    detailSources: 'error',
    errorShape: 'object:code,data,message',
    resultShape: 'undefined',
    scannedChars: 83,
    errorCode: '-32602',
  });
  assert.doesNotMatch(JSON.stringify(fields), /ARGUMENT_SECRET|CREDENTIAL_SECRET|PASSWORD_SECRET|Bearer|password/);
});

test('codexMcpFailureDebugFields — reads CallToolResult-style content but logs only its safe shape', () => {
  const fields = codexMcpFailureDebugFields({
    type: 'mcp_tool_call',
    status: 'failed',
    result: {
      isError: true,
      content: [{ type: 'text', text: 'The tool is unavailable in this session. api_key=RESULT_SECRET' }],
    },
  });
  assert.equal(fields.failureClass, 'unavailable');
  assert.equal(fields.detailSources, 'result');
  assert.equal(fields.errorShape, 'undefined');
  assert.equal(fields.resultShape, 'object:content,isError');
  assert.equal(fields.resultIsError, true);
  assert.ok(fields.scannedChars > 0 && fields.scannedChars <= 2_048);
  assert.doesNotMatch(JSON.stringify(fields), /RESULT_SECRET|api_key/);
});

test('codexMcpFailureDebugFields — unknown shapes remain bounded and honest', () => {
  const fields = codexMcpFailureDebugFields({
    type: 'mcp_tool_call',
    status: 'failed',
    error: { privateBlob: 'SECRET'.repeat(10_000) },
    result: null,
  });
  assert.deepEqual(fields, {
    failureClass: 'unknown',
    detailSources: 'error,result',
    errorShape: 'object',
    resultShape: 'null',
    scannedChars: 0,
  });
  assert.ok(JSON.stringify(fields).length < 180);
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
