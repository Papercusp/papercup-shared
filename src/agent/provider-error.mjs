// Provider-neutral policy shared by governed turns and the standalone PTY host.
// Adapters supply actual failure evidence; ordinary transcript prose is not an error.
import { MODEL_CAPACITY_RE, modelCapacityRetryAfterMs, parseRetryHintMs } from './model-capacity.mjs';

export const MALFORMED_AUTH_HEADER_RE = /failed to convert header to a str for header name ['"]authorization['"]/i;
const AUTH_RE = /(\b401\b|\b403\b|\bunauthorized\b|\bforbidden\b|\binvalid api key\b|\bauthentication\b|failed to convert header to a str for header name ['"]authorization['"])/i;
const CONTEXT_RE = /autocompact(?:ion)? is thrashing|prompt is too long|input (?:length )?is too long|\bcontext[_ -]?length[_ -]?exceeded\b|maximum context length|input length and `?max_tokens`? exceed|exceeds? the (?:model'?s )?maximum (?:context|(?:number of )?(?:input )?tokens)|reduce the length of (?:the )?(?:messages|prompt|input)/i;
const USAGE_RE = /(usage limit|session limit|weekly limit|monthly limit|daily limit|\d+-?hour limit|hit your (?:session|usage|weekly|monthly|daily) limit|insufficient_quota|quota exceeded|exceeded your (?:current )?quota|out of (?:credits|quota)|credit_balance_exhausted|(?:project|organization)_(?:spend|usage)_limit_exceeded)/i;
const TRANSIENT_OVERRIDE_RE = /temporarily limiting|not (?:your|a) (?:usage|session|weekly|monthly|daily) limit/i;
const RATE_RE = /(\b429\b|rate.?limit|too many requests|slow down|temporarily limiting)/i;
const OVERLOAD_RE = /(\b529\b|overloaded|service unavailable|\b50[0234]\b)/i;
const TIMEOUT_RE = /(\b408\b|timed? ?out|deadline exceeded)/i;
const IO_RE = /(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|network|fetch failed)/i;

/** @typedef {'rate_limited'|'usage_limit'|'overloaded'|'timeout'|'transient_io'|'auth'|'context_overflow'|'permanent'} ProviderErrorClass */

/** Classify a provider failure, preserving status/code authority over generic prose.
 * Unknown failures return null so each transport retains its existing fallback.
 * @param {{status?: number|null, code?: string, message?: string}} input
 * @returns {{class: ProviderErrorClass, retryable: boolean, pattern?: RegExp, retryAfterMs?: number}|null}
 */
export function classifyProviderError({ status, code = '', message = '' }) {
  const st = Number.isInteger(status) ? status : undefined;
  const text = String(message);
  const reason = String(code);
  /** @param {ProviderErrorClass} cls @param {RegExp} [pattern] */
  const result = (cls, pattern) => ({
    class: cls,
    retryable: ['rate_limited', 'overloaded', 'timeout', 'transient_io'].includes(cls),
    pattern,
    retryAfterMs: MODEL_CAPACITY_RE.test(text)
      ? modelCapacityRetryAfterMs(text) : parseRetryHintMs(text),
  });
  if (/^(?:invalid_request(?:_error)?|bad_request|unsupported_model)$/.test(reason)) return result('permanent');
  if (st === 401 || st === 403 || /^(?:unauthorized|authentication_failed|permission_denied)$/.test(reason)) {
    return result('auth', AUTH_RE);
  }
  if (CONTEXT_RE.test(text) || /^(?:context_window_exceeded|context_length_exceeded)$/.test(reason)) {
    return result('context_overflow', CONTEXT_RE);
  }
  if (USAGE_RE.test(reason) || USAGE_RE.test(text) && !TRANSIENT_OVERRIDE_RE.test(text)
    && (st === 429 || st === undefined)) return result('usage_limit', USAGE_RE);
  if (st === 429 || st === undefined && (RATE_RE.test(text) || RATE_RE.test(reason) || TRANSIENT_OVERRIDE_RE.test(text))) {
    return result('rate_limited', RATE_RE);
  }
  if (reason === 'server_overloaded' || [500, 502, 503, 504, 529].includes(st)
    || st === undefined && OVERLOAD_RE.test(text)) return result('overloaded', OVERLOAD_RE);
  if (st === undefined && MODEL_CAPACITY_RE.test(text)) return result('rate_limited', MODEL_CAPACITY_RE);
  if (st === 408 || st === undefined && TIMEOUT_RE.test(text)) return result('timeout', TIMEOUT_RE);
  if (st === undefined && AUTH_RE.test(text)) return result('auth', AUTH_RE);
  if (st === undefined && IO_RE.test(text)) return result('transient_io', IO_RE);
  if (st !== undefined && st >= 400 && st < 500) return result('permanent');
  return null;
}
