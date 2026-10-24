import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { createStatelessDiagnosticFetch, invalidateClaudeTokenCache, isTransientLlmError, runAgentChat, type RunAgentChatOptions, type StatelessRequestAttempt, type StatelessTransportDiagnostic } from './chat-stream';
import { configureAgentSpawnTransform, type AgentSpawnRequest } from './spawn-transform';

// Negative pre-implementation cases must never launch a credentialed CLI.
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(() => { throw new Error('Fixture forbids subprocess inference'); }),
}));

const sdk = vi.hoisted(() => ({ fetch: undefined as typeof fetch | undefined,
  headers: [] as Record<string, string>[],
  credential: undefined as string | undefined,
  bodyEvents: [] as unknown[], bodyFailure: undefined as Error | undefined,
  beforeFailure: undefined as (() => void) | undefined,
  real: undefined as typeof import('@anthropic-ai/sdk').default | undefined }));
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original,
    existsSync: (path: Parameters<typeof original.existsSync>[0]) =>
      (String(path).endsWith('.claude/.credentials.json') && sdk.credential !== undefined) || original.existsSync(path),
    readFileSync: (path: Parameters<typeof original.readFileSync>[0], ...args: unknown[]) => {
    if (String(path).endsWith('.claude/.credentials.json') && sdk.credential !== undefined) return JSON.stringify({ claudeAiOauth: { accessToken: sdk.credential } });
    return (original.readFileSync as (...args: unknown[]) => unknown)(path, ...args);
  } };
});
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor(options: { fetch?: typeof fetch; defaultHeaders?: Record<string, string> }) {
      sdk.fetch = options.fetch;
      sdk.headers.push(options.defaultHeaders ?? {});
      if (sdk.real) this.messages = new sdk.real(options).messages as unknown as typeof this.messages;
    }
    messages = {
      stream: () => {
        const listeners = new Map<string, (event: unknown) => void>();
        const stream = {
          response: undefined as Response | undefined,
          once: () => {},
          on: (event: string, listener: (event: unknown) => void) => { listeners.set(event, listener); },
          off: (event: string) => { listeners.delete(event); },
          finalMessage: async () => {
            const response = await sdk.fetch!('http://127.0.0.1:8788/v1/messages');
            stream.response = response;
            if (!response.ok) throw Object.assign(new Error('upstream refusal'), {
              status: response.status, headers: response.headers,
            });
            for (const event of sdk.bodyEvents) listeners.get('streamEvent')?.(event);
            if (sdk.bodyFailure) { sdk.beforeFailure?.(); throw sdk.bodyFailure; }
            return { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } };
          },
        };
        return stream;
      },
    };
  },
}));

afterEach(() => {
  configureAgentSpawnTransform(undefined);
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  sdk.bodyEvents = []; sdk.bodyFailure = undefined; sdk.beforeFailure = undefined; sdk.real = undefined;
  sdk.headers = [];
  sdk.credential = undefined; invalidateClaudeTokenCache();
});

const transport = {
  baseURL: 'http://127.0.0.1:8788', token: 'secret-bearer',
  headers: { 'x-papercusp-account': 'requested-account', authorization: 'secret-header' },
  label: 'anthropic-direct' as const,
};

// WI-10007475: native pipes may split any UTF-8 code point across data events.
// Feed one byte at a time through real Node streams, without launching a CLI.
function nativeByteStream(stdout: string, stderr = '', exitCode = 0, beforeOutput?: () => void) {
  const child = new EventEmitter() as ChildProcess;
  const output = new PassThrough();
  const errors = new PassThrough();
  Object.assign(child, { stdout: output, stderr: errors, kill: vi.fn(),
    stdin: new Writable({ write(_chunk, _encoding, done) { done(); }, final(done) {
      done();
      queueMicrotask(() => {
        beforeOutput?.();
        for (const byte of Buffer.from(stdout)) output.write(Buffer.from([byte]));
        for (const byte of Buffer.from(stderr)) errors.write(Buffer.from([byte]));
        output.end(); errors.end();
        child.emit('exit', exitCode, null);
      });
    } }) });
  vi.mocked(spawn).mockReturnValueOnce(child);
}

describe('assignment-private Codex evidence lifecycle (WI-10007969)', () => {
  const gateway = { baseURL: 'http://127.0.0.1:32123', token: 'fixture_private_token_01234567890123456789' };
  const frames = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'fixture' } }) + '\n';
  const collect = async (options: RunAgentChatOptions) => {
    const events = [];
    for await (const event of runAgentChat(options)) events.push(event);
    return events;
  };
  it('enrolls the transformed native spawn and observes its actual session UUID', async () => {
    const id = '00000000-0000-0000-0000-000000000123';
    nativeByteStream(JSON.stringify({ type: 'thread.started', thread_id: id }) + '\n' + frames);
    const onNativeSession = vi.fn();
    const spawnProcess = vi.fn(async (command, args, options) => spawn(command, args, options));
    configureAgentSpawnTransform(request => ({ command: 'identity-transport', args: [...request.args], cwd: request.cwd, env: request.env }));
    await collect({ backend: 'codex', promptText: 'fixture', spawnProcess, onNativeSession });
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawnProcess.mock.calls[0][0]).toBe('identity-transport');
    expect(onNativeSession).toHaveBeenCalledExactlyOnceWith(id);
  });
  it('never falls back to untracked spawn when host enrollment refuses', async () => {
    const before = vi.mocked(spawn).mock.calls.length;
    const events = await collect({ backend: 'codex', promptText: 'fixture',
      spawnProcess: async () => { throw new Error('required enrollment refused'); } });
    expect(vi.mocked(spawn).mock.calls.length).toBe(before);
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringContaining('required enrollment refused') }));
  });

  it('retains full native bytes in the caller home and uses only the private provider binding', async () => {
    const home = mkdtempSync(join(tmpdir(), 'native-evidence-'));
    vi.stubEnv('PAPERCUSP_AGENT_GOVERNOR', ''); vi.stubEnv('PAPERCUSP_AGENT_DEBUG', '');
    vi.stubEnv('PAPERCUSP_ACCOUNT_ID', 'ambient-account'); vi.stubEnv('PAPERCUSP_GATEWAY_PORT', '9999');
    vi.stubEnv('OPENAI_API_KEY', 'ambient-secret'); vi.stubEnv('CODEX_API_KEY', 'ambient-secret');
    vi.stubEnv('OPENAI_BASE_URL', 'https://ambient.invalid');
    const before = vi.mocked(spawn).mock.calls.length;
    const bytes = '{"type":"session_meta","payload":{"id":"fixture-session"}}\n';
    nativeByteStream(frames, '', 0, () => writeFileSync(join(home, 'rollout.jsonl'), bytes));
    try {
      const events = await collect({ backend: 'codex', promptText: 'stock issue', model: 'gpt-5.5:high',
        isolateConfig: true, isolateDir: home, codexGateway: gateway, ownerId: 'assignment-owner' });
      expect(events.some(event => event.type === 'result')).toBe(true);
      const [, args, options] = vi.mocked(spawn).mock.calls[before];
      expect(args).not.toContain('--ephemeral');
      expect(options?.env?.CODEX_HOME).toBe(home);
      for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) expect(options?.env?.[key]).toBeUndefined();
      expect(readFileSync(join(home, 'rollout.jsonl'), 'utf8')).toBe(bytes);
      const config = readFileSync(join(home, 'config.toml'), 'utf8');
      expect(config).toContain('base_url = "http://127.0.0.1:32123/v1"');
      expect(config).toContain(`experimental_bearer_token = "${gateway.token}"`);
      expect(config).toContain('requires_openai_auth = false');
      expect(config).toContain('"x-papercusp-owner" = "assignment-owner"');
      expect(config).not.toContain('ambient-account'); expect(config).not.toContain('9999');
      expect(existsSync(join(home, 'auth.json'))).toBe(false);
      expect(existsSync(join(home, 'AGENTS.md'))).toBe(false);
      expect(process.env.OPENAI_API_KEY).toBe('ambient-secret');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('honors the configured identity transform and marks the evidence home persistent', async () => {
    const home = mkdtempSync(join(tmpdir(), 'native-identity-'));
    const transform = vi.fn((request: AgentSpawnRequest) => ({ ...request, command: 'fixture-identity-transport', args: [...request.args] }));
    configureAgentSpawnTransform(transform); vi.stubEnv('PAPERCUSP_AGENT_GOVERNOR', '');
    const before = vi.mocked(spawn).mock.calls.length;
    nativeByteStream(frames);
    try {
      await collect({ backend: 'codex', promptText: 'fixture', isolateConfig: true, isolateDir: home, codexGateway: gateway });
      expect(transform).toHaveBeenCalledOnce();
      expect(transform.mock.calls[0][0].stagedDirs).toContainEqual({ path: home, persistent: true });
      expect(vi.mocked(spawn).mock.calls[before][0]).toBe('fixture-identity-transport');
      expect(existsSync(home)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('keeps caller-owned evidence when spawning fails', async () => {
    const home = mkdtempSync(join(tmpdir(), 'native-failed-evidence-'));
    vi.stubEnv('PAPERCUSP_AGENT_GOVERNOR', '');
    writeFileSync(join(home, 'prior-rollout.jsonl'), 'prior evidence');
    vi.mocked(spawn).mockImplementationOnce(() => { throw new Error('fixture spawn failure'); });
    try {
      const events = await collect({ backend: 'codex', promptText: 'fixture', isolateConfig: true, isolateDir: home, codexGateway: gateway });
      expect(events.some(event => event.type === 'error')).toBe(true);
      expect(readFileSync(join(home, 'prior-rollout.jsonl'), 'utf8')).toBe('prior evidence');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('isolates and cleans a temporary Codex home when the caller does not retain it', async () => {
    vi.stubEnv('PAPERCUSP_AGENT_GOVERNOR', ''); vi.stubEnv('PAPERCUSP_AGENT_DEBUG', '');
    const before = vi.mocked(spawn).mock.calls.length;
    nativeByteStream(frames);
    await collect({ backend: 'codex', promptText: 'fixture', isolateConfig: true });
    const [, args, options] = vi.mocked(spawn).mock.calls[before];
    expect(args).toContain('--ephemeral');
    expect(options?.env?.CODEX_HOME).toBeTruthy();
    expect(existsSync(options!.env!.CODEX_HOME!)).toBe(false);
  });

  it.each([
    { backend: 'omp', codexGateway: gateway },
    { backend: 'codex', codexGateway: { ...gateway, baseURL: 'https://outside.invalid' } },
    { backend: 'codex', codexGateway: { ...gateway, token: 'short' } },
    { backend: 'codex', codexGateway: gateway, isolateConfig: false },
    { backend: 'codex', isolateConfig: true, isolateDir: 'relative-home' },
    { backend: 'codex', codexGateway: gateway, statelessGateway: gateway },
    { backend: 'codex', codexGateway: gateway, agentCmd: 'codex -c model_provider="ambient"' },
  ])('refuses unsupported or conflicting controls before spawn: %j', async extra => {
    const before = vi.mocked(spawn).mock.calls.length;
    await expect(collect({ promptText: 'fixture', isolateConfig: true, ...extra } as RunAgentChatOptions)).rejects.toMatchObject({ costUsd: 0 });
    expect(vi.mocked(spawn).mock.calls.length).toBe(before);
  });

  it('also preserves the existing caller-owned Claude session home after completion', async () => {
    const home = mkdtempSync(join(tmpdir(), 'claude-retained-evidence-'));
    vi.stubEnv('PAPERCUSP_AGENT_GOVERNOR', ''); vi.stubEnv('PAPERCUSP_AGENT_DEBUG', '');
    nativeByteStream(JSON.stringify({ type: 'result', result: 'fixture', total_cost_usd: 0 }) + '\n');
    try {
      await collect({ backend: 'claude-code', promptText: 'fixture', isolateConfig: true, isolateDir: home });
      expect(existsSync(home)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('assignment-private Claude transport (WI-6554700010010004)', () => {
  const gateway = { baseURL: 'http://127.0.0.1:32123', token: 'fixture_private_token_01234567890123456789' };
  const id = '00000000-0000-0000-0000-000000000456';
  const frames = [
    { type: 'system', subtype: 'init', session_id: id },
    { type: 'result', result: 'fixture', total_cost_usd: 0 },
  ].map(frame => JSON.stringify(frame)).join('\n') + '\n';
  const collect = async (extra: Partial<RunAgentChatOptions> = {}) => {
    const events = [];
    for await (const event of runAgentChat({ backend: 'claude-code', promptText: 'fixture',
      isolateConfig: true, statelessGateway: gateway, ...extra })) events.push(event);
    return events;
  };

  it('snapshots the private route, excludes ambient credentials/settings, and retains native evidence', async () => {
    const home = mkdtempSync(join(tmpdir(), 'claude-private-evidence-'));
    sdk.credential = 'host-oauth';
    for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS',
      'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'PAPERCUSP_ACCOUNT_ID', 'NODE_OPTIONS']) vi.stubEnv(key, 'ambient-secret');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://ambient.invalid');
    vi.stubEnv('PAPERCUSP_AGENT_GOVERNOR', ''); vi.stubEnv('PAPERCUSP_AGENT_DEBUG', '');
    const route = { ...gateway };
    const onNativeSession = vi.fn();
    const spawnProcess = vi.fn(async (command, args, options) => spawn(command, args, options));
    const before = vi.mocked(spawn).mock.calls.length;
    nativeByteStream(frames, '', 0, () => writeFileSync(join(home, 'transcript.jsonl'), frames));
    configureAgentSpawnTransform(request => {
      expect(request.backend).toBe('claude-code');
      expect(request.stagedDirs).toContainEqual({ path: home, persistent: true });
      route.baseURL = 'http://127.0.0.1:1'; route.token = 'mutated';
      return { ...request, command: 'private-claude-transport' };
    });
    try {
      const events = await collect({ isolateDir: home, statelessGateway: route, onNativeSession, spawnProcess });
      expect(events.some(event => event.type === 'result')).toBe(true);
      const [command, args, options] = vi.mocked(spawn).mock.calls[before];
      expect(command).toBe('private-claude-transport');
      expect(spawnProcess).toHaveBeenCalledOnce();
      expect(spawnProcess.mock.calls[0][0]).toBe(command);
      expect(args).toEqual(expect.arrayContaining(['--setting-sources', '', '--strict-mcp-config']));
      expect(options?.env).toMatchObject({ HOME: home, CLAUDE_CONFIG_DIR: home,
        ANTHROPIC_BASE_URL: gateway.baseURL, ANTHROPIC_AUTH_TOKEN: gateway.token });
      for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_OAUTH_TOKEN',
        'AWS_SECRET_ACCESS_KEY', 'PAPERCUSP_ACCOUNT_ID', 'NODE_OPTIONS']) expect(options?.env?.[key]).toBeUndefined();
      expect(lstatSync(join(home, '.credentials.json'), { throwIfNoEntry: false })).toBeUndefined();
      expect(readFileSync(join(home, 'transcript.jsonl'), 'utf8')).toBe(frames);
      expect(onNativeSession).toHaveBeenCalledExactlyOnceWith(id);
      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('ambient-secret');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('cleans temporary private config after completion', async () => {
    vi.stubEnv('PAPERCUSP_AGENT_GOVERNOR', ''); vi.stubEnv('PAPERCUSP_AGENT_DEBUG', '');
    const before = vi.mocked(spawn).mock.calls.length;
    nativeByteStream(frames);
    await collect();
    const config = vi.mocked(spawn).mock.calls[before][2]?.env?.CLAUDE_CONFIG_DIR;
    expect(config).toBeTruthy();
    expect(existsSync(config!)).toBe(false);
  });

  it('observes only a valid native init UUID, independently of the requested session', async () => {
    const onNativeSession = vi.fn();
    nativeByteStream([
      { type: 'system', subtype: 'init', session_id: 'invalid-id' },
      { type: 'result', session_id: id, result: 'fixture', total_cost_usd: 0 },
    ].map(frame => JSON.stringify(frame)).join('\n') + '\n');
    await collect({ sessionId: id, onNativeSession });
    expect(onNativeSession).not.toHaveBeenCalled();
  });

  it('retains caller evidence when host enrollment refuses without an untracked fallback', async () => {
    const home = mkdtempSync(join(tmpdir(), 'claude-private-refusal-'));
    writeFileSync(join(home, 'prior.jsonl'), 'prior evidence');
    const before = vi.mocked(spawn).mock.calls.length;
    try {
      const events = await collect({ isolateDir: home, spawnProcess: async () => { throw new Error('enrollment refused'); } });
      expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringContaining('enrollment refused') }));
      expect(vi.mocked(spawn).mock.calls.length).toBe(before);
      expect(readFileSync(join(home, 'prior.jsonl'), 'utf8')).toBe('prior evidence');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it.each([
    { isolateConfig: false },
    { isolateDir: 'relative-home' },
    { backend: 'omp' },
    { codexGateway: gateway },
    { routeAccountId: 'ambient-account' },
    { statelessGateway: { ...gateway, baseURL: 'https://outside.invalid' } },
    { statelessGateway: { ...gateway, token: 'short' } },
    { agentCmd: 'claude --settings=/tmp/ambient.json' },
    { agentCmd: 'claude --setting-sources user' },
    { agentCmd: 'claude --mcp-config /tmp/ambient.json' },
    { requireOutputTokenLimit: true, maxTokens: 1 },
    { authorizeStatelessRequest: async () => () => {} },
  ])('refuses unsupported policies and conflicting routes before any spawn: %j', async extra => {
    const before = vi.mocked(spawn).mock.calls.length;
    await expect(collect(extra as Partial<RunAgentChatOptions>)).rejects.toMatchObject({ costUsd: 0 });
    expect(vi.mocked(spawn).mock.calls.length).toBe(before);
  });
});

describe('native UTF-8 pipe decoding (WI-10007475)', () => {
  const text = 'café 東京 🧭';
  it.each(['claude-code', 'codex', 'omp'] as const)('preserves %s assistant and tool-result text across byte boundaries', async backend => {
    vi.stubEnv('PAPERCUSP_AGENT_GOVERNOR', '');
    vi.stubEnv('PAPERCUSP_AGENT_DEBUG', '');
    const frames = backend === 'claude-code' ? [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'utf8', name: 'docs:get' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'utf8', content: text }] } },
      { type: 'result', result: text, total_cost_usd: 0 },
    ] : backend === 'codex' ? [
      { type: 'item.completed', item: { id: 'utf8', type: 'mcp_tool_call', tool: 'docs:get', status: 'completed', result: text } },
      { type: 'item.completed', item: { type: 'agent_message', text } },
    ] : [
      { type: 'tool_execution_end', toolCallId: 'utf8', toolName: 'docs:get', result: text },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } },
    ];
    nativeByteStream(frames.map(frame => JSON.stringify(frame)).join('\n') + '\n');
    const observed = vi.fn();
    const events = [];
    for await (const event of runAgentChat({ backend, promptText: 'Fixture', onToolResult: observed })) events.push(event);
    expect(events.find(event => event.type === 'result')).toMatchObject({ finalText: text });
    expect(observed).toHaveBeenCalledExactlyOnceWith({ name: 'docs:get', output: text, isError: false, callId: 'utf8' });
  });

  it('preserves stderr diagnostics across byte boundaries', async () => {
    vi.stubEnv('PAPERCUSP_AGENT_GOVERNOR', '');
    vi.stubEnv('PAPERCUSP_AGENT_DEBUG', '');
    nativeByteStream('', text, 1);
    const events = [];
    for await (const event of runAgentChat({ backend: 'codex', promptText: 'Fixture' })) events.push(event);
    expect(events.find(event => event.type === 'error')).toMatchObject({ stderr: text });
  });
});

describe('per-request account routing', () => {
  it('never substitutes host OAuth after a pinned gateway account rejects auth', async () => {
    sdk.credential = 'fixture-host-oauth'; invalidateClaudeTokenCache();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{}', { status: 401 })).mockResolvedValue(new Response('{}')));
    const events = [];
    for await (const event of runAgentChat({ backend: 'anthropic-direct', model: 'claude-haiku-4-5', promptText: 'fixture', routeAccountId: 'chosen-account', onTransportDiagnostic: () => {} })) events.push(event);
    expect(sdk.headers).toHaveLength(1);
    expect(sdk.headers[0]).toMatchObject({ 'x-papercusp-account': 'chosen-account' });
    expect(events.some(event => event.type === 'error')).toBe(true);
    expect(events.some(event => event.type === 'result')).toBe(false);
  });
  it('pins a stateless call and leaves ambient routing unchanged', async () => {
    vi.stubEnv('PAPERCUSP_ROUTE_ACCOUNT', 'ambient-account');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    for await (const _event of runAgentChat({ backend: 'anthropic-direct', model: 'claude-haiku-4-5', promptText: 'fixture', routeAccountId: 'chosen-account', onTransportDiagnostic: () => {} })) { /* drain */ }
    expect(sdk.headers.at(-1)).toMatchObject({ 'x-papercusp-account': 'chosen-account' });
    expect(process.env.PAPERCUSP_ROUTE_ACCOUNT).toBe('ambient-account');
  });
  it('auto selects from the pool without inheriting a process account pin', async () => {
    vi.stubEnv('PAPERCUSP_ROUTE_ACCOUNT', 'ambient-account');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    for await (const _event of runAgentChat({ backend: 'anthropic-direct', model: 'claude-haiku-4-5', promptText: 'fixture', routeAccountId: 'auto', onTransportDiagnostic: () => {} })) { /* drain */ }
    expect(sdk.headers.at(-1)?.['x-papercusp-account']).toBeUndefined();
    expect(process.env.PAPERCUSP_ROUTE_ACCOUNT).toBe('ambient-account');
  });
  it.each(['claude-code', 'omp', 'codex'] as const)('refuses account routing on %s before spawn', async backend => {
    await expect(runAgentChat({ backend, promptText: 'fixture', routeAccountId: 'chosen-account' }).next()).rejects.toMatchObject({ costUsd: 0 });
  });
  it('refuses conflicting scoped-gateway and account bindings', async () => {
    await expect(runAgentChat({ backend: 'anthropic-direct', promptText: 'fixture', routeAccountId: 'chosen-account', statelessGateway: { baseURL: 'http://localhost:32123', token: 'scoped' } }).next()).rejects.toMatchObject({ costUsd: 0 });
  });
});

describe('trusted-host authorization at the stateless HTTP boundary (WI-10006164)', () => {
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const requestInit = () => ({ method: 'POST', headers: { authorization: 'Bearer private-fixture' },
    body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 8, messages: [{ role: 'user', content: 'original' }] }) });

  it.each(['missing', 'malformed', 'throws'] as const)('refuses a %s authorization before sending', async kind => {
    const send = vi.fn(async () => new Response('unexpected'));
    const observe = vi.fn();
    const guarded = createStatelessDiagnosticFetch(transport, observe, send,
      { callId: 'authorized', attempt: 0 }, 'disabled', 8, async () => {
        if (kind === 'throws') throw new Error('private-controller-error');
        return kind === 'missing' ? null : 'invalid' as never;
      });
    await expect(guarded('http://127.0.0.1:8788/v1/messages', requestInit()))
      .rejects.toMatchObject({ message: 'Stateless request authorization refused', costUsd: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  it('authorizes the immutable request and passes credential digests rather than credentials', async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const sent: Request[] = [];
    const authorize = vi.fn(async (attempt: StatelessRequestAttempt) => {
      await ready;
      expect(Object.isFrozen(attempt)).toBe(true);
      return () => {};
    });
    const guarded = createStatelessDiagnosticFetch(transport, () => {}, async input => {
      sent.push(input as Request); return new Response('ok');
    }, { callId: 'authorized', attempt: 0 }, 'disabled', 8, authorize);
    const init = requestInit();
    const originalBody = init.body;
    const pending = guarded('http://127.0.0.1:8788/v1/messages', init);
    init.headers.authorization = 'Bearer changed'; init.body = JSON.stringify({ max_tokens: 999 });
    release(); await pending;
    const attempt = authorize.mock.calls[0]![0];
    expect(attempt).toMatchObject({ callId: 'authorized', attempt: 1, method: 'POST',
      url: 'http://127.0.0.1:8788/v1/messages', body: originalBody, bodySha256: digest(originalBody),
      credentialSha256: digest(JSON.stringify({ authorization: 'Bearer private-fixture', apiKey: null })) });
    expect(JSON.stringify(attempt)).not.toContain('private-fixture');
    expect(await sent[0]!.text()).toBe(originalBody);
    expect(sent[0]!.headers.get('authorization')).toBe('Bearer private-fixture');
    expect(sent[0]!.redirect).toBe('error');
  });

  it.each(['aborted', 'revoked', 'validator-aborted', 'async-validator'] as const)('rechecks %s authorization after an asynchronous policy read', async kind => {
    const controller = new AbortController();
    const send = vi.fn(async () => new Response('unexpected'));
    const guarded = createStatelessDiagnosticFetch(transport, () => {}, send,
      { callId: 'authorized', attempt: 0 }, 'disabled', 8, async () => {
        if (kind === 'aborted') controller.abort();
        if (kind === 'async-validator') return (async () => { throw new Error('async private grant'); }) as never;
        return () => {
          if (kind === 'revoked') throw new Error('expired private grant');
          if (kind === 'validator-aborted') controller.abort();
        };
      });
    await expect(guarded('http://127.0.0.1:8788/v1/messages', { ...requestInit(), signal: controller.signal }))
      .rejects.toMatchObject({ message: 'Stateless request authorization refused', costUsd: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('rechecks the grant after diagnostic callbacks and before send', async () => {
    let revoked = false;
    const send = vi.fn(async () => new Response('unexpected'));
    const guarded = createStatelessDiagnosticFetch(transport, () => { revoked = true; }, send,
      { callId: 'authorized', attempt: 0 }, 'disabled', 8,
      async () => () => { if (revoked) throw new Error('revoked'); });
    await expect(guarded('http://127.0.0.1:8788/v1/messages', requestInit())).rejects.toMatchObject({ costUsd: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('authorizes every retry separately and never labels a later refusal as zero total spend', async () => {
    const send = vi.fn(async () => new Response('unknown usage', { status: 503 }));
    const attempts: Array<{ attemptId: string; attempt: number }> = [];
    const state = { callId: 'authorized', attempt: 0 };
    const authorize = vi.fn(async (attempt: StatelessRequestAttempt) => {
      attempts.push(attempt);
      return attempts.length === 1 ? () => {} : null;
    });
    const first = createStatelessDiagnosticFetch(transport, () => {}, send, state, 'disabled', 8, authorize);
    await first('http://127.0.0.1:8788/v1/messages', requestInit());
    // Credential refresh replaces the SDK wrapper, but not this call's send history.
    const retry = createStatelessDiagnosticFetch({ ...transport, token: 'refreshed' }, () => {}, send, state, 'disabled', 8, authorize);
    const refusal = await retry('http://127.0.0.1:8788/v1/messages', requestInit()).catch(error => error);
    expect(refusal).toMatchObject({ costUsdMeasurementMissing: true });
    expect(refusal).not.toHaveProperty('costUsd');
    expect(send).toHaveBeenCalledTimes(1);
    expect(attempts.map(a => a.attempt)).toEqual([1, 2]);
    expect(new Set(attempts.map(a => a.attemptId)).size).toBe(2);
  });

  it.each(['claude-code', 'omp', 'codex'] as const)('refuses authorization on unsupported backend %s before spawn', async backend => {
    const authorizeStatelessRequest = vi.fn(async () => () => {});
    await expect(runAgentChat({ backend, promptText: 'fixture', authorizeStatelessRequest }).next())
      .rejects.toMatchObject({ costUsd: 0 });
    expect(authorizeStatelessRequest).not.toHaveBeenCalled();
  });

  it('refuses HTTP redirects before an unapproved destination receives the request', async () => {
    let originRequests = 0, redirectedRequests = 0;
    const target = createServer((_request, response) => { redirectedRequests++; response.end('unexpected'); });
    const origin = createServer((_request, response) => {
      originRequests++;
      response.writeHead(307, { location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/other` });
      response.end();
    });
    try {
      await new Promise<void>(resolve => { target.listen(0, '127.0.0.1', resolve); });
      await new Promise<void>(resolve => { origin.listen(0, '127.0.0.1', resolve); });
      const authorize = vi.fn(async () => () => {});
      const guarded = createStatelessDiagnosticFetch(transport, () => {}, globalThis.fetch,
        { callId: 'redirect', attempt: 0 }, 'disabled', 8, authorize);
      await expect(guarded(`http://127.0.0.1:${(origin.address() as AddressInfo).port}/v1/messages`,
        { ...requestInit(), signal: AbortSignal.timeout(2000) })).rejects.toThrow();
      expect(originRequests).toBe(1);
      expect(redirectedRequests).toBe(0);
      expect(authorize).toHaveBeenCalledTimes(1);
    } finally {
      origin.closeAllConnections(); target.closeAllConnections();
      await Promise.all([origin, target].map(server => new Promise<void>((resolve, reject) => {
        server.close(error => { if (error) reject(error); else resolve(); });
      })));
    }
  });
});

describe('required Anthropic output bounds (WI-10006340)', () => {
  it.each([undefined, 0, -1, 1.5, Infinity, NaN])('refuses invalid maxTokens=%s before any send', async maxTokens => {
    const send = vi.fn();
    vi.stubGlobal('fetch', send);
    const run = runAgentChat({ backend: 'anthropic-direct', model: 'claude-opus-4-8',
      promptText: 'fixture', maxTokens, requireOutputTokenLimit: true });
    await expect(run.next()).rejects.toMatchObject({ costUsd: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['claude-code', 'omp', 'codex'] as const)('refuses unsupported backend %s before auth or spawn', async backend => {
    const send = vi.fn();
    vi.stubGlobal('fetch', send);
    await expect(runAgentChat({ backend, model: 'fixture', promptText: 'fixture',
      maxTokens: 8, requireOutputTokenLimit: true }).next()).rejects.toMatchObject({ costUsd: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, -1, 1.5, 9, Infinity])('rejects a final HTTP max_tokens=%s that differs from the admitted bound', async maxTokens => {
    const send = vi.fn(async () => new Response('unexpected'));
    const records: StatelessTransportDiagnostic[] = [];
    const guarded = createStatelessDiagnosticFetch(transport, r => records.push(r), send,
      { callId: 'bounded', attempt: 0 }, 'disabled', 8);
    await expect(guarded('http://127.0.0.1:8788/v1/messages', { method: 'POST',
      body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: maxTokens }) })).rejects.toMatchObject({ costUsd: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it('refuses malformed final request bodies without emitting a send diagnostic', async () => {
    const send = vi.fn(async () => new Response('unexpected'));
    const guarded = createStatelessDiagnosticFetch(transport, () => {}, send,
      { callId: 'bounded', attempt: 0 }, 'disabled', 8);
    for (const body of ['not json', 'null', '[]']) {
      await expect(guarded('http://127.0.0.1:8788/v1/messages', { method: 'POST', body })).rejects.toMatchObject({ costUsd: 0 });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('sends the validated immutable request including Request inputs', async () => {
    const sent: Request[] = [];
    const guarded = createStatelessDiagnosticFetch(transport, () => {}, async input => {
      sent.push(input as Request);
      return new Response('ok');
    }, { callId: 'bounded', attempt: 0 }, 'disabled', 8);
    const init = { method: 'POST', headers: { authorization: 'private' },
      body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 8 }) };
    const pending = guarded('http://127.0.0.1:8788/v1/messages', init);
    init.body = JSON.stringify({ max_tokens: 999 });
    await pending;
    await guarded(new Request('http://127.0.0.1:8788/v1/messages', { ...init,
      body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 8 }) }));
    expect(sent).toHaveLength(2);
    for (const request of sent) {
      expect(await request.json()).toEqual({ model: 'claude-opus-4-8', max_tokens: 8 });
      expect(request.headers.get('authorization')).toBe('private');
    }
  });

  it.each(['0', '1'])('the actual SDK retains a per-call gateway across mutation and retries with governor=%s', async governed => {
    vi.stubEnv('PAPERCUSP_DEFAULT_ACCOUNT_ACTIVE', '1');
    vi.stubEnv('PAPERCUSP_AGENT_GOVERNOR', governed);
    sdk.real = (await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk')).default;
    const statelessGateway = { baseURL: 'http://127.0.0.1:32123/cycle', token: 'cycle-private' };
    const requests: Request[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      if (requests.length === 1) return new Response(JSON.stringify({ error: { type: 'overloaded_error', message: 'fixture retry' } }),
        { status: 503, headers: { 'retry-after': '0', 'content-type': 'application/json' } });
      const frames = [
        { type: 'message_start', message: { id: 'msg_scoped', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'scoped' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ].map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join('');
      return new Response(frames, { headers: { 'content-type': 'text/event-stream' } });
    }));
    const attempts: StatelessRequestAttempt[] = [];
    const opts: RunAgentChatOptions = { backend: 'anthropic-direct', model: 'claude-opus-4-8', promptText: 'scoped',
      maxTokens: 8, requireOutputTokenLimit: true, statelessGateway, signal: AbortSignal.timeout(5000),
      authorizeStatelessRequest: async attempt => {
        attempts.push(attempt); statelessGateway.baseURL = 'http://127.0.0.1:1'; statelessGateway.token = 'changed'; return () => {};
      } };
    const run = runAgentChat(opts); const first = run.next();
    opts.statelessGateway = { baseURL: 'http://127.0.0.1:2', token: 'replacement' };
    const events = [(await first).value]; for await (const event of run) events.push(event);
    expect(requests.map(request => [request.url, request.headers.get('authorization')]))
      .toEqual([['http://127.0.0.1:32123/cycle/v1/messages', 'Bearer cycle-private'],
        ['http://127.0.0.1:32123/cycle/v1/messages', 'Bearer cycle-private']]);
    expect(attempts.map(attempt => attempt.url)).toEqual(['http://127.0.0.1:32123/cycle/v1/messages',
      'http://127.0.0.1:32123/cycle/v1/messages']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'result', finalText: 'scoped' }));
  });

  it.each(['claude-code', 'omp', 'codex'] as const)('refuses a per-call gateway on unsupported backend %s', async backend => {
    await expect(runAgentChat({ backend, promptText: 'fixture',
      statelessGateway: { baseURL: 'http://127.0.0.1:32123', token: 'private' } }).next()).rejects.toMatchObject({ costUsd: 0 });
  });

  it.each(['0', '1'])('does not replace an explicit gateway credential on authentication failure with governor=%s', async governed => {
    vi.stubEnv('PAPERCUSP_AGENT_GOVERNOR', governed);
    sdk.real = (await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk')).default;
    const requests: Request[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ error: { type: 'authentication_error', message: 'private fixture refused' } }),
        { status: 401, headers: { 'content-type': 'application/json' } });
    }));
    const events = [];
    for await (const event of runAgentChat({ backend: 'anthropic-direct', model: 'claude-opus-4-8', promptText: 'fixture',
      statelessGateway: { baseURL: 'http://127.0.0.1:32123/cycle', token: 'cycle-private' },
      signal: AbortSignal.timeout(5000), authorizeStatelessRequest: async () => () => {} })) events.push(event);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('http://127.0.0.1:32123/cycle/v1/messages');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer cycle-private');
    expect(events).toContainEqual(expect.objectContaining({ type: 'error' }));
  });

  it.each(['0', '1'])('the actual SDK sends the frozen judge policy and caller snapshot with governor=%s', async governed => {
    vi.stubEnv('PAPERCUSP_DEFAULT_ACCOUNT_ACTIVE', '1');
    vi.stubEnv('PAPERCUSP_AGENT_GOVERNOR', governed);
    sdk.real = (await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk')).default;
    const requests: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(await new Request(input, init).json());
      if (requests.length === 1) return new Response(JSON.stringify({ error: { type: 'overloaded_error', message: 'fixture retry' } }),
        { status: 503, headers: { 'retry-after': '0', 'content-type': 'application/json' } });
      const frames = [
        { type: 'message_start', message: { id: 'msg_bounded', type: 'message', role: 'assistant',
          model: 'claude-opus-4-8', content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'bounded' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ].map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join('');
      return new Response(frames, { headers: { 'content-type': 'text/event-stream' } });
    }));
    const authorized: StatelessRequestAttempt[] = [];
    const authorizeStatelessRequest = vi.fn(async (attempt: StatelessRequestAttempt) => { authorized.push(attempt); return () => {}; });
    const opts: RunAgentChatOptions = { backend: 'anthropic-direct', model: 'claude-opus-4-8',
      promptText: 'original', messages: [{ role: 'user', content: 'original' }],
      maxTokens: 2048, thinkingBudgetTokens: 1024, temperature: 0,
      requireOutputTokenLimit: true, authorizeStatelessRequest, signal: AbortSignal.timeout(5000) };
    const run = runAgentChat(opts);
    const first = run.next();
    opts.maxTokens = 9999; opts.model = 'claude-sonnet-4-6';
    opts.messages![0].content = 'changed'; opts.requireOutputTokenLimit = false;
    opts.authorizeStatelessRequest = undefined;
    const events = [(await first).value];
    for await (const event of run) events.push(event);
    expect(requests).toHaveLength(2);
    expect(authorizeStatelessRequest).toHaveBeenCalledTimes(2);
    expect(authorized.map(a => a.attempt)).toEqual([1, 2]);
    expect(new Set(authorized.map(a => a.attemptId)).size).toBe(2);
    expect(authorized.map(a => JSON.parse(a.body))).toEqual(requests);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]).toMatchObject({ model: 'claude-opus-4-8', max_tokens: 2048,
      messages: [{ role: 'user', content: 'original' }], thinking: { type: 'enabled', budget_tokens: 1024 } });
    expect(requests[0]).not.toHaveProperty('temperature');
    expect(events.at(-1)).toMatchObject({ type: 'result', finalText: 'bounded', tokensIn: 1, tokensOut: 1 });
  });
});

describe('stateless HTTP attempt diagnostics (WI-10005738)', () => {
  it.each(['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'])(
    'classifies masked local gateway %s using the existing bounded retry policy', code => {
      const failure = new Error('Connection error.', { cause: new TypeError('fetch failed', { cause: { code } }) });
      expect(isTransientLlmError(failure, { baseURL: 'http://127.0.0.1:8788' })).toBe(true);
      expect(isTransientLlmError(failure, { baseURL: 'https://api.anthropic.com' })).toBe(false);
      expect(isTransientLlmError(failure)).toBe(false);
    });

  it('does not broaden retries to unknown local failures, DNS or authentication failures', () => {
    for (const failure of [new Error('Connection error.'), new Error('401 unauthorized'),
      new Error('Connection error.', { cause: { code: 'ENOTFOUND' } })]) {
      expect(isTransientLlmError(failure, { baseURL: 'http://127.0.0.1:8788' })).toBe(false);
    }
    expect(isTransientLlmError(new Error('529 overloaded'))).toBe(true);
  });

  it('records actual sends including SDK retries, without changing requests or consuming responses', async () => {
    const records: StatelessTransportDiagnostic[] = [];
    const headers = new Headers({ 'request-id': 'req_provider', 'x-papercusp-routed-account': 'served-account',
      'set-cookie': 'secret-cookie', authorization: 'secret-response' });
    const response = new Response('original body', { status: 429, headers });
    const send = vi.fn(async () => response);
    const observed = createStatelessDiagnosticFetch(transport, records.push.bind(records), send);
    const init = { headers: { authorization: 'secret-request' }, body: 'secret-prompt' };
    const input = 'http://user:secret-password@127.0.0.1:8788/private-token?api_key=secret-query#secret-fragment';
    expect(await observed(input, init)).toBe(response);
    expect(await observed(input, init)).toBe(response);
    expect(send).toHaveBeenNthCalledWith(1, input, init);
    expect(records.map(r => [r.attempt, r.phase])).toEqual([[1, 'request'], [1, 'response'], [2, 'request'], [2, 'response']]);
    expect(new Set(records.map(r => r.callId)).size).toBe(1);
    expect(records[1]).toMatchObject({ endpointOrigin: 'http://127.0.0.1:8788', label: 'anthropic-direct',
      loopback: true, requestedAccount: 'requested-account', servedAccount: 'served-account', providerRequestId: 'req_provider', status: 429 });
    expect(JSON.stringify(records)).not.toContain('secret');
    expect(JSON.stringify(records)).not.toContain('private-token');
    expect(await response.text()).toBe('original body');
  });

  it('records an unknown upstream identity on connection failure and preserves the same exception', async () => {
    const records: StatelessTransportDiagnostic[] = [];
    const failure = new TypeError('secret diagnostic');
    const observed = createStatelessDiagnosticFetch(transport, r => records.push(r), async () => { throw failure; });
    await expect(observed(new Request('https://api.anthropic.com/v1/messages'))).rejects.toBe(failure);
    expect(records[1]).toMatchObject({ phase: 'transport-error', endpointOrigin: 'https://api.anthropic.com',
      loopback: false, servedAccount: null, providerRequestId: null, status: null });
    expect(JSON.stringify(records)).not.toContain('secret diagnostic');
  });

  it('keeps missing response metadata unknown and never lets a diagnostic sink fail the request', async () => {
    const response = new Response('ok');
    const records: StatelessTransportDiagnostic[] = [];
    const observed = createStatelessDiagnosticFetch({ ...transport, headers: {} }, r => {
      records.push(r); throw new Error('broken observer');
    }, async () => response);
    expect(await observed(new URL('http://127.0.0.1:8788/v1/messages'))).toBe(response);
    expect(records[1]).toMatchObject({ requestedAccount: null, servedAccount: null, providerRequestId: null, status: 200 });
  });

  it.each(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'])(
    'retains allowlisted nested fetch cause %s without changing the thrown error', async code => {
      const records: StatelessTransportDiagnostic[] = [];
      const failure = new TypeError('secret URL or credential', {
        cause: new Error('secret underlying message', { cause: { code } }),
      });
      const observed = createStatelessDiagnosticFetch(transport, r => records.push(r), async () => { throw failure; });
      await expect(observed('http://127.0.0.1:8788/v1/messages')).rejects.toBe(failure);
      expect(records[1]).toMatchObject({ phase: 'transport-error', transportFailureCode: code });
      expect(JSON.stringify(records)).not.toContain('secret');
      expect(records[0]).not.toHaveProperty('transportFailureCode');
    });

  it('keeps arbitrary codes, cyclic causes and hostile getters undisclosed', async () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    for (const cause of [{ code: 'secret-token' }, cyclic,
      Object.defineProperty({}, 'code', { get() { throw new Error('secret getter'); } })]) {
      const records: StatelessTransportDiagnostic[] = [];
      const failure = new Error('secret failure', { cause });
      const observed = createStatelessDiagnosticFetch(transport, r => records.push(r), async () => { throw failure; });
      await expect(observed('http://127.0.0.1:8788/v1/messages')).rejects.toBe(failure);
      expect(records[1]).toMatchObject({ phase: 'transport-error', transportFailureCode: null });
      expect(JSON.stringify(records)).not.toContain('secret');
    }
  });

  it.each(['0', '1'])('the real runner observes failures with governor=%s before yielding its error', async governed => {
    vi.stubEnv('PAPERCUSP_DEFAULT_ACCOUNT_ACTIVE', '1');
    vi.stubEnv('PAPERCUSP_AGENT_GOVERNOR', governed);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('refused', { status: governed === '1' ? 400 : 429,
      headers: { 'request-id': 'req_failure', 'x-papercusp-routed-account': 'actual-account' } })));
    const records: StatelessTransportDiagnostic[] = [];
    const events = [];
    for await (const event of runAgentChat({ backend: 'anthropic-direct', model: 'claude-sonnet-4-6',
      promptText: 'unchanged prompt', signal: AbortSignal.timeout(1000), retryDeadlineMs: 0,
      onTransportDiagnostic: r => records.push(r) })) events.push(event);
    expect(records.map(r => r.phase)).toEqual(['request', 'response', 'stream-error']);
    expect(records[1]).toMatchObject({ providerRequestId: 'req_failure', servedAccount: 'actual-account',
      governorMode: governed === '1' ? 'request-local' : 'disabled' });
    expect(events.at(-1)?.type).toBe('error');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('the real successful path observes headers without altering its model result', async () => {
    vi.stubEnv('PAPERCUSP_DEFAULT_ACCOUNT_ACTIVE', '1');
    vi.stubEnv('PAPERCUSP_AGENT_GOVERNOR', '0');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { headers: { 'request-id': 'req_success' } })));
    const records: StatelessTransportDiagnostic[] = [];
    const events = [];
    for await (const event of runAgentChat({ backend: 'anthropic-direct', model: 'claude-sonnet-4-6',
      promptText: 'unchanged prompt', signal: AbortSignal.timeout(1000),
      onTransportDiagnostic: r => records.push(r) })) events.push(event);
    expect(records[1]).toMatchObject({ providerRequestId: 'req_success', servedAccount: null, status: 200 });
    expect(events.at(-1)).toMatchObject({ type: 'result', finalText: 'ok', tokensIn: 1, tokensOut: 1 });
    expect(records.at(-1)).toMatchObject({ phase: 'stream-complete', streamEventCount: 0,
      textChars: 0, firstStreamEventAt: null, lastStreamEventAt: null, callerAborted: false });
  });

  it.each(['0', '1'])('distinguishes caller timeout after header200 from body failure with governor=%s', async governed => {
    vi.stubEnv('PAPERCUSP_DEFAULT_ACCOUNT_ACTIVE', '1');
    vi.stubEnv('PAPERCUSP_AGENT_GOVERNOR', governed);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('secret body', {
      headers: { 'request-id': 'req_partial', 'x-papercusp-routed-account': 'served-account' },
    })));
    sdk.bodyEvents = [{ type: 'message_start' }, { type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'secret partial response' } }];
    sdk.bodyFailure = new Error('Request was aborted.');
    const controller = new AbortController();
    sdk.beforeFailure = () => controller.abort(new DOMException('secret reason', 'TimeoutError'));
    const records: StatelessTransportDiagnostic[] = [], events = [];
    for await (const event of runAgentChat({ backend: 'anthropic-direct', model: 'claude-sonnet-4-6',
      promptText: 'secret prompt', signal: controller.signal, retryDeadlineMs: 0,
      onTransportDiagnostic: r => records.push(r) })) events.push(event);
    expect(records.map(r => r.phase)).toEqual(['request', 'response', 'stream-progress', 'stream-error']);
    expect(records.at(-1)).toMatchObject({ status: 200, providerRequestId: 'req_partial',
      servedAccount: 'served-account', streamEventCount: 2, textChars: 23,
      callerAborted: true, callerAbortReason: 'TimeoutError',
      governorMode: governed === '1' ? 'request-local' : 'disabled' });
    expect(records.at(-1)?.firstStreamEventAt).toBeTruthy();
    expect(records.at(-1)?.lastStreamEventAt).toBeTruthy();
    expect(new Set(records.map(r => r.callId)).size).toBe(1);
    expect(new Set(records.map(r => r.attempt))).toEqual(new Set([1]));
    expect(JSON.stringify(records)).not.toContain('secret');
    // Diagnostics preserve the actual caller-abort evidence before either
    // existing retry path applies its own terminal error classification.
    expect(events.at(-1)).toMatchObject({ type: 'error', message: governed === '1'
      ? 'anthropic-direct error: aborted while rate-limited'
      : expect.stringContaining('Request was aborted.') });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('records a zero-event body failure without falsely claiming caller cancellation', async () => {
    vi.stubEnv('PAPERCUSP_DEFAULT_ACCOUNT_ACTIVE', '1');
    vi.stubEnv('PAPERCUSP_AGENT_GOVERNOR', '0');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unread')));
    sdk.bodyFailure = new Error('malformed provider stream');
    const records: StatelessTransportDiagnostic[] = [];
    const events = [];
    for await (const event of runAgentChat({ backend: 'anthropic-direct', model: 'claude-sonnet-4-6',
      promptText: 'prompt', signal: new AbortController().signal,
      onTransportDiagnostic: r => records.push(r) })) events.push(event);
    expect(records.at(-1)).toMatchObject({ phase: 'stream-error', status: 200, streamEventCount: 0,
      firstStreamEventAt: null, lastStreamEventAt: null, callerAborted: false, callerAbortReason: null });
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('malformed provider stream') });
  });

  it('bounds progress output and preserves success when a diagnostic sink throws', async () => {
    vi.stubEnv('PAPERCUSP_DEFAULT_ACCOUNT_ACTIVE', '1');
    vi.stubEnv('PAPERCUSP_AGENT_GOVERNOR', '0');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unread')));
    sdk.bodyEvents = Array.from({ length: 1000 }, () => ({ type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'secret' } }));
    const records: StatelessTransportDiagnostic[] = [], events = [];
    for await (const event of runAgentChat({ backend: 'anthropic-direct', model: 'claude-sonnet-4-6',
      promptText: 'prompt', onTransportDiagnostic: r => { records.push(r); throw new Error('sink failure'); } })) events.push(event);
    expect(records.map(r => r.phase)).toEqual(['request', 'response', 'stream-progress', 'stream-complete']);
    expect(records.at(-1)).toMatchObject({ streamEventCount: 1000, textChars: 6000,
      callerAborted: null, callerAbortReason: null });
    expect(events.at(-1)).toMatchObject({ type: 'result', finalText: 'ok' });
    expect(JSON.stringify(records)).not.toContain('secret');
  });

  it('observes actual SDK SSE progress before an interrupted body, without a provider request', async () => {
    vi.stubEnv('PAPERCUSP_DEFAULT_ACCOUNT_ACTIVE', '1');
    vi.stubEnv('PAPERCUSP_AGENT_GOVERNOR', '0');
    sdk.real = (await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk')).default;
    const controller = new AbortController();
    const records: StatelessTransportDiagnostic[] = [], events = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      const prefix = [
        { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant',
          model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'secret' } },
      ].map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join('');
      const body = new ReadableStream<Uint8Array>({ start(streamController) {
        streamController.enqueue(new TextEncoder().encode(prefix));
        init?.signal?.addEventListener('abort', () => streamController.error(new Error('fixture body interrupted')), { once: true });
      } });
      return new Response(body, { headers: { 'content-type': 'text/event-stream', 'request-id': 'req_sse_fixture' } });
    }));
    for await (const event of runAgentChat({ backend: 'anthropic-direct', model: 'claude-sonnet-4-6',
      promptText: 'secret prompt', signal: controller.signal, retryDeadlineMs: 0,
      onTransportDiagnostic: r => {
        records.push(r);
        if (r.phase === 'stream-progress') queueMicrotask(() => controller.abort(new DOMException('secret reason', 'TimeoutError')));
      } })) events.push(event);
    expect(records.at(-1)).toMatchObject({ phase: 'stream-error', status: 200,
      providerRequestId: 'req_sse_fixture', callerAborted: true, callerAbortReason: 'TimeoutError' });
    expect(records.at(-1)?.streamEventCount).toBeGreaterThan(0);
    expect(records.at(-1)?.lastStreamEventAt).toBeTruthy();
    expect(JSON.stringify(records)).not.toContain('secret');
    expect(events.at(-1)?.type).toBe('error');
    expect(events.some(event => event.type === 'result')).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
