import { assertValidDimensions } from '../domain/dimensions.js';
import { TerminalError } from '../domain/errors.js';
import {
  TerminalSession,
  type TerminalAttachment,
  type TerminalClient,
  type TerminalSessionSnapshot,
} from '../domain/terminal-session.js';
import type { PtyFactory } from '../ports/pty.js';
import { DEFAULT_ENV_ALLOWLIST, buildPtyEnvironment } from './environment.js';
import { generateSessionId } from './session-id.js';

export interface CreateSessionOptions {
  /** Named shell (a key of `shells`), never an executable path. */
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

/** Lifecycle notifications for logging and metrics. Never carries terminal input or output. */
export type SessionManagerEvent =
  | { type: 'session.created'; session: TerminalSessionSnapshot }
  | { type: 'session.exited'; session: TerminalSessionSnapshot }
  | { type: 'session.terminating'; session: TerminalSessionSnapshot }
  | { type: 'session.removed'; sessionId: string }
  | { type: 'session.spawn_failed'; sessionId: string; shell: string; error: unknown }
  | { type: 'client.attached'; sessionId: string; clients: number }
  | { type: 'client.detached'; sessionId: string; clients: number };

export interface SessionManagerOptions {
  ptyFactory: PtyFactory;
  /** Named shell → executable path (design §16). */
  shells: Readonly<Record<string, string>>;
  defaultShell: string;
  defaultCwd: string;
  defaultCols: number;
  defaultRows: number;
  /** Maximum number of live (not yet exited) sessions. */
  maxSessions: number;
  /** Returns true when `cwd` exists and is a directory. */
  isDirectory: (cwd: string) => Promise<boolean>;
  baseEnv?: Readonly<Record<string, string | undefined>>;
  envAllowlist?: readonly string[];
  shellArgs?: string[];
  /** How long an exited session stays listed so clients can observe its final state. */
  exitedSessionTtlMs?: number;
  killTimeoutMs?: number;
  killGraceMs?: number;
  generateId?: () => string;
  now?: () => Date;
  onEvent?: (event: SessionManagerEvent) => void;
}

const DEFAULT_EXITED_SESSION_TTL_MS = 5 * 60 * 1000;

interface ManagedSession {
  session: TerminalSession;
  /** Position in exit order; set once the session has exited. */
  exitSequence?: number;
  removalTimer?: ReturnType<typeof setTimeout>;
}

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly options: SessionManagerOptions;
  /** Creates that passed the limit check but have not registered their session yet. */
  private pendingCreates = 0;
  private shuttingDown = false;
  private exitCounter = 0;

  constructor(options: SessionManagerOptions) {
    if (!Object.hasOwn(options.shells, options.defaultShell)) {
      throw new Error(`Default shell "${options.defaultShell}" is not a configured shell.`);
    }
    this.options = options;
  }

  async create(request: CreateSessionOptions = {}): Promise<TerminalSessionSnapshot> {
    const o = this.options;
    if (this.shuttingDown) {
      throw new TerminalError('SESSION_LIMIT_REACHED', 'The server is shutting down.');
    }

    const shellName = request.shell ?? o.defaultShell;
    const shell = Object.hasOwn(o.shells, shellName) ? o.shells[shellName] : undefined;
    if (!shell) throw new TerminalError('INVALID_SHELL', 'Unsupported shell.');

    const cols = request.cols ?? o.defaultCols;
    const rows = request.rows ?? o.defaultRows;
    assertValidDimensions(cols, rows);

    const env = buildPtyEnvironment(
      o.baseEnv ?? {},
      request.env,
      o.envAllowlist ?? DEFAULT_ENV_ALLOWLIST,
    );

    if (this.liveCount() + this.pendingCreates >= o.maxSessions) {
      throw new TerminalError(
        'SESSION_LIMIT_REACHED',
        'The maximum number of sessions is reached.',
      );
    }
    // Reserve the slot across the await so concurrent creates cannot exceed the limit.
    this.pendingCreates++;
    try {
      const cwd = request.cwd ?? o.defaultCwd;
      if (!(await o.isDirectory(cwd))) {
        throw new TerminalError('INVALID_CWD', 'Working directory does not exist.');
      }
      if (this.shuttingDown) {
        throw new TerminalError('SESSION_LIMIT_REACHED', 'The server is shutting down.');
      }

      const session = new TerminalSession({
        id: this.newId(),
        shell,
        cwd,
        cols,
        rows,
        ...(o.killTimeoutMs !== undefined ? { killTimeoutMs: o.killTimeoutMs } : {}),
        ...(o.killGraceMs !== undefined ? { killGraceMs: o.killGraceMs } : {}),
        ...(o.now ? { now: o.now } : {}),
      });
      try {
        session.start((size) =>
          o.ptyFactory.spawn({ file: shell, args: o.shellArgs ?? [], cwd, env, ...size }),
        );
      } catch (error) {
        this.emit({
          type: 'session.spawn_failed',
          sessionId: session.id,
          shell: shellName,
          error: error instanceof Error ? (error.cause ?? error) : error,
        });
        throw error;
      }

      const managed: ManagedSession = { session };
      this.sessions.set(session.id, managed);
      session.onExit(() => this.handleExit(managed));
      session.onClientDetached(() =>
        this.emit({ type: 'client.detached', sessionId: session.id, clients: session.clientCount }),
      );
      const created = session.snapshot();
      this.emit({ type: 'session.created', session: created });
      // A process that died during start never reaches the onExit listener registered above.
      if (!session.isLive) this.handleExit(managed);
      return created;
    } finally {
      this.pendingCreates--;
    }
  }

  get(id: string): TerminalSessionSnapshot | undefined {
    return this.sessions.get(id)?.session.snapshot();
  }

  list(): TerminalSessionSnapshot[] {
    return [...this.sessions.values()].map(({ session }) => session.snapshot());
  }

  /** Attaches a client to a live session; see `TerminalSession.attach`. */
  attach(id: string, client: TerminalClient): TerminalAttachment {
    const session = this.require(id).session;
    const attachment = session.attach(client);
    this.emit({ type: 'client.attached', sessionId: id, clients: session.clientCount });
    return attachment;
  }

  /** Terminates the session, waits for its process to exit, then forgets it. */
  async terminate(id: string): Promise<void> {
    const managed = this.require(id);
    if (managed.session.status === 'running') {
      this.emit({ type: 'session.terminating', session: managed.session.snapshot() });
    }
    await managed.session.terminate();
    this.remove(managed);
  }

  /**
   * Stops accepting sessions and terminates every PTY. Sessions still alive after `timeoutMs`
   * are sent SIGKILL and given `forceKillGraceMs` to be reaped, so no shell outlives the server.
   * Returns the ids of sessions that were still alive even then.
   */
  async shutdown(timeoutMs: number, forceKillGraceMs = 1000): Promise<string[]> {
    this.shuttingDown = true;
    const live = [...this.sessions.values()].filter(({ session }) => session.isLive);
    const waitForExits = (ms: number) => {
      const exits = live
        .filter(({ session }) => session.isLive)
        .map(({ session }) => new Promise<void>((resolve) => session.onExit(() => resolve())));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      });
      return Promise.race([Promise.all(exits), timeout]).finally(() => clearTimeout(timer));
    };

    const graceful = waitForExits(timeoutMs);
    // Failures surface through the survivor list; shutdown itself never rejects.
    for (const { session } of live) session.terminate().catch(() => {});
    await graceful;

    if (live.some(({ session }) => session.isLive)) {
      const forced = waitForExits(forceKillGraceMs);
      for (const { session } of live) session.forceKill();
      await forced;
    }
    const survivors = live.filter(({ session }) => session.isLive).map(({ session }) => session.id);
    for (const managed of [...this.sessions.values()]) this.remove(managed);
    return survivors;
  }

  private liveCount(): number {
    let count = 0;
    for (const { session } of this.sessions.values()) if (session.isLive) count++;
    return count;
  }

  private newId(): string {
    const generate = this.options.generateId ?? generateSessionId;
    let id = generate();
    while (this.sessions.has(id)) id = generate();
    return id;
  }

  private require(id: string): ManagedSession {
    const managed = this.sessions.get(id);
    if (!managed) throw new TerminalError('SESSION_NOT_FOUND', 'Terminal session was not found.');
    return managed;
  }

  /** Exited sessions stay visible for a while, then are dropped so the map cannot grow forever. */
  private handleExit(managed: ManagedSession): void {
    const { session } = managed;
    if (!this.sessions.has(session.id)) return;
    this.emit({ type: 'session.exited', session: session.snapshot() });
    const ttl = this.options.exitedSessionTtlMs ?? DEFAULT_EXITED_SESSION_TTL_MS;
    if (ttl <= 0) {
      this.remove(managed);
      return;
    }
    managed.exitSequence = this.exitCounter++;
    managed.removalTimer = setTimeout(() => this.remove(managed), ttl);
    managed.removalTimer.unref?.();
    this.evictOldestExited();
  }

  /** Retained exited sessions are capped at `maxSessions`; the longest-exited go first. */
  private evictOldestExited(): void {
    const exited = [...this.sessions.values()]
      .filter((managed) => managed.exitSequence !== undefined)
      .sort((a, b) => (a.exitSequence ?? 0) - (b.exitSequence ?? 0));
    const excess = exited.length - this.options.maxSessions;
    for (const managed of exited.slice(0, Math.max(0, excess))) this.remove(managed);
  }

  private remove(managed: ManagedSession): void {
    if (managed.removalTimer) clearTimeout(managed.removalTimer);
    if (this.sessions.get(managed.session.id) !== managed) return;
    this.sessions.delete(managed.session.id);
    this.emit({ type: 'session.removed', sessionId: managed.session.id });
  }

  private emit(event: SessionManagerEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // Observers must not break session management.
    }
  }
}
