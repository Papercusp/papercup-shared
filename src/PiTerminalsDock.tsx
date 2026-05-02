'use client';

/**
 * PiTerminalsDock — multi-pane container for pi/omp terminals.
 *
 * Wraps `dockview-react` so the operator can open multiple terminals as
 * tabs, drag them into splits, and rearrange. Each panel mounts its own
 * `<PiPanel>` instance, which independently spawns a pty, owns its xterm
 * instance, and tears everything down on unmount.
 *
 * Layout is persisted in localStorage per harness slug. On reload, the
 * previous arrangement is restored; pty contents are NOT restored (each
 * pane spawns a fresh pty).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from 'dockview';
import 'dockview-react/dist/styles/dockview.css';
import { MessageSquarePlus, Plus, TerminalSquare } from 'lucide-react';
import PiPanel from './PiPanel';
import ChatPanel from './ChatPanel';
import { Tooltip } from './Tooltip';

interface PiTerminalsDockProps {
  slug: string;
  /** Optional initial laneId for the first terminal — typically the active feature. */
  initialLaneId?: string;
}

interface TerminalPanelParams {
  slug: string;
  laneId?: string;
}

interface ChatPanelParams {
  slug: string;
  chatId: string;
}

const LAYOUT_STORAGE_PREFIX = 'papercusp:pi-dock-layout:';

function layoutKey(slug: string): string {
  return `${LAYOUT_STORAGE_PREFIX}${slug}`;
}

/**
 * Cross-component event for opening a chat panel from elsewhere in the
 * dashboard (e.g., FeaturePeekPanel's "chat" button). Dispatched on
 * window; the dock listens. Detail = the chat metadata to mount.
 *
 * Race fix: the event is fired by `openFeatureChat()` *before* the
 * caller switches the dashboard to the consoles tab — so when the
 * dispatcher fires, the dock hasn't mounted yet and no listener exists.
 * To handle that, every dispatch ALSO pushes the detail onto the
 * module-level `pendingOpens` queue. When the dock mounts (or when its
 * event listener fires), it drains the queue. Either path opens the
 * panel exactly once; the queue entry is removed as part of opening.
 */
export interface OpenChatEventDetail {
  slug: string;
  chatId: string;
  title?: string;
  role?: string;
  featureId?: string;
}
export const OPEN_CHAT_EVENT = 'papercusp:open-chat';

const pendingOpens: OpenChatEventDetail[] = [];

function drainPendingOpens(api: DockviewApi, slug: string): void {
  for (let i = pendingOpens.length - 1; i >= 0; i--) {
    const detail = pendingOpens[i];
    if (detail.slug !== slug) continue;
    const panelId = `chat-${detail.chatId}`;
    const existing = api.panels.find((p) => p.id === panelId);
    if (existing) {
      try { existing.api.setActive(); } catch { /* ignore */ }
    } else {
      // Add into the currently-active group so the new chat appears as
      // a tab next to whatever the user was looking at, not as a fresh
      // split. Without this, dockview defaults to creating a new group
      // when the layout is non-empty and the active group's reference
      // becomes ambiguous (StrictMode double-mount can do this).
      const activeGroup = api.activeGroup;
      const panel = api.addPanel({
        id: panelId,
        component: 'chat',
        title:
          detail.title ??
          (detail.featureId
            ? `${detail.role ?? 'agent'} · ${detail.featureId}`
            : (detail.role ?? 'chat')),
        params: { slug: detail.slug, chatId: detail.chatId } satisfies ChatPanelParams,
        ...(activeGroup ? { position: { referenceGroup: activeGroup } } : {}),
      });
      // addPanel restores the previously-active panel from saved layout
      // by default — explicitly activate the new one so the user sees
      // their just-opened chat instead of a stale layout-restored panel.
      try { panel.api.setActive(); } catch { /* ignore */ }
    }
    pendingOpens.splice(i, 1);
  }
}

/**
 * Validate any restored chat panels against the live chat list. Any chat
 * panel whose chat row no longer exists (deleted or archived) gets closed
 * so the operator doesn't see ghost panels from past sessions.
 *
 * Async + best-effort: if the fetch fails, leave the layout alone.
 */
async function pruneStaleChatPanels(api: DockviewApi, slug: string): Promise<void> {
  const chatPanelIds = api.panels
    .map((p) => p.id)
    .filter((id) => id.startsWith('chat-'));
  if (chatPanelIds.length === 0) return;

  let liveChatIds: Set<string>;
  try {
    const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/agent-chats`);
    if (!r.ok) return;
    const body = await r.json() as { chats?: Array<{ id: string }> };
    liveChatIds = new Set((body.chats ?? []).map((c) => c.id));
  } catch {
    return;
  }

  for (const panelId of chatPanelIds) {
    const chatId = panelId.slice('chat-'.length);
    if (!liveChatIds.has(chatId)) {
      const panel = api.getPanel(panelId);
      if (panel) {
        try { api.removePanel(panel); } catch { /* ignore */ }
      }
    }
  }
}

/** Component rendered inside each dockview panel. */
function TerminalPanelComponent(props: IDockviewPanelProps<TerminalPanelParams>) {
  const { slug, laneId } = props.params;
  return (
    <div style={{ width: '100%', height: '100%', minHeight: 0, display: 'flex' }}>
      <PiPanel slug={slug} laneId={laneId} />
    </div>
  );
}

/** Component for chat panels in the dock. */
function ChatPanelComponent(props: IDockviewPanelProps<ChatPanelParams>) {
  const { slug, chatId } = props.params;
  const onArchive = useCallback(() => {
    // The dock keeps a reference to its api via closure on `props.api` —
    // remove this panel.
    props.api.close();
  }, [props.api]);
  return (
    <div style={{ width: '100%', height: '100%', minHeight: 0, display: 'flex' }}>
      <ChatPanel slug={slug} chatId={chatId} onArchive={onArchive} />
    </div>
  );
}

/** Header action: "+" to add another terminal as a new tab. */
function AddTerminalAction({ api, slug }: { api: DockviewApi | null; slug: string }) {
  const onClick = useCallback(() => {
    if (!api) return;
    const id = `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const existing = api.panels.filter((p) => p.id.startsWith('term-')).length;
    api.addPanel({
      id,
      component: 'terminal',
      title: `terminal ${existing + 1}`,
      params: { slug } satisfies TerminalPanelParams,
    });
  }, [api, slug]);

  return (
    <Tooltip label="Open another terminal">
      <button
        type="button"
        onClick={onClick}
        className="pi-dock__add-btn"
      >
        <Plus size={13} />
        <span>terminal</span>
      </button>
    </Tooltip>
  );
}

const VALID_CHAT_ROLES = [
  'worker', 'validator', 'scoper', 'plan-gate', 'architect',
  'orchestrator', 'documenter', 'summarizer', 'curator', 'debugger',
  'project_manager',
] as const;

/** Header action: "+" to start a new ad-hoc chat from the dock. */
function AddChatAction({ api, slug }: { api: DockviewApi | null; slug: string }) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<string>('worker');
  const [featureId, setFeatureId] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useCallback(async () => {
    if (!api) return;
    setCreating(true);
    setError(null);
    try {
      const fid = featureId.trim();
      if (fid && !/^F-[A-Z0-9-]+$/i.test(fid)) {
        setError(`Invalid feature id (expected F-XXX): ${fid}`);
        setCreating(false);
        return;
      }
      const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/agent-chats`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role, feature_id: fid || undefined }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({} as { error?: string }));
        setError(body.error ?? `HTTP ${r.status}`);
        setCreating(false);
        return;
      }
      const chat = await r.json();
      const title = chat.title ?? (fid ? `${role} · ${fid}` : role);
      api.addPanel({
        id: `chat-${chat.id}`,
        component: 'chat',
        title,
        params: { slug, chatId: chat.id } satisfies ChatPanelParams,
      });
      setOpen(false);
      setFeatureId('');
      setRole('worker');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }, [api, slug, role, featureId]);

  return (
    <div style={{ position: 'relative' }}>
      <Tooltip label="Start a new chat with an agent">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="pi-dock__add-btn"
        >
          <MessageSquarePlus size={13} />
          <span>chat</span>
        </button>
      </Tooltip>
      {open && (
        <div className="pi-dock__chat-popover" role="dialog" aria-label="New chat">
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11 }}>
            <span>role</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              style={{
                background: '#0a0a0a', color: '#e7e7e7',
                border: '1px solid #2a2a2a', borderRadius: 4,
                padding: '4px 6px', fontSize: 12,
              }}
            >
              {VALID_CHAT_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11 }}>
            <span>feature (optional)</span>
            <input
              value={featureId}
              onChange={(e) => setFeatureId(e.target.value)}
              placeholder="F-001"
              style={{
                background: '#0a0a0a', color: '#e7e7e7',
                border: '1px solid #2a2a2a', borderRadius: 4,
                padding: '4px 6px', fontSize: 12, fontFamily: 'ui-monospace, Menlo, monospace',
              }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !creating) void create(); }}
            />
          </label>
          {error && (
            <div style={{ color: '#fca5a5', fontSize: 11 }}>{error}</div>
          )}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={creating}
              title="Cancel without creating a chat"
              style={{
                padding: '4px 10px', fontSize: 11,
                background: 'transparent', color: '#888',
                border: '1px solid #2a2a2a', borderRadius: 4,
                cursor: 'pointer',
              }}
            >cancel</button>
            <button
              type="button"
              onClick={() => void create()}
              disabled={creating}
              title="Create a new chat panel with the selected role"
              style={{
                padding: '4px 10px', fontSize: 11,
                background: '#1d2533', color: '#6ea8ff',
                border: '1px solid #3a5070', borderRadius: 4,
                cursor: creating ? 'wait' : 'pointer',
              }}
            >{creating ? 'creating…' : 'create'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function PiTerminalsDock({ slug, initialLaneId }: PiTerminalsDockProps) {
  const apiRef = useRef<DockviewApi | null>(null);
  const [api, setApi] = useState<DockviewApi | null>(null);

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      setApi(event.api);

      // Try to restore a saved layout; on any failure, seed a single terminal.
      let restored = false;
      try {
        const raw = window.localStorage.getItem(layoutKey(slug));
        if (raw) {
          const parsed = JSON.parse(raw);
          event.api.fromJSON(parsed);
          restored = event.api.panels.length > 0;
        }
      } catch {
        restored = false;
      }

      // If the user is opening a chat from the dashboard, don't also
      // seed an initial terminal — they came here for the chat. Only
      // seed when the dock is opened cold (no saved layout, no queued
      // chats waiting).
      const hasPendingForThisSlug = pendingOpens.some((d) => d.slug === slug);
      if (!restored && !hasPendingForThisSlug) {
        event.api.addPanel({
          id: `term-initial`,
          component: 'terminal',
          title: 'terminal 1',
          params: { slug, laneId: initialLaneId } satisfies TerminalPanelParams,
        });
      }

      // Persist layout on every change. CRITICAL: registered BEFORE
      // drainPendingOpens so that any chat panels added by the drain
      // are persisted to localStorage. Otherwise React StrictMode's
      // double-mount in dev silently loses chat panels: round 1 drains
      // the queue and adds the panel but persist isn't wired yet, so
      // localStorage stays stale; round 2 restores from stale storage
      // and finds the queue already drained.
      const persist = () => {
        try {
          window.localStorage.setItem(layoutKey(slug), JSON.stringify(event.api.toJSON()));
        } catch { /* quota / private mode — ignore */ }
      };
      event.api.onDidLayoutChange(persist);
      event.api.onDidAddPanel(persist);
      event.api.onDidRemovePanel(persist);

      // Race fix: drain any pending chat opens that arrived before this
      // mount. Without this, clicking "chat" on the dashboard tab silently
      // drops the event because the dock isn't mounted yet — the user sees
      // only the terminal restored from saved layout.
      // Drain any chat-open request stashed by the Oracle dock before
      // navigation. Survives the route change because it lives in
      // sessionStorage, not module memory.
      try {
        const raw = sessionStorage.getItem('oracle_pending_open_chat');
        if (raw) {
          const detail = JSON.parse(raw) as Partial<OpenChatEventDetail> & { slug?: string; chatId?: string };
          if (detail?.slug === slug && detail.chatId) {
            pendingOpens.push({
              slug: detail.slug,
              chatId: detail.chatId,
              role: detail.role,
              title: detail.title,
              featureId: detail.featureId,
            });
          }
          sessionStorage.removeItem('oracle_pending_open_chat');
        }
      } catch { /* ignore */ }

      drainPendingOpens(event.api, slug);

      // Async cleanup: remove chat panels for chats that no longer exist
      // (deleted, archived, expired). Runs after drain so we don't race
      // against new additions. Best-effort — fetches the live chat list
      // and closes panels whose chatId isn't in it.
      void pruneStaleChatPanels(event.api, slug);
    },
    [slug, initialLaneId],
  );

  // Reset stored layout when the harness slug changes (defensive — DockviewReact
  // remounts on key change so this is mostly belt-and-braces).
  useEffect(() => {
    return () => {
      apiRef.current = null;
    };
  }, [slug]);

  // Listen for cross-component "open chat" events. The dispatcher
  // (openFeatureChat) has already created the chat row AND pushed the
  // detail onto pendingOpens. If the dock is mounted, this handler
  // drains the queue immediately. If the dock isn't mounted yet (because
  // the dashboard tab is still active), the event is dropped — but the
  // queue entry remains, and onReady drains it when the dock mounts.
  useEffect(() => {
    const handler = () => {
      const a = apiRef.current;
      if (!a) return;
      drainPendingOpens(a, slug);
    };
    window.addEventListener(OPEN_CHAT_EVENT, handler);
    return () => window.removeEventListener(OPEN_CHAT_EVENT, handler);
  }, [slug]);

  return (
    <div className="pi-dock">
      <div className="pi-dock__header">
        <span className="pi-dock__title">
          <TerminalSquare size={13} /> consoles
        </span>
        <AddTerminalAction api={api} slug={slug} />
        <AddChatAction api={api} slug={slug} />
      </div>
      <div className="pi-dock__body">
        <DockviewReact
          key={slug}
          components={{ terminal: TerminalPanelComponent, chat: ChatPanelComponent }}
          onReady={onReady}
          className="dockview-theme-dark"
        />
      </div>
    </div>
  );
}

/**
 * Helper for callers (FeaturePeekPanel) to create a chat scoped to a
 * feature and open it in the dock. Returns the new chat id so the caller
 * can persist UI state if desired.
 */
export async function openFeatureChat(opts: {
  slug: string;
  role: string;
  featureId: string;
  title?: string;
}): Promise<{ chatId: string } | { error: string }> {
  try {
    const r = await fetch(`/api/harness/${encodeURIComponent(opts.slug)}/agent-chats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role: opts.role,
        feature_id: opts.featureId,
        title: opts.title,
      }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({} as { error?: string }));
      return { error: body.error ?? `HTTP ${r.status}` };
    }
    const chat = await r.json();
    const detail: OpenChatEventDetail = {
      slug: opts.slug,
      chatId: chat.id,
      title: chat.title,
      role: chat.role,
      featureId: chat.feature_id ?? undefined,
    };
    // Push to queue first so the dock can drain it on mount even if no
    // listener exists yet (dashboard tab is currently active). The
    // event dispatch handles the case where the dock IS already mounted.
    pendingOpens.push(detail);
    window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail }));
    return { chatId: chat.id };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
