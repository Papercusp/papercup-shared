export type ProviderErrorClass =
  | 'rate_limited' | 'usage_limit' | 'overloaded' | 'timeout'
  | 'transient_io' | 'auth' | 'context_overflow' | 'permanent';

export const MALFORMED_AUTH_HEADER_RE: RegExp;

export function classifyProviderError(input: {
  status?: number | null;
  code?: string;
  message?: string;
}): {
  class: ProviderErrorClass;
  retryable: boolean;
  pattern?: RegExp;
  retryAfterMs?: number;
} | null;
