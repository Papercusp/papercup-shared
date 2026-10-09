import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_IDENTITY_SPEC_ENV,
  AgentIdentityTtyRefusedError,
  CLAUDE_PROJECT_LAUNCH_FLAGS,
  parseAgentIdentitySpec,
  planAgentIdentityTty,
  stageAgentIdentityTty,
  type AgentIdentitySpec,
  type AgentIdentityTtyRequest,
} from './loopback-identity-tty.mjs';

// The "agent CLI" in the toolchain: reports what it can see (argv, cwd, env, the shipped
// prompt file) so the test asserts on identity-relevant facts, and exits with --exit=<n>.
const PROBE = `
const fs = require('fs');
const args = process.argv.slice(2);
const promptIdx = args.indexOf('--system-prompt-file');
const exitArg = args.find((a) => a.startsWith('--exit='));
process.stdout.write(JSON.stringify({
  args,
  cwd: process.cwd(),
  home: process.env.HOME,
  path: process.env.PATH,
  term: process.env.TERM,
  claudeCodeFlag: process.env.CLAUDE_CODE_FLAG ?? null,
  oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
  sid: process.env.PAPERCUSP_SID ?? null,
  db: process.env.DATABASE_URL ?? null,
  prompt: promptIdx >= 0 ? fs.readFileSync(args[promptIdx + 1], 'utf8') : null,
}));
process.exit(exitArg ? Number(exitArg.slice(7)) : 0);
`;

const SUPERUSER_TOKEN = 'su-token-0123456789abcdef-must-not-cross';

let root: string;
let spec: AgentIdentitySpec;
let promptFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'identity-tty-'));
  const bin = join(root, 'toolchain', 'bin');
  const localState = join(root, 'local', '.papercusp');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(localState, 'launch-context'), { recursive: true });
  mkdirSync(join(root, 'customer'), { recursive: true });
  writeFileSync(join(root, 'probe.js'), PROBE);
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec '${process.execPath}' '${join(root, 'probe.js')}' "$@"\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  writeFileSync(join(localState, 'superuser-token'), `${SUPERUSER_TOKEN}\n`);
  promptFile = join(localState, 'launch-context', 'session-1.md');
  writeFileSync(promptFile, '# rendered su playbook\n');
  spec = {
    v: 1,
    identity: 'customer@127.0.0.1',
    // `/bin/sh -c <remote command>` stands in for `ssh … <remote command>`.
    stageTransport: { command: '/bin/sh', args: ['-c'] },
    execTransport: { command: '/bin/sh', args: ['-c'] },
    nodePath: process.execPath,
    toolchainBin: bin,
    remoteHome: join(root, 'customer'),
    spawnRoot: join(root, 'customer', '.papercusp', 'agent-spawns'),
    remotePath: [bin, '/usr/bin', '/bin'],
    localHome: join(root, 'local'),
    shipFileRoots: [localState],
    envAllowPrefixes: ['CLAUDE_CODE_'],
    forbiddenSecretFiles: [join(localState, 'superuser-token')],
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function request(overrides: Partial<AgentIdentityTtyRequest> = {}): AgentIdentityTtyRequest {
  return {
    command: 'claude',
    args: ['--dangerously-skip-permissions', '--system-prompt-file', promptFile, '--session-id', 'abc'],
    env: {
      TERM: 'xterm-256color',
      CLAUDE_CODE_FLAG: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'operator-oauth-token-value',
      PAPERCUSP_SID: 'su-operator-session',
      DATABASE_URL: 'postgres://operator/secret',
      PATH: '/opt/papercusp/current/bin:/usr/bin',
    },
    cwd: '/var/lib/papercusp/workspace',
    ...overrides,
  };
}

function refusalCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentIdentityTtyRefusedError);
    return (error as AgentIdentityTtyRefusedError).code;
  }
  return undefined;
}

describe('loopback identity TTY stage + exec (D-424)', () => {
  it('names the env var psu reads the spec from', () => {
    expect(AGENT_IDENTITY_SPEC_ENV).toBe('PAPERCUSP_AGENT_IDENTITY_SPEC');
  });

  // WI-10005296 (D-031): fixedEnv is operator-set env every agent gets (heavy-job admission).
  it('validates fixedEnv: strings under env names, never HOME/PATH or a credential-shaped name', () => {
    expect(parseAgentIdentitySpec({ ...spec, fixedEnv: { NODE_OPTIONS: '--require=/t/h.cjs' } }).fixedEnv).toEqual({ NODE_OPTIONS: '--require=/t/h.cjs' });
    // Deliberately ill-typed inputs: the parser must refuse what the type system would also refuse.
    const bads: unknown[] = [{ PATH: '/x' }, { HOME: '/x' }, { GITHUB_TOKEN: 'x' }, { 'BAD-NAME': 'x' }, { N: 1 }, ['x']];
    for (const bad of bads) {
      expect(() => parseAgentIdentitySpec({ ...spec, fixedEnv: bad as Readonly<Record<string, string>> })).toThrow(/fixedEnv/);
    }
  });

  it('stages then runs the toolchain agent as the target: shipped prompt, own HOME/PATH/cwd, allowlisted env only', () => {
    const exec = stageAgentIdentityTty(JSON.stringify(spec), request({ args: [...request().args, '--exit=3'] }));
    // The exec header was written 0600 by the stage hop, beneath the target's spawn root.
    expect(exec.execHeaderPath.startsWith(spec.spawnRoot)).toBe(true);
    expect(statSync(exec.execHeaderPath).mode & 0o777).toBe(0o600);

    const run = spawnSync(exec.command, exec.args, { env: exec.env, encoding: 'utf8' });
    expect(run.status).toBe(3);
    const seen = JSON.parse(run.stdout);
    const shippedPrompt = seen.args[seen.args.indexOf('--system-prompt-file') + 1] as string;
    expect(shippedPrompt).not.toBe(promptFile);
    expect(shippedPrompt.startsWith(spec.spawnRoot)).toBe(true);
    expect(seen.prompt).toBe('# rendered su playbook\n');
    expect(seen.args).toContain('--session-id');
    expect(seen.home).toBe(spec.remoteHome);
    expect(seen.cwd).toBe(spec.remoteHome);
    expect(seen.path).toBe(spec.remotePath.join(':'));
    expect(seen.term).toBe('xterm-256color');
    expect(seen.claudeCodeFlag).toBe('1');
    // A credential-shaped name never crosses even under an allowed prefix; unlisted names never cross.
    expect(seen.oauth).toBeNull();
    expect(seen.sid).toBeNull();
    expect(seen.db).toBeNull();
    // The header is consumed and the per-spawn dir is removed when the agent exits.
    expect(existsSync(exec.execHeaderPath)).toBe(false);
    expect(existsSync(join(exec.execHeaderPath, '..'))).toBe(false);
  });

  it('keeps the transport env minimal: the operator environment never rides the transport', () => {
    const plan = planAgentIdentityTty(spec, request());
    expect(plan.exec.env).toEqual({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: spec.localHome, TERM: 'xterm-256color' });
    expect(plan.stage.env).toEqual(plan.exec.env);
    expect(plan.exec.args.slice(0, -1)).toEqual(spec.execTransport.args);
  });

  it('ships only files under shipFileRoots; other absolute args pass through verbatim', () => {
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'not shipped');
    const plan = planAgentIdentityTty(spec, request({ args: ['--system-prompt-file', promptFile, '--add-dir', outside] }));
    const header = JSON.parse(plan.stage.input.toString('utf8').replace(/^[0-9]+\n/, ''));
    expect(header.files).toHaveLength(1);
    expect(header.argv).toContain(outside);
    expect(header.argv).not.toContain(promptFile);
  });

  it('refuses a non-agent command by name', () => {
    expect(refusalCode(() => planAgentIdentityTty(spec, request({ command: '/bin/bash' })))).toBe('agent_backend_unsupported');
  });

  it('refuses by name when the toolchain lacks the agent', () => {
    expect(refusalCode(() => planAgentIdentityTty(spec, request({ command: 'codex' })))).toBe('agent_toolchain_missing');
  });

  it('refuses when the operator secret would cross in argv or in a shipped file', () => {
    expect(refusalCode(() => planAgentIdentityTty(spec, request({ args: ['--token', SUPERUSER_TOKEN] })))).toBe(
      'agent_spawn_forbidden_secret',
    );
    writeFileSync(promptFile, `leaked ${SUPERUSER_TOKEN}`);
    expect(refusalCode(() => planAgentIdentityTty(spec, request()))).toBe('agent_spawn_forbidden_secret');
  });

  it('refuses an invalid spec by name', () => {
    expect(refusalCode(() => planAgentIdentityTty('{not json', request()))).toBe('agent_identity_spec_invalid');
    expect(refusalCode(() => planAgentIdentityTty({ ...spec, v: 2 } as unknown as AgentIdentitySpec, request()))).toBe(
      'agent_identity_spec_invalid',
    );
    expect(refusalCode(() => planAgentIdentityTty({ ...spec, remotePath: [] }, request()))).toBe(
      'agent_identity_spec_invalid',
    );
  });

  it('surfaces a failed stage hop as a named refusal with its exit status', () => {
    const failing = { ...spec, stageTransport: { command: '/bin/sh', args: ['-c', 'echo denied >&2; exit 7'] } };
    let caught: AgentIdentityTtyRefusedError | undefined;
    try {
      stageAgentIdentityTty(failing, request());
    } catch (error) {
      caught = error as AgentIdentityTtyRefusedError;
    }
    expect(caught?.code).toBe('agent_identity_stage_failed');
    expect(caught?.message).toContain('exited 7');
    expect(caught?.message).toContain('denied');
    expect(readFileSync(promptFile, 'utf8')).toBe('# rendered su playbook\n');
  });

  it('preserves the transport stderr tail when the stage hop reports a spawn error', () => {
    const spawnError = Object.assign(new Error('stage transport timed out'), { code: 'ETIMEDOUT' });
    const run = vi.fn(() => ({
      error: spawnError,
      status: null,
      signal: 'SIGTERM',
      stdout: Buffer.alloc(0),
      stderr: Buffer.from('earlier diagnostic\ntransport refused the stage header\n'),
    }));
    let caught: AgentIdentityTtyRefusedError | undefined;
    try {
      stageAgentIdentityTty(spec, request(), { spawnSync: run });
    } catch (error) {
      caught = error as AgentIdentityTtyRefusedError;
    }
    expect(caught?.code).toBe('agent_identity_stage_failed');
    expect(caught?.message).toContain('stage transport timed out');
    expect(caught?.message).toContain('transport refused the stage header');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

// P-326: psu launches claude INTERACTIVELY; on a hosted host the TUI reads the TARGET account's
// config, so the stage hop must pre-accept the prompts nobody is there to answer.
describe('claude pre-turn launch readiness on the target account (P-326)', () => {
  const customerJson = () => join(spec.remoteHome, '.claude.json');
  const customerSettings = () => join(spec.remoteHome, '.claude', 'settings.json');
  const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

  it('asserts onboarding, cwd trust and the bypass-accept skip while preserving every other key', () => {
    mkdirSync(join(spec.remoteHome, '.claude'), { recursive: true });
    writeFileSync(
      customerJson(),
      JSON.stringify({
        userID: 'customer-user',
        projects: {
          '/elsewhere': { allowedTools: ['Read'] },
          [spec.remoteHome]: { mcpServers: { own: { command: 'x' } }, hasTrustDialogAccepted: false },
        },
      }),
    );
    writeFileSync(customerSettings(), JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash'] } }));
    writeFileSync(join(spec.remoteHome, '.claude', '.credentials.json'), 'customer-credential');

    stageAgentIdentityTty(spec, request());

    const cfg = readJson(customerJson());
    expect(cfg.hasCompletedOnboarding).toBe(true);
    expect(cfg.userID).toBe('customer-user');
    expect(cfg.projects['/elsewhere']).toEqual({ allowedTools: ['Read'] });
    expect(cfg.projects[spec.remoteHome]).toEqual({
      mcpServers: { own: { command: 'x' } },
      ...Object.fromEntries(CLAUDE_PROJECT_LAUNCH_FLAGS.map((flag) => [flag, true])),
    });
    expect(readJson(customerSettings())).toEqual({
      theme: 'dark',
      permissions: { allow: ['Bash'] },
      skipDangerousModePermissionPrompt: true,
    });
    // The account's own credential is never read, moved or rewritten.
    expect(readFileSync(join(spec.remoteHome, '.claude', '.credentials.json'), 'utf8')).toBe('customer-credential');
    expect(statSync(customerJson()).mode & 0o777).toBe(0o600);
  });

  it('creates the state for an account that has never run claude', () => {
    stageAgentIdentityTty(spec, request());
    const cfg = readJson(customerJson());
    expect(cfg.hasCompletedOnboarding).toBe(true);
    for (const flag of CLAUDE_PROJECT_LAUNCH_FLAGS) expect(cfg.projects[spec.remoteHome][flag]).toBe(true);
    expect(readJson(customerSettings())).toEqual({ skipDangerousModePermissionPrompt: true });
    expect(statSync(customerSettings()).mode & 0o777).toBe(0o600);
  });

  it('pre-trusts the launch cwd, not the home, when the spec pins remoteCwd', () => {
    const work = join(spec.remoteHome, 'work');
    mkdirSync(work, { recursive: true });
    stageAgentIdentityTty({ ...spec, remoteCwd: work }, request());
    const projects = readJson(customerJson()).projects;
    expect(Object.keys(projects)).toEqual([work]);
  });

  it('does not rewrite a target that is already launch-ready', () => {
    stageAgentIdentityTty(spec, request());
    const before = { json: statSync(customerJson()).ino, settings: statSync(customerSettings()).ino };
    stageAgentIdentityTty(spec, request());
    // A rewrite is temp + rename, which always lands a new inode.
    expect(statSync(customerJson()).ino).toBe(before.json);
    expect(statSync(customerSettings()).ino).toBe(before.settings);
  });

  it('leaves an unparseable config untouched and still stages the agent', () => {
    writeFileSync(customerJson(), '{not json');
    const exec = stageAgentIdentityTty(spec, request());
    expect(readFileSync(customerJson(), 'utf8')).toBe('{not json');
    expect(existsSync(exec.execHeaderPath)).toBe(true);
  });

  it('follows CLAUDE_CONFIG_DIR when the spec lets it cross', () => {
    const configDir = join(spec.remoteHome, 'cfg');
    stageAgentIdentityTty(
      { ...spec, envAllow: ['CLAUDE_CONFIG_DIR'] },
      request({ env: { ...request().env, CLAUDE_CONFIG_DIR: configDir } }),
    );
    expect(readJson(join(configDir, '.claude.json')).hasCompletedOnboarding).toBe(true);
    expect(readJson(join(configDir, 'settings.json')).skipDangerousModePermissionPrompt).toBe(true);
    expect(existsSync(customerJson())).toBe(false);
  });

  it('touches no claude state when the agent is not claude', () => {
    const omp = join(spec.toolchainBin, 'omp');
    writeFileSync(omp, `#!/bin/sh\nexec '${process.execPath}' '${join(root, 'probe.js')}' "$@"\n`);
    chmodSync(omp, 0o755);
    stageAgentIdentityTty(spec, request({ command: 'omp', args: [] }));
    expect(existsSync(customerJson())).toBe(false);
    expect(existsSync(customerSettings())).toBe(false);
  });
});
