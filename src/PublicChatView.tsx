'use client';

import { useEffect, useRef, useState } from 'react';

export interface PublicChatViewProps {
  apiBase: string;
  slug?: string;
  storageKey?: string;
  greeting?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_CHARS = 2000;

export default function PublicChatView({ apiBase, slug, storageKey, greeting }: PublicChatViewProps) {
  const lsKey = storageKey ?? `pc.public-chat.${slug ?? 'global'}`;
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamBuf, setStreamBuf] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [costExhausted, setCostExhausted] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Hydrate from localStorage.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(lsKey);
      if (raw) setHistory(JSON.parse(raw));
    } catch { /* ignore */ }
  }, [lsKey]);

  // Persist on change.
  useEffect(() => {
    try {
      window.localStorage.setItem(lsKey, JSON.stringify(history.slice(-30)));
    } catch { /* ignore */ }
  }, [history, lsKey]);

  // Fetch rate-limit status on mount.
  useEffect(() => {
    fetch(`${apiBase}/api/public/papercup/chat-status`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j) return;
        setRemaining(j.remaining);
        setCostExhausted(!!j.globalCostExhausted);
      })
      .catch(() => {});
  }, [apiBase]);

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history, streamBuf]);

  const send = async () => {
    const trimmed = input.trim();
    if (!trimmed || streaming || costExhausted) return;
    if (trimmed.length > MAX_CHARS) {
      setError(`Message too long (${trimmed.length}/${MAX_CHARS} chars).`);
      return;
    }
    setError(null);
    setInput('');
    const next: ChatMessage[] = [...history, { role: 'user', content: trimmed }];
    setHistory(next);
    setStreaming(true);
    setStreamBuf('');

    const ctl = new AbortController();
    abortRef.current = ctl;

    try {
      const r = await fetch(`${apiBase}/api/public/papercup/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ history: next.slice(-8), message: trimmed, slug }),
        signal: ctl.signal,
      });
      if (r.status === 429) {
        const j = await r.json().catch(() => ({}));
        const msg = j.reason === 'daily-cost-cap'
          ? 'Daily chat budget reached. The chatbot will reset tomorrow.'
          : "You've hit today's chat limit (10 messages). Resets at UTC midnight.";
        setError(msg);
        setStreaming(false);
        setHistory((h) => h.slice(0, -1));
        return;
      }
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let leftover = '';
      let acc = '';
      let committed = false;

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        leftover += decoder.decode(value, { stream: true });
        const events = leftover.split('\n\n');
        leftover = events.pop() ?? '';
        for (const ev of events) {
          const eventLine = ev.split('\n').find((l) => l.startsWith('event: '));
          const dataLine = ev.split('\n').find((l) => l.startsWith('data: '));
          if (!eventLine || !dataLine) continue;
          const eventName = eventLine.slice(7).trim();
          const dataRaw = dataLine.slice(6).replace(/\\n/g, '\n');
          if (eventName === 'delta') {
            acc += dataRaw;
            setStreamBuf(acc);
          } else if (eventName === 'error') {
            setError(`Backend error: ${dataRaw}`);
          } else if (eventName === 'done' && !committed) {
            committed = true;
            if (acc.length > 0) {
              setHistory((h) => [...h, { role: 'assistant', content: acc }]);
            }
            setStreamBuf('');
            setStreaming(false);
            break outer;
          }
        }
      }
      try { reader.cancel(); } catch { /* ignore */ }
    } catch (e) {
      if ((e as any)?.name === 'AbortError') {
        setStreaming(false);
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      setStreaming(false);
    } finally {
      // refresh rate-limit display
      fetch(`${apiBase}/api/public/papercup/chat-status`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!j) return;
          setRemaining(j.remaining);
          setCostExhausted(!!j.globalCostExhausted);
        })
        .catch(() => {});
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    setStreaming(false);
    if (streamBuf.length > 0) {
      setHistory((h) => [...h, { role: 'assistant', content: streamBuf }]);
      setStreamBuf('');
    }
  };

  const reset = () => {
    setHistory([]);
    setStreamBuf('');
    setError(null);
  };

  return (
    <div className="pc-chat">
      <div className="pc-chat-header">
        <span className="pc-chat-name">Papercup guide</span>
        <span className="pc-chat-meta">
          {costExhausted ? 'budget exhausted today' :
           remaining !== null ? `${remaining}/10 messages left today` : ''}
        </span>
        {history.length > 0 && (
          <button type="button" className="pc-chat-reset" onClick={reset} aria-label="Reset chat">reset</button>
        )}
      </div>

      <div className="pc-chat-scroller" ref={scrollerRef}>
        {history.length === 0 && !streaming && (
          <div className="pc-chat-greeting">
            <p>{greeting ?? 'Ask about Papercup, the directors, or what you see on this page.'}</p>
            <ul>
              <li onClick={() => setInput('What is Papercup?')}>What is Papercup?</li>
              <li onClick={() => setInput('What does this director do?')}>What does this director do?</li>
              <li onClick={() => setInput('Explain the inbox and outbox.')}>Explain the inbox and outbox.</li>
            </ul>
          </div>
        )}
        {history.map((m, i) => (
          <div key={i} className={`pc-chat-msg pc-chat-msg-${m.role}`}>
            <div className="pc-chat-bubble">{m.content}</div>
          </div>
        ))}
        {streaming && streamBuf.length > 0 && (
          <div className="pc-chat-msg pc-chat-msg-assistant">
            <div className="pc-chat-bubble pc-chat-bubble-streaming">{streamBuf}<span className="pc-chat-cursor" /></div>
          </div>
        )}
        {streaming && streamBuf.length === 0 && (
          <div className="pc-chat-msg pc-chat-msg-assistant">
            <div className="pc-chat-bubble pc-chat-bubble-thinking">
              <span /><span /><span />
            </div>
          </div>
        )}
      </div>

      {error && <div className="pc-chat-error">{error}</div>}

      <form
        className="pc-chat-input"
        onSubmit={(e) => { e.preventDefault(); send(); }}
      >
        <textarea
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
          }}
          placeholder={costExhausted ? 'Daily budget reached.' : 'Ask the Papercup guide…  (⌘↵ to send)'}
          maxLength={MAX_CHARS}
          disabled={streaming || costExhausted}
        />
        <div className="pc-chat-input-row">
          <span className="pc-chat-char-count">{input.length}/{MAX_CHARS}</span>
          {streaming ? (
            <button type="button" className="pc-chat-send pc-chat-cancel" onClick={cancel}>cancel</button>
          ) : (
            <button type="submit" className="pc-chat-send" disabled={!input.trim() || costExhausted}>
              send
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
