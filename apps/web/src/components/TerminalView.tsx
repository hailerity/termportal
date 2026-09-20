import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalSessionStatus } from '@termportal/api-contract';
import { useEffect, useRef, useState } from 'react';
import { TerminalConnection, type ConnectionState } from '../terminal/terminal-connection';

interface Props {
  sessionId: string;
  baseUrl: string;
  /** Called when the session's state changed in a way the session list should reflect. */
  onSessionChanged(): void;
}

interface ExitInfo {
  exitCode: number;
  signal?: number;
}

export function TerminalView({ sessionId, baseUrl, onSessionChanged }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onSessionChangedRef = useRef(onSessionChanged);
  onSessionChangedRef.current = onSessionChanged;

  const [attempt, setAttempt] = useState(0);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  // True once the server ended the stream on purpose; reconnecting would only repeat that.
  const [finalClose, setFinalClose] = useState(false);
  const [status, setStatus] = useState<TerminalSessionStatus>();
  const [exit, setExit] = useState<ExitInfo>();
  const [error, setError] = useState<string>();
  const [size, setSize] = useState({ cols: 0, rows: 0 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setConnection('connecting');
    setFinalClose(false);
    setStatus(undefined);
    setExit(undefined);
    setError(undefined);

    // A fresh terminal per connection: the server replays recent output on attach.
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, "DejaVu Sans Mono", Consolas, monospace',
      fontSize: 13,
      scrollback: 10000,
      theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#58a6ff' },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    fit.fit();
    setSize({ cols: terminal.cols, rows: terminal.rows });

    const conn = new TerminalConnection({
      sessionId,
      baseUrl,
      onStateChange(state, close) {
        setConnection(state);
        if (close?.final) setFinalClose(true);
        if (state === 'open') {
          conn.sendResize(terminal.cols, terminal.rows);
          terminal.focus();
        }
      },
      onMessage(message) {
        switch (message.type) {
          case 'output':
            terminal.write(message.data);
            break;
          case 'status':
            setStatus(message.status);
            onSessionChangedRef.current();
            break;
          case 'exit':
            setExit({ exitCode: message.exitCode, signal: message.signal });
            onSessionChangedRef.current();
            break;
          case 'error':
            setError(message.message);
            break;
        }
      },
    });

    const input = terminal.onData((data) => conn.sendInput(data));
    const resize = terminal.onResize(({ cols, rows }) => {
      setSize({ cols, rows });
      conn.sendResize(cols, rows);
    });

    // Debounced: dragging a window edge fires a burst of resize events. A timer rather than
    // requestAnimationFrame, which never fires while the tab is in the background.
    let refit: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(refit);
      refit = setTimeout(() => fit.fit(), 50);
    });
    observer.observe(container);

    return () => {
      clearTimeout(refit);
      observer.disconnect();
      input.dispose();
      resize.dispose();
      conn.close();
      terminal.dispose();
    };
  }, [sessionId, baseUrl, attempt]);

  const ended = exit !== undefined || status === 'exited';
  const canReconnect = connection === 'closed' && !ended && !finalClose;

  return (
    <section className="terminal-pane">
      <header className="terminal-bar">
        <span className="session-id" data-testid="active-session">
          {sessionId}
        </span>
        <span className={`badge badge-${connection}`} data-testid="connection-state">
          {connection === 'open' ? 'connected' : connection}
        </span>
        {status && (
          <span className={`badge status-${status}`} data-testid="session-status">
            {status}
          </span>
        )}
        <span className="dimensions" data-testid="dimensions">
          {size.cols}×{size.rows}
        </span>
        <span className="spacer" />
        {canReconnect && (
          <button type="button" onClick={() => setAttempt((n) => n + 1)} data-testid="reconnect">
            Reconnect
          </button>
        )}
      </header>
      {exit && (
        <div className="notice" data-testid="exit-notice">
          Session exited with code {exit.exitCode}
          {exit.signal ? ` (signal ${exit.signal})` : ''}.
        </div>
      )}
      {error && !exit && (
        <div className="notice notice-error" data-testid="error-notice">
          {error}
        </div>
      )}
      {canReconnect && !error && (
        <div className="notice notice-error">Connection lost. The session keeps running.</div>
      )}
      <div className="terminal-host" ref={containerRef} data-testid="terminal" />
    </section>
  );
}
