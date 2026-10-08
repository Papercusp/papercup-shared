// Maintained native-CLI fixture. The calling Vitest test runs this whole
// process in a fresh loopback-only network namespace, never on the host network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
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
const codeMode = process.argv[2] === 'public-manual-code-mode';
const names = process.argv[2] === 'public-manual-underscores'
  ? ['docs_search', 'docs_get'] : ['docs:search', 'docs:get'];
const marker = 'Explain the product from the public FAQ first';
const prompt = manual
  ? 'For product questions, retrieve the public FAQ and cite the retrieved heading.'
  : process.env.PAPERCUSP_CODEX_PROMPT_CAPTURE_FILE
    ? readFileSync(process.env.PAPERCUSP_CODEX_PROMPT_CAPTURE_FILE, 'utf8')
    : '# Global instructions\n' + 'Synthetic policy context.\n'.repeat(2800) + '\n' + marker;
if (!manual) {
  assert.ok(Buffer.byteLength(prompt) > 32768);
  assert.ok(prompt.includes(marker));
}
const dir = mkdtempSync(join(tmpdir(), 'codex-contained-capture-'));
const requests: Record<string, unknown>[] = [];
const mcpMethods: string[] = [];
const httpRoutes: string[] = [];
const terminalEvents: Array<Record<string, unknown>> = [];
const bearer = 'local-manual-fixture-only';
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
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
          serverInfo: { name: 'public-manual-fixture', version: '1' } }
      : { tools: names.map(name => ({ name,
          description: 'Read the public manual fixture only',
          inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['public'] } },
            required: ['scope'], additionalProperties: false } })) };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    return;
  }
  if (request.method === 'POST' && request.url === '/v1/responses') requests.push(JSON.parse(raw));
  // Every inference request is rejected; this fixture cannot run a model.
  response.writeHead(400, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { type: 'invalid_request_error',
    code: 'local_capture', message: 'Local request capture; no model was run.' } }));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
try {
  const command = ['codex', '-c model_provider="local-capture"',
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
    systemPromptText: prompt, permissionMode: 'bypassPermissions',
    ...(manual ? { allowedTools: ['mcp__agentmcp__docs:search', 'mcp__agentmcp__docs:get'],
      mcpConfig: { mcpServers: { agentmcp: { type: 'http', url: `${origin}/mcp`,
        headers: { Authorization: `Bearer ${bearer}` } } } } } : {}),
    signal: AbortSignal.timeout(20000) })) {
    if (event.type === 'error') terminalEvents.push({ type: event.type,
      message: event.message.slice(0, 1400), stderr: event.stderr });
    else if (event.type === 'result') terminalEvents.push({ type: event.type,
      tokensIn: event.tokensIn, tokensOut: event.tokensOut });
  }
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(requests[0]);
  const tools = (requests[0]?.tools ?? []) as Array<Record<string, unknown>>;
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
  console.log('CODEX_ISOLATED_CAPTURE ' + JSON.stringify({ isolationVerified: true,
    mode: process.argv[2], requestKeys: Object.keys(requests[0] ?? {}), schemaPaths, namedToolTextPaths,
    requestCount: requests.length, mcpMethods, httpRoutes, unauthorized, terminalEvents,
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
