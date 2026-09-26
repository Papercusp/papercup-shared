import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_IDENTITY_SPEC_ENV,
  AgentIdentityTtyRefusedError,
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
});
