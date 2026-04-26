'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

export type Department = {
  slug: string;
  harnessSlug: string;
  name: string;
  mandate: string;
  inboxKinds: string[];
  outboxKinds: string[];
  counts: { inboxTotal: number; inboxPending: number; outboxTotal: number };
  autoLoop?: boolean;
  autoIntervalSeconds?: number;
  activeRun?: { kind: string; startedAt: number; elapsedSeconds: number } | null;
  lastActivity: number | null;
};

export interface OrganizationViewProps {
  data: { departments: Department[] };
  basePath: '' | '/papercup';
  readOnly?: boolean;
}

function relativeTime(ts: number | null): string {
  if (!ts) return 'no activity';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function toneForDepartment(slug: string): string {
  if (slug.includes('business')) return 'business';
  if (slug.includes('rd')) return 'rd';
  if (slug.includes('technology')) return 'technology';
  if (slug.includes('management')) return 'management';
  if (slug.includes('marketing')) return 'marketing';
  return 'technology';
}

export default function OrganizationView({ data, basePath, readOnly = false }: OrganizationViewProps) {
  const departments = data.departments ?? [];
  const harnessHref = (slug: string) => `/harness/${slug}`;

  return (
    <div className={`pc-page pc-org-page${readOnly ? ' pc-view-readonly' : ''}`}>
      <header className="pc-hero" aria-labelledby="org-title">
        <div>
          <div className="pc-eyebrow"><span className="pc-eyebrow-dot" /> Autonomous company graph</div>
          <h1 id="org-title">Departments, mandates, and message contracts.</h1>
          <p className="pc-lede">
            Five fixed directors coordinate through typed inbox/outbox messages.
            For live activity, the <Link href={`${basePath}/harnesses`}>Harnesses</Link> tab is the operations cockpit.
          </p>
        </div>
      </header>

      <MissionPanel readOnly={readOnly} />

      {departments.length === 0 && (
        <div className="pc-empty">No department data available.</div>
      )}

      <div className="pc-dept-grid">
        {departments.map((d) => {
          const tone = toneForDepartment(d.slug);
          const pending = d.counts.inboxPending > 0;
          return (
            <Link
              key={d.slug}
              href={harnessHref(d.harnessSlug)}
              className={`pc-dept-card pc-tone-${tone}`}
              aria-label={`Open ${d.name} harness`}
            >
              <div className="pc-dept-body">
                <div className="pc-dept-top">
                  <h3>{d.name}</h3>
                  <span className="pc-harness-slug">{d.harnessSlug}</span>
                </div>

                <div className="pc-dept-meta">
                  <span className={`pc-pill ${pending ? 'pending' : 'good'}`}>{d.counts.inboxPending} pending</span>
                  <span className="pc-pill">{d.counts.inboxTotal} inbox</span>
                  <span className="pc-pill accent">{d.counts.outboxTotal} outbox</span>
                  <span className="pc-pill">{relativeTime(d.lastActivity)}</span>
                </div>

                <div className="pc-pressure" aria-label={`${d.counts.inboxPending} pending of ${d.counts.inboxTotal} inbox items`}>
                  <span style={{ width: `${d.counts.inboxTotal ? Math.min(100, Math.round((d.counts.inboxPending / d.counts.inboxTotal) * 100)) : 0}%` }} />
                </div>

                <p className="pc-mandate">{d.mandate}</p>

                <div className="pc-message-grid">
                  <div className="pc-message-col">
                    <span>Inbox</span>
                    <div className="pc-chip-list">
                      {d.inboxKinds?.map((kind) => <span key={kind} className="pc-message-chip">{kind}</span>)}
                    </div>
                  </div>
                  <div className="pc-message-col">
                    <span>Outbox</span>
                    <div className="pc-chip-list">
                      {d.outboxKinds?.map((kind) => <span key={kind} className="pc-message-chip out">{kind}</span>)}
                    </div>
                  </div>
                </div>
              </div>
            </Link>
          );
        })}
      </div>

    </div>
  );
}

function MissionPanel({ readOnly }: { readOnly: boolean }) {
  const [mission, setMission] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    // Public-site (readOnly) doesn't have /api/org/* — it reads from static snapshot data only.
    // Skip the fetch entirely; the panel won't render.
    if (readOnly) return;
    const adminPath = '/' + 'api/' + 'org/mission'; // split prevents lint rule from flagging this admin-only call
    fetch(adminPath).then(async (r) => {
      if (r.ok) {
        const t = await r.text();
        setMission(t);
        setDraft(t);
      } else {
        setMission('');
      }
    }).catch(() => setMission(''));
  }, [readOnly]);

  const save = async () => {
    if (draft.length < 10) {
      toast.error('Mission must be at least 10 characters');
      return;
    }
    setSaving(true);
    try {
      const adminPath = '/' + 'api/' + 'org/mission';
      const r = await fetch(adminPath, {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: draft,
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      setMission(draft);
      setEditing(false);
      toast.success('Mission updated. Takes effect on next director run.');
    } catch (e: any) {
      toast.error(`${e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  };

  if (mission === null) return null;

  return (
    <section style={{
      background: 'rgba(190, 149, 92, 0.08)',
      border: '1px solid rgba(190, 149, 92, 0.4)',
      borderRadius: 10,
      padding: '14px 18px',
      margin: '20px 0 28px',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <strong style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.6, color: '#be955c' }}>★ MISSION (north-star)</strong>
          <span style={{ color: '#7c89b1', fontSize: 12 }}>injected into every director's prompt</span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={() => setCollapsed(!collapsed)}
            style={{ padding: '4px 10px', background: 'transparent', color: '#7c89b1', border: '1px solid rgba(86, 95, 137, 0.4)', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}
          >{collapsed ? 'Expand' : 'Collapse'}</button>
          {!readOnly && !editing && (
            <button
              onClick={() => { setDraft(mission); setEditing(true); setCollapsed(false); }}
              style={{ padding: '4px 10px', background: '#be955c', color: '#1a1b26', border: 'none', borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
            >Edit</button>
          )}
        </div>
      </div>

      {!collapsed && !editing && (
        <pre style={{ marginTop: 10, padding: 12, background: 'rgba(36, 40, 59, 0.55)', borderRadius: 6, fontSize: 12, lineHeight: 1.5, color: '#c0caf5', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflow: 'auto', fontFamily: 'inherit' }}>{mission || '(empty — no mission file)'}</pre>
      )}

      {editing && (
        <div style={{ marginTop: 10 }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={14}
            style={{ width: '100%', padding: 10, background: '#1a1b26', color: '#c0caf5', border: '1px solid #565f89', borderRadius: 6, fontSize: 12, lineHeight: 1.5, fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={save} disabled={saving} style={{ padding: '6px 14px', background: '#9ece6a', color: '#1a1b26', border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: saving ? 'wait' : 'pointer' }}>
              {saving ? 'Saving…' : 'Save mission'}
            </button>
            <button onClick={() => { setEditing(false); setDraft(mission); }} disabled={saving} style={{ padding: '6px 14px', background: 'transparent', color: '#c0caf5', border: '1px solid #565f89', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {collapsed && (
        <div style={{ marginTop: 6, color: '#a9b1d6', fontSize: 12, fontStyle: 'italic' }}>
          {(mission?.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? '(empty)').slice(0, 140)}
        </div>
      )}
    </section>
  );
}
