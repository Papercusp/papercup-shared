/**
 * Shared backend for chat-bubble surfaces: spawns the configured agent
 * CLI (`claude -p` or `omp -p`) with structured-output streaming,
 * parses backend-specific events into a small typed event stream that
 * callers re-emit over SSE.
 *
 * Used by:
 *   - /oracle/chat               (Oracle tab, with MCP config + 6 oracle tools)
 *   - /:slug/agent-chats/:id/messages   (per-harness agent chat tabs)
 *   - /api/agent-mcp/operator-scan, /api/agent-mcp/delegate-chat
 *
 * Backends:
 *   - 'claude-code': claude-cli with `--output-format stream-json`. MCP
 *     servers passed inline via `--mcp-config <json>`.
 *   - 'omp': @oh-my-pi/pi-coding-agent with `--mode json`. MCP servers
 *     passed via a per-spawn `PI_CODING_AGENT_DIR=<tmpdir>` whose
 *     `mcp.json` is written before spawn (omp loads it from disk).
 *
 * Caller responsibilities (intentionally NOT in here):
 *   - Prompt assembly (each surface loads its own prompt + memory)
 *   - Transcript persistence (agent-chats writes to per-harness DB;
 *     Oracle currently doesn't persist server-side)
 *   - Additional out-of-band events (tutorial_end, ui_command) — emit
 *     these from the route directly before/after iterating runClaudeChat
 *
 * Cancellation: pass a signal; spawn is killed on abort.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type AgentBackend = 'claude-code' | 'omp';

/**
 * Optional bootstrap hook for callers that persist agent config to
 * disk (e.g. the operator's /settings/agent → ~/.papercusp/agent/
 * config.json). Called once per process before the first spawn so
 * saved values land in process.env. Pure consumers (visitor chatbot,
 * one-shot scripts) can leave this unset — they read env vars
 * directly and skip the disk-config concept entirely.
 */
let bootstrapHook: (() => void | Promise<void>) | null = null;
let bootstrapped = false;

export function setAgentConfigBootstrap(hook: () => void | Promise<void>): void {
  bootstrapHook = hook;
}

function maybeBootstrap(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  if (bootstrapHook) {
    // The hook may be async (the operator now reads agent config from PG).
    // Fire-and-forget: callers that depend on env being set immediately
    // already pre-warm via /api/agent-config GET on bootstrap; this hook
    // just keeps env in sync after a settings save.
    try {
      const r = bootstrapHook();
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch(() => { /* best-effort */ });
      }
    } catch { /* best-effort */ }
  }
}

/**
 * Resolve which backend to drive. Explicit opt > AGENT_BACKEND env >
 * inferred from the binary name.
 */
function resolveBackend(opts: RunClaudeChatOptions): AgentBackend {
  if (opts.backend) return opts.backend;
  const env = (process.env.AGENT_BACKEND ?? '').trim().toLowerCase();
  if (env === 'omp' || env === 'pi') return 'omp';
  if (env === 'claude-code' || env === 'claude') return 'claude-code';
  const cmd = opts.claudeCmd ?? process.env.AGENT_CMD ?? process.env.CLAUDE_CMD ?? 'claude';
  const first = cmd.split(/\s+/).filter(Boolean)[0] ?? '';
  if (/(?:^|\/)(omp|pi)$/.test(first)) return 'omp';
  return 'claude-code';
}

/**
 * Resolve the agent binary. AGENT_CMD wins over the legacy CLAUDE_CMD;
 * default tracks the resolved backend.
 */
function resolveAgentBin(opts: RunClaudeChatOptions, backend: AgentBackend): string {
  if (opts.claudeCmd) return opts.claudeCmd;
  const fromEnv = process.env.AGENT_CMD ?? process.env.CLAUDE_CMD;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  return backend === 'omp' ? 'omp' : 'claude';
}

export interface RunClaudeChatOptions {
  /** The full assembled prompt sent to claude on stdin. */
  promptText: string;
  /** cwd for the spawned process. Required so claude's session-scoped
      path restriction can read files referenced in the prompt. */
  cwd?: string;
  /** Inline MCP server config — JSON-stringified and passed via
      `--mcp-config`. Pass `undefined` to spawn without MCP. */
  mcpConfig?: object;
  /** Names to whitelist via `--allowed-tools "a b c"`. Required when
      mcpConfig is set, otherwise claude refuses tool calls in -p mode. */
  allowedTools?: string[];
  /** When set, only tool_use blocks whose name passes this filter are
      surfaced as `tool_call` events. Returning a string lets the caller
      strip a prefix (e.g. `mcp__oracle__navigate` → `navigate`).
      Returning null/undefined skips that tool. Default: emit all tools. */
  toolEventFilter?: (rawName: string) => string | null | undefined;
  /** Permission mode flag. Default: not set (claude prompts). Most
      backends pass 'bypassPermissions' for unattended in-app tools. */
  permissionMode?: 'bypassPermissions' | 'default' | 'ask';
  /** Override the agent binary. Defaults to AGENT_CMD/CLAUDE_CMD env or
      'claude'/'omp' depending on backend. */
  claudeCmd?: string;
  /**
   * Which agent backend to drive. Default: env AGENT_BACKEND, else
   * inferred from the binary name. Selects flag set + stream parser.
   */
  backend?: AgentBackend;
  /**
   * Per-call model override. Both backends accept `--model <name>`.
   * claude wants exact ids ('claude-haiku-4-5'); omp does fuzzy matching
   * ('haiku' will resolve). Pass the most specific id you expect both
   * to accept.
   */
  model?: string;
  /** Aborts the spawn. */
  signal?: AbortSignal;
  /**
   * Resume a specific claude session by id. When set, claude continues the
   * existing conversation; when null/undefined, claude starts a fresh one.
   * Voice's delegate_to_claude uses this to route each delegation to either
   * a picked existing claude-session or a brand-new one.
   */
  sessionId?: string;
  /**
   * When `sessionId` is set, controls which flag to use:
   *   - 'resume' → `-r <id>` (fail if no such session in claude's store)
   *   - 'force' → `--session-id <uuid>` (create-or-resume; uuid must be valid)
   * Default: 'force' (create-or-resume) — what delegate_to_claude wants since
   * we manage the session id ourselves.
   */
  sessionMode?: 'resume' | 'force';
}

export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | {
      type: 'result';
      costUsd: number;
      tokensIn: number;
      tokensOut: number;
      finalText: string;
    }
  | { type: 'error'; message: string; stderr?: string };

/**
 * Spawn claude and yield events as they arrive. Always yields exactly
 * one terminal event (`result` on success, `error` on failure) before
 * returning so consumers can rely on it for transcript writing.
 */
export async function* runClaudeChat(
  opts: RunClaudeChatOptions,
): AsyncGenerator<ChatEvent, void, void> {
  maybeBootstrap();
  const backend: AgentBackend = resolveBackend(opts);
  const claudeCmd = resolveAgentBin(opts, backend);
  const argv = claudeCmd.split(/\s+/).filter(Boolean);
  const command = argv[0];
  const baseArgs = argv.slice(1);

  // Per-spawn agent dir (omp only) — `mcp.json` written here is loaded
  // by omp's MCP discovery as if it were `~/.omp/agent/mcp.json`.
  // Cleaned up after the child exits.
  let ompAgentDir: string | undefined;

  const args: string[] = [...baseArgs];
  let spawnEnv: NodeJS.ProcessEnv = process.env;

  if (backend === 'claude-code') {
    args.push('-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages');
    if (opts.model) args.push('--model', opts.model);
    if (opts.mcpConfig) {
      args.push('--mcp-config', JSON.stringify(opts.mcpConfig));
    }
    if (opts.allowedTools && opts.allowedTools.length > 0) {
      args.push('--allowed-tools', opts.allowedTools.join(' '));
    }
    if (opts.permissionMode) {
      args.push('--permission-mode', opts.permissionMode);
    }
    if (opts.sessionId) {
      if ((opts.sessionMode ?? 'force') === 'resume') {
        args.push('-r', opts.sessionId);
      } else {
        args.push('--session-id', opts.sessionId);
      }
    }
  } else {
    // omp / pi-coding-agent. omp's `-p` takes the message as a positional
    // arg (or `@file` to read from disk) — it does NOT read stdin like
    // claude does. Long prompts overflow argv, so we always go via @file.
    args.push('-p', '--mode', 'json');
    if (opts.model) args.push('--model', opts.model);
    if (!opts.sessionId) args.push('--no-session');
    // Skills + project rules are unrelated to chat surfaces — turn off
    // for predictable, fast spawns.
    args.push('--no-skills', '--no-rules');

    if (opts.mcpConfig) {
      // Translate claude-shape mcp-config into a per-spawn omp agent dir.
      // omp loads ~/.omp/agent/mcp.json on startup; PI_CODING_AGENT_DIR
      // overrides the directory to a tmpdir we control.
      ompAgentDir = mkdtempSync(join(tmpdir(), 'omp-chat-'));
      writeFileSync(
        join(ompAgentDir, 'mcp.json'),
        JSON.stringify(opts.mcpConfig),
        'utf8',
      );
      spawnEnv = { ...process.env, PI_CODING_AGENT_DIR: ompAgentDir };
    }

    if (opts.allowedTools && opts.allowedTools.length > 0) {
      // omp `--tools` allow-lists built-in tool names. MCP tools are
      // surfaced regardless; the prompt is responsible for steering.
      // We pass any matching built-in names through and skip the rest.
      const builtins = new Set([
        'read', 'bash', 'edit', 'write', 'grep', 'find', 'lsp', 'python',
        'notebook', 'inspect_image', 'browser', 'task', 'todo_write',
        'web_search', 'fetch', 'ask',
      ]);
      const matched = opts.allowedTools.filter((t) => builtins.has(t));
      if (matched.length > 0) args.push('--tools', matched.join(','));
    }

    if (opts.sessionId) {
      // omp resumes by id-prefix; force-create semantics aren't a 1:1
      // map. We treat both modes as resume-or-start (the file gets
      // created under PI_CODING_AGENT_DIR if absent).
      args.push('-r', opts.sessionId);
    }
  }

  // omp prompt-file: written before spawn so it's visible to the child;
  // deleted after exit. Defined here (outside the spawn try-block) so
  // the cleanup at the end can see it.
  let ompPromptFile: string | undefined;

  // For omp, materialise the prompt to a tmpfile and pass `@<path>` as
  // the positional message arg. Avoids both ARG_MAX overflow and the
  // stdin-not-read footgun.
  const finalArgs = [...args];
  if (backend === 'omp') {
    const promptDir = ompAgentDir ?? mkdtempSync(join(tmpdir(), 'omp-prompt-'));
    if (!ompAgentDir) ompAgentDir = promptDir; // reuse cleanup
    ompPromptFile = join(promptDir, 'prompt.md');
    writeFileSync(ompPromptFile, opts.promptText, 'utf8');
    finalArgs.push(`@${ompPromptFile}`);
  }

  let child: ChildProcess;
  try {
    child = spawn(command, finalArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: opts.cwd,
      env: spawnEnv,
    });
  } catch (e) {
    if (ompAgentDir) {
      try { rmSync(ompAgentDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    yield { type: 'error', message: `failed to spawn ${claudeCmd}: ${(e as Error).message}` };
    return;
  }

  const onAbort = () => {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  // Track in-flight tool_use content blocks so we can pair the name
  // (from content_block_start) with the streamed input json
  // (input_json_delta) and emit one tool_call event per call when the
  // block stops.
  const liveTools = new Map<number, { name: string; input: string }>();

  let stderrBuf = '';
  let stdoutLineBuf = '';
  let finalText = '';
  let costUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  // Buffer events from the line-parser; the generator drains this queue.
  const queue: ChatEvent[] = [];
  let resolveTick: (() => void) | null = null;
  const tick = () => { if (resolveTick) { resolveTick(); resolveTick = null; } };

  const handleClaudeEvent = (ev: any) => {
    const inner = ev.type === 'stream_event' && ev.event ? ev.event : ev;

    if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
      const text = inner.delta.text ?? '';
      finalText += text;
      queue.push({ type: 'delta', text });
    } else if (
      inner?.type === 'content_block_start' &&
      inner.content_block?.type === 'tool_use' &&
      typeof inner.content_block.name === 'string' &&
      typeof inner.index === 'number'
    ) {
      liveTools.set(inner.index, { name: inner.content_block.name, input: '' });
    } else if (
      inner?.type === 'content_block_delta' &&
      inner.delta?.type === 'input_json_delta' &&
      typeof inner.index === 'number' &&
      liveTools.has(inner.index)
    ) {
      liveTools.get(inner.index)!.input += inner.delta.partial_json ?? '';
    } else if (
      inner?.type === 'content_block_stop' &&
      typeof inner.index === 'number' &&
      liveTools.has(inner.index)
    ) {
      const entry = liveTools.get(inner.index)!;
      liveTools.delete(inner.index);
      const filtered = opts.toolEventFilter
        ? opts.toolEventFilter(entry.name)
        : entry.name;
      if (filtered) {
        let parsed: unknown;
        try { parsed = entry.input ? JSON.parse(entry.input) : {}; } catch { parsed = entry.input; }
        queue.push({ type: 'tool_call', name: filtered, input: parsed });
      }
    } else if (ev.type === 'result') {
      if (ev.usage) {
        tokensIn = ev.usage.input_tokens ?? tokensIn;
        tokensOut = ev.usage.output_tokens ?? tokensOut;
      }
      if (typeof ev.total_cost_usd === 'number') costUsd = ev.total_cost_usd;
      // Sometimes the terminal `result.result` is the most complete
      // assistant text — prefer it if longer than the streamed accum.
      if (typeof ev.result === 'string' && ev.result.length > finalText.length) {
        finalText = ev.result;
      }
    }
  };

  /**
   * omp `--mode json` event handler. Maps:
   *   message_update.assistantMessageEvent.text_delta → delta
   *   tool_execution_start                            → tool_call (with full args)
   *   message_end (assistant role) / agent_end        → updates finalText + usage
   */
  const handleOmpEvent = (ev: any) => {
    if (!ev || typeof ev !== 'object') return;

    if (ev.type === 'message_update' && ev.assistantMessageEvent) {
      const ame = ev.assistantMessageEvent;
      if (ame.type === 'text_delta' && typeof ame.delta === 'string') {
        finalText += ame.delta;
        queue.push({ type: 'delta', text: ame.delta });
      } else if (ame.type === 'done' && ame.message) {
        // Capture token usage from the final assistant message.
        const u = ame.message.usage;
        if (u) {
          tokensIn = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
          tokensOut = u.output ?? tokensOut;
        }
      }
      return;
    }

    if (ev.type === 'tool_execution_start' && typeof ev.toolName === 'string') {
      const filtered = opts.toolEventFilter
        ? opts.toolEventFilter(ev.toolName)
        : ev.toolName;
      if (filtered) {
        queue.push({ type: 'tool_call', name: filtered, input: ev.args ?? {} });
      }
      return;
    }

    if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
      // Reconstruct from text content blocks if streaming missed any.
      const parts: string[] = [];
      for (const b of ev.message.content ?? []) {
        if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
      const reconstructed = parts.join('');
      if (reconstructed.length > finalText.length) finalText = reconstructed;
      const u = ev.message.usage;
      if (u) {
        tokensIn = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        tokensOut = u.output ?? tokensOut;
      }
      return;
    }
  };

  const handle = backend === 'omp' ? handleOmpEvent : handleClaudeEvent;

  child.stdout!.on('data', (chunk: Buffer) => {
    stdoutLineBuf += chunk.toString('utf8');
    let nl: number;
    // eslint-disable-next-line no-cond-assign
    while ((nl = stdoutLineBuf.indexOf('\n')) >= 0) {
      const line = stdoutLineBuf.slice(0, nl).trim();
      stdoutLineBuf = stdoutLineBuf.slice(nl + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line));
      } catch { /* non-JSON line — ignore */ }
      tick();
    }
  });

  child.stderr!.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
  });

  // claude reads the prompt on stdin; omp reads it from a `@file`
  // positional arg (handled in finalArgs above). For omp we still close
  // stdin so the child doesn't block waiting for input that won't come.
  if (backend === 'omp') {
    child.stdin!.end();
  } else {
    child.stdin!.write(opts.promptText);
    child.stdin!.end();
  }

  let exitCode: number | null = null;
  let exited = false;
  child.on('exit', (code) => { exitCode = code; exited = true; tick(); });
  child.on('error', () => { exited = true; tick(); });

  // Drain loop.
  while (true) {
    while (queue.length > 0) {
      yield queue.shift()!;
    }
    if (exited) break;
    await new Promise<void>((resolve) => { resolveTick = resolve; });
  }

  if (opts.signal) opts.signal.removeEventListener('abort', onAbort);

  if (ompAgentDir) {
    try { rmSync(ompAgentDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  if (exitCode !== 0) {
    yield {
      type: 'error',
      message: `${backend === 'omp' ? 'omp' : 'claude'} exited ${exitCode ?? '?'}`,
      stderr: stderrBuf.slice(-800),
    };
  } else {
    yield {
      type: 'result',
      costUsd,
      tokensIn,
      tokensOut,
      finalText,
    };
  }
}
