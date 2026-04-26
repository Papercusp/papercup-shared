'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type BriefingStatus =
  | 'draft' | 'rendering' | 'rendered' | 'uploading' | 'uploaded' | 'failed';

interface Briefing {
  id: string;
  title: string;
  quarter: string;
  status: BriefingStatus;
  created_at: string;
  duration_seconds: number | null;
  youtube_url: string | null;
  youtube_video_id: string | null;
  thumbnail_url: string | null;
  summary: string | null;
  error: string | null;
}

const STATUS_TONE: Record<BriefingStatus, { bg: string; fg: string; border: string; label: string }> = {
  draft:     { bg: 'rgba(148,163,184,0.10)', fg: '#94a3b8', border: 'rgba(148,163,184,0.30)', label: 'draft' },
  rendering: { bg: 'rgba(59,130,246,0.10)',  fg: '#60a5fa', border: 'rgba(59,130,246,0.30)',  label: 'rendering' },
  rendered:  { bg: 'rgba(168,85,247,0.10)',  fg: '#c084fc', border: 'rgba(168,85,247,0.30)',  label: 'rendered' },
  uploading: { bg: 'rgba(245,158,11,0.10)',  fg: '#fbbf24', border: 'rgba(245,158,11,0.30)',  label: 'uploading' },
  uploaded:  { bg: 'rgba(16,185,129,0.10)',  fg: '#34d399', border: 'rgba(16,185,129,0.30)',   label: 'uploaded' },
  failed:    { bg: 'rgba(239,68,68,0.10)',   fg: '#fca5a5', border: 'rgba(239,68,68,0.30)',   label: 'failed' },
};

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  const dt = Date.now() - t;
  if (dt < 60_000) return 'just now';
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function formatDuration(s: number | null): string {
  if (s == null) return '—';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}:${String(sec).padStart(2, '0')}` : `${sec}s`;
}

function pendingText(status: BriefingStatus): string {
  if (status === 'draft') return 'awaiting render';
  if (status === 'rendering') return 'rendering video';
  if (status === 'rendered') return 'awaiting upload';
  if (status === 'uploading') return 'uploading';
  if (status === 'failed') return 'pipeline failed';
  return 'published';
}

export interface BriefingsViewProps {
  initialData?: { briefings?: Briefing[] };
  readOnly?: boolean;
}

export default function BriefingsView({ initialData, readOnly = false }: BriefingsViewProps = {}) {
  const [list, setList] = useState<Briefing[] | null>(initialData?.briefings ?? null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/briefings');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setList(d.briefings ?? []);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'load failed');
    }
  }, []);

  useEffect(() => {
    if (initialData) return;       // server already hydrated
    if (readOnly) return;          // public surface — no live polling
    let cancelled = false;
    const guarded = async () => {
      if (!cancelled) await load();
    };
    guarded();
    const id = setInterval(guarded, 15_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [load, initialData, readOnly]);

  const metrics = useMemo(() => {
    const items = list ?? [];
    return {
      total: items.length,
      uploaded: items.filter((b) => b.status === 'uploaded').length,
      inPipeline: items.filter((b) => ['draft', 'rendering', 'rendered', 'uploading'].includes(b.status)).length,
      failed: items.filter((b) => b.status === 'failed').length,
      totalSeconds: items.reduce((sum, b) => sum + (b.duration_seconds ?? 0), 0),
    };
  }, [list]);

  const quarterCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const b of list ?? []) counts[b.quarter || 'unscheduled'] = (counts[b.quarter || 'unscheduled'] ?? 0) + 1;
    return Object.entries(counts).slice(0, 6);
  }, [list]);

  const statusCounts = useMemo(() => {
    const counts: Record<BriefingStatus, number> = { draft: 0, rendering: 0, rendered: 0, uploading: 0, uploaded: 0, failed: 0 };
    for (const b of list ?? []) counts[b.status] += 1;
    return Object.entries(counts).filter(([, count]) => count > 0) as Array<[BriefingStatus, number]>;
  }, [list]);

  const latest = list?.[0] ?? null;

  return (
    <div className={`pc-page pc-briefings-page${readOnly ? ' pc-view-readonly' : ''}`}>
      <header className="pc-hero pc-briefings-hero" aria-labelledby="briefings-title">
        <div>
          <div className="pc-eyebrow"><span className="pc-eyebrow-dot" /> Investor relations studio</div>
          <h1 id="briefings-title">Briefings turn company progress into a publishable narrative.</h1>
          <p className="pc-lede">
            AI-generated shareholder briefings, dignified and routine. Each entry tracks a single episode
            from script through render and YouTube upload.
          </p>
          <div className="pc-hero-actions">
            <button className="pc-action primary" onClick={load}>Refresh briefings</button>
            <span className="pc-action">npm run briefings:produce</span>
          </div>
        </div>

        <aside className="pc-hero-panel" aria-label="Briefing pipeline summary">
          <div className="pc-metric-grid">
            <div className="pc-metric accent"><span>briefings</span><strong>{metrics.total}</strong></div>
            <div className="pc-metric good"><span>uploaded</span><strong>{metrics.uploaded}</strong></div>
            <div className="pc-metric warn"><span>pipeline</span><strong>{metrics.inPipeline}</strong></div>
            <div className={`pc-metric ${metrics.failed > 0 ? 'warn' : 'good'}`}><span>failed</span><strong>{metrics.failed}</strong></div>
          </div>
          <div className="pc-flow-note">
            Total runtime tracked: {formatDuration(metrics.totalSeconds)}. Refreshes every 15 seconds while the producer pipeline runs.
          </div>
        </aside>
      </header>

      <section className="pc-briefing-pipeline" aria-label="Briefing production pipeline">
        <span><b>1</b> Script</span>
        <span><b>2</b> Render</span>
        <span><b>3</b> Upload</span>
        <span><b>4</b> Publish</span>
      </section>

      {statusCounts.length > 0 && (
        <section className="pc-briefing-status-rail" aria-label="Briefing status distribution">
          {statusCounts.map(([status, count]) => (
            <span key={status} className={status}><b>{count}</b><em>{STATUS_TONE[status].label}</em></span>
          ))}
        </section>
      )}

      {quarterCounts.length > 0 && (
        <section className="pc-briefing-quarter-rail" aria-label="Briefings by quarter">
          {quarterCounts.map(([quarter, count]) => (
            <span key={quarter}><b>{quarter}</b><em>{count} episode{count === 1 ? '' : 's'}</em></span>
          ))}
        </section>
      )}

      {latest && (
        <section className="pc-briefing-spotlight" aria-label="Latest briefing spotlight">
          <div>
            <span className="pc-modal-kicker">Latest episode</span>
            {latest.thumbnail_url && <img className="pc-briefing-spotlight-thumb" src={latest.thumbnail_url} alt="" />}
            <h2>{latest.title}</h2>
            <p>{latest.summary || 'No summary has been written for this briefing yet.'}</p>
          </div>
          <div className="pc-briefing-spotlight-meta">
            <span>{latest.quarter || 'quarter —'}</span>
            <span>{formatDuration(latest.duration_seconds)}</span>
            <span>{relTime(latest.created_at)}</span>
            {latest.youtube_url ? (
              <a href={latest.youtube_url} target="_blank" rel="noreferrer">Watch ↗</a>
            ) : (
              <em>{pendingText(latest.status)}</em>
            )}
          </div>
        </section>
      )}

      {error && (
        <div className="pc-empty pc-briefing-error">
          Failed to load briefings: {error}
        </div>
      )}

      {list === null && !error && (
        <div className="pc-empty">loading…</div>
      )}

      {list !== null && list.length === 0 && (
        <div className="pc-empty pc-briefing-empty">
          <span className="pc-empty-icon">▦</span>
          <div>
            <strong>No briefings yet.</strong>
            <p>Produce the first one with <code>npm run briefings:produce</code>.</p>
          </div>
        </div>
      )}

      {list !== null && list.length > 0 && (
        <div className="pc-card-grid pc-briefing-grid">
          {list.map((b) => {
            const tone = STATUS_TONE[b.status];
            return (
              <article key={b.id} className="pc-card briefing-card">
                <div className="briefing-media" aria-hidden="true">
                  {b.thumbnail_url ? <img src={b.thumbnail_url} alt="" /> : <span>▶</span>}
                </div>
                <header className="briefing-card-head">
                  <div className="briefing-id">{b.id}</div>
                  <span
                    className="briefing-status"
                    style={{
                      background: tone.bg, color: tone.fg,
                      border: `1px solid ${tone.border}`,
                    }}
                  >
                    {tone.label}
                  </span>
                </header>
                <h2 className="briefing-title">{b.title}</h2>
                <div className="briefing-meta">
                  <span>{b.quarter || '—'}</span>
                  <span>•</span>
                  <span>{formatDuration(b.duration_seconds)}</span>
                  <span>•</span>
                  <span>{relTime(b.created_at)}</span>
                </div>
                {b.summary && (
                  <p className="briefing-summary">{b.summary}</p>
                )}
                {b.error && (
                  <div className="briefing-error"><strong>error:</strong> {b.error}</div>
                )}
                <div className="briefing-progress" aria-label={`Briefing status ${pendingText(b.status)}`}>
                  <span>{b.youtube_url ? 'published' : pendingText(b.status)}</span>
                  <b>{b.youtube_video_id ? b.youtube_video_id : b.status}</b>
                </div>
                <footer className="briefing-actions">
                  {b.youtube_url ? (
                    <a href={b.youtube_url} target="_blank" rel="noreferrer" className="briefing-link">Watch on YouTube ↗</a>
                  ) : (
                    <span className="briefing-pending">{pendingText(b.status)}</span>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
