import type { ShellType, TerminalSessionResponse } from '@termportal/api-contract';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, createSessionApi } from './api/session-api';
import { TerminalView } from './components/TerminalView';

const BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? '';
const POLL_INTERVAL_MS = 3000;

/** The selected session lives in the URL hash, so a refresh or a second tab reattaches to it. */
function sessionFromHash(): string | undefined {
  const id = window.location.hash.slice(1);
  return id.startsWith('term_') ? id : undefined;
}

export function App() {
  const api = useMemo(() => createSessionApi(BASE_URL), []);
  const [sessions, setSessions] = useState<TerminalSessionResponse[]>([]);
  const [selected, setSelected] = useState<string | undefined>(sessionFromHash);
  const [shell, setShell] = useState<ShellType | ''>('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSessions(await api.list());
      setError(undefined);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load sessions.');
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const onHashChange = () => setSelected(sessionFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const select = (id: string | undefined) => {
    window.location.hash = id ?? '';
    setSelected(id);
  };

  const createSession = async () => {
    setBusy(true);
    try {
      const session = await api.create(shell ? { shell } : {});
      await refresh();
      select(session.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to create a session.');
    } finally {
      setBusy(false);
    }
  };

  const terminateSession = async (id: string) => {
    try {
      await api.terminate(id);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'SESSION_NOT_FOUND')) {
        setError(e instanceof ApiError ? e.message : 'Failed to terminate the session.');
      }
    }
    if (selected === id) select(undefined);
    await refresh();
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="sidebar-header">
          <h1>Terminal Sessions</h1>
          <div className="create">
            <select
              aria-label="Shell"
              value={shell}
              onChange={(e) => setShell(e.target.value as ShellType | '')}
            >
              <option value="">default shell</option>
              <option value="bash">bash</option>
              <option value="zsh">zsh</option>
              <option value="sh">sh</option>
            </select>
            <button type="button" onClick={createSession} disabled={busy} data-testid="new-session">
              + New
            </button>
          </div>
        </header>
        {error && (
          <div className="notice notice-error" data-testid="app-error">
            {error}
          </div>
        )}
        <ul className="session-list" data-testid="session-list">
          {sessions.length === 0 && <li className="empty">No sessions yet.</li>}
          {sessions.map((session) => (
            <li
              key={session.id}
              className={session.id === selected ? 'session selected' : 'session'}
              data-testid="session-item"
              data-session-id={session.id}
            >
              <button type="button" className="session-open" onClick={() => select(session.id)}>
                <span className="session-id">{session.id}</span>
                <span className="session-meta">
                  <span className={`badge status-${session.status}`}>{session.status}</span>
                  {session.shell.split('/').pop()} · {session.cols}×{session.rows}
                </span>
              </button>
              <button
                type="button"
                className="session-terminate"
                title="Terminate session"
                aria-label={`Terminate ${session.id}`}
                onClick={() => void terminateSession(session.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <footer className="sidebar-footer">Trusted/internal use only — no authentication.</footer>
      </aside>
      <main className="main">
        {selected ? (
          <TerminalView
            key={selected}
            sessionId={selected}
            baseUrl={BASE_URL}
            onSessionChanged={() => void refresh()}
          />
        ) : (
          <div className="placeholder">Create or select a terminal session.</div>
        )}
      </main>
    </div>
  );
}
