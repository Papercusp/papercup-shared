'use client';

/**
 * PiPanel — embedded oh-my-pi (omp) terminal pane.
 *
 * Mounts an xterm.js terminal connected to an EventSource SSE stream from
 * `/api/harness/:slug/pty/:id/stream`. User keystrokes POST back to
 * `/api/harness/:slug/pty/:id/input`. Resize on container change.
 *
 * Lifecycle:
 *   - On mount: POST /spawn → record id → open SSE → wire xterm.
 *   - On unmount or slug/laneId change: POST /kill, close SSE.
 *   - On exit event from the server: render an "exited" banner; user can
 *     click Restart to spawn fresh.
 *
 * NOT a client of node-pty directly — that runs in the sidecar. This is a
 * pure browser-side component.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { Tooltip } from './Tooltip';
import './PiPanel.css';

export interface PiPanelProps {
  /** Harness slug — matches the URL `/harness/<slug>`. */
  slug: string;
  /** Optional feature/lane id; scopes the pty cwd to that worktree. */
  laneId?: string;
  /** Override the spawn command. Default: pi (omp) with --no-pty. */
  command?: string;
  /** Override the spawn args. Default: ['--no-pty']. */
  args?: readonly string[];
}

interface ToolDef {
  name: string;
  label: string;
  description: string;
}

interface AuditSession {
  filename: string;
  tag: string | null;
  timestamp: string | null;
  sessionId: string | null;
  sizeBytes: number;
  mtimeMs: number;
}

interface PtyHandle {
  id: string;
  command: string;
  args: readonly string[];
  cwd: string;
  pid: number;
}

type PaneState =
  | { kind: 'starting' }
  | { kind: 'running'; handle: PtyHandle }
  | { kind: 'exited'; code: number; handle: PtyHandle }
  | { kind: 'error'; message: string };

const DARK_THEME = {
  background: '#0a0a0a',
  foreground: '#e7e7e7',
  cursor: '#6ea8ff',
  cursorAccent: '#0a0a0a',
  selectionBackground: '#3a3a4a',
  black: '#0a0a0a',
  red: '#e27e8a',
  green: '#7ee2a8',
  yellow: '#e2c47e',
  blue: '#7ec3e2',
  magenta: '#caa9e3',
  cyan: '#7ed4cc',
  white: '#e7e7e7',
  brightBlack: '#5a5a5a',
  brightRed: '#fca5a5',
  brightGreen: '#a8e2c5',
  brightYellow: '#fcd591',
  brightBlue: '#aac7e3',
  brightMagenta: '#dac3eb',
  brightCyan: '#a3dad4',
  brightWhite: '#ffffff',
};

export default function PiPanel({ slug, laneId, command, args }: PiPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<unknown>(null); // xterm Terminal instance
  const fitAddonRef = useRef<unknown>(null); // FitAddon instance
  const eventSourceRef = useRef<EventSource | null>(null);
  const handleIdRef = useRef<string | null>(null);
  const [state, setState] = useState<PaneState>({ kind: 'starting' });
  const [restartTick, setRestartTick] = useState(0);
  const [tools, setTools] = useState<ToolDef[] | null>(null);
  const [showTools, setShowTools] = useState(false);
  const [sessions, setSessions] = useState<AuditSession[] | null>(null);
  const [showSessions, setShowSessions] = useState(false);

  // Fetch the static papercusp_* tool list once. Endpoint reflects whether
  // the extension file is present on disk; sidecar passes -e <path> on
  // omp spawn when it is, so this also tells the user whether tools are
  // actually wired into this pty.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/pty/tools`);
        if (!r.ok) return;
        const data = await r.json() as { extensionAvailable: boolean; tools: ToolDef[] };
        if (!cancelled && data.extensionAvailable) setTools(data.tools);
      } catch { /* best-effort */ }
    })();
    return () => { cancelled = true; };
  }, [slug]);

  const refreshSessions = useCallback(async () => {
    try {
      const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/pi-sessions/audit`);
      if (!r.ok) { setSessions([]); return; }
      const data = await r.json() as { sessions: AuditSession[] };
      setSessions(data.sessions);
    } catch { setSessions([]); }
  }, [slug]);

  const postKill = useCallback(async (id: string) => {
    try {
      await fetch(`/api/harness/${encodeURIComponent(slug)}/pty/${id}/kill`, {
        method: 'POST',
        keepalive: true,
      });
    } catch { /* best-effort */ }
  }, [slug]);

  useEffect(() => {
    let cancelled = false;
    let mounted = true;

    (async () => {
      // 1. Dynamically import xterm — server bundle shouldn't pull it.
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
      ]);
      if (cancelled || !containerRef.current) return;

      // 2. Build the terminal.
      const term = new Terminal({
        cursorBlink: true,
        fontFamily: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace',
        fontSize: 13,
        lineHeight: 1.2,
        theme: DARK_THEME,
        scrollback: 5000,
        allowProposedApi: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.open(containerRef.current);
      fit.fit();
      termRef.current = term;
      fitAddonRef.current = fit;

      // 3. Spawn the pty.
      const initCols = term.cols;
      const initRows = term.rows;
      let handle: PtyHandle;
      try {
        const res = await fetch(`/api/harness/${encodeURIComponent(slug)}/pty/spawn`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            command,
            args,
            laneId,
            cols: initCols,
            rows: initRows,
          }),
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({} as { error?: string }));
          if (mounted) setState({ kind: 'error', message: errBody?.error ?? `spawn failed: HTTP ${res.status}` });
          return;
        }
        handle = (await res.json()) as PtyHandle;
        handleIdRef.current = handle.id;
      } catch (err) {
        if (mounted) setState({ kind: 'error', message: `spawn failed: ${(err as Error).message}` });
        return;
      }
      if (cancelled) {
        postKill(handle.id);
        return;
      }
      if (mounted) setState({ kind: 'running', handle });

      // 4. Open the SSE stream and wire it to the terminal.
      const es = new EventSource(
        `/api/harness/${encodeURIComponent(slug)}/pty/${handle.id}/stream`,
      );
      eventSourceRef.current = es;

      es.addEventListener('data', (ev) => {
        try {
          const bytes = atob((ev as MessageEvent).data);
          term.write(bytes);
        } catch { /* malformed event — drop */ }
      });
      es.addEventListener('exit', (ev) => {
        try {
          const payload = JSON.parse((ev as MessageEvent).data);
          if (mounted) setState({ kind: 'exited', code: payload?.code ?? 0, handle });
        } catch {
          if (mounted) setState({ kind: 'exited', code: 0, handle });
        }
        es.close();
      });
      es.onerror = () => {
        // The connection may drop temporarily during sidecar restart; let
        // the browser retry. Hard errors surface as exit events.
      };

      // 5. Forward keystrokes.
      term.onData((data) => {
        const b64 = btoa(unescape(encodeURIComponent(data)));
        fetch(`/api/harness/${encodeURIComponent(slug)}/pty/${handle.id}/input`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: b64 }),
        }).catch(() => { /* best-effort; retry happens implicitly via xterm input loop */ });
      });

      // 6. Forward resizes.
      const ro = new ResizeObserver(() => {
        try {
          fit.fit();
          fetch(`/api/harness/${encodeURIComponent(slug)}/pty/${handle.id}/resize`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cols: term.cols, rows: term.rows }),
          }).catch(() => { /* ignore */ });
        } catch { /* term not ready yet */ }
      });
      if (containerRef.current) ro.observe(containerRef.current);

      // Cleanup function.
      return () => {
        ro.disconnect();
      };
    })();

    return () => {
      cancelled = true;
      mounted = false;
      const es = eventSourceRef.current;
      if (es) es.close();
      const id = handleIdRef.current;
      if (id) postKill(id);
      const term = termRef.current as { dispose?: () => void } | null;
      try { term?.dispose?.(); } catch { /* ignore */ }
      termRef.current = null;
      fitAddonRef.current = null;
      handleIdRef.current = null;
    };
  // restartTick forces re-spawn on user-clicked Restart.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, laneId, command, args, postKill, restartTick]);

  return (
    <div className="pi-panel">
      <div className="pi-panel__header">
        <span className="pi-panel__title">pi</span>
        {state.kind === 'running' && (
          <span className="pi-panel__sub">
            pid {state.handle.pid}{laneId ? ` · ${laneId}` : ''}
          </span>
        )}
        {state.kind === 'exited' && (
          <span className="pi-panel__sub pi-panel__sub--exited">
            exited {state.code}
          </span>
        )}
        {state.kind === 'error' && (
          <span className="pi-panel__sub pi-panel__sub--error">{state.message}</span>
        )}

        {/* Spacer so action chips align right */}
        <span className="pi-panel__spacer" />

        {tools && tools.length > 0 && (
          <Tooltip label="Show papercusp tools the LLM can call from this pty">
            <button
              type="button"
              className="pi-panel__chip"
              onClick={() => { setShowTools((v) => !v); setShowSessions(false); }}
            >
              ↯ {tools.length} papercusp tools
            </button>
          </Tooltip>
        )}

        <Tooltip label="Past pi sessions exported to HTML">
          <button
            type="button"
            className="pi-panel__chip"
            onClick={async () => {
              const next = !showSessions;
              setShowSessions(next);
              setShowTools(false);
              if (next && sessions === null) await refreshSessions();
            }}
          >
            past sessions{sessions ? ` (${sessions.length})` : ''}
          </button>
        </Tooltip>

        {state.kind === 'exited' && (
          <button
            type="button"
            className="pi-panel__btn"
            onClick={() => setRestartTick((t) => t + 1)}
          >Restart</button>
        )}
      </div>

      {showTools && tools && (
        <div className="pi-panel__popover">
          <div className="pi-panel__popover-title">papercusp_* tools loaded for this pty</div>
          <ul className="pi-panel__tools-list">
            {tools.map((t) => (
              <li key={t.name}>
                <code>{t.name}</code>
                <span>{t.description}</span>
              </li>
            ))}
          </ul>
          <div className="pi-panel__popover-foot">
            Pi calls these via the extension at <code>~/.papercusp/global-plugins/pi/extension.ts</code>.
          </div>
        </div>
      )}

      {showSessions && sessions !== null && (
        <div className="pi-panel__popover">
          <div className="pi-panel__popover-title">
            Past pi sessions ({sessions.length})
            <Tooltip label="Refresh">
              <button
                type="button"
                className="pi-panel__refresh"
                onClick={refreshSessions}
              >↻</button>
            </Tooltip>
          </div>
          {sessions.length === 0 ? (
            <div className="pi-panel__empty">
              No exported sessions yet. They appear here after a pi pane closes.
            </div>
          ) : (
            <ul className="pi-panel__sessions-list">
              {sessions.map((s) => {
                const date = s.timestamp
                  ? s.timestamp.replace('T', ' ').replace(/-/g, ':').replace(/Z$/, ' UTC').replace('::', '-').replace('::', '-')
                  : null;
                const niceDate = s.mtimeMs ? new Date(s.mtimeMs).toLocaleString() : date;
                return (
                  <li key={s.filename}>
                    <a
                      href={`/api/harness/${encodeURIComponent(slug)}/pi-sessions/audit/${encodeURIComponent(s.filename)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <span className="pi-panel__session-tag">{s.tag ?? s.filename}</span>
                      {niceDate && <span className="pi-panel__session-date">{niceDate}</span>}
                      <span className="pi-panel__session-size">{Math.round(s.sizeBytes / 1024)}&nbsp;KB</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <div className="pi-panel__term" ref={containerRef} />
    </div>
  );
}
