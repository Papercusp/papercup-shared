'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast, Toaster } from 'sonner';
import { orgPath } from './_admin-paths';

type Project = {
  id: string;
  slug: string;
  name: string;
  vertical: string;
  status: 'proposed' | 'approved' | 'in_progress' | 'launched' | 'paused' | 'cancelled';
  owning_director: string;
  budget_cents: number;
  spent_cents: number;
  earned_cents?: number;
  cost_cap_cents?: number;
  created_ts: number;
};

function statusClass(s: string): string {
  return s.replace(/_/g, '-');
}

function statusLabel(s: string): string {
  return s.replace(/_/g, ' ');
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function budgetPct(p: Project): number {
  if (p.budget_cents <= 0) return 0;
  return Math.min(100, Math.round((p.spent_cents / p.budget_cents) * 100));
}

export interface ProjectsViewProps {
  initialData?: { projects?: Project[] };
  readOnly?: boolean;
}

export default function ProjectsView({ initialData, readOnly = false }: ProjectsViewProps = {}) {
  const [projects, setProjects] = useState<Project[]>(initialData?.projects ?? []);
  const [loaded, setLoaded] = useState(initialData?.projects !== undefined);
  const [showNew, setShowNew] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(orgPath('projects'), { cache: 'no-store' });
      const data = await res.json();
      setProjects(data.projects ?? []);
      setLoaded(true);
    } catch (e) {
      toast.error(`refresh failed: ${e}`);
    }
  }, []);

  useEffect(() => {
    if (initialData) return;
    if (readOnly) return;
    refresh();
    const i = setInterval(refresh, 5000);
    return () => clearInterval(i);
  }, [refresh, initialData, readOnly]);

  const grouped = useMemo(() => projects.reduce<Record<string, Project[]>>((acc, p) => {
    (acc[p.vertical] ??= []).push(p);
    return acc;
  }, {}), [projects]);
  const verticals = Object.keys(grouped).sort();

  const totals = useMemo(() => {
    const budget = projects.reduce((sum, p) => sum + p.budget_cents, 0);
    const spent = projects.reduce((sum, p) => sum + p.spent_cents, 0);
    return {
      budget,
      spent,
      proposed: projects.filter((p) => p.status === 'proposed').length,
      active: projects.filter((p) => p.status === 'approved' || p.status === 'in_progress').length,
      launched: projects.filter((p) => p.status === 'launched').length,
      paused: projects.filter((p) => p.status === 'paused' || p.status === 'cancelled').length,
    };
  }, [projects]);

  const portfolioPct = totals.budget > 0 ? Math.min(100, Math.round((totals.spent / totals.budget) * 100)) : 0;

  return (
    <div className={`pc-page pc-projects-page${readOnly ? ' pc-view-readonly' : ''}`}>
      <Toaster position="bottom-right" />

      <header className="pc-hero" aria-labelledby="projects-title">
        <div>
          <div className="pc-eyebrow"><span className="pc-eyebrow-dot" /> Live project portfolio</div>
          <h1 id="projects-title">Execution units grouped by vertical, budget, and operating state.</h1>
          <p className="pc-lede">
            Projects are owned by Management and tagged by vertical. Shared Technology produces capabilities
            that any project can consume, so every new build compounds the platform.
          </p>
          <div className="pc-hero-actions">
            <button className="pc-action primary" onClick={() => setShowNew(true)}>+ New project</button>
            <button className="pc-action" onClick={refresh}>Refresh portfolio</button>
          </div>
        </div>

        <aside className="pc-hero-panel" aria-label="Project portfolio summary">
          <div className="pc-metric-grid">
            <div className="pc-metric accent"><span>projects</span><strong>{projects.length}</strong></div>
            <div className="pc-metric good"><span>verticals</span><strong>{verticals.length}</strong></div>
            <div className="pc-metric"><span>budget</span><strong>{money(totals.budget)}</strong></div>
            <div className="pc-metric warn"><span>spent</span><strong>{money(totals.spent)}</strong></div>
          </div>
          <div className="pc-flow-note">
            {loaded ? `${totals.active} active project${totals.active === 1 ? '' : 's'} and ${totals.proposed} proposed bet${totals.proposed === 1 ? '' : 's'} across ${verticals.length} vertical${verticals.length === 1 ? '' : 's'}.` : 'Loading live project state…'}
          </div>
        </aside>
      </header>

      {showNew && <NewProjectModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); refresh(); }} />}

      <section className="pc-pipeline" aria-label="Project pipeline summary">
        <div className="pc-pipeline-step proposed"><span>Proposed</span><strong>{totals.proposed}</strong><em>waiting for approval</em></div>
        <div className="pc-pipeline-step in-progress"><span>Active</span><strong>{totals.active}</strong><em>approved / in progress</em></div>
        <div className="pc-pipeline-step launched"><span>Launched</span><strong>{totals.launched}</strong><em>market/live</em></div>
        <div className={`pc-pipeline-step ${totals.paused > 0 ? 'attention' : 'launched'}`}><span>Paused</span><strong>{totals.paused}</strong><em>{totals.paused > 0 ? 'needs decision' : 'clear'}</em></div>
      </section>

      <section className="pc-portfolio-rail" aria-label={`Portfolio budget used ${portfolioPct}%`}>
        <div>
          <span>Budget utilization</span>
          <strong>{money(totals.spent)} spent of {money(totals.budget)}</strong>
        </div>
        <div className="pc-budget-rail"><span style={{ width: `${portfolioPct}%` }} /></div>
        <em>{portfolioPct}% allocated</em>
      </section>

      {loaded && projects.length === 0 && (
        <div className="pc-empty" style={{ marginTop: 18 }}>
          No projects yet. Create one to broadcast a ProjectKickoff to all departments.
        </div>
      )}

      <div className="pc-project-sections">
        {verticals.map((vertical) => (
          <section className="pc-vertical" key={vertical}>
            <div className="pc-vertical-title">
              <div>
                <h2>{vertical}</h2>
                <p>{grouped[vertical].length} live project{grouped[vertical].length === 1 ? '' : 's'} in this vertical.</p>
              </div>
              <div className="pc-vertical-meta">
                <span className="pc-code">vertical: {vertical}</span>
                <div className="pc-vertical-rail" aria-label={`${vertical} budget summary`}>
                  <span>{grouped[vertical].length} bets</span>
                  <span>{money(grouped[vertical].reduce((sum, p) => sum + p.budget_cents, 0))} budget</span>
                  <span>{money(grouped[vertical].reduce((sum, p) => sum + p.spent_cents, 0))} spent</span>
                </div>
              </div>
            </div>

            <div className="pc-project-grid">
              {grouped[vertical].map((project) => {
                const pct = budgetPct(project);
                return (
                  <Link key={project.id} href={`/projects/${project.slug}`} className="pc-project-link">
                    <article className="pc-project-card">
                      <div className="pc-project-top">
                        <h3>{project.name}</h3>
                        <span className={`pc-status ${statusClass(project.status)}`}>{statusLabel(project.status)}</span>
                      </div>

                      <div className="pc-project-stats">
                        <div className="pc-project-stat"><span>budget</span><strong>{money(project.budget_cents)}</strong></div>
                        <div className="pc-project-stat"><span>spent</span><strong>{money(project.spent_cents)}</strong></div>
                        {(project.earned_cents ?? 0) > 0 && (
                          <div className="pc-project-stat" style={{ color: '#9ece6a' }}><span>earned</span><strong>{money(project.earned_cents ?? 0)}</strong></div>
                        )}
                        {project.cost_cap_cents && (
                          <div className="pc-project-stat" style={{ color: project.spent_cents >= project.cost_cap_cents ? '#f7768e' : project.spent_cents >= project.cost_cap_cents * 0.8 ? '#fbbf24' : '#7c89b1' }}>
                            <span>cap</span><strong>{money(project.cost_cap_cents)}</strong>
                          </div>
                        )}
                        <div className="pc-project-stat"><span>age</span><strong>{relativeTime(project.created_ts)}</strong></div>
                      </div>
                      {project.cost_cap_cents && project.spent_cents >= project.cost_cap_cents && (
                        <div style={{ background: 'rgba(247, 118, 142, 0.15)', color: '#f7768e', padding: '6px 10px', borderRadius: 6, fontSize: 12, marginTop: 6, fontWeight: 600 }}>
                          ⚠ Cost cap reached — pause recommended
                        </div>
                      )}
                      {project.cost_cap_cents && project.spent_cents < project.cost_cap_cents && project.spent_cents >= project.cost_cap_cents * 0.8 && (
                        <div style={{ background: 'rgba(251, 191, 36, 0.12)', color: '#fbbf24', padding: '6px 10px', borderRadius: 6, fontSize: 12, marginTop: 6 }}>
                          ⚠ {Math.round((project.spent_cents / project.cost_cap_cents) * 100)}% of cost cap used
                        </div>
                      )}

                      <div className="pc-budget-rail" aria-label={`Budget used ${pct}%`}>
                        <span style={{ width: `${pct}%` }} />
                      </div>

                      <div className={`pc-project-stage pc-stage-${statusClass(project.status)}`} aria-label={`${project.name} stage ${statusLabel(project.status)}`}>
                        <span>proposal</span>
                        <span>approve</span>
                        <span>build</span>
                        <span>launch</span>
                      </div>

                      <div className="pc-dept-meta">
                        <span className="pc-pill accent">{project.owning_director || 'Management'}</span>
                        <span className="pc-pill">slug: {project.slug}</span>
                      </div>

                      <footer className="pc-project-foot">
                        <span>{portfolioPct ? `${pct}% of project budget` : 'budget ready'}</span>
                        <em>{project.status === 'launched' ? 'market/live' : project.status === 'in_progress' ? 'in build' : project.status === 'approved' ? 'ready to build' : project.status}</em>
                      </footer>
                    </article>
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

function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [vertical, setVertical] = useState('apps');
  const [budget, setBudget] = useState('');
  const [costCap, setCostCap] = useState('');
  const [saving, setSaving] = useState(false);

  function autoSlug(n: string) {
    return n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  const create = useCallback(async () => {
    if (!name.trim() || !vertical.trim()) {
      toast.error('name and vertical required');
      return;
    }
    setSaving(true);
    try {
      const finalSlug = slug.trim() || autoSlug(name);
      const budgetCents = budget.trim() ? Math.round(parseFloat(budget) * 100) : 0;
      const costCapCents = costCap.trim() ? Math.round(parseFloat(costCap) * 100) : undefined;
      const body: Record<string, unknown> = { slug: finalSlug, name, vertical, budget_cents: budgetCents };
      if (costCapCents !== undefined) body.cost_cap_cents = costCapCents;
      const res = await fetch(orgPath('projects'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'create failed');
      toast.success('project created · ProjectKickoff broadcast · live in Zero');
      onCreated();
    } catch (e) {
      toast.error(`${e}`);
    } finally {
      setSaving(false);
    }
  }, [name, slug, vertical, budget, costCap, onCreated]);

  return (
    <div className="pc-modal-backdrop" onClick={onClose}>
      <section className="pc-modal" onClick={(e) => e.stopPropagation()} aria-label="Create new project">
        <header className="pc-modal-head">
          <div>
            <span className="pc-modal-kicker">Portfolio intake</span>
            <h2>New project</h2>
            <p>Create an execution unit and broadcast a ProjectKickoff to the company graph.</p>
          </div>
        </header>

        <div className="pc-field">
          <label>Name</label>
          <input className="pc-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Music App" />
        </div>

        <div className="pc-field">
          <label>Slug</label>
          <input className="pc-input" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={`auto: ${autoSlug(name) || 'music-app'}`} />
        </div>

        <div className="pc-field-grid two">
          <div className="pc-field">
            <label>Vertical</label>
            <input className="pc-input" value={vertical} onChange={(e) => setVertical(e.target.value)} placeholder="apps / construction / platform" />
          </div>
          <div className="pc-field">
            <label>Budget ($)</label>
            <input className="pc-input" type="number" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="optional" />
          </div>
        </div>

        <div className="pc-field">
          <label>Cost cap ($)</label>
          <input
            className="pc-input"
            type="number"
            value={costCap}
            onChange={(e) => setCostCap(e.target.value)}
            placeholder="optional — hard ceiling on agent spend"
          />
        </div>

        <footer className="pc-modal-actions end">
          <button className="pc-button" onClick={onClose}>Cancel</button>
          <button className="pc-button primary" onClick={create} disabled={saving || !name.trim()}>
            {saving ? 'Creating…' : 'Create project'}
          </button>
        </footer>
      </section>
    </div>
  );
}

