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
 *   - 'codex': codex-cli `exec --json` (JSONL events; prompt on stdin via
 *     the trailing `-`). No --system-prompt / --mcp-config flags — both
 *     are configured through a per-spawn `CODEX_HOME=<tmpdir>` holding
 *     `AGENTS.md` (system prompt), `config.toml` (`[mcp_servers.*]`), and
 *     a symlink to `~/.codex/auth.json` (shared ChatGPT OAuth login).
 *   - 'meridian': stateless single Anthropic-format HTTP round-trip, no
 *     subprocess. No MCP. For one-shot LLM turns (judges, summarisers).
 *
 * Caller responsibilities (intentionally NOT in here):
 *   - Prompt assembly (each surface loads its own prompt + memory)
 *   - Transcript persistence (agent-chats writes to per-harness DB;
 *     Oracle currently doesn't persist server-side)
 *   - Additional out-of-band events (tutorial_end, ui_command) — emit
 *     these from the route directly before/after iterating runAgentChat
 *
 * Cancellation: pass a signal; spawn is killed on abort.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
// Agent-turn robustness (opt-in via PAPERCUSP_AGENT_GOVERNOR=1). These modules are pure +
// import nothing from this file, so there's no cycle and ~no load cost when the flag is off.
import { runAgentTurn, type TurnOutcome } from './turn-runner';
import { governorForBackend, BACKEND_PROFILES } from './governor-registry';
import { classifyTurnError, isAccountWide, type TurnBackend, type TurnError } from './turn-error';

/** Default cap on a CLI spawn's wait for a shared-governor permit (RB-012). Long enough to
    wait out a normal 429's retry-after, short enough that a multi-hour subscription lockout
    surfaces instead of freezing the caller for hours. */
export const DEFAULT_CLI_GOVERNOR_MAX_WAIT_MS = 5 * 60_000;

// --- In-process usage telemetry seam (rate-limit-layer-v2 D-002, capture point 1) --------------
// The meridian path is the ONE place real `anthropic-ratelimit-*` headers + token usage are
// visible in-process. This lib stays host-free, so the host (operator-core) installs a sink at
// boot (`setMeridianUsageSink`) and both meridian paths (legacy + governed) emit one event per
// completed call. Best-effort: a sink failure must never break the LLM call.
export interface MeridianUsageEvent {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  costUsd: number;
  /** Lower-cased response headers when the transport exposed them (anthropic-ratelimit-*). */
  headers?: Record<string, string | undefined>;
}
let meridianUsageSink: ((ev: MeridianUsageEvent) => void) | undefined;
/** Install (or clear) the host's usage-telemetry sink. Call once at operator boot. */
export function setMeridianUsageSink(fn?: (ev: MeridianUsageEvent) => void): void {
  meridianUsageSink = fn;
}
function emitMeridianUsage(ev: MeridianUsageEvent): void {
  if (!meridianUsageSink) return;
  try {
    meridianUsageSink(ev);
  } catch {
    /* telemetry is best-effort; never throw into the LLM path */
  }
}

/**
 * Backends the in-app brains can drive. The three subprocess backends
 * (`claude-code`/`omp`/`codex`) are the canonical spawn set shared with
 * `@papercusp/orchestrator` (`AGENT_BACKENDS`) and
 * `apps/operator/lib/agent-config.ts` (`AGENT_BACKENDS`); `meridian` is an
 * extra brains-only stateless HTTP round-trip (no subprocess, not
 * spawnable by the orchestrator). The submodule boundary rules out a
 * single literal import; `apps/operator/lib/__tests__/agent-backend-sync.test.ts`
 * guards the subprocess subset against drift across the three. */
export const AGENT_BACKENDS = ['claude-code', 'omp', 'meridian', 'codex'] as const;
/** The subset that maps to a real subprocess (excludes `meridian`). */
export const SUBPROCESS_AGENT_BACKENDS = ['claude-code', 'omp', 'codex'] as const;
export type AgentBackend = (typeof AGENT_BACKENDS)[number];

/**
 * Claude Code built-ins denied by `disallowBuiltins` (claude-code) — the
 * filesystem/web/subagent/scheduling tools a persona brain never needs and
 * misuses (no-op `Bash` "comments", stray `Task`/`Write`). Captured from a
 * `claude -p` init's non-`mcp__` `tools` (v2.1).
 *
 * DELIBERATELY KEPT (NOT denied): `ToolSearch` + `ListMcpResourcesTool`/
 * `ReadMcpResourceTool`. A large `--mcp-config` surface (the 226 agentmcp
 * tools) is presented DEFERRED — `ToolSearch` is how the model ACTIVATES a
 * deferred tool before calling it. Denying it left the brain unable to call
 * ANY agentmcp tool: it narrated "checking…" every turn with zero tool calls
 * (verified regression, 2026-06-02). So we trim the dangerous built-ins but
 * preserve the tool-loading path.
 */
export const CLAUDE_BUILTIN_TOOLS = [
  'Task', 'AskUserQuestion', 'Bash', 'CronCreate', 'CronDelete', 'CronList',
  'Edit', 'EnterPlanMode', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree',
  'Glob', 'Grep', 'Monitor', 'NotebookEdit', 'PushNotification', 'Read',
  'RemoteTrigger', 'ScheduleWakeup', 'Skill', 'TaskCreate', 'TaskGet',
  'TaskList', 'TaskOutput', 'TaskStop', 'TaskUpdate',
  'WebFetch', 'WebSearch', 'Workflow', 'Write',
] as const;

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
 * inferred from the binary name. Default fallback: omp (Meridian-routed).
 *
 * Exported so non-runAgentChat callers with their own bespoke stream
 * parser can resolve the backend identically.
 */
/**
 * Resolve which backend to drive. Explicit opt > AGENT_BACKEND env >
 * inferred from the binary name. Default fallback: omp.
 *
 * Exported so non-runAgentChat callers with their own bespoke stream
 * parser can resolve the backend identically.
 */
export function resolveBackend(opts: RunAgentChatOptions): AgentBackend {
  if (opts.backend) return opts.backend;
  const env = (process.env.AGENT_BACKEND ?? '').trim().toLowerCase();
  if (env === 'omp' || env === 'pi') return 'omp';
  if (env === 'claude-code' || env === 'claude') return 'claude-code';
  if (env === 'meridian') return 'meridian';
  if (env === 'codex') return 'codex';
  const cmd = opts.agentCmd ?? process.env.AGENT_CMD ?? process.env.CLAUDE_CMD ?? '';
  const first = cmd.split(/\s+/).filter(Boolean)[0] ?? '';
  if (/(?:^|\/)(omp|pi)$/.test(first)) return 'omp';
  if (/(?:^|\/)claude$/.test(first)) return 'claude-code';
  if (/(?:^|\/)codex$/.test(first)) return 'codex';
  return 'omp';
}

/**
 * Resolve the agent binary. AGENT_CMD wins over the legacy CLAUDE_CMD;
 * default tracks the resolved backend.
 */
export function resolveAgentBin(opts: RunAgentChatOptions, backend: AgentBackend): string {
  if (opts.agentCmd) return opts.agentCmd;
  const fromEnv = process.env.AGENT_CMD ?? process.env.CLAUDE_CMD;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  if (backend === 'omp') return 'omp';
  if (backend === 'codex') return 'codex';
  return 'claude';
}

/**
 * claude's `--model` wants a bare id (`claude-opus-4-7`) or an alias
 * (`opus`/`sonnet`/`haiku`); it rejects omp/Meridian's `provider/model`
 * form (e.g. `anthropic/claude-opus-4-7`), which is what callers like the
 * operator brain default pass. Strip a single leading `provider/` segment
 * for the claude-code backend; an already-bare id passes through. (omp
 * does its own fuzzy resolution and must keep the prefix, so only the
 * claude branch calls this.)
 */
export function normalizeModelForClaude(model: string): string {
  if (!model) return model;
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(slash + 1) : model;
}

/** Escape a string for a double-quoted TOML basic value. */
function tomlStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
/**
 * A TOML bare key may only contain [A-Za-z0-9_-]; codex MCP server names
 * (e.g. `papercusp-su`) qualify, but anything with a `:` or `.` (like a
 * tool-style name) must be quoted. Quote defensively.
 */
function tomlKey(s: string): string {
  return /^[A-Za-z0-9_-]+$/.test(s) ? s : `"${tomlStr(s)}"`;
}

export interface RunAgentChatOptions {
  /** The full assembled prompt sent to claude on stdin. */
  promptText: string;
  /**
   * When set, sent as the agent's SYSTEM prompt (omp
   * `--append-system-prompt`, claude default-prompt replacement) and
   * `promptText` is sent as the USER message. Without this, `promptText`
   * becomes the user message and the agent treats persona+playbook
   * content as something *the user handed it*, producing meta-commentary
   * instead of acting on the persona. Required for operator/oracle/
   * architect brains whose "prompt" is actually a persona spec.
   */
  systemPromptText?: string;
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
  /**
   * Isolate the spawn from the host's agent config (claude-code only).
   * When set, the `claude` subprocess runs against a CLEAN per-spawn
   * `CLAUDE_CONFIG_DIR` (a fresh tmpdir) instead of the developer's
   * `~/.claude`, so it loads NONE of the host environment: no
   * `~/.claude.json` MCP servers (`coord_*`/`harness_*`/`papercusp-su`/…),
   * no SessionStart/PreToolUse hooks, no plugins/skills. The spawn sees
   * ONLY its `--mcp-config` tools + persona system prompt. The Claude-Max
   * OAuth credentials are symlinked into the clean dir so auth carries
   * over (mirrors the codex `auth.json` symlink). The tmpdir is removed
   * on child exit. REQUIRED for in-app brains (operator/oracle) that run
   * with `bypassPermissions` on a developer box — without it the brain
   * inherits the dev's full Claude Code agent surface and goes agentic
   * (calls coord/harness tools, reads files) instead of emitting a clean
   * persona turn. Not needed for stateless one-shot completions
   * (sim/judge llm-client) which pass no mcpConfig and don't tool-call. */
  isolateConfig?: boolean;
  /**
   * Block ALL Claude Code built-in tools (claude-code only) via
   * `--disallowed-tools`, leaving ONLY the `--mcp-config` tools. A
   * persona brain (operator) reaches its world exclusively through its
   * agentmcp tools and emits `<say>`/`<spawn>` as control-tag TEXT, so it
   * needs none of `Bash`/`Read`/`Edit`/`Write`/`Glob`/`Grep`/`Task`/
   * `ToolSearch`/`WebFetch`/… — and when they're present it MISUSES them
   * (a no-op `Bash` "comment", `ToolSearch`-ing for tool names that are
   * already loaded, occasionally looping until the 600 s wall-cap). With
   * `bypassPermissions`, `--allowed-tools` does NOT restrict the surface,
   * so this explicit deny-list is the lever. */
  disallowBuiltins?: boolean;
  /** Override the agent binary. Defaults to AGENT_CMD/CLAUDE_CMD env or
      'claude'/'omp' depending on backend. */
  agentCmd?: string;
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
  /**
   * Multi-turn message history. For stateless backends (`meridian`) this
   * is the entire conversation sent to the model each turn — caller
   * manages history. For subprocess backends (`omp` / `claude-code`),
   * `promptText` is the only user message; this field is ignored
   * (the agent loop manages its own conversation state).
   */
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /**
   * Max output tokens. `meridian` honors this; `omp` / `claude-code`
   * have their own internal limits.
   */
  maxTokens?: number;
  /**
   * Sampling temperature (0–1). `meridian` honors when the model
   * accepts it (skipped for `opus*` per the Anthropic API constraint).
   * `omp` / `claude-code` ignore.
   */
  temperature?: number;
  /**
   * Thinking budget (tokens). Maps to Anthropic's `thinking: {type:
   * 'enabled', budget_tokens: N}`. Meridian translates per-provider
   * (e.g. OpenAI `reasoning_effort`). `meridian` only.
   */
  thinkingBudgetTokens?: number;
  /**
   * Cap (ms) on how long a CLI spawn will wait for a shared-governor permit before it
   * surfaces a `rate_limited` error instead of blocking (RB-012). Only consulted when the
   * `PAPERCUSP_AGENT_GOVERNOR` flag is on. Interactive callers (operator/oracle brains) pass
   * a small value (or rely on `signal`) so they escalate rather than inherit a far-off shared
   * pause (D-002); unattended callers (the gym) leave the default so a normal 429's
   * retry-after is waited out. Default `DEFAULT_CLI_GOVERNOR_MAX_WAIT_MS`.
   */
  governorMaxWaitMs?: number;
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
  | {
      type: 'error';
      message: string;
      stderr?: string;
      /**
       * RB-006: the classified turn error, when known. Lets a consumer (e.g. the gym's
       * `llmCall` → `runAbEvaluation`) distinguish a `rate_limited` failure (pause + resume)
       * from a permanent one (skip) instead of re-parsing the message string. Populated on
       * the governed meridian + CLI paths; absent on the legacy un-governed path (consumers
       * fall back to message classification / treat as a generic error).
       */
      turn?: TurnError;
    };

// ===========================================================================
// Stateless `meridian` backend — a single Anthropic-format HTTP round-trip,
// NO subprocess (~100-300ms vs. ~1-2s for an agent spawn). Use when a caller
// needs an LLM round-trip but NOT a full agent loop (no MCP, no multi-step
// tool use): llm-testing judge + sim-user, summarisers, one-shot Q&A.
//
// Transport is resolved per call (resolveStatelessTransport): a claude-code
// user goes DIRECT to api.anthropic.com with their Claude OAuth session —
// Meridian, the multi-provider router, is only needed for non-claude backends
// — while an omp user routes through the local Meridian router. The shared
// pricing / retry / streaming surface below serves both.
// ===========================================================================

let _meridianTokenCache: string | null | undefined; // undefined = not loaded; null = no token

function readMeridianToken(): string | null {
  if (_meridianTokenCache !== undefined) return _meridianTokenCache;
  try {
    const raw = readFileSync(join(homedir(), '.omp', 'agent', 'auth.json'), 'utf8');
    const parsed = JSON.parse(raw) as { anthropic?: { token?: { access?: string } } };
    _meridianTokenCache = parsed.anthropic?.token?.access ?? null;
  } catch {
    _meridianTokenCache = null;
  }
  return _meridianTokenCache;
}

/**
 * Claude Code's own OAuth session token (`~/.claude/.credentials.json`).
 * It's the same Claude-Max OAuth credential Meridian forwards, and works
 * directly against api.anthropic.com with the `anthropic-beta:
 * oauth-2025-04-20` header (verified) — no Meridian router needed. Cached.
 */
let _claudeTokenCache: string | null | undefined;
function readClaudeOauthToken(): string | null {
  if (_claudeTokenCache !== undefined) return _claudeTokenCache;
  try {
    const raw = readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8');
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    _claudeTokenCache = parsed.claudeAiOauth?.accessToken ?? null;
  } catch {
    _claudeTokenCache = null;
  }
  return _claudeTokenCache;
}

interface StatelessTransport {
  baseURL: string;
  token: string;
  headers: Record<string, string>;
  label: 'anthropic-direct' | 'meridian';
}

/**
 * Resolve the transport for a stateless Anthropic-format call.
 *
 *  - claude-code backend (or no Meridian token but a Claude session present)
 *    → DIRECT to api.anthropic.com with the Claude OAuth session. Meridian is
 *    the multi-provider router; a claude user doesn't need it.
 *  - otherwise → the local Meridian router with omp's OAuth token, carrying a
 *    per-call-unique `x-meridian-agent` so requests don't fold into a shared
 *    agent context.
 *
 * Returns `{ error }` when neither credential is present.
 */
function resolveStatelessTransport(): StatelessTransport | { error: string } {
  const backend = resolveBackend({}); // env-driven effective agent backend
  const claudeTok = readClaudeOauthToken();
  const meridianTok = readMeridianToken();
  const direct = (): StatelessTransport => ({
    baseURL: process.env.PAPERCUSP_ANTHROPIC_URL ?? 'https://api.anthropic.com',
    token: claudeTok!,
    headers: { 'anthropic-beta': 'oauth-2025-04-20' },
    label: 'anthropic-direct',
  });
  const viaMeridian = (): StatelessTransport => ({
    baseURL: process.env.PAPERCUSP_MERIDIAN_URL ?? 'http://127.0.0.1:3456',
    token: meridianTok!,
    headers: { 'x-meridian-agent': `papercup-llm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` },
    label: 'meridian',
  });
  if (backend === 'claude-code' && claudeTok) return direct();
  if (meridianTok) return viaMeridian();
  if (claudeTok) return direct();
  return {
    error:
      'stateless LLM path needs a Claude session (~/.claude/.credentials.json) ' +
      'or omp/Meridian auth (~/.omp/agent/auth.json)',
  };
}

interface ModelPrice { in: number; out: number }
const MERIDIAN_PRICES: Record<string, ModelPrice> = {
  // Anthropic family (per 1M tokens, USD)
  'claude-haiku-4-5':  { in: 0.80, out: 4.00 },
  'claude-sonnet-4-6': { in: 3.00, out: 15.00 },
  'claude-opus-4-7':   { in: 15.00, out: 75.00 },
  'claude-opus-4-8':   { in: 15.00, out: 75.00 },
  // OpenAI codex models routed via Meridian (approximate 2026-05 reference)
  'openai-codex/gpt-5':           { in: 1.25, out: 10.00 },
  'openai-codex/gpt-5.5':         { in: 2.50, out: 20.00 },
  'openai-codex/gpt-5.5:xhigh':   { in: 2.50, out: 20.00 },
};
function meridianPriceFor(model: string): ModelPrice {
  if (MERIDIAN_PRICES[model]) return MERIDIAN_PRICES[model];
  const prefix = Object.keys(MERIDIAN_PRICES).find((m) => model.startsWith(m));
  return prefix ? MERIDIAN_PRICES[prefix] : { in: 0, out: 0 };
}

// Codex (`codex exec`) emits NO cost field — only a token `usage` block on
// `turn.completed`. We derive costUsd from this table the same way the
// stateless meridian path does (model → in/out per 1M tokens, USD).
// Codex runs OpenAI GPT-5 family models (logged in via ChatGPT OAuth);
// keys are the BARE model id codex reports (`gpt-5.5`), plus the
// `openai-codex/*` form for callers that pass the meridian-style prefix.
// Approximate 2026-05 reference pricing — keep in sync with MERIDIAN_PRICES.
const CODEX_PRICES: Record<string, ModelPrice> = {
  'gpt-5':              { in: 1.25, out: 10.00 },
  'gpt-5.5':            { in: 2.50, out: 20.00 },
  'gpt-5.5:xhigh':      { in: 2.50, out: 20.00 },
  'openai-codex/gpt-5':   { in: 1.25, out: 10.00 },
  'openai-codex/gpt-5.5': { in: 2.50, out: 20.00 },
};
function codexPriceFor(model: string | undefined): ModelPrice {
  if (!model) return CODEX_PRICES['gpt-5.5'];
  if (CODEX_PRICES[model]) return CODEX_PRICES[model];
  const prefix = Object.keys(CODEX_PRICES).find((m) => model.startsWith(m));
  return prefix ? CODEX_PRICES[prefix] : { in: 0, out: 0 };
}

function isMeridianTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Anthropic SDK APIError surfaces as `<status> <body>` in .message.
  // Retry on 529 overloaded, 429 rate-limit, 5xx, and network blips.
  return /(\b529\b|overloaded|rate.?limit|service unavailable|\b50[02-4]\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up)/i.test(msg);
}

/** Prompt-caching is ON unless explicitly disabled (RB-008). Off-switch:
    `PAPERCUSP_PROMPT_CACHE=0` (e.g. if a transport rejects `cache_control`). */
export function promptCacheEnabled(): boolean {
  return process.env.PAPERCUSP_PROMPT_CACHE !== '0';
}

/** A cached system text block. */
type CachedSystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

/**
 * Build the meridian `system` request field (RB-008: prompt caching).
 *
 * When caching is enabled we send the system prompt as a single text block marked
 * `cache_control: { type: 'ephemeral' }` instead of a bare string. The system prompt is the
 * large STABLE prefix on our in-process meridian calls (the gym judge's frozen 32k-thinking
 * rubric, the sim-user persona, the generators' instructions) while the user turn varies —
 * so caching it makes the prefix a cache-READ on repeat calls, and cache-read input tokens
 * don't count toward ITPM, raising effective throughput (the cheapest rate-limit pressure
 * relief per the plan review). Anthropic ignores `cache_control` below the minimum cacheable
 * size, so it's a safe no-op on short prompts; the off-switch covers a transport that rejects
 * the field outright.
 */
export function buildSystemParam(systemPromptText: string, cache: boolean = promptCacheEnabled()): string | CachedSystemBlock[] {
  if (!cache) return systemPromptText;
  return [{ type: 'text', text: systemPromptText, cache_control: { type: 'ephemeral' } }];
}

async function* meridianAgentChat(
  opts: RunAgentChatOptions,
): AsyncGenerator<ChatEvent, void, void> {
  if (opts.mcpConfig) {
    yield { type: 'error', message: 'meridian backend does not support mcpConfig — use omp/claude-code for MCP-bearing turns' };
    return;
  }
  if (!opts.model) {
    yield { type: 'error', message: 'meridian backend requires opts.model (resolve via modelRoles or pass explicitly)' };
    return;
  }
  // Resolve transport: direct-to-Anthropic for claude-code users, else the
  // local Meridian router (see resolveStatelessTransport).
  const transport = resolveStatelessTransport();
  if ('error' in transport) {
    yield { type: 'error', message: transport.error };
    return;
  }

  // Lazy-load the SDK so consumers that never use this path don't pay the import
  // cost. Dynamic `import()` (not a static top-level import) keeps it lazy, stays
  // inlinable by the desktop sidecar's esbuild bundle, and resolves the class off
  // the module namespace at runtime — avoiding the ESM↔CJS named-import linking
  // failure under tsx (operator-core is `"type": "module"`).
  const sdkMod = await import('@anthropic-ai/sdk');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Anthropic: any = (sdkMod as { default?: unknown }).default ?? sdkMod;

  const client = new Anthropic({
    baseURL: transport.baseURL,
    authToken: transport.token,
    defaultHeaders: transport.headers,
    maxRetries: 2,
  });

  // Build request params. messages overrides promptText for multi-turn.
  const messages = opts.messages && opts.messages.length > 0
    ? opts.messages
    : [{ role: 'user' as const, content: opts.promptText }];
  // opus models reject the temperature parameter (Anthropic API
  // constraint as of 2026-05); skip pre-emptively.
  const sendsTemperature = !/opus/i.test(opts.model);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: Record<string, any> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    messages,
  };
  if (opts.systemPromptText) params.system = buildSystemParam(opts.systemPromptText);
  if (sendsTemperature && opts.temperature !== undefined) params.temperature = opts.temperature;
  if (opts.thinkingBudgetTokens && opts.thinkingBudgetTokens > 0) {
    params.thinking = { type: 'enabled', budget_tokens: opts.thinkingBudgetTokens };
  }

  // Robustness opt-in (agent-turn-robustness P-004): route through the shared
  // RateLimitGovernor + runAgentTurn so concurrent callers pace under the provider's
  // limit and a 429 honors the server's retry-after instead of a blind backoff. OFF by
  // default → the proven retry loop below runs unchanged (zero behavior change for the
  // live fleet until validated).
  if (process.env.PAPERCUSP_AGENT_GOVERNOR === '1') {
    yield* governedMeridian(client, params, opts);
    return;
  }

  // Patient retry on transient errors (sustained 529 overload). 8
  // attempts, backoff 2/4/8/16/32/60/60/60s + SDK's own retries.
  const RETRY_MAX = 8;
  const RETRY_CAP_MS = 60_000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    if (opts.signal?.aborted) {
      yield { type: 'error', message: 'meridian: aborted' };
      return;
    }
    try {
      // Use the streaming transport (.stream().finalMessage()) rather than the
      // non-streaming .create(): the Anthropic SDK REJECTS a non-streaming request
      // whose max_tokens could exceed the 10-minute ceiling (e.g. the gym's frozen
      // Opus judge runs 32k-token extended thinking → ~36k max_tokens, which trips
      // "Streaming is required for operations that may take longer than 10 minutes").
      // .stream() satisfies that guard; .finalMessage() resolves to the same full
      // Message (content + usage), so the downstream extraction below is unchanged.
      const stream = client.messages.stream(params, opts.signal ? { signal: opts.signal } : {});
      const resp = await stream.finalMessage();
      let finalText = '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const block of (resp.content ?? []) as Array<any>) {
        if (block?.type === 'text' && typeof block.text === 'string') finalText += block.text;
      }
      const inputTokens = resp.usage?.input_tokens ?? 0;
      const outputTokens = resp.usage?.output_tokens ?? 0;
      const p = meridianPriceFor(opts.model);
      const costUsd = (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
      // Usage telemetry (D-002 capture point 1): tokens + the raw response's ratelimit headers.
      emitMeridianUsage({
        model: opts.model,
        inputTokens,
        outputTokens,
        cacheReadTokens: resp.usage?.cache_read_input_tokens ?? undefined,
        costUsd,
        headers: headersToRecord(stream.response?.headers),
      });
      if (finalText) yield { type: 'delta', text: finalText };
      yield { type: 'result', costUsd, tokensIn: inputTokens, tokensOut: outputTokens, finalText };
      return;
    } catch (err) {
      lastErr = err;
      if (!isMeridianTransient(err) || attempt === RETRY_MAX) {
        yield {
          type: 'error',
          message: `meridian error: ${err instanceof Error ? err.message : String(err)}`,
        };
        return;
      }
      const backoffMs = Math.min(RETRY_CAP_MS, 1000 * 2 ** attempt) + Math.random() * 500;
      console.warn(
        `[meridian] transient (attempt ${attempt}/${RETRY_MAX}), retrying in ${Math.round(backoffMs)}ms: ${err instanceof Error ? err.message.slice(0, 140) : String(err)}`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  yield {
    type: 'error',
    message: `meridian: exhausted ${RETRY_MAX} retries: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  };
}

/** Convert an SDK error's `.headers` (a Headers object OR a plain object) to a record so
    the TurnError classifier can read `retry-after` / `anthropic-ratelimit-*`. */
export function headersToRecord(h: unknown): Record<string, string | undefined> | undefined {
  if (!h || typeof h !== 'object') return undefined;
  const anyH = h as { forEach?: (cb: (v: string, k: string) => void) => void };
  if (typeof anyH.forEach === 'function') {
    const o: Record<string, string> = {};
    anyH.forEach((v, k) => {
      o[k.toLowerCase()] = v;
    });
    return o;
  }
  const o: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) o[k.toLowerCase()] = v == null ? undefined : String(v);
  return o;
}

/**
 * Governed meridian request (agent-turn-robustness P-004): the SAME single request as the
 * loop above, but run through `runAgentTurn` + the shared `RateLimitGovernor` —
 * concurrency-capped, paced under the provider RPM, and on a 429 it penalizes the governor
 * with the server's `retry-after` (so the NEXT acquire waits exactly that long, across all
 * callers) instead of a blind exponential backoff. Yields the same delta/result/error.
 */
async function* governedMeridian(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: Record<string, any>,
  opts: RunAgentChatOptions,
): AsyncGenerator<ChatEvent, void, void> {
  const model = opts.model as string;
  const governor = governorForBackend('meridian', model);
  type V = { finalText: string; tokensIn: number; tokensOut: number; costUsd: number };
  const result = await runAgentTurn<V>(
    // No estTokens: max_tokens does NOT count toward OTPM (only tokens actually produced),
    // so estimating OTPM as max_tokens would massively over-charge the budget. Until we
    // reconcile from real usage headers, pace on concurrency + RPM + 429-penalty only
    // (token-budget dimensions stay inert on the subscription path anyway). [reviewer #4]
    { backend: 'meridian', maxAttempts: 8 },
    {
      governor,
      runOnce: async (): Promise<TurnOutcome<V>> => {
        if (opts.signal?.aborted) return { ok: false, raw: { message: 'meridian: aborted' } };
        try {
          const stream = client.messages.stream(params, opts.signal ? { signal: opts.signal } : {});
          const resp = await stream.finalMessage();
          let finalText = '';
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const block of (resp.content ?? []) as Array<any>) {
            if (block?.type === 'text' && typeof block.text === 'string') finalText += block.text;
          }
          const tokensIn = resp.usage?.input_tokens ?? 0;
          const tokensOut = resp.usage?.output_tokens ?? 0;
          const p = meridianPriceFor(model);
          const costUsd = (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
          const headers = headersToRecord(stream.response?.headers);
          // Usage telemetry (D-002 capture point 1) — tokens + ratelimit headers when present.
          emitMeridianUsage({
            model,
            inputTokens: tokensIn,
            outputTokens: tokensOut,
            cacheReadTokens: resp.usage?.cache_read_input_tokens ?? undefined,
            costUsd,
            headers,
          });
          // Returning headers lets runWithRetry feed governor.recordResponse → header-driven
          // pacing (limits auto-tune, low-headroom soft pacing) activates on API-key paths.
          return { ok: true, value: { finalText, tokensIn, tokensOut, costUsd }, ...(headers ? { headers } : {}) };
        } catch (err) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const e = err as any;
          return {
            ok: false,
            raw: {
              status: typeof e?.status === 'number' ? e.status : undefined,
              headers: headersToRecord(e?.headers),
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      },
    },
  );
  if (result.ok) {
    if (result.value.finalText) yield { type: 'delta', text: result.value.finalText };
    yield { type: 'result', costUsd: result.value.costUsd, tokensIn: result.value.tokensIn, tokensOut: result.value.tokensOut, finalText: result.value.finalText };
  } else {
    // result.error IS a TurnError — pass it through so the caller can pause/resume on a
    // rate_limited class instead of re-parsing the message (RB-006).
    yield { type: 'error', message: `meridian error: ${result.error.message}`, turn: result.error };
  }
}

/**
 * Spawn claude and yield events as they arrive. Always yields exactly
 * one terminal event (`result` on success, `error` on failure) before
 * returning so consumers can rely on it for transcript writing.
 */
export async function* runAgentChat(
  opts: RunAgentChatOptions,
): AsyncGenerator<ChatEvent, void, void> {
  maybeBootstrap();
  const backend: AgentBackend = resolveBackend(opts);
  if (backend === 'meridian') {
    yield* meridianAgentChat(opts);
    return;
  }

  // RB-012/RB-005 — govern the CLI spawn at the subprocess-turn granularity (flag-gated;
  // default OFF = byte-identical legacy path). Acquire a SHARED concurrency permit BEFORE
  // spawning (the real burst lever), and on a rate-limited / overloaded outcome penalize the
  // shared governor with the server's retry-after so concurrent callers back off. We do NOT
  // re-retry the spawn: the CLI self-retries internally and the orchestrator/director owns
  // turn retries (re-spawning here would be our-retry × CLI-retry amplification — exactly
  // what makes 429s worse). omp self-paces (fallback chaining) → concurrency-cap only. The
  // permit is held for the whole subprocess and released in the `finally` below.
  const governed = process.env.PAPERCUSP_AGENT_GOVERNOR === '1';
  let releaseGovernor: (() => void) | null = null;
  if (governed) {
    const gov = governorForBackend(backend as TurnBackend, opts.model ?? '');
    const release = await gov.acquire(
      {},
      { signal: opts.signal, maxWaitMs: opts.governorMaxWaitMs ?? DEFAULT_CLI_GOVERNOR_MAX_WAIT_MS },
    );
    if (!release) {
      // Bailed: the shared bucket is paused past our maxWait (a far-off reset) or aborted.
      // Surface as an error so the caller decides — interactive: escalate (D-002); the gym:
      // pause/resume (RB-006) — instead of freezing here. Attach a structured `rate_limited`
      // turn (carrying the reset) so the caller doesn't re-parse the message.
      const pausedUntil = gov.state.pausedUntil;
      const aborted = opts.signal?.aborted;
      yield {
        type: 'error',
        message: aborted
          ? `${backend}: aborted`
          : `${backend}: rate-limited${pausedUntil ? ` — paused until ${new Date(pausedUntil).toISOString()}` : ''}`,
        ...(aborted
          ? {}
          : {
              turn: {
                class: 'rate_limited' as const,
                message: 'shared rate-limit pause exceeds maxWait',
                provider: BACKEND_PROFILES[backend as TurnBackend].provider,
                retryable: false,
                ...(pausedUntil ? { resetAt: pausedUntil } : {}),
              },
            }),
      };
      return;
    }
    releaseGovernor = release;
  }

  // try/finally exists only so the governor permit is released on EVERY exit path (normal,
  // spawn-failure return, abort, or a consumer abandoning the generator). Body indentation is
  // left unchanged to keep the diff readable.
  try {
  const agentCmd = resolveAgentBin(opts, backend);
  const argv = agentCmd.split(/\s+/).filter(Boolean);
  const command = argv[0];
  const baseArgs = argv.slice(1);

  // Per-spawn agent dir (omp only) — `mcp.json` written here is loaded
  // by omp's MCP discovery as if it were `~/.omp/agent/mcp.json`.
  // Cleaned up after the child exits.
  let ompAgentDir: string | undefined;

  // Per-spawn CODEX_HOME (codex only) — holds AGENTS.md (codex's only
  // system-prompt surface), config.toml (MCP servers), and a symlink to
  // the user's ~/.codex/auth.json so the ChatGPT OAuth login carries
  // over. Created only when systemPromptText or mcpConfig is set;
  // otherwise codex runs against the user's real ~/.codex. Cleaned up
  // after the child exits (alongside ompAgentDir).
  let codexHome: string | undefined;

  // Per-spawn clean CLAUDE_CONFIG_DIR (claude-code, opts.isolateConfig
  // only) — isolates the brain spawn from the developer's ~/.claude.
  // Holds only a symlink to the real ~/.claude/.credentials.json so the
  // OAuth login carries over; nothing else, so no host MCP/hooks/plugins
  // load. Cleaned up after the child exits (alongside codexHome).
  let claudeConfigDir: string | undefined;

  // Per-spawn dir holding the claude-code `--system-prompt-file` (the
  // persona). Only allocated when claudeConfigDir is absent (the persona
  // file is otherwise written INTO claudeConfigDir, sharing its cleanup).
  let claudeSysDir: string | undefined;

  const args: string[] = [...baseArgs];
  let spawnEnv: NodeJS.ProcessEnv = process.env;

  if (backend === 'claude-code') {
    args.push('-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages');
    if (opts.model) args.push('--model', normalizeModelForClaude(opts.model));
    if (opts.mcpConfig) {
      args.push('--mcp-config', JSON.stringify(opts.mcpConfig));
    }
    if (opts.allowedTools && opts.allowedTools.length > 0) {
      args.push('--allowed-tools', opts.allowedTools.join(' '));
    }
    if (opts.disallowBuiltins) {
      // Deny every Claude Code built-in so a persona brain has ONLY its
      // --mcp-config tools (under bypassPermissions, --allowed-tools does
      // not restrict the surface — this deny-list does).
      args.push('--disallowed-tools', CLAUDE_BUILTIN_TOOLS.join(' '));
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
    if (opts.isolateConfig) {
      // Run against a CLEAN CLAUDE_CONFIG_DIR so the spawn inherits NONE
      // of the host ~/.claude (no `.claude.json` MCP servers, no
      // settings.json/SessionStart hooks, no plugins/skills). Symlink the
      // real OAuth credentials in so Claude-Max auth still works — exactly
      // the codex `auth.json` symlink pattern below. (`--bare` would also
      // isolate but forces ANTHROPIC_API_KEY auth, disabling the OAuth
      // login this box runs on — see plan operator-brain-test-isolation.)
      claudeConfigDir = mkdtempSync(join(tmpdir(), 'claude-chat-'));
      try {
        const realCreds = join(homedir(), '.claude', '.credentials.json');
        if (existsSync(realCreds)) {
          symlinkSync(realCreds, join(claudeConfigDir, '.credentials.json'));
        }
      } catch (err) {
        console.warn('[chat-stream] claude-code: failed to symlink credentials:', err);
      }
      spawnEnv = { ...process.env, CLAUDE_CONFIG_DIR: claudeConfigDir };
    }
  } else if (backend === 'codex') {
    // codex (`codex exec`). Like claude, codex reads the prompt from
    // STDIN via the `-` positional (handled in the stdin block below).
    // `--json` emits JSONL events (one per line, NOT token-streamed);
    // `--skip-git-repo-check` allows running outside a git repo;
    // `--ephemeral` keeps no persistent session/rollout on disk.
    args.push('exec', '--json', '--skip-git-repo-check', '--ephemeral');
    // Sandbox / approval mode. Default read-only; bypassPermissions
    // unlocks full access (lets MCP tool calls + shell run without an
    // interactive approval gate — verified: `read-only` cancels MCP
    // calls with "user cancelled MCP tool call").
    if (opts.permissionMode === 'bypassPermissions') {
      args.push('-s', 'danger-full-access', '--dangerously-bypass-approvals-and-sandbox');
    } else {
      args.push('-s', 'read-only');
    }
    // Model: codex wants a bare id (`gpt-5.5`); strip any `provider/`
    // prefix the same way the claude branch normalizes.
    if (opts.model) args.push('-m', normalizeModelForClaude(opts.model));

    // codex has NO --system-prompt flag and NO inline --mcp-config flag.
    // Both surfaces are configured through a per-spawn CODEX_HOME:
    //   - AGENTS.md  ← systemPromptText (codex's only system-prompt surface)
    //   - config.toml ← [mcp_servers.<name>] blocks (mirrors
    //                    install-standalone-mcp.sh's codex-su TOML shape)
    //   - auth.json  ← symlink to ~/.codex/auth.json (shared ChatGPT login)
    // Created only when one of those is needed; otherwise codex uses the
    // user's real ~/.codex (which already has auth + config).
    if (opts.systemPromptText !== undefined || opts.mcpConfig) {
      codexHome = mkdtempSync(join(tmpdir(), 'codex-chat-'));
      // Share the ChatGPT OAuth login. codex resolves auth from
      // $CODEX_HOME/auth.json; symlink the user's real one in so we
      // don't need an API key (login is via ChatGPT OAuth).
      try {
        const realAuth = join(homedir(), '.codex', 'auth.json');
        if (existsSync(realAuth)) {
          symlinkSync(realAuth, join(codexHome, 'auth.json'));
        }
      } catch (err) {
        console.warn('[chat-stream] codex: failed to symlink auth.json:', err);
      }

      if (opts.systemPromptText !== undefined) {
        // AGENTS.md is codex's only system-prompt surface (it has no
        // --system-prompt / --append-system-prompt flag).
        writeFileSync(join(codexHome, 'AGENTS.md'), opts.systemPromptText, 'utf8');
      }

      spawnEnv = { ...process.env, CODEX_HOME: codexHome };

      if (opts.mcpConfig) {
        // Translate the claude-shape mcpConfig ({ mcpServers: { <name>:
        // { type:'http', url, headers:{Authorization:'Bearer <tok>'} } } })
        // into codex's config.toml [mcp_servers.<name>] blocks. codex does
        // NOT env-expand inside config.toml, so the bearer token is passed
        // via an env var (bearer_token_env_var) and exported in spawnEnv —
        // exactly the pattern install-standalone-mcp.sh uses for
        // papercusp-su. We strip the `Bearer ` prefix for the env value.
        const servers = (opts.mcpConfig as { mcpServers?: Record<string, unknown> }).mcpServers ?? {};
        const tomlLines: string[] = [
          '# Per-spawn codex MCP config (managed by chat-stream.ts).',
        ];
        let bearerIdx = 0;
        for (const [name, raw] of Object.entries(servers)) {
          const srv = raw as {
            type?: string;
            url?: string;
            command?: string;
            args?: string[];
            headers?: Record<string, string>;
            env?: Record<string, string>;
          };
          tomlLines.push('', `[mcp_servers.${tomlKey(name)}]`);
          if (srv.url) {
            // HTTP transport (our agentmcp server).
            tomlLines.push(`url = "${tomlStr(srv.url)}"`);
            const auth = srv.headers?.Authorization ?? srv.headers?.authorization;
            if (auth) {
              const tok = auth.replace(/^Bearer\s+/i, '');
              const envName = `AGENTMCP_BEARER${bearerIdx === 0 ? '' : `_${bearerIdx}`}`;
              bearerIdx += 1;
              tomlLines.push(`bearer_token_env_var = "${envName}"`);
              (spawnEnv as Record<string, string>)[envName] = tok;
            }
            // Any non-Authorization headers pass through verbatim.
            const extra = Object.entries(srv.headers ?? {}).filter(
              ([h]) => h.toLowerCase() !== 'authorization',
            );
            if (extra.length > 0) {
              const hdrInline = extra
                .map(([h, v]) => `"${tomlStr(h)}" = "${tomlStr(v)}"`)
                .join(', ');
              tomlLines.push(`http_headers = { ${hdrInline} }`);
            }
          } else if (srv.command) {
            // stdio transport (forward-compat; agentmcp is HTTP).
            tomlLines.push(`command = "${tomlStr(srv.command)}"`);
            if (srv.args && srv.args.length > 0) {
              tomlLines.push(
                `args = [${srv.args.map((a) => `"${tomlStr(a)}"`).join(', ')}]`,
              );
            }
          }
        }
        writeFileSync(join(codexHome, 'config.toml'), tomlLines.join('\n') + '\n', 'utf8');
      }
    }

    // codex reads the prompt from stdin via the trailing `-` positional
    // (added after finalArgs is built, so it's the last arg).
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
    // --allow-home: when mcpConfig is set, the omp branch below points
    // BOTH `HOME` and the spawn `cwd` at ompAgentDir — HOME for CLAUDE.md
    // suppression, cwd so omp's project-scope `$cwd/mcp.json` scan finds
    // our merged config. But omp, started in a dir that *equals* `~`,
    // auto-switches cwd to a throwaway temp dir — which silently defeats
    // the `$cwd/mcp.json` scan, so agentmcp never loads and the brain
    // runs with zero MCP tools (2026-05-21 P5 root cause; verified with
    // a logging MCP proxy — 0 requests without this flag, full
    // initialize + tools/list handshake with it). Harmless when cwd != ~.
    args.push('--allow-home');

    if (opts.mcpConfig) {
      // Translate claude-shape mcp-config into a per-spawn omp agent dir.
      // omp loads PI_CODING_AGENT_DIR/mcp.json on startup; PI_CODING_AGENT_DIR
      // is the FULL agent state directory, NOT just an mcp.json holder
      // (it also contains auth.json — Meridian/Anthropic OAuth — plus
      // config.json, claude-bridge.json, the session DB, and blobs).
      //
      // Earlier versions of this code pointed PI_CODING_AGENT_DIR at a
      // fresh tmpdir with ONLY mcp.json, which silently broke every omp
      // invocation that passed mcpConfig: auth.json was missing → omp
      // could not authenticate to Meridian → produced zero output and
      // exited 0 (silent failure). Symptom: oracle "thinking" then
      // empty response; operator-scan returns done event with 0 deltas.
      //
      // The fix: copy the user's existing agent dir into our tmpdir
      // (so auth + config carry over), then OVERWRITE mcp.json with
      // the union of the user's existing servers plus the caller's.
      const realAgentDir = process.env.PI_CODING_AGENT_DIR
        ?? join(homedir(), '.omp', 'agent');
      ompAgentDir = mkdtempSync(join(tmpdir(), 'omp-chat-'));
      // Copy the small per-agent metadata files (auth, config, bridge,
      // model-roles yaml). Also includes agent.db so the MCP tool
      // cache (mcp_tools:* rows) carries over — without it, omp's
      // 250ms STARTUP_TIMEOUT_MS expires before our HTTP MCP server
      // can return tools/list (especially for papercusp-su which
      // serves 100+ tools). Cached tools are surfaced as
      // DeferredMCPTool while the real connection finishes in the
      // background, so the model sees the full surface immediately.
      // Threads/jobs in agent.db are session-keyed and don't pollute
      // a fresh spawn. NOT blobs (large file cache).
      //
      // config.yml is the most important: it carries `modelRoles`
      // which selects the Anthropic-via-Meridian provider. Without it,
      // omp falls back to the claude-bridge provider, which fails with
      // "Claude Code native binary not found" if @anthropic-ai/
      // claude-agent-sdk-linux-x64-musl isn't installed at the path
      // omp expects (and on this workspace it isn't). Symptom: omp
      // exits 0 but message_start carries an errorMessage, no deltas,
      // empty finalText.
      for (const f of [
        'auth.json',          // Meridian/Anthropic OAuth tokens
        'config.json',        // user prefs
        'config.yml',         // modelRoles → selects anthropic provider
        'models.json',        // **provider config: baseUrl=http://127.0.0.1:3456 (Meridian)**
        'models.yml',         // models.json's yaml twin
        'claude-bridge.json', // claude-bridge tool config (askClaude etc.)
        'agent.db',           // cache table holds mcp_tools:* — needed for fast cold-start MCP surface
      ]) {
        const src = join(realAgentDir, f);
        if (existsSync(src)) {
          try { cpSync(src, join(ompAgentDir, f)); } catch { /* best-effort */ }
        }
      }

      // Per-spawn-unique Meridian agent identity (2026-05-21 P5 bug #5
      // core root cause). The engineer's models.json/models.yml set
      // `providers.*.headers.x-meridian-agent: pi` — `pi` is the SHARED
      // omp identity every omp process on the box uses. Meridian keys
      // context (system prompt + tool set + prompt cache) by that name,
      // so all `pi` traffic is folded into ONE shared context. A brain
      // spawn that inherits `pi` has its request's `system` + `tools`
      // OVERRIDDEN by whatever other `pi` agent is live — e.g. the
      // engineer's Claude Code session — so the model never sees its 228
      // agentmcp tools, reports "no such tool", and confabulates. (The
      // engineer's normal omp agents are unaffected: they all expect the
      // same shared fleet, so sharing is harmless for them; only a brain
      // that uniquely needs `agentmcp` breaks.) Verified by direct
      // Meridian probe: identical request with `x-meridian-agent: pi`
      // ignores the request's tools and returns a foreign session's
      // toolset; with a fresh unique name the tools pass through and the
      // model calls them. Rewrite to a per-spawn-unique value so Meridian
      // gives this brain an isolated context. Per-spawn (not per-role)
      // so concurrent brain spawns never cross-contaminate each other.
      const meridianAgent = `papercup-brain-${basename(ompAgentDir)}`;
      for (const modelFile of ['models.json', 'models.yml']) {
        const modelPath = join(ompAgentDir, modelFile);
        if (!existsSync(modelPath)) continue;
        try {
          const yaml = await import('yaml');
          const isJson = modelFile.endsWith('.json');
          const raw = readFileSync(modelPath, 'utf8');
          const parsed = (isJson ? JSON.parse(raw) : yaml.parse(raw)) as
            | { providers?: Record<string, { headers?: Record<string, string> }> }
            | null;
          if (parsed && parsed.providers && typeof parsed.providers === 'object') {
            for (const provider of Object.values(parsed.providers)) {
              if (!provider || typeof provider !== 'object') continue;
              const headers = (provider.headers ??= {} as Record<string, string>);
              headers['x-meridian-agent'] = meridianAgent;
            }
            writeFileSync(
              modelPath,
              isJson ? JSON.stringify(parsed, null, 2) : yaml.stringify(parsed),
              'utf8',
            );
          }
        } catch (err) {
          console.warn(`[chat-stream] failed to rewrite ${modelFile} x-meridian-agent:`, err);
        }
      }

      // mcp.json: ONLY the caller-provided servers (e.g. agentmcp).
      // Deliberately NOT merged with the engineer's personal
      // ~/.omp/agent/mcp.json. A papercusp brain (operator / oracle /
      // agent-chat) works entirely through agentmcp; it has no use for
      // playwright / voice-mode / hindsight / plur, which are stdio
      // servers. omp connects to EVERY configured server at startup and
      // blocks on uncached ones until their handshake settles — cold-
      // spawning the engineer's npx-based stdio MCP fleet on every brain
      // turn pushed operator:converse past its 600s timeout once
      // --allow-home made mcp.json actually load (2026-05-21 P5).
      writeFileSync(
        join(ompAgentDir, 'mcp.json'),
        JSON.stringify({ mcpServers: opts.mcpConfig.mcpServers ?? {} }),
        'utf8',
      );

      // Disable omp's MCP tool-discovery mode for papercusp brain
      // spawns. The user's global config carries tools.discoveryMode=
      // mcp-only for their own coding sessions; for a brain spawn that
      // is wrong twice over: (a) discovery gates agentmcp's tools behind
      // a search_tool_bm25 step the model does not reliably take — it
      // concludes "no tools" and confabulates; and (b) — observed
      // 2026-05-21 P5 — an omp run with discovery on does not exit after
      // the turn completes, hanging operator:converse until its 600s
      // timeout (diag: discovery-on omp exit=124, discovery-off exit=0,
      // all else identical). mcp.json holds only agentmcp now, so there
      // is nothing to "discover" — load every tool directly. PER-SPAWN;
      // the user's real ~/.omp/agent/config.yml is untouched.
      try {
        const configPath = join(ompAgentDir, 'config.yml');
        if (existsSync(configPath)) {
          const yaml = await import('yaml');
          const parsed = (yaml.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown> | null) ?? {};
          const tools = (parsed.tools ??= {} as Record<string, unknown>) as Record<string, unknown>;
          tools.discoveryMode = 'off';
          const mcp = (parsed.mcp ??= {} as Record<string, unknown>) as Record<string, unknown>;
          mcp.discoveryMode = false;
          // Disable omp's local memory backend for brain spawns.
          // chat-stream copies the engineer's agent.db (for auth/model
          // config); with memories enabled omp injects the ENGINEER's
          // accumulated omp memories into the brain's system prompt, and
          // the operator brain recites that stale papercup state
          // (feature ids, escalations, server names like papercusp-su)
          // as if it were live data it had retrieved — the 2026-05-21 P5
          // confabulation. The brain must read live state through
          // agentmcp tools and nothing else.
          const memories = (parsed.memories ??= {} as Record<string, unknown>) as Record<string, unknown>;
          memories.enabled = false;
          writeFileSync(configPath, yaml.stringify(parsed), 'utf8');
        }
      } catch (err) {
        // Non-fatal: if yaml parsing fails, we still have a working config.
        console.warn('[chat-stream] failed to disable omp discovery mode:', err);
      }

      // Redirect HOME to the scoped agent dir. Otherwise omp's `claude`
      // discovery provider (node_modules/@oh-my-pi/pi-coding-agent/src/
      // discovery/claude.ts) scans `$HOME/.claude/` and pulls in the
      // user's CLAUDE.md as system context — on engineer workstations
      // that file says "you are the engineer-collaborator working with
      // Papercusp engineers," which makes the operator brain refuse to
      // roleplay as the Operator and emit a coherent role-refusal
      // instead of operator output (2026-05-21 P5 root cause). PI_CODING_AGENT_DIR
      // continues to point at the same scoped dir, so omp's own
      // ~/.omp/agent state discovery still resolves correctly.
      // ompAgentDir has no `.claude/` subdir → omp's claude provider
      // finds nothing → brain runs with only the supplied prompt.
      spawnEnv = { ...process.env, HOME: ompAgentDir, PI_CODING_AGENT_DIR: ompAgentDir };
    }

    if (opts.allowedTools && opts.allowedTools.length > 0) {
      // omp `--tools` allow-lists built-in tool names. MCP tools are
      // surfaced through the mcp.json path (see PI_CODING_AGENT_DIR
      // and mcp.discoveryDefaultServers above), not via --tools.
      //
      // Strictly safer than a hardcoded built-in name Set: passes through
      // every non-MCP name to omp. omp ignores unknown names so this is
      // forward-compatible with new built-ins (e.g. future `web_search`)
      // without requiring a sync edit here.
      const ompTools = opts.allowedTools.filter((t) => !t.startsWith('mcp__'));
      if (ompTools.length > 0) args.push('--tools', ompTools.join(','));
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
  //
  // When `systemPromptText` is provided, write it to a separate file
  // and pass it via `--append-system-prompt` so the operator/oracle
  // persona is ADDED to omp's default prompt. Without the system/user
  // split, persona+playbook content lands in the user-message slot and
  // the model meta-comments on it instead of acting on it.
  const finalArgs = [...args];
  let ompSystemPromptFile: string | undefined;
  if (backend === 'omp') {
    const promptDir = ompAgentDir ?? mkdtempSync(join(tmpdir(), 'omp-prompt-'));
    if (!ompAgentDir) ompAgentDir = promptDir; // reuse cleanup
    if (opts.systemPromptText !== undefined) {
      ompSystemPromptFile = join(promptDir, 'system.md');
      writeFileSync(ompSystemPromptFile, opts.systemPromptText, 'utf8');
      // Two things this line gets right, both 2026-05-21 P5 bug #5:
      //
      // 1. `--append-system-prompt`, NOT `--system-prompt`. omp's
      //    `--system-prompt` REPLACES omp's default prompt; that default
      //    is what grounds the model as an omp agent ("you have these
      //    tools, use them to complete the task"). Stripped of it the
      //    brain reverts to its training prior — claude-opus-4-7's prior
      //    is Claude Code — and opens the turn with the Claude-Code
      //    `WaitForMcpServers` startup reflex. omp has no such tool, the
      //    call fails, and the brain concludes MCP is unavailable and
      //    confabulates instead of calling its (real, connected) tools.
      //    `--append-system-prompt` keeps omp's grounding and layers the
      //    persona AFTER it (persona wins on any conflict). Verified:
      //    `--system-prompt` → 5x WaitForMcpServers / 0 real tool calls;
      //    `--append-system-prompt` → 0 WaitForMcpServers.
      //
      // 2. BARE FILE PATH, not `@file`. omp's resolvePromptInput() does
      //    `Bun.file(value).text()` directly; a leading `@` makes the
      //    path nonexistent, the ENOENT is silently swallowed, and omp
      //    falls back to the literal string `@/tmp/.../system.md` as the
      //    prompt — persona never reaches the model (model-API proxy:
      //    systemChars 1370 with `@`, ~73k as a bare path appended to
      //    omp's default). The `@` IS correct for the positional message
      //    arg below — that path goes through omp's file-processor which
      //    does expand `@file`. Only the prompt flags differ.
      finalArgs.push('--append-system-prompt', ompSystemPromptFile);
    }
    ompPromptFile = join(promptDir, 'prompt.md');
    writeFileSync(ompPromptFile, opts.promptText, 'utf8');
    finalArgs.push(`@${ompPromptFile}`);
  } else if (backend === 'codex') {
    // codex reads the prompt from STDIN via the trailing `-` positional —
    // it must be the LAST arg (everything after it is treated as the
    // positional prompt source). The prompt itself is written to
    // child.stdin in the stdin block below, exactly like the claude branch.
    finalArgs.push('-');
  } else if (backend === 'claude-code' && opts.systemPromptText !== undefined) {
    // claude-code's `-p` mode otherwise runs with its DEFAULT Claude Code
    // coding-agent system prompt — so a persona caller (operator/oracle
    // brain, sim-user, judge) that only sets `systemPromptText` would be
    // ignored: the spawn behaves as a generic coding agent (reads the cwd
    // CLAUDE.md, asks "what would you like to work on?") instead of BEING
    // the persona, which breaks every persona turn. Pass the persona via
    // `--system-prompt-file` (REPLACE — matches the meridian backend's
    // `params.system = systemPromptText`, NOT omp's append-to-default).
    // The persona is large (~70k chars), so a file, not an inline arg.
    // Written into claudeConfigDir when isolated (shares its cleanup),
    // else a dedicated tmpdir tracked via claudeSysDir.
    const sysDir = claudeConfigDir ?? (claudeSysDir = mkdtempSync(join(tmpdir(), 'claude-sys-')));
    const sysFile = join(sysDir, 'system.md');
    writeFileSync(sysFile, opts.systemPromptText, 'utf8');
    finalArgs.push('--system-prompt-file', sysFile);
  }

  // omp's MCP discovery uses os.homedir() for the user-scope mcp.json
  // and spawn-cwd for the project-scope mcp.json — it does NOT honor
  // PI_CODING_AGENT_DIR for MCP loading (that env var is only for
  // sessions/prompts/etc). To make our merged mcp.json visible we run
  // omp with cwd = ompAgentDir, so its project-level scan
  // ($cwd/mcp.json) lands on the file we just wrote. For an isolated
  // claude-code spawn, run in the clean config dir (no project CLAUDE.md)
  // so the persona spawn doesn't inherit the repo's agent guide as context.
  const spawnCwd = ompAgentDir ?? claudeConfigDir ?? opts.cwd;

  let child: ChildProcess;
  try {
    child = spawn(command, finalArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: spawnCwd,
      env: spawnEnv,
    });
  } catch (e) {
    if (ompAgentDir) {
      try { rmSync(ompAgentDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    if (codexHome) {
      try { rmSync(codexHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    if (claudeConfigDir) {
      try { rmSync(claudeConfigDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    if (claudeSysDir) {
      try { rmSync(claudeSysDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    yield { type: 'error', message: `failed to spawn ${agentCmd}: ${(e as Error).message}` };
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

  /**
   * codex `exec --json` event handler. codex emits JSONL (one event per
   * line), NOT token-streamed. Observed shapes (verified codex 0.135.0):
   *   {type:'thread.started', thread_id}                       → ignore
   *   {type:'turn.started'}                                    → ignore
   *   {type:'item.started',  item:{...}}                       → ignore (we
   *                                                              act on the
   *                                                              matching
   *                                                              item.completed)
   *   {type:'item.completed', item:{type:'agent_message', text}}
   *       → assistant text (WHOLE blob): emit one delta + accumulate finalText
   *   {type:'item.completed', item:{type:'mcp_tool_call',
   *       server, tool, arguments, status}}                    → tool_call
   *   {type:'item.completed', item:{type:'command_execution',
   *       command, exit_code, status}}                         → tool_call
   *   {type:'turn.completed', usage:{input_tokens,
   *       cached_input_tokens, output_tokens,
   *       reasoning_output_tokens}}                            → terminal usage
   *                                                              (cost derived
   *                                                              from CODEX_PRICES;
   *                                                              codex emits NO
   *                                                              cost field)
   *
   * Tool items arrive twice — once as item.started (status 'in_progress')
   * and once as item.completed (status 'completed'/'failed'). We emit the
   * tool_call on the COMPLETED item only (full arguments present, no
   * double-emit).
   */
  const handleCodexEvent = (ev: any) => {
    if (!ev || typeof ev !== 'object') return;

    if (ev.type === 'item.completed' && ev.item && typeof ev.item === 'object') {
      const item = ev.item;
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        // codex emits the assistant message as one whole blob (not token
        // deltas). Emit it as a single delta and accumulate finalText.
        finalText += item.text;
        queue.push({ type: 'delta', text: item.text });
        return;
      }
      if (item.type === 'mcp_tool_call') {
        // MCP tool name lives on item.tool (NOT item.name); args on
        // item.arguments. item.server names the configured server.
        const rawName = typeof item.tool === 'string' ? item.tool : '';
        if (!rawName) return;
        const filtered = opts.toolEventFilter ? opts.toolEventFilter(rawName) : rawName;
        if (filtered) {
          queue.push({ type: 'tool_call', name: filtered, input: item.arguments ?? {} });
        }
        return;
      }
      if (item.type === 'command_execution') {
        // codex's built-in shell tool. Surface it as a `shell` tool_call
        // (subject to toolEventFilter like every other backend).
        const filtered = opts.toolEventFilter ? opts.toolEventFilter('shell') : 'shell';
        if (filtered) {
          queue.push({
            type: 'tool_call',
            name: filtered,
            input: { command: item.command ?? '', exit_code: item.exit_code ?? null },
          });
        }
        return;
      }
      return;
    }

    if (ev.type === 'turn.completed' && ev.usage && typeof ev.usage === 'object') {
      const u = ev.usage;
      // input_tokens already includes cached_input_tokens in codex's
      // accounting; keep the raw total for tokensIn.
      tokensIn = (u.input_tokens ?? tokensIn);
      tokensOut = (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
      // codex emits NO cost field — derive from the price table.
      const p = codexPriceFor(opts.model ? normalizeModelForClaude(opts.model) : undefined);
      costUsd = (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
      return;
    }
  };

  const handle =
    backend === 'codex'
      ? handleCodexEvent
      : backend === 'omp'
        ? handleOmpEvent
        : handleClaudeEvent;

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

  // claude AND codex read the prompt on stdin (codex via its trailing `-`
  // positional); omp reads it from a `@file` positional arg (handled in
  // finalArgs above). For omp we still close stdin so the child doesn't
  // block waiting for input that won't come.
  if (backend === 'omp') {
    child.stdin!.end();
  } else {
    child.stdin!.write(opts.promptText);
    child.stdin!.end();
  }

  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let exited = false;
  child.on('exit', (code, signal) => { exitCode = code; exitSignal = signal; exited = true; tick(); });
  child.on('error', () => { exited = true; tick(); });

  // RB review #6 — wall-clock turn timeout backstop. A subprocess that hangs (never exits,
  // never streams) would otherwise wedge an un-signaled caller forever; the orchestrator passes
  // its own AbortSignal/deadline, but ungoverned/interactive callers may not. On expiry we set
  // `timedOut` (→ classified `timeout`, retryable) and SIGTERM, escalating to SIGKILL after a
  // short grace. Default 15 min — generous, so a caller's own shorter deadline usually fires first.
  let timedOut = false;
  const TURN_TIMEOUT_MS = Number(process.env.PAPERCUSP_AGENT_TURN_TIMEOUT_MS ?? 900_000);
  const turnTimer =
    TURN_TIMEOUT_MS > 0
      ? setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGTERM'); } catch { /* ignore */ }
          setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 5_000).unref?.();
          tick();
        }, TURN_TIMEOUT_MS)
      : null;
  turnTimer?.unref?.();

  // Drain loop.
  while (true) {
    while (queue.length > 0) {
      yield queue.shift()!;
    }
    if (exited) break;
    await new Promise<void>((resolve) => { resolveTick = resolve; });
  }

  if (turnTimer) clearTimeout(turnTimer);
  if (opts.signal) opts.signal.removeEventListener('abort', onAbort);

  // Silent-failure surfacing: an agent that exits 0 with no text is
  // almost always a misconfigured per-spawn agent dir (missing auth or
  // provider config — see the omp branch above). Log the command +
  // stderr so it is diagnosable, instead of bubbling up to the caller
  // as a blank turn.
  if (exitCode === 0 && finalText.trim() === '') {
    console.error(
      `[chat-stream] ${backend} exited 0 with EMPTY output. ` +
        `cmd: ${command} ${finalArgs.join(' ')} | cwd: ${spawnCwd ?? '(default)'} | ` +
        `stderr: ${stderrBuf.slice(-1500) || '(none)'}`,
    );
  }

  if (ompAgentDir) {
    if (process.env.PAPERCUSP_AGENT_DEBUG) {
      console.error(`[chat-stream] PAPERCUSP_AGENT_DEBUG — preserving agent dir: ${ompAgentDir}`);
    } else {
      try { rmSync(ompAgentDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
  if (codexHome) {
    if (process.env.PAPERCUSP_AGENT_DEBUG) {
      console.error(`[chat-stream] PAPERCUSP_AGENT_DEBUG — preserving CODEX_HOME: ${codexHome}`);
    } else {
      try { rmSync(codexHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
  if (claudeConfigDir) {
    if (process.env.PAPERCUSP_AGENT_DEBUG) {
      console.error(`[chat-stream] PAPERCUSP_AGENT_DEBUG — preserving CLAUDE_CONFIG_DIR: ${claudeConfigDir}`);
    } else {
      try { rmSync(claudeConfigDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
  if (claudeSysDir) {
    if (process.env.PAPERCUSP_AGENT_DEBUG) {
      console.error(`[chat-stream] PAPERCUSP_AGENT_DEBUG — preserving claude system-prompt dir: ${claudeSysDir}`);
    } else {
      try { rmSync(claudeSysDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }

  // RB-012/RB-005 — classify the subprocess TURN outcome and, on rate-limit/overload,
  // penalize the SHARED governor so concurrent callers back off (no re-spawn here). Only on
  // the governed path; cheap + side-effect-free otherwise. The classified turn is also
  // attached to the terminal error event so a consumer can pause/resume (RB-006).
  let cliTurn: TurnError | undefined;
  if (governed) {
    cliTurn = classifyTurnError(
      backend as TurnBackend,
      { exitCode, signal: exitSignal, stderr: stderrBuf, stdout: finalText, timedOut },
      Date.now(),
    );
    if (isAccountWide(cliTurn.class)) {
      // rate_limited/overloaded (transient) AND usage_limit (plan cap) all pause the shared
      // bucket so concurrent CLI spawns back off together (D-001).
      governorForBackend(backend as TurnBackend, opts.model ?? '').penalize({
        retryAfterMs: cliTurn.retryAfterMs,
        resetAt: cliTurn.resetAt,
      });
    }
  }

  if (exitCode !== 0) {
    yield {
      type: 'error',
      message: `${backend} exited ${exitCode ?? '?'}`,
      stderr: stderrBuf.slice(-800),
      ...(cliTurn ? { turn: cliTurn } : {}),
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
  } finally {
    // Release the shared concurrency permit (no-op when ungoverned). Runs on normal exit, the
    // spawn-failure early return, an abort, and a consumer that abandons the generator early.
    releaseGovernor?.();
  }
}
