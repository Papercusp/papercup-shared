import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStatelessDiagnosticFetch, runAgentChat, type StatelessTransportDiagnostic } from './chat-stream';

const sdk = vi.hoisted(() => ({ fetch: undefined as typeof fetch | undefined }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor(options: { fetch?: typeof fetch }) { sdk.fetch = options.fetch; }
    messages = {
      stream: () => ({
        once: () => {},
        finalMessage: async () => {
          const response = await sdk.fetch!('http://127.0.0.1:8788/v1/messages');
          if (!response.ok) throw Object.assign(new Error('upstream refusal'), {
            status: response.status, headers: response.headers,
          });
          return { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } };
        },
      }),
    };
  },
}));

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const transport = {
  baseURL: 'http://127.0.0.1:8788', token: 'secret-bearer',
  headers: { 'x-papercusp-account': 'requested-account', authorization: 'secret-header' },
  label: 'anthropic-direct' as const,
};

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
    expect(records.map(r => r.phase)).toEqual(['request', 'response']);
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
  });
});
