/**
 * chat-stream-resolve.test.ts — the backend/binary resolution seam of
 * chat-stream. `resolveBackend` + `resolveAgentBin` are pure precedence
 * functions exported so non-runAgentChat callers resolve identically; they read
 * process.env (AGENT_BACKEND / AGENT_CMD / CLAUDE_CMD), so each test owns a
 * clean env slice. (The runAgentChat generator itself is a subprocess/SSE
 * integration surface and is out of scope for this unit lane.)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveBackend,
  resolveAgentBin,
  tokenIsLive,
  chooseStatelessTransport,
  resolveAnthropicBaseUrl,
  isConnectionFailure,
  isAuthFailure,
  type AgentBackend,
  type RunAgentChatOptions,
} from './chat-stream';

const ENV_KEYS = ['AGENT_BACKEND', 'AGENT_CMD', 'CLAUDE_CMD'] as const;
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

  it('AGENT_BACKEND env beats an inferable agentCmd', () => {
    process.env.AGENT_BACKEND = 'anthropic-direct';
    expect(resolveBackend(opts({ agentCmd: 'claude' }))).toBe('anthropic-direct');
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

describe('chooseStatelessTransport (EI-281 / EI-399)', () => {
  it('a live Claude session resolves anthropic-direct — the named default and only transport', () => {
    expect(chooseStatelessTransport({ claudeTok: 'c' })).toBe('anthropic-direct');
  });

  it('no usable credential → null', () => {
    expect(chooseStatelessTransport({ claudeTok: null })).toBeNull();
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
