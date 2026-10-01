/**
 * Guard for the @anthropic-ai/sdk patch (patches/@anthropic-ai+sdk+0.81.0.patch, WI-10004615).
 *
 * SDK 0.81 honours a 429 `retry-after` with no upper bound and waits it out with a sleep
 * that ignores the request's AbortSignal. Measured 2026-10-01: a usage-window 429 carrying
 * `retry-after: 8286` froze four in-process judge calls for 2h18m, and the caller's
 * AbortSignal.timeout(120 s) could not interrupt them (EI-24751974038660529). Every
 * in-process `new Anthropic(...)` client (chat-stream.ts builds it with maxRetries: 2)
 * inherits that behaviour, so the fix lives in the SDK itself.
 *
 * These tests drive the REAL installed SDK against a stub fetch, so they fail if the patch
 * is ever lost (an SDK upgrade, a dropped patch file, a reinstall without patch-package).
 */
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

type FetchCall = { at: number };

function stubFetch(responses: Array<() => Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl = async (_url: unknown, init?: { signal?: AbortSignal | null }) => {
    calls.push({ at: Date.now() });
    if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return next();
  };
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const rateLimited = (headers: Record<string, string>) => () =>
  new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }), {
    status: 429,
    headers: { 'content-type': 'application/json', ...headers },
  });

const ok = () =>
  new Response(
    JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

function client(fetchImpl: typeof fetch, maxRetries = 2) {
  return new Anthropic({ apiKey: 'test-key', baseURL: 'http://sdk-patch.test', fetch: fetchImpl, maxRetries });
}

const params = { model: 'claude-test', max_tokens: 8, messages: [{ role: 'user' as const, content: 'hi' }] };

describe('@anthropic-ai/sdk retry-after patch (WI-10004615)', () => {
  it('surfaces a 429 whose retry-after exceeds 60 s instead of sleeping it out', async () => {
    const { calls, fetchImpl } = stubFetch([rateLimited({ 'retry-after': '8286' })]);
    const started = Date.now();
    await expect(client(fetchImpl).messages.create(params)).rejects.toMatchObject({ status: 429 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls).toHaveLength(1);
  });

  it('also refuses a long wait requested via retry-after-ms and via an HTTP date', async () => {
    const longWaits: Record<string, string>[] = [
      { 'retry-after-ms': '61000' },
      { 'retry-after': new Date(Date.now() + 3_600_000).toUTCString() },
    ];
    for (const headers of longWaits) {
      const { calls, fetchImpl } = stubFetch([rateLimited(headers)]);
      await expect(client(fetchImpl).messages.create(params)).rejects.toMatchObject({ status: 429 });
      expect(calls).toHaveLength(1);
    }
  });

  it('refuses the long wait even when the server sends x-should-retry: true', async () => {
    const { calls, fetchImpl } = stubFetch([rateLimited({ 'retry-after': '8286', 'x-should-retry': 'true' })]);
    await expect(client(fetchImpl).messages.create(params)).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(1);
  });

  it('still honours a short retry-after and retries (the pre-0.5x behaviour this restores)', async () => {
    const { calls, fetchImpl } = stubFetch([rateLimited({ 'retry-after-ms': '50' }), ok]);
    const msg = await client(fetchImpl).messages.create(params);
    expect(msg.content[0]).toMatchObject({ type: 'text', text: 'ok' });
    expect(calls).toHaveLength(2);
    const [first, second] = calls;
    expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(40);
  });

  it('a retry wait observes the request AbortSignal', async () => {
    const { calls, fetchImpl } = stubFetch([rateLimited({ 'retry-after': '30' }), ok]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    await expect(client(fetchImpl).messages.create(params, { signal: controller.signal })).rejects.toBeInstanceOf(
      Anthropic.APIUserAbortError,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(calls).toHaveLength(1);
  });
});
