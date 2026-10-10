// Maintained native-CLI fixture. The calling Vitest test runs this whole
// process in a fresh loopback-only network namespace, never on the host network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentChat } from '../chat-stream';
import { agentSpawnTransformConfigured } from '../spawn-transform';

const namespace = readlinkSync('/proc/self/ns/net');
assert.notEqual(namespace, process.env.PAPERCUSP_CAPTURE_PARENT_NETNS,
  'Native capture must run in a separate network namespace');
assert.deepEqual(Object.keys(networkInterfaces()), ['lo'],
  'The capture namespace must expose loopback only');
assert.equal(agentSpawnTransformConfigured(), false);
for (const key of ['PAPERCUSP_ACCOUNT_ID', 'PAPERCUSP_CODEX_GATEWAY',
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) assert.equal(process.env[key], undefined);

const manual = process.argv[2].startsWith('public-manual');
const stockNative = process.argv[2] === 'stock-native-route';
const codeMode = process.argv[2] === 'public-manual-code-mode';
const toolLoop = process.argv[2].startsWith('public-manual-tool-loop');
const names = process.argv[2].endsWith('-underscores')
  ? ['docs_search', 'docs_get'] : ['docs:search', 'docs:get'];
const marker = 'Explain the product from the public FAQ first';
const prompt = stockNative ? 'Inspect this fixture repository using your native coding tools.' : manual
  ? 'For product questions, retrieve the public FAQ and cite the retrieved heading.'
  : process.env.PAPERCUSP_CODEX_PROMPT_CAPTURE_FILE
    ? readFileSync(process.env.PAPERCUSP_CODEX_PROMPT_CAPTURE_FILE, 'utf8')
    : '# Global instructions\n' + 'Synthetic policy context.\n'.repeat(2800) + '\n' + marker;
if (!manual && !stockNative) {
  assert.ok(Buffer.byteLength(prompt) > 32768);
  assert.ok(prompt.includes(marker));
}
const dir = mkdtempSync(join(tmpdir(), 'codex-contained-capture-'));
const requests: Record<string, unknown>[] = [];
const mcpMethods: string[] = [];
const httpRoutes: string[] = [];
const terminalEvents: Array<Record<string, unknown>> = [];
const mcpCalls: Array<Record<string, unknown>> = [];
const returnedToolItems: Array<Record<string, unknown>> = [];
const bearer = stockNative ? 'stock_native_fixture_token_01234567890123456789' : 'local-manual-fixture-only';
let unauthorized = 0;
const server = createServer(async (request, response) => {
  httpRoutes.push(`${request.method} ${request.url}`);
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  if (manual && request.url === '/mcp') {
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
    if (message.method === 'tools/call') mcpCalls.push(message.params);
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
          serverInfo: { name: 'public-manual-fixture', version: '1' } }
      : message.method === 'tools/call'
        ? { content: [{ type: 'text', text: JSON.stringify({ scope: 'public',
            marker: 'PUBLIC_MANUAL_LOCAL_RESULT', name: message.params.name }) }] }
      : { tools: names.map(name => ({ name,
          description: 'Read the public manual fixture only',
          inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['public'] } },
            required: ['scope'], additionalProperties: false } })) };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    return;
  }
  if (request.method === 'POST' && request.url === '/v1/responses') {
    if (stockNative && request.headers.authorization !== `Bearer ${bearer}`) {
      unauthorized++;
      response.writeHead(401).end();
      return;
    }
    const body = JSON.parse(raw);
    requests.push(body);
    if (toolLoop) {
      returnedToolItems.push(...(body.input ?? []).filter((item: Record<string, unknown>) =>
        /tool_call_output|function_call_output/.test(String(item.type))));
      const round = requests.length;
      const item = round === 1
        ? { type: 'custom_tool_call', id: 'ctc_fixture_1', call_id: 'call_fixture_1',
            namespace: 'functions', name: 'exec', status: 'completed',
            input: 'text(ALL_TOOLS.filter(t => /tool_search|mcp__agentmcp__docs/.test(t.name)));' }
        : round === 2
          ? { type: 'custom_tool_call', id: 'ctc_fixture_2', call_id: 'call_fixture_2',
              namespace: 'functions', name: 'exec', status: 'completed',
              input: 'for (const name of ["mcp__agentmcp__docs_search", "mcp__agentmcp__docs_get"]) {'
                + ' if (!ALL_TOOLS.some(t => t.name === name)) throw new Error("Missing public docs: " + name);'
                + ' text(await tools[name]({scope:"public"})); }' }
        : { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: 'Local fixture completed.', annotations: [] }] };
      const completed = { id: `resp_fixture_${round}`, object: 'response', status: 'completed',
        output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
      const events = [
        { type: 'response.created', response: { ...completed, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: completed },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
      return;
    }
  }
  // Requests are captured or answered synthetically; this fixture cannot run a model.
  response.writeHead(400, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { type: 'invalid_request_error',
    code: 'local_capture', message: 'Local request capture; no model was run.' } }));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
try {
  const command = stockNative ? 'codex' : ['codex', '-c model_provider="local-capture"',
    '-c model_providers.local-capture.name="local-capture"',
    `-c model_providers.local-capture.base_url="${origin}/v1"`,
    '-c model_providers.local-capture.wire_api="responses"',
    '-c model_providers.local-capture.requires_openai_auth=false',
    '-c model_providers.local-capture.request_max_retries=0',
    '-c model_providers.local-capture.stream_max_retries=0',
    '-c model_providers.local-capture.supports_websockets=false',
    '-c features.responses_websockets=false', '-c features.plugins=false',
    ...(codeMode ? ['-c features.code_mode=true'] : []),
    ...(process.argv[3] ? [`-c project_doc_max_bytes=${Number(process.argv[3])}`] : [])].join(' ');
  for await (const event of runAgentChat({ backend: 'codex', agentCmd: command,
    model: manual ? (process.argv[4] || 'gpt-5.6-luna:low') : 'gpt-5.5', cwd: dir,
    promptText: manual ? 'Will agents stop when I close this browser tab?' : 'Inspect the configured instruction context.',
    ...(stockNative ? { isolateConfig: true, isolateDir: join(dir, 'native-home'),
      codexGateway: { baseURL: origin, token: bearer }, ownerId: 'stock-native-fixture' }
      : { systemPromptText: prompt }), permissionMode: 'bypassPermissions',
    ...(manual ? { allowedTools: ['mcp__agentmcp__docs:search', 'mcp__agentmcp__docs:get'],
      mcpConfig: { mcpServers: { agentmcp: { type: 'http', url: `${origin}/mcp`,
        headers: { Authorization: `Bearer ${bearer}` } } } } } : {}),
    signal: AbortSignal.timeout(20000) })) {
    if (event.type === 'error') terminalEvents.push({ type: event.type,
      message: event.message.slice(0, 1400), stderr: event.stderr });
    else if (event.type === 'result') terminalEvents.push({ type: event.type,
      tokensIn: event.tokensIn, tokensOut: event.tokensOut, finalText: event.finalText });
  }
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(requests[0]);
  // Responses Lite puts tool declarations on an input item. Top-level-only
  // inspection incorrectly reports zero tools for code-mode-only models.
  const input = (requests[0]?.input ?? []) as Array<Record<string, unknown>>;
  const tools = (requests[0]?.tools ?? input.flatMap(item => item.tools ?? [])) as Array<Record<string, unknown>>;
  const schemaPaths: Array<{ path: string; keys: string[]; name?: unknown; type?: unknown }> = [];
  const namedToolTextPaths: string[] = [];
  const inspect = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (names.some(name => value.includes(name) || value.includes(name.replaceAll(':', '_')))) {
        namedToolTextPaths.push(path);
      }
    } else if (Array.isArray(value)) value.forEach((child, i) => inspect(child, `${path}[${i}]`));
    else if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      if (/tool|function|code_mode|namespace/.test(path) || Object.keys(object).some(key => /tool|function|namespace/.test(key))) {
        schemaPaths.push({ path, keys: Object.keys(object), name: object.name, type: object.type });
      }
      Object.entries(object).forEach(([key, child]) => inspect(child, `${path}.${key}`));
    }
  };
  inspect(requests[0], '$');
  const nativeHome = join(dir, 'native-home');
  const nativeFiles: string[] = [];
  const collectNativeFiles = (path: string): void => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) collectNativeFiles(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) nativeFiles.push(file);
    }
  };
  if (stockNative) collectNativeFiles(join(nativeHome, 'sessions'));
  const nativeBytes = nativeFiles.map(file => readFileSync(file, 'utf8'));
  const nativeRecords = nativeBytes.flatMap(bytes => bytes.split('\n').filter(Boolean).map(line => JSON.parse(line)));
  const nativeConfig = stockNative && existsSync(join(nativeHome, 'config.toml'))
    ? readFileSync(join(nativeHome, 'config.toml'), 'utf8') : '';
  console.log('CODEX_ISOLATED_CAPTURE ' + JSON.stringify({ isolationVerified: true,
    ...(stockNative ? { nativeEvidence: {
      homeRetained: existsSync(nativeHome), noHostAuth: !existsSync(join(nativeHome, 'auth.json')),
      noPersonaFile: !existsSync(join(nativeHome, 'AGENTS.md')),
      privateProvider: nativeConfig.includes(`base_url = "${origin}/v1"`)
        && nativeConfig.includes(`experimental_bearer_token = "${bearer}"`),
      nativeSourceHashes: nativeBytes.map(bytes => createHash('sha256').update(bytes).digest('hex')),
      sessionMeta: nativeRecords.filter(record => record.type === 'session_meta').map(record => ({
        id: record.payload.id, version: record.payload.cli_version, provider: record.payload.model_provider })),
    } } : {}),
    mode: process.argv[2], requestKeys: Object.keys(requests[0] ?? {}), schemaPaths, namedToolTextPaths,
    inputShape: input.map(item => ({ keys: Object.keys(item), type: item.type, role: item.role })),
    requestCount: requests.length, mcpMethods, mcpCalls, returnedToolItems,
    httpRoutes, unauthorized, terminalEvents,
    models: requests.map(request => request.model),
    tools: tools.map(tool => ({ type: tool.type, name: tool.name, parameters: tool.parameters,
      tools: tool.tools, functions: tool.functions })),
    promptBytes: Buffer.byteLength(prompt), promptSha256: createHash('sha256').update(prompt).digest('hex'),
    fullPrompt: strings.some(text => text.includes(prompt)),
    lateMarkerPresent: strings.some(text => text.includes(marker)) }));
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  rmSync(dir, { recursive: true, force: true });
}
