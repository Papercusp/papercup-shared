'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Toaster } from 'sonner';
import { orgPath } from './_admin-paths';

type OrgMessage = {
  id: string;
  ts: number;
  from: string;
  to: string[];
  kind: string;
  subject: string;
  body: string;
  status: string;
  projectId?: string;
  directiveId?: string;
};

type Project = { id: string; slug: string; name: string; vertical: string };
type Department = { slug: string; name: string };

function relTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

const KIND_COLOR: Record<string, string> = {
  Directive: '#fbbf24',
  ProjectKickoff: '#a78bfa',
  Priority: '#7aa2f7',
  Decision: '#9ece6a',
  BudgetAllocation: '#f7768e',
  ProgressUpdate: '#7aa2f7',
  BuildRequest: '#bb9af7',
  BuildRequestResponse: '#bb9af7',
  Capability: '#9ece6a',
  PlatformUpdate: '#e0af68',
  FeasibilityQuery: '#7dcfff',
  FeasibilityResponse: '#7dcfff',
  LaunchReady: '#9ece6a',
  MarketSignal: '#ff9e64',
  Campaign: '#ff9e64',
  ProjectSpinout: '#bb9af7',
};

function toneForKind(kind: string): React.CSSProperties {
  return { '--kind-color': KIND_COLOR[kind] ?? 'var(--accent)' } as React.CSSProperties;
}

export interface TimelineViewProps {
  initialData?: { messages?: OrgMessage[]; projects?: Project[]; departments?: Department[] };
  readOnly?: boolean;
}

export default function TimelineView({ initialData, readOnly = false }: TimelineViewProps = {}) {
  const [messages, setMessages] = useState<OrgMessage[]>(initialData?.messages ?? []);
  const [projects, setProjects] = useState<Project[]>(initialData?.projects ?? []);
  const [departments, setDepartments] = useState<Department[]>(initialData?.departments ?? []);
  const [filterKind, setFilterKind] = useState<string>('');
  const [filterFrom, setFilterFrom] = useState<string>('');
  const [filterProject, setFilterProject] = useState<string>('');
  const [filterQuery, setFilterQuery] = useState<string>('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [msgs, projs, depts] = await Promise.all([
        fetch(orgPath('messages?'), { cache: 'no-store' }).then((r) => r.json()),
        fetch(orgPath('projects'), { cache: 'no-store' }).then((r) => r.json()),
        fetch(orgPath('departments'), { cache: 'no-store' }).then((r) => r.json()),
      ]);
      setMessages(msgs.messages ?? []);
      setProjects(projs.projects ?? []);
      setDepartments(depts.departments ?? []);
      setError(null);
      setLoaded(true);
    } catch (e) {
      setError(`${e}`);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (initialData) { setLoaded(true); return; }
    if (readOnly) { setLoaded(true); return; }
    refresh();
    const i = setInterval(refresh, 5000);
    return () => clearInterval(i);
  }, [refresh, initialData, readOnly]);

  const filtered = useMemo(() => {
    return messages.filter((m) => {
      if (filterKind && m.kind !== filterKind) return false;
      if (filterFrom && m.from !== filterFrom) return false;
      if (filterProject && m.projectId !== filterProject) return false;
      if (filterQuery) {
        const q = filterQuery.toLowerCase();
        const hit = m.subject.toLowerCase().includes(q) || m.body.toLowerCase().includes(q) || m.kind.toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });
  }, [messages, filterKind, filterFrom, filterProject, filterQuery]);

  const projectById = useMemo(() => {
    const m: Record<string, Project> = {};
    for (const p of projects) m[p.id] = p;
    return m;
  }, [projects]);

  const allKinds = useMemo(() => {
    const s = new Set<string>();
    for (const m of messages) s.add(m.kind);
    return Array.from(s).sort();
  }, [messages]);

  const kindCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const m of messages) counts[m.kind] = (counts[m.kind] ?? 0) + 1;
    return counts;
  }, [messages]);

  const senderCount = useMemo(() => new Set(messages.map((m) => m.from)).size, [messages]);
  const linkedProjectCount = useMemo(() => new Set(messages.map((m) => m.projectId).filter(Boolean)).size, [messages]);
  const senderCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const m of messages) counts[m.from] = (counts[m.from] ?? 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 7);
  }, [messages]);

  const grouped = useMemo(() => {
    const groups: Record<string, OrgMessage[]> = {};
    for (const m of filtered) {
      const day = new Date(m.ts).toISOString().slice(0, 10);
      (groups[day] ??= []).push(m);
    }
    return groups;
  }, [filtered]);
  const days = Object.keys(grouped).sort().reverse();
  const filtersActive = Boolean(filterKind || filterFrom || filterProject || filterQuery);

  return (
    <div className={`pc-page pc-timeline-page${readOnly ? ' pc-view-readonly' : ''}`}>
      <Toaster position="bottom-right" />

      <header className="pc-hero pc-timeline-hero" aria-labelledby="timeline-title">
        <div>
          <div className="pc-eyebrow"><span className="pc-eyebrow-dot" /> Cross-department activity</div>
          <h1 id="timeline-title">Timeline makes every company handoff inspectable.</h1>
          <p className="pc-lede">
            A live log of directives, budgets, build requests, project kickoffs, and market signals.
            Filter down to a sender, message kind, or project without losing the operating context.
          </p>
          <div className="pc-hero-actions">
            <button className="pc-action primary" onClick={refresh}>Refresh timeline</button>
            <Link className="pc-action" href="/papercup/directives">Open directives</Link>
            <Link className="pc-action" href="/papercup/projects">View projects</Link>
          </div>
        </div>

        <aside className="pc-hero-panel" aria-label="Timeline summary">
          <div className="pc-metric-grid">
            <div className="pc-metric accent"><span>messages</span><strong>{messages.length}</strong></div>
            <div className="pc-metric good"><span>visible</span><strong>{filtered.length}</strong></div>
            <div className="pc-metric"><span>kinds</span><strong>{allKinds.length}</strong></div>
            <div className="pc-metric warn"><span>senders</span><strong>{senderCount}</strong></div>
          </div>
          <div className="pc-flow-note">
            {linkedProjectCount} linked project{linkedProjectCount === 1 ? '' : 's'} · {departments.length} departments · refreshes every 5 seconds.
          </div>
        </aside>
      </header>

      <section className="pc-timeline-filters" aria-label="Timeline filters">
        <label style={{ flex: 1, minWidth: 200 }}>
          <span>Search</span>
          <input
            className="pc-input pc-timeline-search"
            type="search"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder="full-text across subject + body…"
          />
        </label>
        <label>
          <span>Kind</span>
          <select value={filterKind} onChange={(e) => setFilterKind(e.target.value)}>
            <option value="">all kinds</option>
            {allKinds.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <label>
          <span>Sender</span>
          <select value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)}>
            <option value="">all senders</option>
            <option value="user">user</option>
            {departments.map((d) => <option key={d.slug} value={d.slug}>{d.name || d.slug}</option>)}
          </select>
        </label>
        <label>
          <span>Project</span>
          <select value={filterProject} onChange={(e) => setFilterProject(e.target.value)}>
            <option value="">all projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.vertical})</option>)}
          </select>
        </label>
        {filtersActive && (
          <button className="pc-filter-clear" onClick={() => { setFilterKind(''); setFilterFrom(''); setFilterProject(''); setFilterQuery(''); }}>
            clear filters
          </button>
        )}
      </section>

      <section className="pc-kind-rail" aria-label="Message kind quick filters">
        {allKinds.slice(0, 8).map((kind) => (
          <button
            key={kind}
            className={filterKind === kind ? 'is-active' : ''}
            style={toneForKind(kind)}
            onClick={() => setFilterKind(filterKind === kind ? '' : kind)}
          >
            <span>{kind}</span>
            <b>{kindCounts[kind] ?? 0}</b>
          </button>
        ))}
      </section>

      <section className="pc-sender-rail" aria-label="Sender quick filters">
        {senderCounts.map(([sender, count]) => (
          <button key={sender} className={filterFrom === sender ? 'is-active' : ''} onClick={() => setFilterFrom(filterFrom === sender ? '' : sender)}>
            <span>{sender}</span><b>{count}</b>
          </button>
        ))}
      </section>

      {error && <div className="pc-empty">Failed to load timeline: {error}</div>}
      {!loaded && !error && <div className="pc-empty neutral">loading timeline…</div>}
      {loaded && filtered.length === 0 && !error && (
        <div className="pc-empty neutral">No messages match the current filters.</div>
      )}

      <div className="pc-timeline-list" aria-label="Filtered timeline messages">
        {days.map((day) => (
          <section key={day} className="pc-timeline-day">
            <div className="pc-timeline-day-head">
              <span>{day}</span>
              <strong>{grouped[day].length} message{grouped[day].length === 1 ? '' : 's'}</strong>
              <div className="pc-day-bars" aria-hidden="true">
                {Object.entries(grouped[day].reduce<Record<string, number>>((acc, m) => {
                  acc[m.kind] = (acc[m.kind] ?? 0) + 1;
                  return acc;
                }, {})).slice(0, 5).map(([kind, count]) => (
                  <span key={kind} title={`${kind}: ${count}`} style={{ ...toneForKind(kind), width: `${Math.max(12, Math.round((count / grouped[day].length) * 100))}%` }} />
                ))}
              </div>
            </div>
            <div className="pc-timeline-rows">
              {grouped[day].map((m) => {
                const proj = m.projectId ? projectById[m.projectId] : null;
                return (
                  <Link key={m.id} href={`/messages/${m.id}`} className="pc-timeline-row" style={{ ...toneForKind(m.kind), textDecoration: 'none', color: 'inherit' }}>
                    <time className="pc-timeline-time" dateTime={new Date(m.ts).toISOString()}>{new Date(m.ts).toISOString().slice(11, 16)}</time>
                    <span className="pc-timeline-kind">{m.kind}</span>
                    <span className="pc-timeline-route"><b>{m.from}</b> → {Array.isArray(m.to) ? m.to.join(', ') : (m.to ?? '')}</span>
                    <span className="pc-timeline-subject">{m.subject}</span>
                    {proj ? (
                      <span className="pc-timeline-project">{proj.slug}</span>
                    ) : (
                      <span className="pc-timeline-project empty">—</span>
                    )}
                    <span className="pc-timeline-age">{relTime(m.ts)}</span>
                    <span className="pc-timeline-status">{m.status}</span>
                    <span className="pc-row-open" aria-hidden="true">open →</span>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
