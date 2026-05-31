'use client';

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check, AlertTriangle, Loader2, Clock, CircleSlash, Circle, Activity,
} from 'lucide-react';
import type { ColumnFormatter, GridConfig } from '@papercusp/grid-core';

// DataGridShell uses @glideapps/glide-data-grid's canvas renderer — not SSR-safe.
const DataGridShell = dynamic(
  () => import('@papercusp/grid-core').then((m) => m.DataGridShell),
  { ssr: false },
);

export interface HarnessFeatureRow {
  id: string;
  title: string;
  status: string;
  attempts: number;
  claims: string[];
}

export interface HarnessAgentRun {
  runId: string;
  role: string;
  ts: number;
  sizeBytes: number;
  running: boolean;
  lastEventTs?: number;
}

export interface HarnessReview {
  id: string;
  kind: string;
  from?: string;
  to?: string;
  status: string;
  readinessScore?: number;
  summary?: string;
  readinessSummary?: string;
  question?: string;
  criteria?: Record<string, unknown>;
}

export interface HarnessProposal {
  id: string;
  ts: number;
  sizeBytes: number;
  status: string;
}

export interface HarnessLane {
  featureId: string;
  role: string;
  ts: number;
}

export interface HarnessHealthCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface HarnessConsolePayload {
  slug: string;
  counts: {
    passed: number;
    failing: number;
    todo: number;
    in_progress: number;
    validating: number;
    blocked: number;
    total: number;
  };
  features: HarnessFeatureRow[];
  agents: HarnessAgentRun[];
  iteration: number;
  alive: boolean;
  escalated: boolean;
  pendingCheckpoints: number;
  activeCompetitions: number;
  smokeFail: boolean;
  missionCostUsd: number;
  lastRunAgeSeconds: number | null;
  log: string;
  lanes: HarnessLane[];
  laneCapacity: number;
  reviews: HarnessReview[];
  proposals: HarnessProposal[];
  issues: string;
  healthChecks: HarnessHealthCheck[];
}

export interface HarnessConsoleViewProps {
  data: HarnessConsolePayload | null;
  loading?: boolean;
  error?: string | null;
  liveAt?: number | null;
  /** Base URL for the public API; enables click-to-load detail panels. */
  apiBase?: string;
}

const STATUS_LABEL: Record<string, string> = {
  passed: 'Passed',
  failing: 'Failing',
  todo: 'Todo',
  in_progress: 'In progress',
  validating: 'Validating',
  blocked: 'Blocked',
};

const STATUS_ORDER = ['failing', 'in_progress', 'validating', 'blocked', 'todo', 'passed'];

const STATUS_ICONS: Record<string, typeof Check> = {
  passed: Check,
  failing: AlertTriangle,
  in_progress: Loader2,
  validating: Loader2,
  todo: Clock,
  blocked: CircleSlash,
};

function StatusPill({ status }: { status: string }) {
  const Icon = STATUS_ICONS[status] ?? Circle;
  const spin = status === 'in_progress' || status === 'validating';
  return (
    <span className={`pc-status-pill pc-status-${status}`}>
      <Icon size={11} className={spin ? 'pc-spin' : ''} />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

// Glide-grid columns + per-status background tint. Glide is canvas-based so we
// can't render the StatusPill icon inside a cell — the tint conveys urgency
// instead, with the human-readable label as the cell text.
const FEATURE_STATUS_FORMATTER: ColumnFormatter = (_, row) => {
  const k = (row as { _statusKey?: string })._statusKey;
  if (k === 'passed') return { bg: 'good', bold: true };
  if (k === 'failing') return { bg: 'bad', bold: true };
  if (k === 'in_progress' || k === 'validating') return { bg: 'info' };
  if (k === 'blocked') return { bg: 'warn' };
  return null;
};

const FEATURE_GRID_CONFIG: GridConfig = {
  headers: [
    { path: 'id', title: 'ID', width: 140 },
    { path: 'title', title: 'Title', width: 380 },
    { path: 'claims', title: 'Claims', width: 110 },
    { path: 'attempts', title: 'Attempts', width: 90 },
    { path: 'status', title: 'Status', width: 130 },
  ],
  formatters: {
    status: FEATURE_STATUS_FORMATTER,
  },
};

type ViewMode = 'list' | 'board';

function formatRelative(seconds: number | null): string {
  if (seconds == null) return 'never';
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatRelativeMs(ms: number | null): string {
  if (!ms) return 'never';
  return formatRelative((Date.now() - ms) / 1000);
}

function formatCost(usd: number | null | undefined): string {
  if (usd == null) return '—';
  if (usd < 0.01) return '<$0.01';
  if (usd < 1) return `$${usd.toFixed(2)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString()}`;
}

interface DetailModalState {
  kind: 'proposal' | 'feature';
  id: string;
}

interface ParsedIssue {
  featureId: string | null;
  round: string | null;
  title: string;
  body: string;
}

function parseIssues(raw: string): ParsedIssue[] {
  if (!raw) return [];
  const chunks = raw.split(/\n\s*---\s*\n/);
  const out: ParsedIssue[] = [];
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    // Match `## F-XXX — Validation round N — TS` style header
    const headerMatch = trimmed.match(/^##\s+([^\n]+)$/m);
    if (!headerMatch) {
      out.push({ featureId: null, round: null, title: trimmed.slice(0, 80), body: trimmed });
      continue;
    }
    const headerLine = headerMatch[1];
    const body = trimmed.slice(headerMatch.index! + headerMatch[0].length).trim();
    // Pull out F-XXX from header
    const featureMatch = headerLine.match(/(F-[A-Z0-9-]+)/);
    const roundMatch = headerLine.match(/round\s+\d+/i);
    out.push({
      featureId: featureMatch ? featureMatch[1] : null,
      round: roundMatch ? roundMatch[0] : null,
      title: headerLine,
      body,
    });
  }
  return out.slice(0, 20); // Cap to avoid massive payload reflection
}

export default function HarnessConsoleView({ data, loading, error, liveAt, apiBase }: HarnessConsoleViewProps) {
  const [statusFilter, setStatusFilter] = useState<string | 'all'>('all');
  const [view, setView] = useState<ViewMode>('list');
  const [search, setSearch] = useState('');
  const [now, setNow] = useState(Date.now());
  const [modal, setModal] = useState<DetailModalState | null>(null);
  const [modalContent, setModalContent] = useState<any>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);
  void now;

  useEffect(() => {
    if (!modal || !apiBase || !data) { setModalContent(null); return; }
    let cancelled = false;
    setModalLoading(true);
    setModalError(null);
    const url = modal.kind === 'proposal'
      ? `${apiBase}/api/public/papercup/harness/${data.slug}/proposal/${encodeURIComponent(modal.id)}`
      : `${apiBase}/api/public/papercup/harness/${data.slug}/feature/${encodeURIComponent(modal.id)}`;
    fetch(url, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then((j) => { if (!cancelled) setModalContent(j); })
      .catch((e) => { if (!cancelled) setModalError(String(e)); })
      .finally(() => { if (!cancelled) setModalLoading(false); });
    return () => { cancelled = true; };
  }, [modal, apiBase, data]);

  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!modal) return;
    previouslyFocusedRef.current = (typeof document !== 'undefined' ? document.activeElement as HTMLElement : null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setModal(null); return; }
      if (e.key === 'Tab' && modalRef.current) {
        // Focus trap
        const focusables = modalRef.current.querySelectorAll<HTMLElement>(
          'a[href], button, textarea, input, select, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    // Autofocus close button when modal opens
    setTimeout(() => closeButtonRef.current?.focus(), 50);
    return () => {
      window.removeEventListener('keydown', onKey);
      // Restore focus to trigger
      if (previouslyFocusedRef.current && typeof previouslyFocusedRef.current.focus === 'function') {
        previouslyFocusedRef.current.focus();
      }
    };
  }, [modal]);

  const visibleFeatures = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    let filtered = [...data.features];
    if (statusFilter !== 'all') filtered = filtered.filter((f) => f.status === statusFilter);
    if (q) filtered = filtered.filter((f) =>
      f.id.toLowerCase().includes(q) || f.title.toLowerCase().includes(q),
    );
    return filtered.sort((a, b) => {
      const ai = STATUS_ORDER.indexOf(a.status);
      const bi = STATUS_ORDER.indexOf(b.status);
      if (ai !== bi) return ai - bi;
      return a.id.localeCompare(b.id);
    });
  }, [data, statusFilter, search]);

  const featuresByStatus = useMemo(() => {
    const groups: Record<string, HarnessFeatureRow[]> = {
      failing: [], in_progress: [], validating: [], blocked: [], todo: [], passed: [],
    };
    for (const f of visibleFeatures) {
      const k = f.status in groups ? f.status : 'todo';
      groups[k].push(f);
    }
    return groups;
  }, [visibleFeatures]);

  // Project the feature rows into the flat shape DataGridShell expects.
  // Each row is consumed by `onRowClick` to surface the feature-detail modal.
  const featureGridRows = useMemo(
    () => visibleFeatures.map((f) => ({
      id: f.id,
      title: f.title,
      claims: f.claims.length > 0 ? `${f.claims.length} claim${f.claims.length === 1 ? '' : 's'}` : '—',
      attempts: f.attempts > 0 ? `try ${f.attempts}` : '',
      status: STATUS_LABEL[f.status] ?? f.status,
      _statusKey: f.status,
    })),
    [visibleFeatures],
  );

  if (loading && !data) {
    return <div className="pc-console pc-console-loading">Loading live console…</div>;
  }
  if (!data) {
    return <div className="pc-console pc-console-loading">{error ?? 'Console unavailable.'}</div>;
  }

  const c = data.counts;
  const pct = c.total > 0 ? Math.round((c.passed / c.total) * 100) : 0;
  const stallSec = data.lastRunAgeSeconds ?? null;

  return (
    <div className="pc-console">
      <header className="pc-console-head">
        <div className="pc-console-title">
          <span className={`pc-console-dot${data.alive ? ' is-alive' : ''}`} aria-hidden />
          <h2>{data.slug}</h2>
          <span className="pc-console-iter">iteration {data.iteration}</span>
        </div>
        <div className="pc-console-meta">
          {error ? <span className="pc-console-warn">offline · {error}</span>
            : liveAt ? <span>live · {formatRelativeMs(liveAt)}</span>
            : <span>snapshot</span>}
        </div>
      </header>

      <div className="pc-console-stats">
        <div className="pc-console-stat">
          <dt>Status</dt>
          <dd>{data.alive ? 'Running' : data.escalated ? 'Escalated' : 'Idle'}</dd>
        </div>
        <div className="pc-console-stat">
          <dt>Last run</dt>
          <dd>{formatRelative(stallSec)}</dd>
        </div>
        <div className="pc-console-stat">
          <dt>Features passed</dt>
          <dd>{c.passed}/{c.total}{c.total > 0 ? ` (${pct}%)` : ''}</dd>
        </div>
        <div className="pc-console-stat">
          <dt>Failing</dt>
          <dd className={c.failing > 0 ? 'is-warn' : ''}>{c.failing}</dd>
        </div>
        <div className="pc-console-stat">
          <dt>In progress</dt>
          <dd>{c.in_progress}</dd>
        </div>
        <div className="pc-console-stat">
          <dt>Cost</dt>
          <dd>{formatCost(data.missionCostUsd)}</dd>
        </div>
        {data.pendingCheckpoints > 0 && (
          <div className="pc-console-stat"><dt>Checkpoints</dt><dd className="is-warn">{data.pendingCheckpoints}</dd></div>
        )}
        {data.activeCompetitions > 0 && (
          <div className="pc-console-stat"><dt>Competitions</dt><dd>{data.activeCompetitions}</dd></div>
        )}
      </div>

      <div className="pc-console-row pc-console-progress" aria-label={`${pct}% passed`}>
        <div className="pc-console-progress-bar pc-console-progress-passed" style={{ width: `${(c.passed / Math.max(1, c.total)) * 100}%` }} />
        <div className="pc-console-progress-bar pc-console-progress-prog" style={{ width: `${(c.in_progress / Math.max(1, c.total)) * 100}%` }} />
        <div className="pc-console-progress-bar pc-console-progress-fail" style={{ width: `${(c.failing / Math.max(1, c.total)) * 100}%` }} />
        <span className="pc-console-progress-label">
          {c.total} features · {c.passed} passed · {c.in_progress} in flight · {c.failing} failing
        </span>
      </div>

      <div className="pc-console-grid">
        <section className="pc-console-pane pc-console-features">
          <header>
            <h3>Feature queue <span className="pc-console-pane-count">· {c.total}</span></h3>
            <div className="pc-console-feat-tools">
              <input
                type="search"
                className="pc-console-search"
                placeholder="search features…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search features"
              />
              <div className="pc-console-view-toggle" role="group" aria-label="View mode">
                <button type="button" className={view === 'list' ? 'is-on' : ''} onClick={() => setView('list')} aria-pressed={view === 'list'}>list</button>
                <button type="button" className={view === 'board' ? 'is-on' : ''} onClick={() => setView('board')} aria-pressed={view === 'board'}>board</button>
              </div>
            </div>
            <div className="pc-console-filters" role="tablist">
              <button type="button" className={statusFilter === 'all' ? 'is-on' : ''} onClick={() => setStatusFilter('all')}>All <em>{c.total}</em></button>
              {STATUS_ORDER.map((s) => {
                const count = c[s as keyof typeof c] ?? 0;
                if (!count) return null;
                return (
                  <button key={s} type="button" className={statusFilter === s ? 'is-on' : ''} onClick={() => setStatusFilter(s)}>
                    {STATUS_LABEL[s] ?? s} <em>{count}</em>
                  </button>
                );
              })}
            </div>
          </header>

          {view === 'list' ? (
            visibleFeatures.length === 0 ? (
              <div className="pc-console-empty">No features matching.</div>
            ) : (
              <DataGridShell
                config={FEATURE_GRID_CONFIG}
                data={featureGridRows}
                height={Math.min(560, 56 + featureGridRows.length * 32)}
                onRowClick={(_idx, row) => apiBase && setModal({ kind: 'feature', id: row.id })}
              />
            )
          ) : (
            <div className="pc-console-feat-board">
              {STATUS_ORDER.map((s) => {
                const items = featuresByStatus[s] ?? [];
                if (items.length === 0) return null;
                return (
                  <div key={s} className={`pc-console-feat-col pc-feat-col-${s}`}>
                    <header><StatusPill status={s} /><span className="pc-console-pane-count">· {items.length}</span></header>
                    <ol>
                      {items.map((f) => (
                        <li key={f.id}>
                          <button
                            type="button"
                            onClick={() => apiBase && setModal({ kind: 'feature', id: f.id })}
                            disabled={!apiBase}
                          >
                            <strong>{f.id}</strong>
                            <span>{f.title}</span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <aside className="pc-console-pane pc-console-side">
          {data.reviews.length > 0 && (
            <section className="pc-console-section">
              <h3>Pending decisions</h3>
              <ol className="pc-console-rev-list">
                {data.reviews.map((rv) => (
                  <li key={rv.id} className={`pc-console-rev pc-rev-${rv.status}`}>
                    <div className="pc-rev-head">
                      <span className="pc-rev-kind">{rv.kind}</span>
                      <span className="pc-rev-flow">{rv.from} → {rv.to}</span>
                      <span className="pc-rev-status">{rv.status}</span>
                    </div>
                    {rv.summary && <p className="pc-rev-sum">{rv.summary}</p>}
                    {rv.readinessSummary && <p className="pc-rev-detail">{rv.readinessSummary}</p>}
                    {typeof rv.readinessScore === 'number' && (
                      <div className="pc-rev-score">readiness {Math.round(rv.readinessScore * 100)}%</div>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          )}

          {data.proposals.length > 0 && (
            <section className="pc-console-section">
              <h3>Architect proposals ({data.proposals.length})</h3>
              <ol className="pc-console-prop-list">
                {data.proposals.slice(0, 6).map((p) => (
                  <li key={p.id} className={`pc-console-prop pc-prop-${p.status}`}>
                    <button
                      type="button"
                      className="pc-console-prop-row"
                      onClick={() => apiBase && setModal({ kind: 'proposal', id: p.id })}
                      disabled={!apiBase}
                      aria-label={`Open proposal ${p.id}`}
                    >
                      <span className="pc-prop-ts">{new Date(p.ts).toISOString().slice(0, 16).replace('T', ' ')}</span>
                      <span className="pc-prop-id">{p.id.replace(/\.md$/, '')}</span>
                      <span className="pc-prop-status">{p.status}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section className="pc-console-section">
            <h3>Health</h3>
            <ul className="pc-console-health-list">
              {data.healthChecks.map((ck) => (
                <li key={ck.name} className={ck.ok ? 'is-ok' : 'is-not-ok'}>
                  <span aria-hidden>{ck.ok ? '✓' : '✗'}</span>
                  <span>{ck.name}</span>
                  {ck.detail && <em>{ck.detail}</em>}
                </li>
              ))}
            </ul>
          </section>

          <section className="pc-console-section">
            <h3>Recent agent runs</h3>
            <ol className="pc-console-agent-list">
              {data.agents.length === 0 && <li className="pc-console-empty">No agents yet.</li>}
              {data.agents.slice(0, 8).map((a) => (
                <li key={a.runId}>
                  <span className={`pc-agent-role pc-agent-role-${a.role}`}>{a.role}</span>
                  <span className="pc-agent-ts">{formatRelative((Date.now() - (a.lastEventTs ?? a.ts)) / 1000)}</span>
                  <span className="pc-agent-state">{a.running ? 'running' : 'done'}</span>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>

      {data.issues && data.issues.trim().length > 0 && (
        <section className="pc-console-pane pc-console-issues">
          <header>
            <h3>Validator issues</h3>
            <span className="pc-console-meta">structured · sanitized</span>
          </header>
          <div className="pc-console-issues-list">
            {parseIssues(data.issues).map((iss, i) => (
              <article key={i} className="pc-console-issue">
                <header className="pc-console-issue-head">
                  <span className="pc-console-issue-title">{iss.title}</span>
                  {iss.featureId && <code className="pc-console-issue-feat">{iss.featureId}</code>}
                  {iss.round && <span className="pc-console-issue-round">{iss.round}</span>}
                </header>
                {iss.body && <pre className="pc-console-issue-body">{iss.body}</pre>}
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="pc-console-pane pc-console-logs">
        <header>
          <h3>Run log</h3>
          <span className="pc-console-meta">last {data.log.split('\n').length} lines · sanitized</span>
        </header>
        <pre className="pc-console-log-text" aria-label="Recent run log">
          {data.log || '(no log yet)'}
        </pre>
      </section>

      {modal && (
        <div
          className="pc-console-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={modal.kind === 'proposal' ? 'Architect proposal' : 'Feature detail'}
          onClick={(e) => { if (e.target === e.currentTarget) setModal(null); }}
        >
          <div className="pc-console-modal" ref={modalRef}>
            <header className="pc-console-modal-head">
              <span className="pc-console-modal-kind">{modal.kind}</span>
              <code className="pc-console-modal-id">{modal.id}</code>
              <button
                type="button"
                className="pc-console-modal-close"
                onClick={() => setModal(null)}
                aria-label="Close (Esc)"
                ref={closeButtonRef}
              >×</button>
            </header>
            <div className="pc-console-modal-body">
              {modalLoading && <div className="pc-console-modal-loading">Loading…</div>}
              {modalError && <div className="pc-console-modal-error">Failed to load: {modalError}</div>}
              {!modalLoading && !modalError && modalContent && modal.kind === 'proposal' && (
                <pre className="pc-console-modal-pre">{modalContent.content}</pre>
              )}
              {!modalLoading && !modalError && modalContent && modal.kind === 'feature' && (
                <div className="pc-console-modal-feature">
                  <h3>{modalContent.title}</h3>
                  <dl className="pc-console-modal-stats">
                    <div><dt>Status</dt><dd>{STATUS_LABEL[modalContent.status] ?? modalContent.status}</dd></div>
                    <div><dt>Attempts</dt><dd>{modalContent.attempts}</dd></div>
                    <div><dt>Claims</dt><dd>{(modalContent.claims ?? []).length}</dd></div>
                  </dl>
                  {Array.isArray(modalContent.claims) && modalContent.claims.length > 0 && (
                    <>
                      <h4>Validation claims</h4>
                      <ul className="pc-console-modal-claims">
                        {modalContent.claims.map((cid: string) => <li key={cid}><code>{cid}</code></li>)}
                      </ul>
                    </>
                  )}
                  {modalContent.body && (
                    <>
                      <h4>Description</h4>
                      <pre className="pc-console-modal-pre">{modalContent.body}</pre>
                    </>
                  )}
                  {modalContent.spec && (
                    <>
                      <h4>SPEC excerpt</h4>
                      <pre className="pc-console-modal-pre">{modalContent.spec}</pre>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
