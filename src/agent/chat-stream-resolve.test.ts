/**
 * chat-stream-resolve.test.ts — the backend/binary resolution seam of
 * chat-stream. `resolveBackend` + `resolveAgentBin` are pure precedence
 * functions exported so non-runAgentChat callers resolve identically; they read
 * process.env (AGENT_BACKEND / AGENT_CMD / CLAUDE_CMD), so each test owns a
 * clean env slice. (The runAgentChat generator itself is a subprocess/SSE
 * integration surface and is out of scope for this unit lane.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  resolveBackend,
  resolveAgentBin,
  withAgentBinDirs,
  tokenIsLive,
  chooseStatelessTransport,
  defaultAccountActive,
  DEFAULT_ACCOUNT_ACTIVE_ENV,
  probeStatelessTransport,
  invalidateClaudeTokenCache,
  resolveAnthropicBaseUrl,
  resolveDelegatedGatewayUrl,
  GATEWAY_DELEGATED_AUTH_TOKEN,
  resolveRouteAccountId,
  isConnectionFailure,
  isAuthFailure,
  type AgentBackend,
  type RunAgentChatOptions,
} from './chat-stream';

const ENV_KEYS = ['AGENT_BACKEND', 'AGENT_CMD', 'CLAUDE_CMD', 'HOME'] as const;
const saved: Record<string, string | undefined> = {};

function opts(partial: Partial<RunAgentChatOptions> = {}): RunAgentChatOptions {
  return { promptText: '', ...partial };
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolveBackend', () => {
  it('an explicit opts.backend wins over everything', () => {
    process.env.AGENT_BACKEND = 'claude-code';
    expect(resolveBackend(opts({ backend: 'codex' }))).toBe('codex');
  });

  it('maps the AGENT_BACKEND env aliases', () => {
    const cases: Array<[string, AgentBackend]> = [
      ['omp', 'omp'],
      ['pi', 'omp'],
      ['claude-code', 'claude-code'],
      ['claude', 'claude-code'],
      ['anthropic-direct', 'anthropic-direct'],
      ['codex', 'codex'],
      ['  CODEX  ', 'codex'], // trimmed + lowercased
    ];
    for (const [env, expected] of cases) {
      process.env.AGENT_BACKEND = env;
      expect(resolveBackend(opts())).toBe(expected);
    }
  });

  it('infers from opts.agentCmd binary name when env is unset', () => {
    expect(resolveBackend(opts({ agentCmd: 'omp' }))).toBe('omp');
    expect(resolveBackend(opts({ agentCmd: '/usr/local/bin/claude --foo' }))).toBe('claude-code');
    expect(resolveBackend(opts({ agentCmd: '/opt/pi' }))).toBe('omp');
    expect(resolveBackend(opts({ agentCmd: 'codex' }))).toBe('codex');
  });

  it('infers from AGENT_CMD / CLAUDE_CMD env when no opts.agentCmd', () => {
    process.env.AGENT_CMD = '/bin/claude';
    expect(resolveBackend(opts())).toBe('claude-code');
    delete process.env.AGENT_CMD;
    process.env.CLAUDE_CMD = 'omp';
    expect(resolveBackend(opts())).toBe('omp');
  });

  it('an inferable agentCmd beats a stale AGENT_BACKEND env', () => {
    process.env.AGENT_BACKEND = 'claude-code';
    expect(resolveBackend(opts({ agentCmd: 'codex' }))).toBe('codex');
  });

  it('an inferable AGENT_CMD env beats a stale AGENT_BACKEND env', () => {
    process.env.AGENT_BACKEND = 'claude-code';
    process.env.AGENT_CMD = 'codex';
    expect(resolveBackend(opts())).toBe('codex');
  });

  it('AGENT_BACKEND env still applies when no command is inferable', () => {
    process.env.AGENT_BACKEND = 'anthropic-direct';
    expect(resolveBackend(opts({ agentCmd: 'some-unknown-bin' }))).toBe('anthropic-direct');
  });

  it('defaults to omp when nothing resolves', () => {
    expect(resolveBackend(opts())).toBe('omp');
    expect(resolveBackend(opts({ agentCmd: 'some-unknown-bin' }))).toBe('omp');
  });
});

describe('resolveAgentBin', () => {
  it('opts.agentCmd wins over env and backend', () => {
    process.env.AGENT_CMD = '/env/claude';
    expect(resolveAgentBin(opts({ agentCmd: '/explicit/omp' }), 'omp')).toBe('/explicit/omp');
  });

  it('an explicit per-call backend selects its compatible binary above ambient AGENT_CMD', () => {
    process.env.AGENT_CMD = 'claude -p';
    expect(resolveAgentBin(opts({ backend: 'codex' }), 'codex')).toBe('codex');
    expect(resolveAgentBin(opts({ backend: 'omp' }), 'omp')).toBe('omp');

    process.env.AGENT_CMD = 'codex exec';
    expect(resolveAgentBin(opts({ backend: 'claude-code' }), 'claude-code')).toBe('claude');
  });

  it('opts.agentCmd still permits a deliberate non-default binary for an explicit backend', () => {
    process.env.AGENT_CMD = 'claude -p';
    expect(
      resolveAgentBin(opts({ backend: 'codex', agentCmd: '/opt/wrapped-codex' }), 'codex'),
    ).toBe('/opt/wrapped-codex');
  });

  it('AGENT_CMD env wins over the legacy CLAUDE_CMD', () => {
    process.env.AGENT_CMD = '/new/agent';
    process.env.CLAUDE_CMD = '/legacy/claude';
    expect(resolveAgentBin(opts(), 'claude-code')).toBe('/new/agent');
  });

  it('falls back to the legacy CLAUDE_CMD when AGENT_CMD is unset', () => {
    process.env.CLAUDE_CMD = '/legacy/claude';
    expect(resolveAgentBin(opts(), 'claude-code')).toBe('/legacy/claude');
  });

  it('ignores a blank/whitespace env value and uses the backend default', () => {
    process.env.AGENT_CMD = '   ';
    expect(resolveAgentBin(opts(), 'omp')).toBe('omp');
  });

  it('defaults the binary to the resolved backend', () => {
    expect(resolveAgentBin(opts(), 'omp')).toBe('omp');
    expect(resolveAgentBin(opts(), 'codex')).toBe('codex');
    expect(resolveAgentBin(opts(), 'claude-code')).toBe('claude');
    // anthropic-direct has no subprocess of its own → default claude binary
    expect(resolveAgentBin(opts(), 'anthropic-direct')).toBe('claude');
  });
});

// EI-281: the stateless-transport selection seam. The box-level failure was an
// EXPIRED omp token (auth.json `expires` long past) winning over a fresh Claude
// OAuth session, then 8 doomed round-trips to a dead 127.0.0.1:3456.
describe('tokenIsLive (EI-281)', () => {
  const NOW = 1_781_145_000_000;

  it('no recorded expiry → live (some auth files omit it)', () => {
    expect(tokenIsLive(undefined, NOW)).toBe(true);
    expect(tokenIsLive(null, NOW)).toBe(true);
  });

  it('an expired token is dead', () => {
    expect(tokenIsLive(NOW - 1, NOW)).toBe(false);
    // the real EI-281 shape: omp token expired 2026-04-12, now 2026-06-11
    expect(tokenIsLive(1_775_896_076_789, NOW)).toBe(false);
  });

  it('a token inside the 60s skew window is treated as already dead', () => {
    expect(tokenIsLive(NOW + 30_000, NOW)).toBe(false);
    expect(tokenIsLive(NOW + 61_000, NOW)).toBe(true);
  });
});

describe('chooseStatelessTransport (EI-281 / EI-399 / EI-12940)', () => {
  it('a live Claude session resolves anthropic-direct — the preferred transport', () => {
    expect(chooseStatelessTransport({ claudeTok: 'c' })).toBe('anthropic-direct');
  });

  it('no usable credential → gateway-pool delegation, never a hard failure (EI-12940)', () => {
    expect(chooseStatelessTransport({ claudeTok: null })).toBe('gateway-pool');
  });

  // default-deploy-account-2026-08-08 P-008 / D-004.
  describe('a nominated DEFAULT account overrides the local ~/.claude session', () => {
    it('routes via gateway-pool EVEN WITH a live local token — the whole point of the default', () => {
      // This is the case the feature exists for. Judges, sim-users, summarisers and memory
      // session-extraction all run where a local token is present, so if a live token still
      // won here, "set a default account" would silently mean "…except for most in-process
      // traffic" — which is exactly the split the owner asked to remove.
      expect(chooseStatelessTransport({ claudeTok: 'c', defaultAccountSet: true })).toBe('gateway-pool');
    });

    it('with NO default set, a live token still wins — behaviour is unchanged by this feature', () => {
      expect(chooseStatelessTransport({ claudeTok: 'c', defaultAccountSet: false })).toBe('anthropic-direct');
    });

    it('reads the env marker when the caller does not pass the flag', () => {
      const prev = process.env[DEFAULT_ACCOUNT_ACTIVE_ENV];
      try {
        process.env[DEFAULT_ACCOUNT_ACTIVE_ENV] = '1';
        expect(defaultAccountActive()).toBe(true);
        expect(chooseStatelessTransport({ claudeTok: 'c' })).toBe('gateway-pool');
        // Fresh read per call, never cached — clearing the default must take effect at once
        // rather than at the next process restart.
        delete process.env[DEFAULT_ACCOUNT_ACTIVE_ENV];
        expect(defaultAccountActive()).toBe(false);
        expect(chooseStatelessTransport({ claudeTok: 'c' })).toBe('anthropic-direct');
      } finally {
        if (prev === undefined) delete process.env[DEFAULT_ACCOUNT_ACTIVE_ENV];
        else process.env[DEFAULT_ACCOUNT_ACTIVE_ENV] = prev;
      }
    });

    it('an explicit flag beats the env marker in BOTH directions (so tests + callers can pin it)', () => {
      const prev = process.env[DEFAULT_ACCOUNT_ACTIVE_ENV];
      try {
        process.env[DEFAULT_ACCOUNT_ACTIVE_ENV] = '1';
        expect(chooseStatelessTransport({ claudeTok: 'c', defaultAccountSet: false })).toBe('anthropic-direct');
        delete process.env[DEFAULT_ACCOUNT_ACTIVE_ENV];
        expect(chooseStatelessTransport({ claudeTok: 'c', defaultAccountSet: true })).toBe('gateway-pool');
      } finally {
        if (prev === undefined) delete process.env[DEFAULT_ACCOUNT_ACTIVE_ENV];
        else process.env[DEFAULT_ACCOUNT_ACTIVE_ENV] = prev;
      }
    });

    it('only 1/true arm it — a stray empty or "0" value must not reroute every in-process call', () => {
      const prev = process.env[DEFAULT_ACCOUNT_ACTIVE_ENV];
      try {
        for (const v of ['', '0', 'false', 'no']) {
          process.env[DEFAULT_ACCOUNT_ACTIVE_ENV] = v;
          expect(defaultAccountActive()).toBe(false);
        }
        for (const v of ['1', 'true', ' true ']) {
          process.env[DEFAULT_ACCOUNT_ACTIVE_ENV] = v;
          expect(defaultAccountActive()).toBe(true);
        }
      } finally {
        if (prev === undefined) delete process.env[DEFAULT_ACCOUNT_ACTIVE_ENV];
        else process.env[DEFAULT_ACCOUNT_ACTIVE_ENV] = prev;
      }
    });
  });

  it('probe with no credentials file resolves gateway-pool (the 2026-07-16 5h-outage class: a stale local token must not be a SPOF)', () => {
    const home = mkdtempSync(join(tmpdir(), 'papercusp-no-claude-home-'));
    try {
      process.env.HOME = home;
      invalidateClaudeTokenCache();

      const probed = probeStatelessTransport();
      expect(probed.ok).toBe(true);
      if (probed.ok) expect(probed.label).toBe('gateway-pool');
    } finally {
      rmSync(home, { recursive: true, force: true });
      invalidateClaudeTokenCache();
    }
  });
});

// EI-12940: where a DELEGATED (no-local-token) call egresses. The placeholder
// bearer (GATEWAY_DELEGATED_AUTH_TOKEN) is only ever allowed to go to a
// loopback host — the local pacing gateway, which strips it and re-auths from
// its account pool.
describe('resolveDelegatedGatewayUrl (EI-12940)', () => {
  const URL_KEYS = ['PAPERCUSP_ANTHROPIC_URL', 'ANTHROPIC_BASE_URL', 'PAPERCUSP_GATEWAY_PORT'] as const;
  const savedUrls: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of URL_KEYS) {
      savedUrls[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of URL_KEYS) {
      if (savedUrls[k] === undefined) delete process.env[k];
      else process.env[k] = savedUrls[k];
    }
  });

  it('defaults to the well-known local gateway when no env is configured (the bg-host case)', () => {
    expect(resolveDelegatedGatewayUrl()).toBe('http://127.0.0.1:8788');
  });

  it('honors PAPERCUSP_GATEWAY_PORT for the default', () => {
    process.env.PAPERCUSP_GATEWAY_PORT = '9917';
    expect(resolveDelegatedGatewayUrl()).toBe('http://127.0.0.1:9917');
  });

  it('uses a configured loopback base URL (it IS the gateway)', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:8788';
    expect(resolveDelegatedGatewayUrl()).toBe('http://127.0.0.1:8788');
    process.env.PAPERCUSP_ANTHROPIC_URL = 'http://localhost:9021';
    expect(resolveDelegatedGatewayUrl()).toBe('http://localhost:9021');
  });

  it('NEVER delegates to a non-loopback URL — the placeholder bearer must not egress to a real API host', () => {
    process.env.PAPERCUSP_ANTHROPIC_URL = 'https://api.anthropic.com';
    expect(resolveDelegatedGatewayUrl()).toBe('http://127.0.0.1:8788');
  });

  it('the delegated bearer is the gateway client placeholder, not a credential', () => {
    expect(GATEWAY_DELEGATED_AUTH_TOKEN).toBe('papercusp-gateway');
  });
});

// EI-456: in-process anthropic-direct calls must route through the inference
// gateway (which exports ANTHROPIC_BASE_URL) just like spawned `claude -p` bees.
describe('resolveAnthropicBaseUrl (EI-456)', () => {
  const URL_KEYS = ['PAPERCUSP_ANTHROPIC_URL', 'ANTHROPIC_BASE_URL'] as const;
  const savedUrls: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of URL_KEYS) {
      savedUrls[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of URL_KEYS) {
      if (savedUrls[k] === undefined) delete process.env[k];
      else process.env[k] = savedUrls[k];
    }
  });

  it('defaults to api.anthropic.com when neither var is set (behavior unchanged)', () => {
    expect(resolveAnthropicBaseUrl()).toBe('https://api.anthropic.com');
  });

  it('falls back to ANTHROPIC_BASE_URL — the gateway-set var — for in-process calls', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:8788';
    expect(resolveAnthropicBaseUrl()).toBe('http://127.0.0.1:8788');
  });

  it('PAPERCUSP_ANTHROPIC_URL takes precedence over ANTHROPIC_BASE_URL', () => {
    process.env.PAPERCUSP_ANTHROPIC_URL = 'http://override:9999';
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:8788';
    expect(resolveAnthropicBaseUrl()).toBe('http://override:9999');
  });
});

describe('isConnectionFailure (EI-281)', () => {
  it("matches the SDK's masked APIConnectionError and raw syscall failures", () => {
    expect(isConnectionFailure(new Error('Connection error.'))).toBe(true);
    expect(isConnectionFailure(new Error('connect ECONNREFUSED 127.0.0.1:3456'))).toBe(true);
    expect(isConnectionFailure(new Error('fetch failed'))).toBe(true);
  });

  it('does not match HTTP-level errors (those are retry/transient territory)', () => {
    expect(isConnectionFailure(new Error('529 {"type":"overloaded_error"}'))).toBe(false);
    expect(isConnectionFailure(new Error('401 unauthorized'))).toBe(false);
    expect(isConnectionFailure(new Error('rate limited'))).toBe(false);
  });
});

// autonomous-loop-hardening B4/F5 — a single-account PIN on the in-process anthropic-direct
// path has no 429 failover. The pin is honored (value unchanged) but made LOUD (a one-shot
// warn) so the footgun that silently gated the scout circuit can't recur silently.
describe('resolveRouteAccountId (B4/F5 hard-pin footgun guard)', () => {
  const KEY = 'PAPERCUSP_ROUTE_ACCOUNT';
  let savedPin: string | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    savedPin = process.env[KEY];
    delete process.env[KEY];
    // The suite runs vitest-fail-on-console; the guard's one-shot warn is expected here.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    if (savedPin === undefined) delete process.env[KEY];
    else process.env[KEY] = savedPin;
  });

  it('returns the trimmed pin when set, undefined when unset/blank', () => {
    expect(resolveRouteAccountId()).toBeUndefined();
    process.env[KEY] = '  aviynw6  ';
    expect(resolveRouteAccountId()).toBe('aviynw6');
    process.env[KEY] = '   ';
    expect(resolveRouteAccountId()).toBeUndefined();
  });

  it('warns exactly ONCE per process when a pin is set (loud, not spammy)', async () => {
    // Fresh module instance so the one-shot warn flag starts un-fired.
    vi.resetModules();
    const mod = await import('./chat-stream');
    process.env[KEY] = 'aviynw6';
    expect(mod.resolveRouteAccountId()).toBe('aviynw6');
    expect(mod.resolveRouteAccountId()).toBe('aviynw6'); // 2nd call
    const pinWarns = warnSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('PAPERCUSP_ROUTE_ACCOUNT'));
    expect(pinWarns.length).toBe(1); // one-shot, both calls returned the value
  });

  it('does NOT warn when no pin is set', async () => {
    vi.resetModules();
    const mod = await import('./chat-stream');
    expect(mod.resolveRouteAccountId()).toBeUndefined();
    const pinWarns = warnSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('PAPERCUSP_ROUTE_ACCOUNT'));
    expect(pinWarns.length).toBe(0);
  });
});

describe('isAuthFailure (EI-281 rotated-token retry)', () => {
  it('matches the SDK status property', () => {
    const e = Object.assign(new Error('boom'), { status: 401 });
    expect(isAuthFailure(e)).toBe(true);
    expect(isAuthFailure(Object.assign(new Error('boom'), { status: 403 }))).toBe(true);
    expect(isAuthFailure(Object.assign(new Error('boom'), { status: 429 }))).toBe(false);
  });

  it('matches the SDK `<status> <body>` message form and Anthropic error types', () => {
    expect(isAuthFailure(new Error('401 {"type":"error","error":{"type":"authentication_error"}}'))).toBe(true);
    expect(isAuthFailure(new Error('403 forbidden'))).toBe(true);
    expect(isAuthFailure(new Error('permission_error: oauth token revoked'))).toBe(true);
  });

  it('does not match transient/connection errors', () => {
    expect(isAuthFailure(new Error('529 {"type":"overloaded_error"}'))).toBe(false);
    expect(isAuthFailure(new Error('Connection error.'))).toBe(false);
    expect(isAuthFailure(new Error('rate limited'))).toBe(false);
    // 4013-shaped ids must not false-positive the `<status> ` prefix match.
    expect(isAuthFailure(new Error('40134 bad id'))).toBe(false);
  });
});

describe('withAgentBinDirs (EI-11519 stripped-PATH spawn fix)', () => {
  it('appends well-known per-user bin dirs that exist but are missing from PATH', () => {
    const home = mkdtempSync(join(tmpdir(), 'wabd-'));
    try {
      // Simulate the claude native-installer layout under a fake HOME.
      const localBin = join(home, '.local', 'bin');
      mkdirSync(localBin, { recursive: true });
      const env = { HOME: home, PATH: '/usr/bin:/bin' };
      const out = withAgentBinDirs(env);
      const parts = (out.PATH ?? '').split(delimiter);
      expect(parts[0]).toBe('/usr/bin'); // existing entries win (append, never prepend)
      expect(parts).toContain(localBin);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns the env unchanged when every existing well-known dir is already on PATH', () => {
    const home = mkdtempSync(join(tmpdir(), 'wabd-'));
    try {
      const localBin = join(home, '.local', 'bin');
      mkdirSync(localBin, { recursive: true });
      // PATH already carries the only well-known dir that exists under this HOME
      // (the real linuxbrew dir may exist on the host, so include it too).
      const env = { HOME: home, PATH: `/usr/bin:${localBin}:/home/linuxbrew/.linuxbrew/bin` };
      const out = withAgentBinDirs(env);
      expect(out).toBe(env); // identity — no copy, no mutation
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not append well-known dirs that do not exist on disk', () => {
    const home = mkdtempSync(join(tmpdir(), 'wabd-'));
    try {
      // No ~/.local/bin created under this HOME.
      const env = { HOME: home, PATH: '/usr/bin:/home/linuxbrew/.linuxbrew/bin' };
      const out = withAgentBinDirs(env);
      expect(out.PATH).not.toContain(join(home, '.local', 'bin'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
