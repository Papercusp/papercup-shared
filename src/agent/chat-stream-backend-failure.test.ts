/**
 * WI-10003188 — a CLI backend's own failure line must reach the terminal `error` event.
 *
 * Measured 2026-09-27 on avi-test (r55): the hosted Papercup chat showed the customer
 * `operator brain produced no output (agent backend failure: codex, model gpt-5.6-luna:low:
 * codex exited 1)`. The actual cause — the customer's ChatGPT plan was out of credit
 * ("You’ve hit your usage limit … try again at Oct 3rd, 2026 5:30 PM.") — never surfaced,
 * because `codex exec --json` reports a failed turn ON STDOUT as JSONL frames with an EMPTY
 * stderr, and the adapter ignored those frames. The same frames were also invisible to the
 * turn classifier (fed stderr + assistant text), so a codex plan cap was never classified
 * `usage_limit` and the shared governor never paused.
 *
 * The frame shapes below are copied from a real run (codex-cli 0.157.1, invalid model →
 * nested provider envelope) and from the avi-test plain-text usage-limit output.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentExitErrorMessage,
  backendFailureLine,
  claudeFailureResultMessage,
  codexFailureFrameMessage,
  runAgentChat,
  type ChatEvent,
} from './chat-stream';

const USAGE_LIMIT =
  'You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 3rd, 2026 5:30 PM.';

// Real codex-cli 0.157.1 output for an unsupported model (captured 2026-09-27).
const NESTED_400 =
  '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'definitely-not-a-model-xyz\' model is not supported when using Codex with a ChatGPT account."}}';

let dir: string;

beforeEach(() => {
  // These assertions exercise the error receipt, while Codex debug runs emit
  // intentional console.error diagnostics. Isolate that inherited host setting.
  vi.stubEnv('PAPERCUSP_AGENT_DEBUG', '');
  dir = mkdtempSync(join(tmpdir(), 'wi10003188-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** A stand-in CLI that drains stdin, prints the given stdout lines, and exits with `code`. */
function fakeCli(lines: unknown[], code: number, stderr = ''): string {
  const path = join(dir, 'fake-cli.cjs');
  const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l)));
  writeFileSync(
    path,
    `#!${process.execPath}\n` +
      `process.stdin.resume();\n` +
      `process.stdin.on('end', () => {\n` +
      `  for (const l of ${JSON.stringify(body)}) process.stdout.write(l + '\\n');\n` +
      `  if (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)});\n` +
      `  process.exit(${code});\n` +
      `});\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

async function collect(opts: Parameters<typeof runAgentChat>[0]): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of runAgentChat(opts)) out.push(ev);
  return out;
}

function terminalError(events: ChatEvent[]): Extract<ChatEvent, { type: 'error' }> {
  const errs = events.filter((e): e is Extract<ChatEvent, { type: 'error' }> => e.type === 'error');
  expect(errs).toHaveLength(1);
  return errs[0]!;
}

describe('native tool-result observation', () => {
  const output = 'PUBLIC-ORCHARD-CONTROL-7391';
  const result = { content: [{ type: 'text', text: output }] };
  it.each(['claude-code', 'codex', 'omp'] as const)('captures actual %s returns and respects the tool filter', async backend => {
    const frames = backend === 'claude-code' ? [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'docs:get' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: result, is_error: true }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-2', name: 'private:read' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-2', content: 'private' }] } },
    ] : backend === 'codex' ? [
      { type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'docs:get', status: 'completed', result: { ...result, isError: true } } },
      { type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'private:read', status: 'completed', result: 'private' } },
    ] : [
      { type: 'tool_execution_end', toolName: 'docs:get', result, isError: true },
      { type: 'tool_execution_end', toolName: 'private:read', result: 'private' },
    ];
    const terminalFrame = backend === 'claude-code'
      ? { type: 'result', result: 'Done', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } }
      : backend === 'codex'
        ? { type: 'item.completed', item: { type: 'agent_message', text: 'Done' } }
        : { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } };
    const observed = vi.fn();
    await collect({ backend, agentCmd: fakeCli([...frames, terminalFrame], 0), promptText: 'Test fixture',
      toolEventFilter: name => name === 'docs:get' ? name : null, onToolResult: observed });
    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed.mock.calls[0][0]).toMatchObject({ name: 'docs:get', isError: true });
    expect(observed.mock.calls[0][0].output).toContain(output);
    expect(observed.mock.calls[0][0].output).not.toContain('private');
  });

  it('pairs streamed Claude ids with returned results without duplicate observation', async () => {
    const observed = vi.fn();
    await collect({ backend: 'claude-code', agentCmd: fakeCli([
      { type: 'stream_event', event: { type: 'content_block_start', index: 0,
        content_block: { type: 'tool_use', id: 'call-1', name: 'docs:get' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: output }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: output }] } },
      { type: 'result', result: 'Done', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } },
    ], 0), promptText: 'Test fixture', onToolResult: observed });
    expect(observed).toHaveBeenCalledExactlyOnceWith({ name: 'docs:get', output, isError: false, callId: 'call-1' });
  });

  it.each(['claude-code', 'codex', 'omp'] as const)('pairs repeated %s calls by native ID rather than tool name', async backend => {
    const frames = ['call-1', 'call-2'].flatMap((id, index) => backend === 'claude-code' ? [
      { type: 'stream_event', event: { type: 'content_block_start', index,
        content_block: { type: 'tool_use', id, name: 'docs:get' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: id }] } },
    ] : backend === 'codex' ? [
      { type: 'item.completed', item: { id, type: 'mcp_tool_call', tool: 'docs:get', status: 'completed', result: id } },
    ] : [
      { type: 'tool_execution_start', toolCallId: id, toolName: 'docs:get', args: {} },
      { type: 'tool_execution_end', toolCallId: id, toolName: 'docs:get', result: id },
    ]);
    const terminal = backend === 'claude-code'
      ? { type: 'result', result: 'Done', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } }
      : backend === 'codex'
        ? { type: 'item.completed', item: { type: 'agent_message', text: 'Done' } }
        : { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } };
    const observed = vi.fn();
    const events = await collect({ backend, agentCmd: fakeCli([...frames, terminal], 0),
      promptText: 'Test fixture', onToolResult: observed });
    expect(events.filter(event => event.type === 'tool_call').map(event => event.callId)).toEqual(['call-1', 'call-2']);
    expect(observed.mock.calls.map(([result]) => ({ id: result.callId, output: result.output })))
      .toEqual([{ id: 'call-1', output: 'call-1' }, { id: 'call-2', output: 'call-2' }]);
  });
});

describe('backendFailureLine', () => {
  it('unwraps a provider error envelope serialized as a JSON string', () => {
    expect(backendFailureLine(NESTED_400)).toBe(
      "The 'definitely-not-a-model-xyz' model is not supported when using Codex with a ChatGPT account.",
    );
  });

  it('keeps plain prose and takes only its first non-empty line', () => {
    expect(backendFailureLine(`\n  ${USAGE_LIMIT}\nsecond line`)).toBe(USAGE_LIMIT);
  });

  it('caps a runaway line', () => {
    const line = backendFailureLine('x'.repeat(5000));
    expect(line!.length).toBeLessThanOrEqual(400);
    expect(line!.endsWith('…')).toBe(true);
  });

  it('returns null for nothing usable', () => {
    expect(backendFailureLine('')).toBeNull();
    expect(backendFailureLine('   \n  ')).toBeNull();
    expect(backendFailureLine(undefined)).toBeNull();
  });
});

describe('codexFailureFrameMessage', () => {
  it('reads turn.failed.error.message and the top-level error frame', () => {
    expect(codexFailureFrameMessage({ type: 'turn.failed', error: { message: USAGE_LIMIT } })).toBe(USAGE_LIMIT);
    expect(codexFailureFrameMessage({ type: 'error', message: USAGE_LIMIT })).toBe(USAGE_LIMIT);
  });

  it('ignores non-fatal error ITEMS (codex warnings) and ordinary frames', () => {
    expect(
      codexFailureFrameMessage({
        type: 'item.completed',
        item: { id: 'item_0', type: 'error', message: 'Model metadata for `x` not found. Defaulting to fallback metadata.' },
      }),
    ).toBeNull();
    expect(codexFailureFrameMessage({ type: 'turn.started' })).toBeNull();
    expect(codexFailureFrameMessage(null)).toBeNull();
  });
});

describe('claudeFailureResultMessage', () => {
  it('reads an is_error result and ignores a successful one', () => {
    expect(
      claudeFailureResultMessage({ type: 'result', is_error: true, result: 'Invalid API key · Please run /login' }),
    ).toBe('Invalid API key · Please run /login');
    expect(claudeFailureResultMessage({ type: 'result', is_error: false, result: 'hello' })).toBeNull();
  });
});

describe('agentExitErrorMessage', () => {
  it('appends the backend line to the exit code, and stays bare without one', () => {
    expect(agentExitErrorMessage('codex', 1, USAGE_LIMIT)).toBe(`codex exited 1: ${USAGE_LIMIT}`);
    expect(agentExitErrorMessage('codex', 1, null)).toBe('codex exited 1');
    expect(agentExitErrorMessage('codex', null, null)).toBe('codex exited ?');
  });
});

describe('runAgentChat — backend failure reaches the terminal error (end to end)', () => {
  it.each([0, 0.42])('retains reported Claude failure spend of $%s', async costUsd => {
    const cmd = fakeCli([{ type: 'result', is_error: true, result: 'tool failed after inference',
      total_cost_usd: costUsd, usage: { input_tokens: 12, output_tokens: 4 } }], 1);
    const err = terminalError(await collect({ backend: 'claude-code', agentCmd: cmd, promptText: 'Reply OK' }));
    expect(err).toMatchObject({ costUsd });
    expect(err).not.toHaveProperty('unreportedFrames');
    expect(err.message).toContain('tool failed after inference');
  });

  it('retains reported spend while marking incomplete Claude usage', async () => {
    const cmd = fakeCli([{ type: 'result', is_error: true, result: 'tool failed',
      total_cost_usd: 0.42, usage: { input_tokens: 12 } }], 1);
    const err = terminalError(await collect({ backend: 'claude-code', agentCmd: cmd, promptText: 'Reply OK' }));
    expect(err).toMatchObject({ costUsd: 0.42, unreportedFrames: 1 });
  });

  it.each([undefined, -0.42])('does not turn absent/invalid Claude failure spend %s into a measured zero', async costUsd => {
    const cmd = fakeCli([{ type: 'result', is_error: true, result: 'tool failed',
      ...(costUsd === undefined ? {} : { total_cost_usd: costUsd }),
      usage: { input_tokens: 12, output_tokens: 4 } }], 1);
    const err = terminalError(await collect({ backend: 'claude-code', agentCmd: cmd, promptText: 'Reply OK' }));
    expect(err).not.toHaveProperty('costUsd');
    expect(err).toMatchObject({ unreportedFrames: 1 });
  });

  it('retains OMP spend on a failed subprocess', async () => {
    const cmd = fakeCli([{ type: 'message_end', message: { role: 'assistant', content: [],
      usage: { input: 12, output: 4, cost: 0.27 } } }], 1);
    const err = terminalError(await collect({ backend: 'omp', agentCmd: cmd, promptText: 'Reply OK' }));
    expect(err).toMatchObject({ costUsd: 0.27 });
    expect(err).not.toHaveProperty('unreportedFrames');
  });

  it('retains priced Codex usage before a later subprocess failure', async () => {
    const cmd = fakeCli([{ type: 'turn.completed', usage: { input_tokens: 120, output_tokens: 40 } },
      { type: 'turn.failed', error: { message: 'tool failed after inference' } }], 1);
    const err = terminalError(await collect({ backend: 'codex', model: 'gpt-5.5', agentCmd: cmd, promptText: 'Reply OK' }));
    expect(err).toMatchObject({ costUsd: expect.any(Number) });
    expect((err as unknown as { costUsd: number }).costUsd).toBeGreaterThan(0);
    expect(err).not.toHaveProperty('unreportedFrames');
  });

  it.each([
    { model: 'gpt-unknown-failure-price', usage: { input_tokens: 120, output_tokens: 40 } },
    { model: 'gpt-5.5', usage: { input_tokens: 120 } },
  ])('keeps unpriced/incomplete Codex failure spend unknown ($model)', async ({ model, usage }) => {
    const cmd = fakeCli([{ type: 'turn.completed', usage }], 1);
    const err = terminalError(await collect({ backend: 'codex', model, agentCmd: cmd, promptText: 'Reply OK' }));
    expect(err).not.toHaveProperty('costUsd');
    expect(err).toMatchObject({ unreportedFrames: 1 });
  });

  it('codex usage limit: the plan-cap line is in the error message (stderr empty, as measured)', async () => {
    const cmd = fakeCli(
      [
        { type: 'thread.started', thread_id: 't1' },
        { type: 'turn.started' },
        { type: 'error', message: USAGE_LIMIT },
        { type: 'turn.failed', error: { message: USAGE_LIMIT } },
      ],
      1,
    );
    const err = terminalError(await collect({ backend: 'codex', agentCmd: cmd, promptText: 'Reply OK' }));
    expect(err.message).toBe(`codex exited 1: ${USAGE_LIMIT}`);
  });

  it('codex provider envelope: the nested human message is what surfaces', async () => {
    const cmd = fakeCli(
      [
        { type: 'thread.started', thread_id: 't1' },
        { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata for `x` not found.' } },
        { type: 'turn.started' },
        { type: 'error', message: NESTED_400 },
        { type: 'turn.failed', error: { message: NESTED_400 } },
      ],
      1,
    );
    const err = terminalError(await collect({ backend: 'codex', agentCmd: cmd, promptText: 'Reply OK' }));
    expect(err.message).toBe(
      "codex exited 1: The 'definitely-not-a-model-xyz' model is not supported when using Codex with a ChatGPT account.",
    );
  });

  it('codex with only a warning item: no invented cause', async () => {
    const cmd = fakeCli(
      [{ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata for `x` not found.' } }],
      1,
    );
    const err = terminalError(await collect({ backend: 'codex', agentCmd: cmd, promptText: 'Reply OK' }));
    expect(err.message).toBe('codex exited 1');
  });

  it('claude-code revoked credential: the is_error result line is in the error message', async () => {
    const line =
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has been revoked. Please obtain a new token or refresh your existing token."}}';
    const cmd = fakeCli([{ type: 'result', subtype: 'success', is_error: true, result: line }], 1);
    const err = terminalError(await collect({ backend: 'claude-code', agentCmd: cmd, promptText: 'Reply OK' }));
    expect(err.message.startsWith('claude-code exited 1: API Error: 401')).toBe(true);
    expect(err.message).toContain('OAuth token has been revoked');
  });

  describe('governed turn classification', () => {
    const prev = process.env.PAPERCUSP_AGENT_GOVERNOR;
    beforeEach(() => {
      process.env.PAPERCUSP_AGENT_GOVERNOR = '1';
    });
    afterEach(() => {
      if (prev === undefined) delete process.env.PAPERCUSP_AGENT_GOVERNOR;
      else process.env.PAPERCUSP_AGENT_GOVERNOR = prev;
    });

    it('a codex plan cap reported only in JSONL is classified usage_limit', async () => {
      const cmd = fakeCli([{ type: 'turn.failed', error: { message: USAGE_LIMIT } }], 1);
      const err = terminalError(
        await collect({
          backend: 'codex',
          agentCmd: cmd,
          promptText: 'Reply OK',
          // A model key no other test shares, so the governor this penalizes is isolated.
          model: 'gpt-wi10003188-isolated',
        }),
      );
      expect(err.turn?.class).toBe('usage_limit');
    });
  });
});
