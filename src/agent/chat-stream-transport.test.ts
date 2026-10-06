import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createStatelessDiagnosticFetch, runAgentChat, type RunAgentChatOptions, type StatelessTransportDiagnostic } from './chat-stream';

// Negative pre-implementation cases must never launch a credentialed CLI.
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(() => { throw new Error('Fixture forbids subprocess inference'); }),
}));

const sdk = vi.hoisted(() => ({ fetch: undefined as typeof fetch | undefined,
  bodyEvents: [] as unknown[], bodyFailure: undefined as Error | undefined,
  beforeFailure: undefined as (() => void) | undefined,
  real: undefined as typeof import('@anthropic-ai/sdk').default | undefined }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor(options: { fetch?: typeof fetch }) {
      sdk.fetch = options.fetch;
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
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  sdk.bodyEvents = []; sdk.bodyFailure = undefined; sdk.beforeFailure = undefined; sdk.real = undefined;
});

const transport = {
  baseURL: 'http://127.0.0.1:8788', token: 'secret-bearer',
  headers: { 'x-papercusp-account': 'requested-account', authorization: 'secret-header' },
  label: 'anthropic-direct' as const,
};

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
    const authorize = vi.fn(async attempt => {
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
  });

  it.each(['aborted', 'revoked'] as const)('rechecks %s authorization after an asynchronous policy read', async kind => {
    const controller = new AbortController();
    const send = vi.fn(async () => new Response('unexpected'));
    const guarded = createStatelessDiagnosticFetch(transport, () => {}, send,
      { callId: 'authorized', attempt: 0 }, 'disabled', 8, async () => {
        if (kind === 'aborted') controller.abort();
        return () => { if (kind === 'revoked') throw new Error('expired private grant'); };
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
    const authorize = vi.fn(async attempt => {
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

  it.each(['0', '1'])('the actual SDK sends the frozen judge policy and caller snapshot with governor=%s', async governed => {
    vi.stubEnv('PAPERCUSP_DEFAULT_ACCOUNT_ACTIVE', '1');
    vi.stubEnv('PAPERCUSP_AGENT_GOVERNOR', governed);
    sdk.real = (await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk')).default;
    const requests: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(await new Request(input, init).json());
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
    const opts: RunAgentChatOptions = { backend: 'anthropic-direct', model: 'claude-opus-4-8',
      promptText: 'original', messages: [{ role: 'user', content: 'original' }],
      maxTokens: 2048, thinkingBudgetTokens: 1024, temperature: 0,
      requireOutputTokenLimit: true, signal: AbortSignal.timeout(2000) };
    const run = runAgentChat(opts);
    const first = run.next();
    opts.maxTokens = 9999; opts.model = 'claude-sonnet-4-6';
    opts.messages![0].content = 'changed'; opts.requireOutputTokenLimit = false;
    const events = [(await first).value];
    for await (const event of run) events.push(event);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: 'claude-opus-4-8', max_tokens: 2048,
      messages: [{ role: 'user', content: 'original' }], thinking: { type: 'enabled', budget_tokens: 1024 } });
    expect(requests[0]).not.toHaveProperty('temperature');
    expect(events.at(-1)).toMatchObject({ type: 'result', finalText: 'bounded', tokensIn: 1, tokensOut: 1 });
  });
});

describe('stateless HTTP attempt diagnostics (WI-10005738)', () => {
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
