'use client';

import { useEffect, useState } from 'react';

/**
 * Single-source-of-truth role list for chat surfaces. Fetches from
 * `/api/harness/<slug>/prompts` (which derives from the global prompts
 * dir via lib/known-roles.ts) so OracleDock, PiTerminalsDock, and any
 * other client picker share one list and can never drift from disk.
 *
 * `feedback` and `expert` are excluded by default — `feedback` is
 * ephemeral (no chat surface) and `expert` is instanced (one per
 * feature area; has its own UI). Pass exclude=[] to opt out.
 */
const DEFAULT_EXCLUDE = new Set(['feedback', 'expert']);

const FALLBACK_ROLES: string[] = [
  'worker', 'validator', 'scoper', 'reviewer', 'architect',
  'orchestrator', 'documenter', 'summarizer', 'curator', 'debugger',
  'project_manager',
];

export function useAgentRoles(slug: string | null | undefined, exclude: Iterable<string> = DEFAULT_EXCLUDE): string[] {
  const [roles, setRoles] = useState<string[]>(FALLBACK_ROLES);
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/prompts`, { cache: 'no-store' });
        if (!r.ok) return;
        const d: unknown = await r.json();
        const all = (d as { roles?: unknown })?.roles;
        if (!Array.isArray(all)) return;
        const ex = exclude instanceof Set ? exclude : new Set(exclude);
        const filtered = all
          .filter((x): x is string => typeof x === 'string')
          .filter((r) => !ex.has(r));
        if (!cancelled && filtered.length > 0) setRoles(filtered);
      } catch { /* keep fallback */ }
    })();
    return () => { cancelled = true; };
  }, [slug, exclude]);
  return roles;
}
