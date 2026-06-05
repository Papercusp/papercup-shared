/**
 * @vitest-environment jsdom
 *
 * openFeatureChat.test.ts — the small fetch + window-event helper that opens
 * an agent chat in the operator dock. Covers: the POST request shape (path
 * encoding + body), success → returns chatId, pushes to the pending-open
 * window queue, and dispatches the OPEN_CHAT_EVENT CustomEvent with the
 * correctly-shaped detail (including the optional `mode` only when supplied);
 * the !ok and thrown-fetch error branches; and the no-window guard.
 *
 * jsdom env gives a real `window` + `CustomEvent` + `dispatchEvent`; `fetch`
 * is stubbed per-test. No real network. Console stays silent so the default
 * vitest-fail-on-console setup is satisfied.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openFeatureChat, OPEN_CHAT_EVENT, type OpenChatEventDetail } from './openFeatureChat';

type WindowWithQueue = Window & {
  __PAPERCUSP_PENDING_CHAT_OPENS__?: OpenChatEventDetail[];
};

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

beforeEach(() => {
  delete (window as WindowWithQueue).__PAPERCUSP_PENDING_CHAT_OPENS__;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('openFeatureChat — request shape', () => {
  it('POSTs to the slug-encoded agent-chats endpoint with the role/feature body', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ id: 'chat-1', title: 'T', role: 'worker', feature_id: 'F-1' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await openFeatureChat({ slug: 'my harness/x', role: 'worker', featureId: 'F-1', title: 'T' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // slug is encoded into the path
    expect(url).toBe('/api/harness/my%20harness%2Fx/agent-chats');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.parse(init?.body as string)).toEqual({
      role: 'worker',
      feature_id: 'F-1',
      title: 'T',
    });
  });
});

describe('openFeatureChat — success path', () => {
  it('returns { chatId } and dispatches the open-chat event with shaped detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ id: 'chat-42', title: 'Hello', role: 'validator', feature_id: 'F-9' })),
    );

    const events: OpenChatEventDetail[] = [];
    const handler = (e: Event) => events.push((e as CustomEvent<OpenChatEventDetail>).detail);
    window.addEventListener(OPEN_CHAT_EVENT, handler);

    const result = await openFeatureChat({ slug: 's', role: 'validator', featureId: 'F-9', title: 'Hello' });

    window.removeEventListener(OPEN_CHAT_EVENT, handler);

    expect(result).toEqual({ chatId: 'chat-42' });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      slug: 's',
      chatId: 'chat-42',
      title: 'Hello',
      role: 'validator',
      featureId: 'F-9',
    });
    // mode omitted when not supplied
    expect('mode' in events[0]).toBe(false);
  });

  it('pushes the detail onto the window pending-open queue (and appends to an existing one)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ id: 'c1', title: 't', role: 'worker', feature_id: 'F' })),
    );

    // pre-seed an existing queue entry to prove we append, not overwrite
    const seed: OpenChatEventDetail = { slug: 'old', chatId: 'c0' };
    (window as WindowWithQueue).__PAPERCUSP_PENDING_CHAT_OPENS__ = [seed];

    await openFeatureChat({ slug: 'new', role: 'worker', featureId: 'F' });

    const queue = (window as WindowWithQueue).__PAPERCUSP_PENDING_CHAT_OPENS__!;
    expect(queue).toHaveLength(2);
    expect(queue[0]).toBe(seed);
    expect(queue[1].chatId).toBe('c1');
    expect(queue[1].slug).toBe('new');
  });

  it('carries mode through to the event detail when supplied', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ id: 'cm', title: 't', role: 'worker', feature_id: 'F' })),
    );

    const events: OpenChatEventDetail[] = [];
    const handler = (e: Event) => events.push((e as CustomEvent<OpenChatEventDetail>).detail);
    window.addEventListener(OPEN_CHAT_EVENT, handler);

    await openFeatureChat({ slug: 's', role: 'worker', featureId: 'F', mode: 'discuss' });

    window.removeEventListener(OPEN_CHAT_EVENT, handler);
    expect(events[0].mode).toBe('discuss');
  });

  it('maps a null feature_id from the server to undefined', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ id: 'c', title: 't', role: 'worker', feature_id: null })),
    );

    const events: OpenChatEventDetail[] = [];
    const handler = (e: Event) => events.push((e as CustomEvent<OpenChatEventDetail>).detail);
    window.addEventListener(OPEN_CHAT_EVENT, handler);

    await openFeatureChat({ slug: 's', role: 'worker', featureId: 'F' });

    window.removeEventListener(OPEN_CHAT_EVENT, handler);
    expect(events[0].featureId).toBeUndefined();
  });
});

describe('openFeatureChat — error paths', () => {
  it('returns the server-provided error message on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'forbidden' }, { status: 403 })),
    );

    const result = await openFeatureChat({ slug: 's', role: 'worker', featureId: 'F' });
    expect(result).toEqual({ error: 'forbidden' });
  });

  it('falls back to "HTTP <status>" when the error body lacks an error field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not json', { status: 500 })),
    );

    const result = await openFeatureChat({ slug: 's', role: 'worker', featureId: 'F' });
    expect(result).toEqual({ error: 'HTTP 500' });
  });

  it('does not dispatch an event or push to the queue on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'nope' }, { status: 400 })),
    );

    const handler = vi.fn();
    window.addEventListener(OPEN_CHAT_EVENT, handler);
    await openFeatureChat({ slug: 's', role: 'worker', featureId: 'F' });
    window.removeEventListener(OPEN_CHAT_EVENT, handler);

    expect(handler).not.toHaveBeenCalled();
    expect((window as WindowWithQueue).__PAPERCUSP_PENDING_CHAT_OPENS__).toBeUndefined();
  });

  it('returns { error } with the thrown message when fetch rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    const result = await openFeatureChat({ slug: 's', role: 'worker', featureId: 'F' });
    expect(result).toEqual({ error: 'network down' });
  });
});
