'use client';

import { useState } from 'react';

export interface InboxMessage {
  id: string;
  ts: number;
  from: string;
  to: string[];
  kind: string;
  subject: string;
  body: string;
  status: 'pending' | 'acknowledged' | 'actioned' | 'archived';
  projectId?: string | null;
  directiveId?: string | null;
}

export interface InboxPayload {
  messages: InboxMessage[];
}

export interface InboxReadOnlyViewProps {
  data: InboxPayload;
  departmentSlug: string;
  kind: 'inbox' | 'outbox';
}

const KIND_META: Record<string, { color: string }> = {
  ProjectKickoff: { color: '#86efac' },
  ProgressUpdate: { color: '#93c5fd' },
  BudgetAllocation: { color: '#fcd34d' },
  Priority: { color: '#fca5a5' },
  Decision: { color: '#cbd5e1' },
};

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function statusLabel(s: InboxMessage['status']): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function InboxReadOnlyView({ data, departmentSlug, kind }: InboxReadOnlyViewProps) {
  const messages = (data?.messages ?? []).slice().sort((a, b) => b.ts - a.ts);
  const [openId, setOpenId] = useState<string | null>(null);

  if (messages.length === 0) {
    return (
      <div className="pc-inbox pc-inbox-empty">
        <p>No {kind} messages.</p>
      </div>
    );
  }

  return (
    <div className="pc-inbox">
      <ol className="pc-inbox-list" role="list">
        {messages.map((m) => {
          const open = openId === m.id;
          const kindMeta = KIND_META[m.kind];
          const peer = kind === 'inbox' ? m.from : (m.to[0] ?? '—');
          return (
            <li key={m.id} className={`pc-inbox-item${open ? ' is-open' : ''} pc-inbox-status-${m.status}`}>
              <button
                type="button"
                className="pc-inbox-row"
                onClick={() => setOpenId(open ? null : m.id)}
                aria-expanded={open}
              >
                <span className="pc-inbox-kind" style={kindMeta ? { color: kindMeta.color } : undefined}>
                  {m.kind}
                </span>
                <span className="pc-inbox-peer">
                  {kind === 'inbox' ? 'from ' : 'to '}<strong>{peer}</strong>
                </span>
                <span className="pc-inbox-subject">{m.subject}</span>
                <span className="pc-inbox-status">{statusLabel(m.status)}</span>
                <span className="pc-inbox-ts">{relativeTime(m.ts)}</span>
              </button>
              {open && (
                <div className="pc-inbox-body">
                  <div className="pc-inbox-body-meta">
                    <span><b>From:</b> {m.from}</span>
                    <span><b>To:</b> {m.to.join(', ')}</span>
                    <span><b>Kind:</b> {m.kind}</span>
                    <span><b>Status:</b> {statusLabel(m.status)}</span>
                    {m.projectId && <span><b>Project:</b> <code>{m.projectId.slice(0, 8)}</code></span>}
                    {m.directiveId && <span><b>Directive:</b> <code>{m.directiveId}</code></span>}
                  </div>
                  <pre className="pc-inbox-body-text">{m.body}</pre>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <p className="pc-inbox-foot">
        {messages.length} {kind} message{messages.length === 1 ? '' : 's'} for <strong>{departmentSlug}</strong>
      </p>
    </div>
  );
}
