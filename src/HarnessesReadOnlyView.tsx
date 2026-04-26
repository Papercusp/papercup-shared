'use client';

import { useEffect, useState } from 'react';

export interface HarnessRow {
  slug: string;
  director: string;
  passed: number;
  total: number;
  inProgress: number;
  failing: number;
  iteration: number;
  alive: boolean;
  lastRunMs: number | null;
  costUsd?: number | null;
  // Department messaging activity
  inboxTotal?: number;
  inboxPending?: number;
  outboxTotal?: number;
  lastActivityMs?: number | null;
  mandate?: string | null;
}

export interface HarnessesSnapshot {
  harnesses: HarnessRow[];
}

export interface HarnessesReadOnlyViewProps {
  data: HarnessesSnapshot | null;
  loading?: boolean;
  error?: string | null;
  liveAt?: number | null;
}

const DIRECTOR_LABELS: Record<string, string> = {
  business: 'Business',
  rd: 'R&D',
  technology: 'Technology',
  management: 'Management',
  marketing: 'Marketing',
};

function formatDirector(slug: string): string {
  return DIRECTOR_LABELS[slug] ?? slug.replace(/^./, (c) => c.toUpperCase());
}

function formatRelative(ms: number | null): string {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatCost(usd: number | null | undefined): string {
  if (usd == null || Number.isNaN(usd)) return '—';
  if (usd < 0.01) return '<$0.01';
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString()}`;
}

export default function HarnessesReadOnlyView({ data, loading, error, liveAt }: HarnessesReadOnlyViewProps) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  void tick;

  const rows = data?.harnesses ?? [];
  const aliveCount = rows.filter((r) => r.alive).length;
  const inProgressTotal = rows.reduce((a, r) => a + (r.inProgress ?? 0), 0);
  const failingTotal = rows.reduce((a, r) => a + (r.failing ?? 0), 0);
  const passedTotal = rows.reduce((a, r) => a + (r.passed ?? 0), 0);
  const totalTotal = rows.reduce((a, r) => a + (r.total ?? 0), 0);
  const costTotal = rows.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  const inboxPendingTotal = rows.reduce((a, r) => a + (r.inboxPending ?? 0), 0);
  const inboxTotal = rows.reduce((a, r) => a + (r.inboxTotal ?? 0), 0);
  const outboxTotal = rows.reduce((a, r) => a + (r.outboxTotal ?? 0), 0);
  const newestActivityMs = rows.reduce<number | null>((a, r) => {
    const ms = r.lastActivityMs ?? null;
    if (!ms) return a;
    return a == null ? ms : Math.max(a, ms);
  }, null);

  return (
    <div className="pc-harness-readonly">
      <header className="pc-harness-header">
        <div className="pc-harness-title">
          <span className={`pc-harness-live-dot${aliveCount > 0 ? ' is-live' : ''}`} aria-hidden="true" />
          <strong>Live ops cockpit</strong>
          <em>read-only public view</em>
        </div>
        <dl className="pc-harness-rollup">
          <div><dt>Directors</dt><dd>{rows.length}</dd></div>
          <div><dt>Inbox</dt><dd className={inboxPendingTotal > 0 ? 'is-warn' : ''}>{inboxPendingTotal > 0 ? `${inboxPendingTotal}/${inboxTotal}` : `${inboxTotal}`}</dd></div>
          <div><dt>Outbox</dt><dd>{outboxTotal}</dd></div>
          <div><dt>Active runs</dt><dd>{aliveCount}/{rows.length}</dd></div>
          <div><dt>Last activity</dt><dd>{formatRelative(newestActivityMs)}</dd></div>
          {totalTotal > 0 && <div><dt>Features</dt><dd>{passedTotal}/{totalTotal}</dd></div>}
          {failingTotal > 0 && <div><dt>Failing</dt><dd className="is-warn">{failingTotal}</dd></div>}
          {(costTotal ?? 0) > 0 && <div><dt>Cost</dt><dd>{formatCost(costTotal)}</dd></div>}
        </dl>
        <div className="pc-harness-meta">
          {error ? <span className="pc-harness-meta-warn">offline · showing snapshot</span>
            : liveAt ? <span>updated {formatRelative(liveAt)}</span>
            : loading ? <span>loading…</span>
            : <span>snapshot</span>}
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="pc-harness-empty">
          {loading ? 'Loading harness state…' : 'No harness projects active right now.'}
        </div>
      ) : (
        <div className="pc-harness-grid">
          {rows.map((r) => {
            const pct = r.total > 0 ? Math.round((r.passed / r.total) * 100) : 0;
            const status = r.alive ? 'running' : r.failing > 0 ? 'failing' : r.passed === r.total && r.total > 0 ? 'done' : 'idle';
            const hasFeatures = (r.total ?? 0) > 0;
            const lastSignal = r.lastActivityMs ?? r.lastRunMs;
            return (
              <a
                key={r.slug}
                href={`/harnesses/${r.slug}/`}
                className={`pc-harness-card pc-harness-card-link pc-harness-status-${status}`}
              >
                <header className="pc-harness-card-head">
                  <h3>{formatDirector(r.director)}</h3>
                  <span className={`pc-harness-pill pc-harness-pill-${status}`}>
                    {status === 'running' ? '● running' :
                     status === 'failing' ? '⚠ failing' :
                     status === 'done' ? '✓ done' : '◌ idle'}
                  </span>
                </header>
                {hasFeatures ? (
                  <div className="pc-harness-progress" aria-label={`${pct}% passed`}>
                    <div className="pc-harness-progress-bar" style={{ width: `${pct}%` }} />
                    <span className="pc-harness-progress-label">{r.passed}/{r.total} features ({pct}%)</span>
                  </div>
                ) : (
                  <div className="pc-harness-quiet">
                    <span>No coding work in flight — director routes via inbox/outbox.</span>
                  </div>
                )}
                <dl className="pc-harness-stats">
                  <div><dt>inbox</dt><dd className={(r.inboxPending ?? 0) > 0 ? 'is-warn' : ''}>{(r.inboxPending ?? 0) > 0 ? `${r.inboxPending}/${r.inboxTotal}` : `${r.inboxTotal ?? 0}`}</dd></div>
                  <div><dt>outbox</dt><dd>{r.outboxTotal ?? 0}</dd></div>
                  {hasFeatures ? (
                    <>
                      <div><dt>in-prog</dt><dd>{r.inProgress}</dd></div>
                      <div><dt>iter</dt><dd>{r.iteration}</dd></div>
                    </>
                  ) : (
                    <>
                      <div><dt>failing</dt><dd className={r.failing > 0 ? 'is-warn' : ''}>{r.failing}</dd></div>
                      <div><dt>cost</dt><dd>{formatCost(r.costUsd)}</dd></div>
                    </>
                  )}
                </dl>
                <footer className="pc-harness-card-foot">
                  <span>{lastSignal ? `active ${formatRelative(lastSignal)}` : 'no activity yet'}</span>
                  <code className="pc-harness-slug">{r.slug}</code>
                </footer>
                <div className="pc-harness-card-cta" aria-hidden="true">view details →</div>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
