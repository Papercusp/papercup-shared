'use client';

import { useState } from 'react';
import BrainstormReadOnlyView, { type BrainstormPayload } from './BrainstormReadOnlyView';
import InboxReadOnlyView, { type InboxPayload } from './InboxReadOnlyView';
import PublicChatView from './PublicChatView';
import HarnessConsoleView, { type HarnessConsolePayload } from './HarnessConsoleView';

export interface HarnessDetailPayload {
  slug: string;
  departmentSlug: string;
  brainstorm: BrainstormPayload;
  inbox: InboxPayload;
  outbox: InboxPayload;
}

export type HarnessKind = 'department' | 'coding';

export interface HarnessDetailViewProps {
  data: HarnessDetailPayload | null;
  loading?: boolean;
  error?: string | null;
  liveAt?: number | null;
  initialTab?: HarnessDetailTab;
  /** Base URL for the public API (used by the Chat tab). Required to enable Chat. */
  apiBase?: string;
  /** Live console data (sanitized cockpit payload). Enables Console tab when present. */
  console?: HarnessConsolePayload | null;
  consoleLoading?: boolean;
  consoleError?: string | null;
  /** Which kind of harness — drives default tab. 'coding' defaults to console. */
  harnessKind?: HarnessKind;
}

export type HarnessDetailTab = 'console' | 'brainstorm' | 'inbox' | 'outbox' | 'chat';

const TABS_CODING: { key: HarnessDetailTab; label: string; icon: string }[] = [
  { key: 'console', label: 'Console', icon: '⌁' },
  { key: 'brainstorm', label: 'Brainstorm', icon: '🧠' },
  { key: 'chat', label: 'Chat', icon: '💬' },
];
const TABS_DEPARTMENT: { key: HarnessDetailTab; label: string; icon: string }[] = [
  { key: 'console', label: 'Console', icon: '⌁' },
  { key: 'brainstorm', label: 'Brainstorm', icon: '🧠' },
  { key: 'inbox', label: 'Inbox', icon: '📥' },
  { key: 'outbox', label: 'Outbox', icon: '📤' },
  { key: 'chat', label: 'Chat', icon: '💬' },
];

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

export default function HarnessDetailView({
  data, loading, error, liveAt, initialTab, apiBase,
  console: consoleData, consoleLoading, consoleError,
  harnessKind = 'department',
}: HarnessDetailViewProps) {
  const TABS = harnessKind === 'coding' ? TABS_CODING : TABS_DEPARTMENT;
  const defaultTab: HarnessDetailTab = initialTab ?? (harnessKind === 'coding' ? 'console' : 'inbox');
  const [tab, setTab] = useState<HarnessDetailTab>(defaultTab);

  if (!data && loading) {
    return (
      <div className="pc-harness-detail">
        <div className="pc-harness-detail-loading">Loading…</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="pc-harness-detail">
        <div className="pc-harness-detail-loading">{error ?? 'No data.'}</div>
      </div>
    );
  }

  const inboxCount = data.inbox?.messages?.length ?? 0;
  const inboxPending = data.inbox?.messages?.filter((m) => m.status === 'pending').length ?? 0;
  const outboxCount = data.outbox?.messages?.length ?? 0;
  const brainstormChars = data.brainstorm?.content?.length ?? 0;

  return (
    <div className="pc-harness-detail">
      <header className="pc-harness-detail-head">
        <div className="pc-harness-detail-title">
          <a href="/harnesses/" className="pc-harness-detail-back" aria-label="Back to harnesses">← all harnesses</a>
          <h2>{formatDirector(data.departmentSlug)}</h2>
          <code>{data.slug}</code>
        </div>
        <div className="pc-harness-detail-meta">
          {error ? <span className="pc-harness-meta-warn">offline</span>
            : liveAt ? <span>live · updated {Math.max(0, Math.floor((Date.now() - liveAt) / 1000))}s ago</span>
            : <span>snapshot</span>}
        </div>
      </header>

      <nav className="pc-harness-detail-tabs" role="tablist">
        {TABS.map((t) => {
          const active = tab === t.key;
          const badge =
            t.key === 'console' ? (consoleData ? `${consoleData.counts.passed}/${consoleData.counts.total}` : 'live') :
            t.key === 'brainstorm' ? (brainstormChars > 0 ? `${brainstormChars}c` : '0') :
            t.key === 'inbox' ? (inboxPending > 0 ? `${inboxPending}/${inboxCount}` : `${inboxCount}`) :
            t.key === 'outbox' ? `${outboxCount}` :
            'AI';
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              className={`pc-harness-detail-tab${active ? ' is-active' : ''}`}
            >
              <span className="pc-harness-detail-tab-icon" aria-hidden>{t.icon}</span>
              <span className="pc-harness-detail-tab-label">{t.label}</span>
              <span className="pc-harness-detail-tab-badge">{badge}</span>
            </button>
          );
        })}
      </nav>

      <section className="pc-harness-detail-body">
        {tab === 'console' && (
          <HarnessConsoleView
            data={consoleData ?? null}
            loading={consoleLoading}
            error={consoleError}
            liveAt={liveAt}
            apiBase={apiBase}
          />
        )}
        {tab === 'brainstorm' && <BrainstormReadOnlyView data={data.brainstorm} />}
        {tab === 'inbox' && <InboxReadOnlyView data={data.inbox} departmentSlug={data.departmentSlug} kind="inbox" />}
        {tab === 'outbox' && <InboxReadOnlyView data={data.outbox} departmentSlug={data.departmentSlug} kind="outbox" />}
        {tab === 'chat' && (
          apiBase
            ? <PublicChatView apiBase={apiBase} slug={data.slug} greeting={`Ask about the ${formatDirector(data.departmentSlug)} director, the inbox/outbox you see, or how Papercup works.`} />
            : <div className="pc-chat-disabled">Chat is not available here.</div>
        )}
      </section>
    </div>
  );
}
