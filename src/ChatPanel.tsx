'use client';

/**
 * ChatPanel — multi-turn conversational UI for an agent_chats row.
 *
 * Mounted inside the pi-dock as the 'chat' panel type. On mount it loads
 * the chat (GET /agent-chats/:chatId), renders the transcript, and
 * exposes a compose area. Send POSTs /messages and opens an EventSource
 * to stream deltas back, appending to the live assistant message. On
 * stream end, refetches the chat to pick up the persisted token/cost
 * counters and the canonical assistant turn.
 *
 * Side-channel design: the chat agent's prompt tells it not to commit
 * code, only to advise + write supervisor-notes. If the feature_lock is
 * active, a banner makes that visible to the user too.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Send, Archive, Loader2, AlertTriangle, Coins, RotateCcw } from 'lucide-react';
import { COLORS, FONTS, RADIUS, SIZES } from './theme';
import { Tooltip } from './Tooltip';

interface TranscriptTurn {
  role: 'user' | 'assistant';
  content: string;
  ts: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_cents?: number;
}

interface FeatureLock {
  taken_by: string | null;
  taken_at: string | null;
  expires_at: string | null;
  active: boolean;
}

interface ChatRow {
  id: string;
  role: string;
  feature_id: string | null;
  title: string | null;
  transcript: TranscriptTurn[];
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd_cents: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  feature_lock?: FeatureLock | null;
}

export interface ChatPanelProps {
  slug: string;
  chatId: string;
  /** Called when the user archives this chat — parent should remove the dock panel. */
  onArchive?: () => void;
}

type SendState =
  | { kind: 'idle' }
  | { kind: 'streaming'; partial: string }
  | { kind: 'error'; message: string };

export default function ChatPanel({ slug, chatId, onArchive }: ChatPanelProps) {
  const [chat, setChat] = useState<ChatRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sendState, setSendState] = useState<SendState>({ kind: 'idle' });
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const loadChat = useCallback(async () => {
    try {
      const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/agent-chats/${encodeURIComponent(chatId)}`);
      if (!r.ok) {
        const body = await r.json().catch(() => ({} as { error?: string }));
        setLoadError(body.error ?? `HTTP ${r.status}`);
        return;
      }
      setChat((await r.json()) as ChatRow);
      setLoadError(null);
    } catch (err) {
      setLoadError(`load failed: ${(err as Error).message}`);
    }
  }, [slug, chatId]);

  useEffect(() => { void loadChat(); }, [loadChat]);

  // Auto-scroll on new content.
  useEffect(() => {
    const el = transcriptScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chat?.transcript.length, sendState.kind === 'streaming' ? sendState.partial : '']);

  // Cleanup any in-flight stream on unmount.
  useEffect(() => () => { eventSourceRef.current?.close(); }, []);

  const send = useCallback(async () => {
    const content = draft.trim();
    if (!content || !chat || sendState.kind === 'streaming') return;

    setSendState({ kind: 'streaming', partial: '' });
    setDraft('');

    // Optimistic — append the user turn locally so it appears immediately.
    setChat((prev) => prev ? {
      ...prev,
      transcript: [...prev.transcript, { role: 'user', content, ts: new Date().toISOString() }],
    } : prev);

    try {
      const res = await fetch(
        `/api/harness/${encodeURIComponent(slug)}/agent-chats/${encodeURIComponent(chatId)}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        setSendState({
          kind: 'error',
          message: body.error ? `${body.error}${body.hint ? ` — ${body.hint}` : ''}` : `HTTP ${res.status}`,
        });
        return;
      }
      // Server returns SSE; read the response body as a stream.
      if (!res.body) {
        setSendState({ kind: 'error', message: 'no response body — server did not stream' });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let lineBuf = '';
      let pendingEvent: string | null = null;
      let assistantText = '';

      // Read the SSE stream. Format:
      //   event: delta
      //   data: {"text":"...."}
      //
      //   event: done
      //   data: {...}
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        lineBuf += decoder.decode(value, { stream: true });
        let nl: number;
        // eslint-disable-next-line no-cond-assign
        while ((nl = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, nl).replace(/\r$/, '');
          lineBuf = lineBuf.slice(nl + 1);
          if (!line) {
            pendingEvent = null;
            continue;
          }
          if (line.startsWith('event:')) {
            pendingEvent = line.slice(6).trim();
            continue;
          }
          if (line.startsWith('data:')) {
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              const data = JSON.parse(payload);
              if (pendingEvent === 'delta' && typeof data.text === 'string') {
                assistantText += data.text;
                setSendState({ kind: 'streaming', partial: assistantText });
              } else if (pendingEvent === 'error') {
                setSendState({ kind: 'error', message: data.message ?? 'stream error' });
              }
            } catch { /* malformed — ignore */ }
          }
        }
      }

      // Stream finished — refetch to get persisted assistant turn + counters.
      setSendState({ kind: 'idle' });
      void loadChat();
    } catch (err) {
      setSendState({ kind: 'error', message: `send failed: ${(err as Error).message}` });
    }
  }, [chat, chatId, draft, loadChat, sendState.kind, slug]);

  const onArchiveClick = useCallback(async () => {
    if (!confirm('Archive this chat? The transcript is retained but it disappears from the active list.')) return;
    try {
      await fetch(`/api/harness/${encodeURIComponent(slug)}/agent-chats/${encodeURIComponent(chatId)}`, { method: 'DELETE' });
      onArchive?.();
    } catch { /* best effort */ }
  }, [slug, chatId, onArchive]);

  const costUsd = useMemo(() => (chat?.total_cost_usd_cents ?? 0) / 100, [chat?.total_cost_usd_cents]);
  const tokensTotal = (chat?.total_input_tokens ?? 0) + (chat?.total_output_tokens ?? 0);

  if (loadError) {
    return (
      <div className="chat-panel chat-panel--error">
        <AlertTriangle size={14} /> Failed to load chat: {loadError}
        <button className="chat-panel__retry" onClick={() => void loadChat()} title="Retry loading the chat transcript">retry</button>
      </div>
    );
  }
  if (!chat) {
    return (
      <div className="chat-panel chat-panel--loading">
        <Loader2 size={14} className="chat-panel__spin" /> loading chat…
      </div>
    );
  }

  return (
    <div className="chat-panel">
      <div className="chat-panel__header">
        <span className="chat-panel__role">{chat.role}</span>
        {chat.feature_id && <span className="chat-panel__feature">{chat.feature_id}</span>}
        <span className="chat-panel__title">{chat.title ?? ''}</span>
        <Tooltip label={`${tokensTotal.toLocaleString()} tokens`}>
          <span className="chat-panel__cost">
            <Coins size={11} /> ${costUsd.toFixed(4)}
          </span>
        </Tooltip>
        <Tooltip label="Archive chat">
          <button onClick={onArchiveClick} className="chat-panel__archive">
            <Archive size={12} />
          </button>
        </Tooltip>
      </div>

      {chat.feature_lock?.active && (
        <div className="chat-panel__lock-warning" role="status">
          <AlertTriangle size={12} />
          <span>
            Feature {chat.feature_id} is being worked on autonomously
            {chat.feature_lock.taken_by ? ` (${chat.feature_lock.taken_by})` : ''}.
            This chat will advise but not commit code; for guidance the worker should pick up,
            ask it to leave a note in <code>.harness/notes/{chat.feature_id}.md</code>.
          </span>
        </div>
      )}

      <div ref={transcriptScrollRef} className="chat-panel__transcript">
        {chat.transcript.length === 0 && sendState.kind === 'idle' && (
          <div className="chat-panel__empty">
            Start the conversation. The agent has the same context the autonomous {chat.role} would{chat.feature_id ? ` for feature ${chat.feature_id}` : ''}.
          </div>
        )}
        {chat.transcript.map((t, i) => (
          <div key={i} className={`chat-turn chat-turn--${t.role}`}>
            <div className="chat-turn__role">{t.role}</div>
            <div className="chat-turn__body">{t.content}</div>
          </div>
        ))}
        {sendState.kind === 'streaming' && (
          <div className="chat-turn chat-turn--assistant chat-turn--streaming">
            <div className="chat-turn__role">
              <Loader2 size={11} className="chat-panel__spin" /> assistant
            </div>
            <div className="chat-turn__body">{sendState.partial || '…'}</div>
          </div>
        )}
        {sendState.kind === 'error' && (
          <div className="chat-panel__send-error" role="alert">
            <AlertTriangle size={12} /> {sendState.message}
            <Tooltip label="Dismiss">
              <button onClick={() => setSendState({ kind: 'idle' })}>
                <RotateCcw size={11} />
              </button>
            </Tooltip>
          </div>
        )}
      </div>

      <form
        className="chat-panel__compose"
        onSubmit={(e) => { e.preventDefault(); void send(); }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={
            sendState.kind === 'streaming'
              ? 'agent is responding…'
              : `Message ${chat.role}${chat.feature_id ? ` about ${chat.feature_id}` : ''}… (Shift+Enter for newline)`
          }
          disabled={sendState.kind === 'streaming'}
          rows={2}
          className="chat-panel__input"
        />
        <Tooltip label="Send (Enter)">
          <button
            type="submit"
            disabled={sendState.kind === 'streaming' || !draft.trim()}
            className="chat-panel__send"
          >
            {sendState.kind === 'streaming' ? <Loader2 size={13} className="chat-panel__spin" /> : <Send size={13} />}
          </button>
        </Tooltip>
      </form>
    </div>
  );
}
