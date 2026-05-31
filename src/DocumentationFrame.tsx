'use client';

import { useEffect, useRef, useState } from 'react';

interface Props {
  src: string;
  /** When set, deep-link the iframe to docs relevant to this harness. */
  harnessSlug?: string | null;
}

const QUICK_LINKS = [
  { label: 'How it works', path: '/overview/how-it-works/' },
  { label: 'Decisions', path: '/decisions/log/' },
  { label: 'Framework comparison', path: '/compared/overview/' },
  { label: 'Operating', path: '/operating/config/' },
];

// Map a harness slug to a starting docs path. Department harnesses (anything
// matching `*-org-<dept>` or `org-<dept>`) share /org/charter/; everything
// else lands in /architecture/. The slug pattern itself is the indicator —
// no compile-time list of departments.
function harnessDocsPath(slug: string): string {
  if (/(?:^|-)(?:org)-[a-z0-9_-]+$/.test(slug)) return '/org/charter/';
  return '/architecture/';
}

// Best-effort label for the department portion of a slug. The dept name
// is the suffix after the final `-org-` segment (or after `org-` for the
// plain `org-<dept>` form).
function deptLabelFromSlug(slug: string): string | null {
  const m = slug.match(/(?:^|-)org-([a-z0-9_-]+)$/);
  if (!m) return null;
  const raw = m[1];
  if (raw === 'rd') return 'R&D';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export default function DocumentationFrame({ src, harnessSlug }: Props) {
  const [isUp, setIsUp] = useState<boolean | null>(null);
  const initialSrc = harnessSlug ? `${src}${harnessDocsPath(harnessSlug)}` : src;
  const [iframeSrc, setIframeSrc] = useState<string>(initialSrc);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        await fetch(src, { method: 'HEAD', mode: 'no-cors' });
        if (!cancelled) setIsUp(true);
      } catch {
        if (!cancelled) setIsUp(false);
      }
    };
    probe();
    return () => { cancelled = true; };
  }, [src]);

  // If the harness param changes after mount (rare — page reloads usually),
  // re-point the iframe to the harness-specific landing.
  useEffect(() => {
    setIframeSrc(harnessSlug ? `${src}${harnessDocsPath(harnessSlug)}` : src);
  }, [harnessSlug, src]);

  // Update the iframe by setting `contentWindow.location` so the user
  // doesn't get bounced to the docs origin in a new tab.
  const navigateInline = (path: string) => {
    const url = `${src}${path.startsWith('/') ? path : '/' + path}`;
    setIframeSrc(url);
    try {
      iframeRef.current?.contentWindow?.location?.replace(url);
    } catch {
      // Cross-origin replace will throw; setting `src` already triggers a load.
    }
  };

  return (
    <div className="pc-page pc-docs-page">
      <section className="pc-docs-hero" aria-label="Papercup documentation overview">
        <div>
          <div className="pc-eyebrow"><span className="pc-eyebrow-dot" /> Harness reference{harnessSlug ? ` · ${deptLabelFromSlug(harnessSlug) ?? harnessSlug}` : ''}</div>
          <h1>{harnessSlug ? `Documentation for ${deptLabelFromSlug(harnessSlug) ?? harnessSlug}.` : 'Documentation stays docked beside the live operating console.'}</h1>
          <p className="pc-lede">{harnessSlug ? `Showing the docs section most relevant to this harness. Use the shortcuts to navigate.` : 'Read the framework notes, runtime decisions, and comparison material without leaving Papercup.'}</p>
        </div>
        <div className="pc-docs-actions">
          <a className="pc-action primary" href={src} target="_blank" rel="noreferrer">Open docs site ↗</a>
          <span className={`pc-docs-status ${isUp === false ? 'warn' : 'good'}`}>{isUp === false ? 'offline' : isUp === true ? 'online' : 'checking'}</span>
        </div>
      </section>
      <nav className="pc-docs-quick" aria-label="Documentation shortcuts">
        <button type="button" onClick={() => navigateInline('/')}>Home</button>
        {QUICK_LINKS.map((q) => (
          <button key={q.path} type="button" onClick={() => navigateInline(q.path)}>{q.label}</button>
        ))}
      </nav>
      {isUp === false && (
        <div className="pc-empty pc-docs-warning">
          <strong>Docs site not reachable.</strong> The Starlight app should be running at <code>{src}</code>.
          <span>Start it with: <code>npm run --workspace=@papercusp/papercup-docs dev</code></span>
        </div>
      )}
      <section className="pc-docs-frame-shell" aria-label="Embedded Papercup documentation">
        <iframe
          ref={iframeRef}
          src={iframeSrc}
          title="Papercup harness documentation"
          className="pc-docs-frame"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        />
      </section>
    </div>
  );
}
