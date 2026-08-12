/**
 * WI-38316 — the refresh-on-upstream-rejection path for the Claude OAuth bundle.
 *
 * The incident this covers: an access token that is LOCALLY VALID (expires 7h out) but
 * rejected upstream as revoked. Every local check passes, so the old code re-read the same
 * unchanged file, found the same token, and surfaced a hard non-retryable 401 — while a live
 * refresh token sat unused in the same bundle.
 *
 * Every test drives a bundle in a TEMP dir with an injected `fetchImpl`; nothing here reads or
 * writes the real `~/.claude/.credentials.json`. Fixture tokens are deliberately SHORT, opaque
 * and nothing like a real key shape — a realistic-looking credential in a tree file trips the
 * secrets guard, and the pot-git publish guard then refuses the containing range permanently.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  refreshClaudeOauthCredential,
  readClaudeCredentialBundle,
  describeClaudeAuthFailure,
  CLAUDE_OAUTH_DEFAULTS,
  type ClaudeCredentialBundle,
} from './claude-oauth';

let dir: string;
let path: string;

const HOUR = 3_600_000;
const TOK_STALE = 'tok-stale';
const TOK_FRESH = 'tok-fresh';
const TOK_PEER = 'tok-peer';
const RT_A = 'rt-a';
const RT_B = 'rt-b';

function writeBundle(extra: Record<string, unknown> = {}, oauth: Record<string, unknown> = {}): void {
  const bundle: ClaudeCredentialBundle = {
    ...extra,
    claudeAiOauth: {
      accessToken: TOK_STALE,
      refreshToken: RT_A,
      expiresAt: Date.now() + 7 * HOUR,
      refreshTokenExpiresAt: Date.now() + 28 * 24 * HOUR,
      scopes: ['user:inference'],
      subscriptionType: 'max',
      ...oauth,
    },
  };
  writeFileSync(path, JSON.stringify(bundle, null, 2), { mode: 0o600 });
}

/** A token endpoint that returns a rotated pair, recording what it was asked. */
function okEndpoint(calls: Array<Record<string, string>>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: TOK_FRESH, refresh_token: RT_B, expires_in: 28800 }),
    };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-oauth-test-'));
  path = join(dir, '.credentials.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('refreshClaudeOauthCredential', () => {
  it('exchanges the refresh token and persists the rotated pair', async () => {
    writeBundle();
    const calls: Array<Record<string, string>> = [];
    const out = await refreshClaudeOauthCredential({ path, rejectedAccessToken: TOK_STALE, fetchImpl: okEndpoint(calls) });

    expect(out).toMatchObject({ ok: true, accessToken: TOK_FRESH, adopted: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(CLAUDE_OAUTH_DEFAULTS.tokenUrl);
    expect(calls[0].body).toContain('grant_type=refresh_token');
    expect(calls[0].body).toContain(`client_id=${CLAUDE_OAUTH_DEFAULTS.clientId}`);

    const after = readClaudeCredentialBundle(path)!;
    expect(after.claudeAiOauth?.accessToken).toBe(TOK_FRESH);
    // Anthropic rotates the refresh token on use — persisting the OLD one would make the next
    // refresh fail with a token that was already spent.
    expect(after.claudeAiOauth?.refreshToken).toBe(RT_B);
    expect(after.claudeAiOauth?.expiresAt as number).toBeGreaterThan(Date.now() + 7 * HOUR);
  });

  it("preserves every other bundle field — this file is the owner's live credential", async () => {
    writeBundle({ someOtherProvider: { value: 'keep-me' } });
    await refreshClaudeOauthCredential({ path, fetchImpl: okEndpoint([]) });

    const after = readClaudeCredentialBundle(path)!;
    expect(after.someOtherProvider).toEqual({ value: 'keep-me' });
    expect(after.claudeAiOauth?.scopes).toEqual(['user:inference']);
    expect(after.claudeAiOauth?.subscriptionType).toBe('max');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('ADOPTS a peer-refreshed token instead of burning its own refresh token', async () => {
    // The multi-process case: many agents share ONE bundle and a refresh token is single-use.
    writeBundle({}, { accessToken: TOK_PEER });
    const calls: Array<Record<string, string>> = [];
    const out = await refreshClaudeOauthCredential({ path, rejectedAccessToken: TOK_STALE, fetchImpl: okEndpoint(calls) });

    expect(out).toMatchObject({ ok: true, accessToken: TOK_PEER, adopted: true });
    expect(calls).toHaveLength(0); // no exchange issued
  });

  it('collapses concurrent callers onto ONE exchange', async () => {
    // 10 judge calls hitting the same dead token must not fire 10 rotations, which would
    // invalidate each other's refresh tokens and fail most of them.
    writeBundle();
    const calls: Array<Record<string, string>> = [];
    const slow = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, status: 200, json: async () => ({ access_token: TOK_FRESH, expires_in: 28800 }) };
    }) as unknown as typeof fetch;

    const outs = await Promise.all(
      Array.from({ length: 10 }, () => refreshClaudeOauthCredential({ path, rejectedAccessToken: TOK_STALE, fetchImpl: slow })),
    );
    expect(calls).toHaveLength(1);
    expect(outs.every((o) => o.ok)).toBe(true);
  });

  it('reports a typed reason instead of throwing, so the original 401 is never masked', async () => {
    writeBundle({}, { refreshToken: undefined });
    await expect(refreshClaudeOauthCredential({ path, fetchImpl: okEndpoint([]) })).resolves.toMatchObject({
      ok: false,
      reason: 'no-refresh-token',
    });

    writeBundle({}, { refreshTokenExpiresAt: Date.now() - 1000 });
    await expect(refreshClaudeOauthCredential({ path, fetchImpl: okEndpoint([]) })).resolves.toMatchObject({
      ok: false,
      reason: 'refresh-token-expired',
    });

    rmSync(path);
    await expect(refreshClaudeOauthCredential({ path, fetchImpl: okEndpoint([]) })).resolves.toMatchObject({
      ok: false,
      reason: 'no-bundle',
    });
  });

  it('leaves the bundle untouched when the exchange fails or the endpoint is unreachable', async () => {
    writeBundle();
    const before = readFileSync(path, 'utf8');

    const rejecting = (async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant', error_description: 'refresh token revoked' }),
    })) as unknown as typeof fetch;
    const out = await refreshClaudeOauthCredential({ path, fetchImpl: rejecting });
    expect(out).toMatchObject({ ok: false, reason: 'exchange-failed' });
    expect((out as { detail?: string }).detail).toContain('refresh token revoked');
    expect(readFileSync(path, 'utf8')).toBe(before);

    const throwing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(refreshClaudeOauthCredential({ path, fetchImpl: throwing })).resolves.toMatchObject({
      ok: false,
      reason: 'exchange-failed',
    });
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('never writes a bundle with an empty refresh token when the response omits one', async () => {
    writeBundle();
    const noRotate = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: TOK_FRESH, expires_in: 28800 }),
    })) as unknown as typeof fetch;
    await refreshClaudeOauthCredential({ path, fetchImpl: noRotate });
    expect(readClaudeCredentialBundle(path)!.claudeAiOauth?.refreshToken).toBe(RT_A);
  });
});

describe('describeClaudeAuthFailure', () => {
  const now = Date.UTC(2026, 7, 12, 21, 31, 0);

  it('names the confusing case out loud: locally valid, rejected upstream', () => {
    const msg = describeClaudeAuthFailure({ expiresAt: now + 7 * HOUR, now });
    expect(msg).toContain('NOT expired');
    expect(msg).toContain('rejected UPSTREAM');
    expect(msg).toContain('WI-38316');
    // The two actionable exits the incident cost an hour to find.
    expect(msg).toContain('re-authenticate');
    expect(msg).toContain('LLM_TEST_BACKEND=claude-code');
  });

  it('does NOT claim an expired credential was rejected upstream', () => {
    const msg = describeClaudeAuthFailure({ expiresAt: now - HOUR, now });
    expect(msg).toContain('expired at');
    expect(msg).not.toContain('rejected UPSTREAM');
  });

  it('reports the refresh verdict, so a failure says why recovery did not happen', () => {
    expect(describeClaudeAuthFailure({ expiresAt: now + HOUR, now, refreshOutcome: { ok: false, reason: 'no-refresh-token' } }))
      .toContain('no refresh token');
    expect(
      describeClaudeAuthFailure({
        expiresAt: now + HOUR,
        now,
        refreshOutcome: { ok: false, reason: 'refresh-token-expired', detail: '2026-08-01T00:00:00.000Z' },
      }),
    ).toContain('refresh token itself expired');
    expect(
      describeClaudeAuthFailure({ expiresAt: now + HOUR, now, refreshOutcome: { ok: true, accessToken: 'x', expiresAt: null, adopted: true } }),
    ).toContain('peer had already rotated');
  });
});
