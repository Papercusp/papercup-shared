'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast, Toaster } from 'sonner';
import { orgPath } from './_admin-paths';

type Directive = {
  id: string;
  title: string;
  body: string;
  status: 'active' | 'paused' | 'complete' | 'cancelled';
  created_by: string;
  created_ts: number;
  deadline_ts?: number;
  budget_cents?: number;
  priority?: 'low' | 'normal' | 'high';
  assignedDepartments?: string[];
  linkedProjectIds?: string[];
};

type DirectiveSummary = {
  id: string;
  directiveId: string;
  ts: number;
  author: 'ceo' | 'user';
  body: string;
};

type OrgMessage = {
  id: string;
  ts: number;
  from: string;
  to: string[];
  kind: string;
  subject: string;
  body: string;
  status: string;
  directiveId?: string;
};

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function statusColor(status: string): string {
  if (status === 'active') return 'var(--good)';
  if (status === 'paused') return 'var(--warn)';
  if (status === 'complete') return 'var(--accent)';
  return 'var(--fg-dim)';
}

function directiveProgress(d: Directive): number {
  let score = d.status === 'cancelled' ? 20 : 12;
  if (d.assignedDepartments?.length) score += 34;
  if (d.linkedProjectIds?.length) score += 34;
  if (d.status === 'complete') score = 100;
  if (d.status === 'paused') score = Math.max(score, 45);
  return Math.min(100, score);
}

export interface DirectivesViewProps {
  initialData?: { directives?: Directive[] };
  readOnly?: boolean;
}

export default function DirectivesView({ initialData, readOnly = false }: DirectivesViewProps = {}) {
  const [directives, setDirectives] = useState<Directive[]>(initialData?.directives ?? []);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Record<string, { summaries: DirectiveSummary[]; messages: OrgMessage[] }>>({});
  const [showNew, setShowNew] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(orgPath('directives'), { cache: 'no-store' });
      const data = await res.json();
      setDirectives(data.directives ?? []);
    } catch (e) {
      toast.error(`refresh failed: ${e}`);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const res = await fetch(orgPath(`directives/${id}`), { cache: 'no-store' });
      const data = await res.json();
      setDetails((d) => ({
        ...d,
        [id]: { summaries: data.summaries ?? [], messages: data.messages ?? [] },
      }));
    } catch (e) {
      toast.error(`detail load failed: ${e}`);
    }
  }, []);

  useEffect(() => {
    if (initialData) return;     // server hydrated
    if (readOnly) return;        // public — no live polling
    refresh();
    const interval = setInterval(() => {
      refresh();
      expanded.forEach((id) => loadDetail(id));
    }, 5000);
    return () => clearInterval(interval);
  }, [refresh, loadDetail, expanded, initialData, readOnly]);

  function toggleExpand(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
      loadDetail(id);
    }
    setExpanded(next);
  }

  async function routeDirective(id: string) {
    // First-time route: create the initial project from the directive
    try {
      const res = await fetch(orgPath(`directives/${id}/projects`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}), // empty body → create from directive title + heuristics
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? 'route failed');
      }
      const data = await res.json();
      toast.success(`Spun up project "${data.projectSlug}". CEO summary added.`);
      refresh();
      loadDetail(id);
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  async function spinUpProject(
    id: string,
    opts: { projectName: string; projectVertical?: string; projectBudgetCents?: number; additionalContext?: string },
  ) {
    try {
      const res = await fetch(orgPath(`directives/${id}/projects`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(opts),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? 'spin-up failed');
      }
      const data = await res.json();
      toast.success(`Spun up project #${data.totalProjects}: "${data.projectSlug}"`);
      refresh();
      loadDetail(id);
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  async function changeStatus(id: string, status: Directive['status']) {
    try {
      await fetch(orgPath(`directives/${id}`), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      refresh();
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  async function addSummary(id: string, body: string) {
    if (!body.trim()) return;
    try {
      await fetch(orgPath(`directives/${id}/summaries`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body, author: 'user' }),
      });
      toast.success('summary added');
      loadDetail(id);
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  const activeCount = directives.filter((d) => d.status === 'active').length;
  const routedCount = directives.filter((d) => d.assignedDepartments?.length).length;
  const pendingRouting = directives.filter((d) => d.status === 'active' && !d.assignedDepartments?.length).length;
  const highPriority = directives.filter((d) => d.priority === 'high').length;
  const pausedCount = directives.filter((d) => d.status === 'paused').length;
  const completeCount = directives.filter((d) => d.status === 'complete').length;
  const cancelledCount = directives.filter((d) => d.status === 'cancelled').length;
  const normalPriority = directives.filter((d) => !d.priority || d.priority === 'normal').length;
  const lowPriority = directives.filter((d) => d.priority === 'low').length;

  return (
    <div className={`pc-page pc-directives-page${readOnly ? ' pc-view-readonly' : ''}`}>
      <Toaster position="bottom-right" />

      <header className="pc-hero pc-directives-hero" aria-labelledby="directives-title">
        <div>
          <div className="pc-eyebrow"><span className="pc-eyebrow-dot" /> Executive direction queue</div>
          <h1 id="directives-title">Directives route user intent into department action.</h1>
          <p className="pc-lede">
            Top-of-stack user direction. CEO inside Business routes each directive to the right departments,
            tracks status, and writes progress summaries back into the organization log.
          </p>
          <div className="pc-hero-actions">
            <button className="pc-action primary" onClick={() => setShowNew(true)}>+ New directive</button>
            <button className="pc-action" onClick={refresh}>Refresh queue</button>
          </div>
        </div>

        <aside className="pc-hero-panel" aria-label="Directive queue summary">
          <div className="pc-metric-grid">
            <div className="pc-metric accent"><span>directives</span><strong>{directives.length}</strong></div>
            <div className="pc-metric good"><span>active</span><strong>{activeCount}</strong></div>
            <div className={`pc-metric ${pendingRouting > 0 ? 'warn' : 'good'}`}><span>unrouted</span><strong>{pendingRouting}</strong></div>
            <div className={`pc-metric ${highPriority > 0 ? 'warn' : ''}`}><span>high priority</span><strong>{highPriority}</strong></div>
          </div>
          <div className="pc-flow-note">
            {routedCount} routed directive{routedCount === 1 ? '' : 's'} have assigned departments. Open a row to inspect summaries and linked messages.
          </div>
        </aside>
      </header>

      <section className="pc-directive-lifecycle" aria-label="Directive lifecycle">
        <span><b>1</b> Intake</span>
        <span><b>2</b> Route</span>
        <span><b>3</b> Execute</span>
        <span><b>4</b> Report</span>
      </section>

      <section className="pc-status-rail" aria-label="Directive status distribution">
        <span className="active"><b>{activeCount}</b><em>active</em></span>
        <span className="paused"><b>{pausedCount}</b><em>paused</em></span>
        <span className="complete"><b>{completeCount}</b><em>complete</em></span>
        <span className="cancelled"><b>{cancelledCount}</b><em>cancelled</em></span>
      </section>

      <section className="pc-priority-rail" aria-label="Directive priority distribution">
        <span className="high"><b>{highPriority}</b><em>high</em></span>
        <span><b>{normalPriority}</b><em>normal</em></span>
        <span className="low"><b>{lowPriority}</b><em>low</em></span>
        <strong>{pendingRouting > 0 ? `${pendingRouting} route next` : 'routing clear'}</strong>
      </section>

      {showNew && <NewDirectiveModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); refresh(); }} />}

      <section className="pc-directive-board" aria-label="Directive work queue">
        <div className="pc-section-title compact">
          <div>
            <h2>Directive work queue</h2>
            <p>Expand a directive to route it, update lifecycle state, add summaries, and inspect linked inter-department messages.</p>
          </div>
          <span className="pc-code">{directives.length} total · {pendingRouting} waiting route</span>
        </div>
        <div className="pc-directive-list">
        {directives.length === 0 && (
          <div className="pc-empty pc-directive-empty" style={{ padding: 32, textAlign: 'center', background: 'var(--bg-2)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--fg-dim)' }}>
            No directives yet. Click "+ New directive" to set the first direction for the org.
          </div>
        )}

        {directives.map((d) => {
          const isExpanded = expanded.has(d.id);
          const detail = details[d.id];
          const progress = directiveProgress(d);
          return (
            <div
              key={d.id}
              className={`pc-directive-card pc-directive-${d.status}${d.priority === 'high' ? ' high' : ''}`}
              style={{
                background: 'var(--bg-2)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                overflow: 'hidden',
              }}
            >
              <button
                onClick={() => toggleExpand(d.id)}
                className="pc-directive-row"
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '14px 16px',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--fg)',
                  textAlign: 'left',
                  fontFamily: 'inherit',
                }}
              >
                <span style={{ color: 'var(--fg-dim)', fontSize: 12, fontFamily: 'ui-monospace, monospace' }}>
                  {isExpanded ? '▼' : '▶'}
                </span>
                <span style={{ color: 'var(--fg-dim)', fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>
                  {d.id}
                </span>
                <span className="pc-directive-title">{d.title}</span>
                {d.priority === 'high' && (
                  <span className="pc-directive-priority" style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: 'var(--bg-3)', color: 'var(--counter)', border: '1px solid var(--border)', letterSpacing: 0.5 }}>
                    HIGH
                  </span>
                )}
                <span className={`pc-directive-status ${d.status}`} style={{ fontSize: 11, color: statusColor(d.status), fontFamily: 'ui-monospace, monospace', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  {d.status}
                </span>
                <span className="pc-directive-age" style={{ fontSize: 11, color: 'var(--fg-dim)', minWidth: 60, textAlign: 'right' }}>
                  {relativeTime(d.created_ts)}
                </span>
                <a
                  href={`/directives/${d.id}`}
                  onClick={(e) => e.stopPropagation()}
                  style={{ fontSize: 11, padding: '4px 10px', background: 'var(--bg-3)', color: 'var(--accent)', borderRadius: 3, textDecoration: 'none', fontFamily: 'ui-monospace, monospace' }}
                  title="Open dedicated directive page"
                >
                  open ↗
                </a>
              </button>
              <div className="pc-directive-compact-meta">
                <span>{d.assignedDepartments?.length ? `${d.assignedDepartments.length} dept${d.assignedDepartments.length === 1 ? '' : 's'}` : 'unrouted'}</span>
                <span>{d.linkedProjectIds?.length ?? 0} project{(d.linkedProjectIds?.length ?? 0) === 1 ? '' : 's'}</span>
                {d.budget_cents ? <span>${(d.budget_cents / 100).toFixed(0)} budget</span> : <span>no budget</span>}
                {d.deadline_ts ? <span>due {new Date(d.deadline_ts).toISOString().slice(0, 10)}</span> : <span>no deadline</span>}
              </div>
              <div className="pc-directive-route-strip" aria-label={`${d.title} routing progress ${progress}%`}>
                {(d.assignedDepartments?.length ? d.assignedDepartments : ['awaiting route']).slice(0, 5).map((dept) => (
                  <span key={dept} className={d.assignedDepartments?.length ? '' : 'muted'}>{dept}</span>
                ))}
                <em>{progress}% routed</em>
              </div>
              <div className="pc-mini-progress" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>

              {isExpanded && (
                <div className="pc-directive-detail" style={{ padding: '0 16px 16px', borderTop: '1px solid var(--border)' }}>
                  {/* Body */}
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Directive</div>
                    <pre style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: 10, fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontFamily: 'inherit' }}>
                      {d.body}
                    </pre>
                  </div>

                  {/* Metadata */}
                  <div style={{ marginTop: 12, display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11, color: 'var(--fg-dim)' }}>
                    {d.budget_cents ? <span>budget: ${(d.budget_cents / 100).toFixed(2)}</span> : null}
                    {d.deadline_ts ? <span>deadline: {new Date(d.deadline_ts).toISOString().slice(0, 10)}</span> : null}
                    {d.assignedDepartments?.length ? (
                      <span>assigned: <b style={{ color: 'var(--fg)' }}>{d.assignedDepartments.join(', ')}</b></span>
                    ) : (
                      <span style={{ color: 'var(--warn)' }}>not yet routed</span>
                    )}
                  </div>

                  {/* Linked projects */}
                  <LinkedProjectsBlock directive={d} onSpinUp={(opts) => spinUpProject(d.id, opts)} />

                  {/* Actions */}
                  <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {!d.linkedProjectIds?.length && d.status === 'active' && (
                      <button
                        onClick={() => routeDirective(d.id)}
                        style={{ padding: '6px 14px', background: 'var(--accent)', color: 'var(--bg)', border: 'none', borderRadius: 4, fontSize: 12, cursor: 'pointer', fontWeight: 500 }}
                      >
                        Route directive (creates first project)
                      </button>
                    )}

                    {d.status === 'active' && (
                      <button onClick={() => changeStatus(d.id, 'paused')} style={pillBtn('warn')}>Pause</button>
                    )}
                    {d.status === 'paused' && (
                      <button onClick={() => changeStatus(d.id, 'active')} style={pillBtn('good')}>Resume</button>
                    )}
                    {d.status !== 'complete' && (
                      <button onClick={() => changeStatus(d.id, 'complete')} style={pillBtn('accent')}>Mark complete</button>
                    )}
                    {d.status !== 'cancelled' && (
                      <button onClick={() => changeStatus(d.id, 'cancelled')} style={pillBtn('bad')}>Cancel</button>
                    )}
                  </div>

                  {/* Summary log */}
                  <div style={{ marginTop: 16 }}>
                    <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      Summary log{detail ? ` (${detail.summaries.length})` : ''}
                    </div>
                    {!detail && <div style={{ fontSize: 12, color: 'var(--fg-dim)' }}>Loading…</div>}
                    {detail && detail.summaries.length === 0 && (
                      <div style={{ fontSize: 12, color: 'var(--fg-dim)', fontStyle: 'italic' }}>
                        No summaries yet. {d.assignedDepartments?.length ? 'Run "Re-route" to refresh or let CEO auto-summarize.' : 'Click "Route directive" for CEO to add the first entry.'}
                      </div>
                    )}
                    {detail && detail.summaries.map((s) => (
                      <div
                        key={s.id}
                        style={{
                          marginBottom: 8,
                          padding: 10,
                          background: 'var(--bg)',
                          border: '1px solid var(--border)',
                          borderLeft: `3px solid ${s.author === 'ceo' ? 'var(--accent)' : 'var(--good)'}`,
                          borderRadius: 4,
                        }}
                      >
                        <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginBottom: 4 }}>
                          <b style={{ color: s.author === 'ceo' ? 'var(--accent)' : 'var(--good)' }}>{s.author.toUpperCase()}</b>
                          {' · '}
                          {new Date(s.ts).toISOString().replace('T', ' ').slice(0, 16)}
                        </div>
                        <div style={{ fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                          {s.body}
                        </div>
                      </div>
                    ))}
                    {detail && (
                      <AddSummaryForm onAdd={(body) => addSummary(d.id, body)} />
                    )}
                  </div>

                  {/* Linked messages */}
                  {detail && detail.messages.length > 0 && (
                    <div style={{ marginTop: 16 }}>
                      <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                        Linked messages ({detail.messages.length})
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {detail.messages.map((m) => (
                          <div
                            key={m.id}
                            style={{
                              padding: '6px 10px',
                              background: 'var(--bg)',
                              border: '1px solid var(--border)',
                              borderRadius: 4,
                              fontSize: 11,
                              display: 'flex',
                              gap: 8,
                              alignItems: 'center',
                            }}
                          >
                            <span style={{ padding: '1px 6px', background: 'var(--bg-3)', color: 'var(--accent)', borderRadius: 3, fontFamily: 'ui-monospace, monospace' }}>
                              {m.kind}
                            </span>
                            <span style={{ color: 'var(--fg-dim)' }}>{m.from} → {m.to.join(', ')}</span>
                            <span style={{ flex: 1, color: 'var(--fg)' }}>{m.subject}</span>
                            <span style={{ color: 'var(--fg-dim)' }}>{relativeTime(m.ts)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        </div>
      </section>
    </div>
  );
}

function LinkedProjectsBlock({
  directive,
  onSpinUp,
}: {
  directive: Directive;
  onSpinUp: (opts: { projectName: string; projectVertical?: string; projectBudgetCents?: number; additionalContext?: string }) => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [allProjects, setAllProjects] = useState<{ id: string; slug: string; name: string; vertical: string; budget_cents: number; status: string }[]>([]);

  useEffect(() => {
    fetch(orgPath('projects'), { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setAllProjects(d.projects ?? []))
      .catch(() => {});
  }, [directive.linkedProjectIds]);

  const linked = (directive.linkedProjectIds ?? [])
    .map((id) => allProjects.find((p) => p.id === id))
    .filter(Boolean) as typeof allProjects;

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ fontSize: 11, color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Linked projects ({linked.length})
        </div>
        {directive.status === 'active' && directive.linkedProjectIds?.length ? (
          <button
            onClick={() => setShowForm(true)}
            style={{ fontSize: 11, padding: '4px 10px', background: 'var(--accent)', color: 'var(--bg)', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 500 }}
          >
            + Spin up another project
          </button>
        ) : null}
      </div>

      {linked.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--fg-dim)', fontStyle: 'italic' }}>
          No projects spun up yet. Click "Route directive" below to create the first.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {linked.map((p) => (
            <a
              key={p.id}
              href={`/projects/${p.slug}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 10px',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                textDecoration: 'none',
                color: 'var(--fg)',
                fontSize: 12,
              }}
            >
              <span style={{ fontFamily: 'ui-monospace, monospace', color: 'var(--accent)', flex: 1 }}>{p.slug}</span>
              <span style={{ color: 'var(--fg-dim)' }}>{p.name}</span>
              <span style={{ padding: '1px 6px', background: 'var(--bg-3)', borderRadius: 3, fontSize: 10, color: 'var(--fg-dim)' }}>{p.vertical}</span>
              <span style={{ fontSize: 10, color: 'var(--fg-dim)' }}>${(p.budget_cents / 100).toFixed(0)}</span>
              <span style={{ fontSize: 10, color: 'var(--accent)' }}>open →</span>
            </a>
          ))}
        </div>
      )}

      {showForm && (
        <SpinUpProjectForm
          onSubmit={(opts) => { onSpinUp(opts); setShowForm(false); }}
          onCancel={() => setShowForm(false)}
        />
      )}
    </div>
  );
}

function SpinUpProjectForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (opts: { projectName: string; projectVertical?: string; projectBudgetCents?: number; additionalContext?: string }) => void;
  onCancel: () => void;
}) {
  const [projectName, setProjectName] = useState('');
  const [projectVertical, setProjectVertical] = useState('');
  const [budget, setBudget] = useState('');
  const [scope, setScope] = useState('');

  const inputStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: 8, background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 13 };

  return (
    <div style={{ marginTop: 8, padding: 12, background: 'var(--bg)', border: '1px dashed var(--accent)', borderRadius: 4 }}>
      <div style={{ fontSize: 11, color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
        Spin up another project for this directive
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
        <input value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="Project name *" style={inputStyle} />
        <input value={projectVertical} onChange={(e) => setProjectVertical(e.target.value)} placeholder="vertical (auto if blank)" style={inputStyle} />
        <input type="number" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="Budget $" style={inputStyle} />
      </div>
      <textarea
        value={scope}
        onChange={(e) => setScope(e.target.value)}
        rows={2}
        placeholder="Project-specific scope (what part of the directive this project covers)"
        style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace', resize: 'vertical', minHeight: 60 }}
      />
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button
          disabled={!projectName.trim()}
          onClick={() => onSubmit({
            projectName: projectName.trim(),
            projectVertical: projectVertical.trim() || undefined,
            projectBudgetCents: budget.trim() ? Math.round(parseFloat(budget) * 100) : undefined,
            additionalContext: scope.trim() || undefined,
          })}
          style={{ padding: '6px 14px', background: 'var(--accent)', color: 'var(--bg)', border: 'none', borderRadius: 4, fontSize: 12, fontWeight: 500, cursor: 'pointer', opacity: projectName.trim() ? 1 : 0.5 }}
        >
          Spin up project
        </button>
        <button
          onClick={onCancel}
          style={{ padding: '6px 14px', background: 'transparent', color: 'var(--fg-dim)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 12, cursor: 'pointer' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function pillBtn(color: 'good' | 'warn' | 'bad' | 'accent'): React.CSSProperties {
  return {
    padding: '6px 14px',
    background: 'var(--bg-3)',
    color: `var(--${color})`,
    border: `1px solid var(--${color})`,
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
  };
}

function AddSummaryForm({ onAdd }: { onAdd: (body: string) => void }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{ marginTop: 4, padding: '6px 12px', background: 'transparent', color: 'var(--fg-dim)', border: '1px dashed var(--border)', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}
      >
        + Add summary note
      </button>
    );
  }
  return (
    <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder="Your note about directive progress…"
        style={{ width: '100%', padding: 8, background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' }}
      />
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={() => { onAdd(text); setText(''); setOpen(false); }}
          disabled={!text.trim()}
          style={{ padding: '6px 12px', background: 'var(--good)', color: 'var(--bg)', border: 'none', borderRadius: 4, fontSize: 12, cursor: 'pointer', opacity: text.trim() ? 1 : 0.4 }}
        >
          Add
        </button>
        <button
          onClick={() => { setText(''); setOpen(false); }}
          style={{ padding: '6px 12px', background: 'transparent', color: 'var(--fg-dim)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 12, cursor: 'pointer' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function NewDirectiveModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<'low' | 'normal' | 'high'>('normal');
  const [budget, setBudget] = useState('');
  const [deadline, setDeadline] = useState('');
  const [targetMarket, setTargetMarket] = useState('');
  const [monetizationModel, setMonetizationModel] = useState('');
  const [successMetric, setSuccessMetric] = useState('');
  const [saving, setSaving] = useState(false);

  async function create() {
    if (!title.trim() || !body.trim()) {
      toast.error('title and body required');
      return;
    }
    setSaving(true);
    try {
      const budgetCents = budget.trim() ? Math.round(parseFloat(budget) * 100) : undefined;
      const deadlineTs = deadline.trim() ? new Date(deadline).getTime() : undefined;
      const constraints: Record<string, string> = {};
      if (targetMarket.trim()) constraints.target_market = targetMarket.trim();
      if (monetizationModel.trim()) constraints.monetization_model = monetizationModel.trim();
      if (successMetric.trim()) constraints.success_metric = successMetric.trim();
      const res = await fetch(orgPath('directives'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title, body, priority,
          budget_cents: budgetCents,
          deadline_ts: deadlineTs,
          ...(Object.keys(constraints).length > 0 ? { constraints } : {}),
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'create failed');
      const j = await res.json();
      const warns: string[] = j.tightnessWarnings ?? [];
      if (warns.length > 0) {
        toast.warning(`Directive created with ${warns.length} tightness warning${warns.length === 1 ? '' : 's'}: ${warns.join('; ')}`);
      } else {
        toast.success('directive created');
      }
      onCreated();
    } catch (e) {
      toast.error(`${e}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pc-modal-backdrop" onClick={onClose}>
      <section className="pc-modal pc-modal-large" onClick={(e) => e.stopPropagation()} aria-label="Create new directive">
        <header className="pc-modal-head">
          <div>
            <span className="pc-modal-kicker">Executive direction</span>
            <h2>New directive</h2>
            <p>Capture user intent with enough scope, constraints, and success criteria for CEO routing.</p>
          </div>
        </header>

        <div className="pc-field">
          <label>Title</label>
          <input
            className="pc-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="One-line goal"
          />
        </div>

        <div className="pc-field">
          <label>Directive (markdown)</label>
          <textarea
            className="pc-input pc-textarea pc-directive-textarea"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={10}
            placeholder="What should the org focus on? Be specific about scope, constraints, and success criteria. CEO will route to the right departments."
          />
        </div>

        <div className="pc-field-grid three">
          <div className="pc-field">
            <label>Priority</label>
            <select className="pc-input" value={priority} onChange={(e) => setPriority(e.target.value as any)}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </select>
          </div>
          <div className="pc-field">
            <label>Budget ($)</label>
            <input className="pc-input" type="number" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="optional" />
          </div>
          <div className="pc-field">
            <label>Deadline</label>
            <input className="pc-input" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </div>
        </div>

        <div className="pc-field">
          <label>Constraints (optional but improves CEO routing reproducibility)</label>
          <input className="pc-input" value={targetMarket} onChange={(e) => setTargetMarket(e.target.value)} placeholder="Target market — e.g. self-improvement / SMB CRM users / day traders" style={{ marginBottom: 6 }} />
          <input className="pc-input" value={monetizationModel} onChange={(e) => setMonetizationModel(e.target.value)} placeholder="Monetization model — e.g. freemium subscription via RevenueCat / paid app / free + ads" style={{ marginBottom: 6 }} />
          <input className="pc-input" value={successMetric} onChange={(e) => setSuccessMetric(e.target.value)} placeholder="Success metric — e.g. 1000 paying subscribers in 6 months / $10k MRR / 50% D7 retention" />
        </div>

        <footer className="pc-modal-actions end">
          <button className="pc-button" onClick={onClose}>Cancel</button>
          <button className="pc-button primary" onClick={create} disabled={saving || !title.trim() || !body.trim()}>
            {saving ? 'Creating…' : 'Create directive'}
          </button>
        </footer>
      </section>
    </div>
  );
}
