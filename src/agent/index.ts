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
  AGENT_BACKENDS,
  SUBPROCESS_AGENT_BACKENDS,
  type AgentBackend,
  type ChatEvent,
  type RunAgentChatOptions,
} from './chat-stream';
