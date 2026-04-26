'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';

export type HarnessDept = {
  slug: string;
  harnessSlug?: string;
  name: string;
  autoLoop?: boolean;
  autoIntervalSeconds?: number;
  scheduler?: { secondsRemaining: number; lastRunAt: number | null } | null;
  activeRun?: { kind: string; startedAt: number; elapsedSeconds: number } | null;
  inboxPending?: number;
  // Older fields still accepted for SSR compatibility
  counts?: { inboxTotal: number; inboxPending: number; outboxTotal: number };
  lastActivity?: number | null;
};

type HealthSnapshot = {
  snapshotTs: number;
  departments: Array<{
    slug: string;
    name: string;
    autoLoop: boolean;
    autoIntervalSeconds: number;
    scheduler: { secondsRemaining: number; lastRunAt: number | null } | null;
    activeRun: { kind: string; startedAt: number; elapsedSeconds: number } | null;
    inboxPending: number;
  }>;
  activeRuns: Array<{
    deptSlug: string;
    kind: string;
    startedAt: number;
    elapsedSeconds: number;
    cancelled: boolean;
    pid?: number;
  }>;
  backlog: {
    messages: { total: number; byStatus: Record<string, number> };
    projects: { total: number; byStatus: Record<string, number> };
    directives: { total: number; byStatus: Record<string, number> };
  };
  recentAudit: Array<{
    ts: number;
    actor?: string;
    action: string;
    subject?: string;
    target?: string;
    note?: string;
  }>;
};

export interface HarnessesViewProps {
  basePath: '' | '/papercup';
  readOnly?: boolean;
  /** Slot for the admin-only HarnessDashboard embed. Public site passes nothing. */
  dashboardSlot?: ReactNode;
  /** SSR seed (used by public-site readOnly render). Admin client polls live. */
  initialData?: HealthSnapshot;
}

function relTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 0) return 'in the future';
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const STATUS_COLOR: Record<string, string> = {
  pending: '#fbbf24',
  acknowledged: '#7aa2f7',
  archived: '#565f89',
  proposed: '#fbbf24',
  approved: '#7aa2f7',
  in_progress: '#9ece6a',
  launched: '#bb9af7',
  paused: '#f7768e',
  cancelled: '#565f89',
  active: '#9ece6a',
  completed: '#7aa2f7',
};

const STALE_THRESHOLD_MS = 60 * 60 * 1000;

export default function HarnessesView({ basePath, readOnly = false, dashboardSlot, initialData }: HarnessesViewProps) {
  const [snap, setSnap] = useState<HealthSnapshot | null>(initialData ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(!initialData);
  const [busyDept, setBusyDept] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [runViewer, setRunViewer] = useState<{ deptSlug: string; filename: string | null; content: string | null; loading: boolean; error: string | null } | null>(null);

  const fetchSnap = async () => {
    try {
      const r = await fetch('/api/org/health-snapshot', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setSnap(j);
      setErr(null);
      setLoading(false);
    } catch (e: any) {
      setErr(e?.message ?? 'fetch failed');
      setLoading(false);
    }
  };

  useEffect(() => {
    if (readOnly) return;
    fetchSnap();
    const id = setInterval(fetchSnap, 5000);
    return () => clearInterval(id);
  }, [readOnly]);

  const runNow = async (deptSlug: string) => {
    setBusyDept(deptSlug);
    setActionMsg(null);
    try {
      const r = await fetch(`/api/org/${deptSlug}/run-director`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'orchestrator', timeoutMs: 30000 }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setActionMsg(`${deptSlug}: ${j.decisionKeyword ?? 'completed'}`);
      fetchSnap();
    } catch (e: any) {
      setActionMsg(`${deptSlug}: error — ${e?.message ?? 'failed'}`);
    } finally {
      setBusyDept(null);
    }
  };

  const toggleAutoLoop = async (deptSlug: string, currentlyOn: boolean) => {
    setBusyDept(deptSlug);
    setActionMsg(null);
    try {
      const cfgRes = await fetch(`/api/org/${deptSlug}/director-config`, { cache: 'no-store' });
      const cfg = cfgRes.ok ? await cfgRes.json() : {};
      const next = { ...cfg, autoLoop: !currentlyOn };
      if (typeof next.autoIntervalSeconds !== 'number' || next.autoIntervalSeconds < 30) next.autoIntervalSeconds = 60;
      const r = await fetch(`/api/org/${deptSlug}/director-config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setActionMsg(`${deptSlug}: auto-loop ${next.autoLoop ? 'ON' : 'OFF'}`);
      fetchSnap();
    } catch (e: any) {
      setActionMsg(`${deptSlug}: error — ${e?.message ?? 'failed'}`);
    } finally {
      setBusyDept(null);
    }
  };

  const openLatestRun = async (deptSlug: string) => {
    setRunViewer({ deptSlug, filename: null, content: null, loading: true, error: null });
    try {
      const listRes = await fetch(`/api/org/${deptSlug}/director-runs`, { cache: 'no-store' });
      if (!listRes.ok) throw new Error(`HTTP ${listRes.status}`);
      const list = await listRes.json();
      const latest = list.runs?.[0];
      if (!latest) {
        setRunViewer({ deptSlug, filename: null, content: null, loading: false, error: 'No runs recorded yet.' });
        return;
      }
      const fileRes = await fetch(`/api/org/${deptSlug}/director-runs/${latest.filename}`, { cache: 'no-store' });
      if (!fileRes.ok) throw new Error(`HTTP ${fileRes.status}`);
      const content = await fileRes.text();
      setRunViewer({ deptSlug, filename: latest.filename, content, loading: false, error: null });
    } catch (e: any) {
      setRunViewer({ deptSlug, filename: null, content: null, loading: false, error: e?.message ?? 'fetch failed' });
    }
  };

  const runAllStale = async () => {
    if (!snap) return;
    const staleDepts = snap.departments.filter((d) => {
      const lastRunAt = d.scheduler?.lastRunAt ?? null;
      return d.inboxPending > 0 && !d.autoLoop && !d.activeRun && (lastRunAt === null || Date.now() - lastRunAt > STALE_THRESHOLD_MS);
    });
    if (staleDepts.length === 0) {
      setActionMsg('No stale departments to run.');
      return;
    }
    setActionMsg(`Running ${staleDepts.length} stale dept${staleDepts.length === 1 ? '' : 's'}…`);
    const results = await Promise.allSettled(staleDepts.map((d) =>
      fetch(`/api/org/${d.slug}/run-director`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'orchestrator', timeoutMs: 60000 }),
      }).then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    ));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const fail = results.length - ok;
    setActionMsg(`Bulk run: ${ok} ok, ${fail} failed.`);
    fetchSnap();
  };

  if (loading) return <div style={{ padding: 24, color: '#a9b1d6' }}>Loading harness state…</div>;
  if (err && !snap) return <div style={{ padding: 24, color: '#f7768e' }}>Error: {err}</div>;
  if (!snap) return null;

  const totalActive = snap.activeRuns.length;
  const totalPendingMsgs = snap.backlog.messages.byStatus.pending ?? 0;
  const totalOpenDirectives = snap.backlog.directives.byStatus.active ?? 0;
  const totalInProgressProjects = snap.backlog.projects.byStatus.in_progress ?? 0;
  const staleCount = snap.departments.filter((d) => {
    const lastRunAt = d.scheduler?.lastRunAt ?? null;
    return d.inboxPending > 0 && !d.autoLoop && !d.activeRun && (lastRunAt === null || Date.now() - lastRunAt > STALE_THRESHOLD_MS);
  }).length;

  return (
    <div style={{ padding: 24, color: '#c0caf5', maxWidth: 1400, margin: '0 auto' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 28 }}>Harnesses</h1>
          <p style={{ margin: '4px 0 0', color: '#7c89b1', fontSize: 13 }}>
            {readOnly
              ? <>Public snapshot · taken {fmtTime(snap.snapshotTs)}</>
              : <>Live ops cockpit · refreshes every 5s · snapshot {fmtTime(snap.snapshotTs)}</>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 16, fontSize: 13 }}>
          <span><b style={{ color: '#9ece6a' }}>{totalActive}</b> active runs</span>
          <span><b style={{ color: '#fbbf24' }}>{totalPendingMsgs}</b> pending msgs</span>
          <span><b style={{ color: '#7aa2f7' }}>{totalOpenDirectives}</b> open directives</span>
          <span><b style={{ color: '#bb9af7' }}>{totalInProgressProjects}</b> projects in progress</span>
        </div>
      </header>

      <section style={{ marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12, gap: 8 }}>
          <h2 style={{ fontSize: 14, textTransform: 'uppercase', letterSpacing: 0.6, color: '#7c89b1', margin: 0 }}>Departments</h2>
          {!readOnly && staleCount > 0 && (
            <button
              onClick={runAllStale}
              disabled={!!busyDept}
              style={{ padding: '6px 12px', fontSize: 12, fontWeight: 600, color: '#1a1b26', background: '#fbbf24', border: 'none', borderRadius: 6, cursor: busyDept ? 'wait' : 'pointer' }}
            >▶ Run {staleCount} stale</button>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          {snap.departments.map((d) => {
            const live = !!d.activeRun;
            const sched = d.scheduler;
            const lastRunAt = sched?.lastRunAt ?? null;
            const stale = d.inboxPending > 0 && !d.autoLoop && !live && (lastRunAt === null || Date.now() - lastRunAt > STALE_THRESHOLD_MS);
            const borderColor = live ? '#9ece6a' : stale ? '#fbbf24' : 'rgba(86, 95, 137, 0.4)';
            const bgColor = live ? 'rgba(158, 206, 106, 0.08)' : stale ? 'rgba(251, 191, 36, 0.08)' : 'rgba(36, 40, 59, 0.55)';
            const isBusy = busyDept === d.slug;
            return (
              <div key={d.slug} style={{ padding: 14, borderRadius: 10, background: bgColor, border: `1px solid ${borderColor}`, color: '#c0caf5', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Link href={`/harness/org-${d.slug}`} style={{ color: '#c0caf5', textDecoration: 'none', fontSize: 15, fontWeight: 600 }}>{d.name}</Link>
                  <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 999, background: d.autoLoop ? '#9ece6a' : '#565f89', color: '#1a1b26', fontWeight: 600 }}>{d.autoLoop ? 'AUTO ON' : 'AUTO OFF'}</span>
                </div>
                <div style={{ fontSize: 11, color: '#7c89b1', lineHeight: 1.6 }}>
                  {live && <div style={{ color: '#9ece6a' }}>▶ Running {d.activeRun!.kind} · {d.activeRun!.elapsedSeconds}s</div>}
                  {!live && sched && <div>Next run in <b style={{ color: '#c0caf5' }}>{sched.secondsRemaining}s</b></div>}
                  {!live && !sched && <div>Scheduler idle</div>}
                  <div>Last run: {relTime(lastRunAt)}</div>
                  <div>Inbox pending: <b style={{ color: d.inboxPending > 0 ? '#fbbf24' : '#c0caf5' }}>{d.inboxPending}</b></div>
                  <div>Interval: {d.autoIntervalSeconds}s</div>
                  {stale && <div style={{ color: '#fbbf24', fontWeight: 600, marginTop: 4 }}>⚠ Stale: pending work, no scheduler</div>}
                </div>
                {!readOnly && (
                  <>
                    <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                      <button onClick={() => runNow(d.slug)} disabled={isBusy || live} style={{ flex: 1, padding: '6px 10px', fontSize: 11, fontWeight: 600, color: '#1a1b26', background: isBusy ? '#565f89' : live ? '#414868' : '#7aa2f7', border: 'none', borderRadius: 6, cursor: (isBusy || live) ? 'not-allowed' : 'pointer', opacity: live ? 0.5 : 1 }}>
                        {isBusy ? '…' : live ? 'In flight' : '▶ Run now'}
                      </button>
                      <button onClick={() => toggleAutoLoop(d.slug, d.autoLoop)} disabled={isBusy} style={{ flex: 1, padding: '6px 10px', fontSize: 11, fontWeight: 600, color: d.autoLoop ? '#1a1b26' : '#c0caf5', background: d.autoLoop ? '#9ece6a' : 'transparent', border: `1px solid ${d.autoLoop ? '#9ece6a' : '#565f89'}`, borderRadius: 6, cursor: isBusy ? 'not-allowed' : 'pointer' }}>
                        {d.autoLoop ? 'Auto: ON' : 'Auto: OFF'}
                      </button>
                    </div>
                    <button onClick={() => openLatestRun(d.slug)} style={{ marginTop: 2, padding: '4px 10px', fontSize: 10, color: '#7c89b1', background: 'transparent', border: '1px solid rgba(86, 95, 137, 0.4)', borderRadius: 6, cursor: 'pointer' }}>📄 View latest run</button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 24 }}>
        <section>
          <h2 style={{ fontSize: 14, textTransform: 'uppercase', letterSpacing: 0.6, color: '#7c89b1', margin: '0 0 12px' }}>Active Runs</h2>
          {snap.activeRuns.length === 0 ? (
            <div style={{ padding: 16, color: '#7c89b1', fontSize: 13, background: 'rgba(36, 40, 59, 0.4)', borderRadius: 8 }}>No runs in flight.</div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {snap.activeRuns.map((r) => (
                <li key={`${r.deptSlug}:${r.startedAt}`} style={{ padding: 12, background: 'rgba(36, 40, 59, 0.55)', borderRadius: 8, border: '1px solid rgba(158, 206, 106, 0.3)', fontSize: 13 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <strong>{r.deptSlug}</strong>
                    <span style={{ fontSize: 11, color: '#7c89b1' }}>pid {r.pid ?? '?'}</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#a9b1d6', marginTop: 4 }}>
                    {r.kind} · {r.elapsedSeconds}s elapsed · started {fmtTime(r.startedAt)}
                    {r.cancelled && <span style={{ color: '#f7768e', marginLeft: 8 }}>· CANCELLING</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 style={{ fontSize: 14, textTransform: 'uppercase', letterSpacing: 0.6, color: '#7c89b1', margin: '0 0 12px' }}>Backlog</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <BacklogCard title="Messages" total={snap.backlog.messages.total} byStatus={snap.backlog.messages.byStatus} />
            <BacklogCard title="Projects" total={snap.backlog.projects.total} byStatus={snap.backlog.projects.byStatus} />
            <BacklogCard title="Directives" total={snap.backlog.directives.total} byStatus={snap.backlog.directives.byStatus} />
          </div>
        </section>

        <section>
          <h2 style={{ fontSize: 14, textTransform: 'uppercase', letterSpacing: 0.6, color: '#7c89b1', margin: '0 0 12px' }}>Recent Audit</h2>
          {snap.recentAudit.length === 0 ? (
            <div style={{ padding: 16, color: '#7c89b1', fontSize: 13, background: 'rgba(36, 40, 59, 0.4)', borderRadius: 8 }}>No audit entries yet.</div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 480, overflowY: 'auto' }}>
              {snap.recentAudit.map((e, i) => (
                <li key={`${e.ts}:${i}`} style={{ padding: '8px 12px', background: 'rgba(36, 40, 59, 0.4)', borderRadius: 6, fontSize: 12, borderLeft: '2px solid #7aa2f7' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <strong style={{ color: '#c0caf5' }}>{e.action}</strong>
                    <span style={{ color: '#7c89b1', fontSize: 10 }}>{relTime(e.ts)}</span>
                  </div>
                  <div style={{ color: '#a9b1d6', marginTop: 2 }}>
                    {e.subject && <span>{e.subject}</span>}
                    {e.target && <span> → {e.target}</span>}
                    {e.actor && <span style={{ color: '#7c89b1' }}> · by {e.actor}</span>}
                  </div>
                  {e.note && <div style={{ color: '#7c89b1', fontSize: 11, marginTop: 2, fontStyle: 'italic' }}>{e.note}</div>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {dashboardSlot && (
        <section style={{ marginTop: 32 }}>
          <h2 style={{ fontSize: 14, textTransform: 'uppercase', letterSpacing: 0.6, color: '#7c89b1', margin: '0 0 12px' }}>Live harness console</h2>
          {dashboardSlot}
        </section>
      )}

      {actionMsg && <div style={{ position: 'fixed', bottom: 20, right: 20, padding: '10px 16px', background: '#7aa2f7', color: '#1a1b26', fontSize: 13, fontWeight: 600, borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.4)', zIndex: 1000 }}>{actionMsg}</div>}

      {runViewer && (
        <div onClick={() => setRunViewer(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, padding: 20 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#1a1b26', border: '1px solid #565f89', borderRadius: 10, maxWidth: 900, width: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '12px 18px', borderBottom: '1px solid #565f89', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <strong style={{ color: '#c0caf5', fontSize: 14 }}>{runViewer.deptSlug} · latest run</strong>
                {runViewer.filename && <span style={{ color: '#7c89b1', fontSize: 11, marginLeft: 8 }}>{runViewer.filename}</span>}
              </div>
              <button onClick={() => setRunViewer(null)} style={{ padding: '4px 10px', background: 'transparent', color: '#7c89b1', border: '1px solid #565f89', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>Close</button>
            </div>
            <div style={{ padding: 18, overflow: 'auto', flex: 1 }}>
              {runViewer.loading && <div style={{ color: '#7c89b1' }}>Loading…</div>}
              {runViewer.error && <div style={{ color: '#f7768e' }}>{runViewer.error}</div>}
              {runViewer.content && <pre style={{ margin: 0, fontSize: 12, color: '#c0caf5', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>{runViewer.content}</pre>}
            </div>
          </div>
        </div>
      )}

      {err && <div style={{ marginTop: 16, padding: 8, background: 'rgba(247, 118, 142, 0.1)', color: '#f7768e', fontSize: 12, borderRadius: 6 }}>Last refresh failed: {err}. Showing stale data.</div>}
    </div>
  );
}

function BacklogCard({ title, total, byStatus }: { title: string; total: number; byStatus: Record<string, number> }) {
  const entries = Object.entries(byStatus).sort((a, b) => b[1] - a[1]);
  return (
    <div style={{ padding: 12, background: 'rgba(36, 40, 59, 0.55)', borderRadius: 8, border: '1px solid rgba(86, 95, 137, 0.3)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>{title}</strong>
        <span style={{ color: '#7c89b1', fontSize: 12 }}>{total} total</span>
      </div>
      {entries.length === 0 ? (
        <div style={{ color: '#7c89b1', fontSize: 12 }}>None.</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {entries.map(([status, count]) => (
            <span key={status} style={{ padding: '3px 8px', borderRadius: 999, background: STATUS_COLOR[status] ?? '#565f89', color: '#1a1b26', fontSize: 11, fontWeight: 600 }}>{status}: {count}</span>
          ))}
        </div>
      )}
    </div>
  );
}
