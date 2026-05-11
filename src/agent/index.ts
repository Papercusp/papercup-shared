/**
 * Server-only entry point. Pull this from API routes / server modules
 * via `@restart/papercup-shared/agent`. Don't import from a client
 * component — this module reaches `node:child_process` and Turbopack
 * will refuse to bundle it for the client. (We don't pull in the
 * `server-only` marker package since it isn't a workspace dep; the
 * sub-export boundary alone keeps it out of the client graph.)
 */
export {
  runAgentChat,
  setAgentConfigBootstrap,
  resolveBackend,
  resolveAgentBin,
  type AgentBackend,
  type ChatEvent,
  type RunAgentChatOptions,
} from './chat-stream';

// Backwards-compatible aliases for the pre-rename identifiers. The
// `claude`-prefixed names were legacy from when claude-code was the
// only backend; the abstraction is backend-agnostic now (omp by
// default). Kept as deprecated re-exports so external consumers don't
// have to update in lockstep. Remove after one release cycle.
export { runAgentChat as runClaudeChat } from './chat-stream';
export type { RunAgentChatOptions as RunClaudeChatOptions } from './chat-stream';
