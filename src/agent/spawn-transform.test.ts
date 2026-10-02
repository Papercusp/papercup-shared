import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentSpawnRefusedError,
  buildLoopbackIdentitySpawn,
  configureAgentSpawnTransform,
  planAgentSpawn,
  type AgentSpawnPlan,
  type AgentSpawnRequest,
  type LoopbackIdentitySpawnOptions,
} from './spawn-transform';

// The "agent" the wrapper launches: reports what it can see so the test can
// assert on identity-relevant facts (cwd, env, staged files, stdin).
const PROBE_AGENT = `
const fs = require('fs');
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  const codexHome = process.env.CODEX_HOME;
  const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
  process.stdout.write(JSON.stringify({
    cwd: process.cwd(),
    home: process.env.HOME,
    path: process.env.PATH,
    codexHome,
    lang: process.env.LANG,
    operatorSecret: process.env.OPERATOR_DB_URL ?? null,
    agentsMd: read(codexHome + '/AGENTS.md'),
    auth: read(codexHome + '/auth.json'),
    stdin,
  }));
  process.exit(Number(process.env.PROBE_EXIT ?? '0'));
});
`;

let root: string;
let operatorHome: string;
let remoteHome: string;
let stagedCodexHome: string;

function options(overrides: Partial<LoopbackIdentitySpawnOptions> = {}): LoopbackIdentitySpawnOptions {
  return {
    // Stand-in for `ssh … -l <user> 127.0.0.1`: runs the remote command in a shell as the same user.
    transportCommand: '/bin/bash',
    transportArgs: ['-c'],
    identity: 'test-customer@local',
    nodePath: process.execPath,
    remoteHome,
    spawnRoot: join(remoteHome, '.papercusp', 'agent-spawns'),
    localHome: operatorHome,
    baseEnv: { OPERATOR_DB_URL: 'postgres://operator-secret', LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' },
    passthroughEnv: ['LANG'],
    homeLinks: [{ envVar: 'CODEX_HOME', name: 'auth.json', homeRelative: '.codex/auth.json' }],
    newId: () => 'spawn-1',
    ...overrides,
  };
}

function request(overrides: Partial<AgentSpawnRequest> = {}): AgentSpawnRequest {
  return {
    backend: 'codex',
    command: process.execPath,
    args: ['-e', PROBE_AGENT],
    cwd: stagedCodexHome,
    env: {
      OPERATOR_DB_URL: 'postgres://operator-secret',
      LANG: 'C.UTF-8',
      PATH: `${operatorHome}/.local/bin:/usr/bin:/bin`,
      CODEX_HOME: stagedCodexHome,
    },
    stagedDirs: [{ path: stagedCodexHome, persistent: false }],
    ...overrides,
  };
}

async function run(plan: AgentSpawnPlan, stdin: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(plan.command, [...plan.args], { cwd: plan.cwd, env: plan.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (plan.stdinPrelude) child.stdin.write(plan.stdinPrelude);
    child.stdin.end(stdin);
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'spawn-transform-'));
  operatorHome = join(root, 'operator-home');
  remoteHome = join(root, 'customer-home');
  stagedCodexHome = join(root, 'tmp', 'codex-chat-abc123');
  mkdirSync(operatorHome, { recursive: true });
  mkdirSync(join(remoteHome, '.codex'), { recursive: true });
  mkdirSync(stagedCodexHome, { recursive: true });
  writeFileSync(join(stagedCodexHome, 'AGENTS.md'), 'You are the papercup brain.');
  writeFileSync(join(stagedCodexHome, 'config.toml'), '[mcp_servers.agentmcp]\nurl = "http://127.0.0.1:3880/api/mcp"\n');
  writeFileSync(join(remoteHome, '.codex', 'auth.json'), '{"customer":"credential"}');
});

afterEach(() => {
  configureAgentSpawnTransform(undefined);
  rmSync(root, { recursive: true, force: true });
});

describe('planAgentSpawn', () => {
  it('returns the staged spawn unchanged when no transform is configured', () => {
    const req = request();
    const plan = planAgentSpawn(req);
    expect(plan).toEqual({ command: req.command, args: [...req.args], cwd: req.cwd, env: req.env });
    expect(plan.stdinPrelude).toBeUndefined();
  });

  it('routes every spawn through the configured transform', () => {
    configureAgentSpawnTransform(buildLoopbackIdentitySpawn(options()));
    const plan = planAgentSpawn(request());
    expect(plan.command).toBe('/bin/bash');
    expect(plan.identity).toBe('test-customer@local');
    expect(plan.stdinPrelude).toBeInstanceOf(Buffer);
  });
});

describe('buildLoopbackIdentitySpawn — the real inline wrapper', () => {
  it('runs the agent with config materialized under the target home, the target credential linked in, and stdin passed through', async () => {
    const plan = buildLoopbackIdentitySpawn(options())(request());
    const result = await run(plan, 'hello from the customer');
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const seen = JSON.parse(result.stdout);
    const remoteCodexHome = join(remoteHome, '.papercusp', 'agent-spawns', 'spawn-1', '0-codex-chat-abc123');
    expect(seen.codexHome).toBe(remoteCodexHome);
    expect(seen.cwd).toBe(remoteCodexHome);
    expect(seen.home).toBe(remoteHome);
    expect(seen.agentsMd).toBe('You are the papercup brain.');
    expect(seen.auth).toBe('{"customer":"credential"}');
    expect(seen.stdin).toBe('hello from the customer');
    expect(seen.lang).toBe('C.UTF-8');
    // The operator's inherited environment never crosses identities.
    expect(seen.operatorSecret).toBeNull();
    expect(seen.path.split(':')).toEqual([join(remoteHome, '.local', 'bin'), '/usr/bin', '/bin']);
    // Ephemeral per-spawn dirs are removed once the agent exits.
    expect(existsSync(join(remoteHome, '.papercusp', 'agent-spawns', 'spawn-1'))).toBe(false);
  });

  it('an explicit remotePath replaces the forwarded operator PATH entirely (D-423)', async () => {
    const req = request({ env: { ...request().env, PATH: `/opt/papercusp/current/bin:${operatorHome}/.local/bin:/usr/bin:/bin` } });
    const remotePath = ['/usr/local/lib/papercusp-agent-toolchain/bin', '/usr/bin', '/bin'];
    const result = await run(buildLoopbackIdentitySpawn(options({ remotePath }))(req), '');
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).path.split(':')).toEqual(remotePath);
  });

  // WI-10005296 (D-031): fixedEnv is operator-set env; HOME/PATH stay owned by remoteHome/remotePath.
  it('refuses a fixedEnv that tries to set HOME or PATH', () => {
    for (const key of ['HOME', 'PATH']) {
      expect(() => buildLoopbackIdentitySpawn(options({ fixedEnv: { [key]: '/x' } }))(request())).toThrow(`fixedEnv may not set ${key}`);
    }
  });

  it('propagates the agent exit code so a failed turn stays a failure', async () => {
    const req = request({ env: { ...request().env, PROBE_EXIT: '3' } });
    const result = await run(buildLoopbackIdentitySpawn(options())(req), '');
    expect(result.code).toBe(3);
  });

  it('maps a caller-owned persistent dir to a stable path that survives the spawn', async () => {
    const sessionDir = join(root, 'brain-session');
    mkdirSync(sessionDir);
    writeFileSync(join(sessionDir, 'settings.json'), '{}');
    const transform = buildLoopbackIdentitySpawn(options());
    const req = request({ stagedDirs: [{ path: stagedCodexHome, persistent: false }, { path: sessionDir, persistent: true }] });
    const first = transform(req);
    const second = transform(req);
    const header = (p: AgentSpawnPlan) => JSON.parse(p.stdinPrelude!.toString('utf8').split('\n').slice(1).join('\n'));
    const persistA = header(first).dirs.find((d: string) => d.includes('/persist/'));
    expect(persistA).toBeDefined();
    expect(header(second).dirs).toContain(persistA);
    await run(first, '');
    expect(existsSync(join(persistA, 'settings.json'))).toBe(true);
  });

  it('never ships operator symlinks; the target-home link is created instead', async () => {
    const operatorAuth = join(operatorHome, '.codex', 'auth.json');
    mkdirSync(join(operatorHome, '.codex'), { recursive: true });
    writeFileSync(operatorAuth, '{"operator":"credential"}');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(operatorAuth, join(stagedCodexHome, 'auth.json'));
    const plan = buildLoopbackIdentitySpawn(options())(request());
    expect(plan.stdinPrelude!.toString('utf8')).not.toContain('operator":"credential');
    const seen = JSON.parse((await run(plan, '')).stdout);
    expect(seen.auth).toBe('{"customer":"credential"}');
    const remoteCodexHome = join(remoteHome, '.papercusp', 'agent-spawns', 'spawn-1', '0-codex-chat-abc123');
    expect(existsSync(remoteCodexHome)).toBe(false);
    void readlinkSync;
  });
});

describe('buildLoopbackIdentitySpawn — refusals', () => {
  it('refuses when a forbidden operator secret would reach the target identity in a staged file', () => {
    writeFileSync(join(stagedCodexHome, 'config.toml'), 'bearer = "superuser-token-0123456789"\n');
    const transform = buildLoopbackIdentitySpawn(options({ forbiddenSecrets: ['superuser-token-0123456789'] }));
    expect(() => transform(request())).toThrow(AgentSpawnRefusedError);
  });

  it('refuses when a forbidden secret is in a forwarded env value', () => {
    const transform = buildLoopbackIdentitySpawn(options({ forbiddenSecrets: ['superuser-token-0123456789'] }));
    const req = request({ env: { ...request().env, ANTHROPIC_AUTH_TOKEN: 'superuser-token-0123456789' } });
    expect(() => transform(req)).toThrow(/forbidden operator secret/);
  });

  it('does not treat an inherited operator env value as forwarded, so it cannot trip or leak', () => {
    const transform = buildLoopbackIdentitySpawn(options({ forbiddenSecrets: ['postgres://operator-secret'] }));
    const plan = transform(request());
    expect(plan.stdinPrelude!.toString('utf8')).not.toContain('operator-secret');
  });
});
