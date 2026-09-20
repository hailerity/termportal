import type { PtyExitEvent, PtyProcess, Unsubscribe } from '../ports/pty.js';
import { assertValidDimensions } from './dimensions.js';
import { Emitter } from './emitter.js';
import { TerminalError } from './errors.js';

export type TerminalSessionStatus = 'starting' | 'running' | 'exited' | 'terminating' | 'failed';

/** Serializable public view of a session (design §6). */
export interface TerminalSessionSnapshot {
  id: string;
  status: TerminalSessionStatus;
  shell: string;
  cwd: string;
  pid?: number;
  cols: number;
  rows: number;
  createdAt: string;
  lastActivityAt: string;
  exitCode?: number;
  exitSignal?: number;
}

export type TerminalClientEvent =
  | { type: 'status'; status: TerminalSessionStatus }
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number; signal?: number };

/** A consumer of one session's stream, e.g. a WebSocket connection. */
export interface TerminalClient {
  send(event: TerminalClientEvent): void;
}

/** Handle returned by `attach`; the only way a client talks to the session. */
export interface TerminalAttachment {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  detach(): void;
}

export interface TerminalSessionOptions {
  id: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  /** Delay before an unresponsive PTY is sent SIGKILL during termination. */
  killTimeoutMs?: number;
  now?: () => Date;
}

const DEFAULT_KILL_TIMEOUT_MS = 3000;

export class TerminalSession {
  readonly id: string;
  readonly shell: string;
  readonly cwd: string;

  private currentStatus: TerminalSessionStatus = 'starting';
  private cols: number;
  private rows: number;
  private pty: PtyProcess | undefined;
  private exit: PtyExitEvent | undefined;
  private readonly createdAt: Date;
  private lastActivityAt: Date;
  private readonly now: () => Date;
  private readonly killTimeoutMs: number;
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private ptySubscriptions: Unsubscribe[] = [];
  private exitWaiters: Array<() => void> = [];

  private readonly clients = new Set<TerminalClient>();
  private readonly statusEmitter = new Emitter<TerminalSessionStatus>();
  private readonly exitEmitter = new Emitter<PtyExitEvent>();

  constructor(options: TerminalSessionOptions) {
    assertValidDimensions(options.cols, options.rows);
    this.id = options.id;
    this.shell = options.shell;
    this.cwd = options.cwd;
    this.cols = options.cols;
    this.rows = options.rows;
    this.now = options.now ?? (() => new Date());
    this.killTimeoutMs = options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;
    this.createdAt = this.now();
    this.lastActivityAt = this.createdAt;
  }

  get status(): TerminalSessionStatus {
    return this.currentStatus;
  }

  get pid(): number | undefined {
    return this.pty?.pid;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** True while the session can still produce output: not yet exited or failed. */
  get isLive(): boolean {
    return this.currentStatus !== 'exited' && this.currentStatus !== 'failed';
  }

  /**
   * Spawns the PTY and moves `starting` → `running`, or → `failed` when the spawn throws.
   * The spawn function receives the session's dimensions at the time of the call.
   */
  start(spawn: (size: { cols: number; rows: number }) => PtyProcess): void {
    if (this.currentStatus !== 'starting') {
      throw new Error(`Cannot start a session in status "${this.currentStatus}".`);
    }
    let pty: PtyProcess;
    try {
      pty = spawn({ cols: this.cols, rows: this.rows });
    } catch (cause) {
      this.setStatus('failed');
      throw new TerminalError('PTY_SPAWN_FAILED', 'Failed to start the terminal process.', {
        cause,
      });
    }
    this.pty = pty;
    this.ptySubscriptions = [
      pty.onData((data) => this.handleOutput(data)),
      pty.onExit((event) => this.handleExit(event)),
    ];
    this.setStatus('running');
  }

  write(data: string): void {
    const pty = this.requireRunningPty();
    this.touch();
    pty.write(data);
  }

  /** Last resize wins: the PTY has a single size shared by every attached client (design §15). */
  resize(cols: number, rows: number): void {
    assertValidDimensions(cols, rows);
    const pty = this.requireRunningPty();
    if (cols === this.cols && rows === this.rows) return;
    pty.resize(cols, rows);
    this.cols = cols;
    this.rows = rows;
  }

  /**
   * Registers a client: it synchronously receives the current status and from then on every
   * output, status and exit event. Exited or failed sessions reject new attachments.
   */
  attach(client: TerminalClient): TerminalAttachment {
    if (!this.isLive) {
      throw new TerminalError('SESSION_ALREADY_EXITED', 'Terminal session has already exited.');
    }
    this.clients.add(client);
    this.sendTo(client, { type: 'status', status: this.currentStatus });
    return {
      write: (data) => this.write(data),
      resize: (cols, rows) => this.resize(cols, rows),
      detach: () => {
        this.clients.delete(client);
      },
    };
  }

  /**
   * Asks the PTY to exit and resolves once it has. Idempotent: repeated calls share the same
   * exit, and calling it on an exited or failed session resolves immediately.
   */
  terminate(): Promise<void> {
    if (!this.isLive) return Promise.resolve();
    const exited = new Promise<void>((resolve) => this.exitWaiters.push(resolve));
    if (this.currentStatus === 'terminating') return exited;

    const pty = this.pty;
    if (!pty) {
      // Never started: there is no process to wait for.
      this.finish({ exitCode: 0 });
      return exited;
    }
    this.setStatus('terminating');
    // SIGHUP is what a closing terminal sends; interactive shells ignore SIGTERM.
    this.safeKill(pty, 'SIGHUP');
    this.killTimer = setTimeout(() => this.safeKill(pty, 'SIGKILL'), this.killTimeoutMs);
    this.killTimer.unref?.();
    return exited;
  }

  /** Sends SIGKILL without waiting; used when a graceful shutdown runs out of time. */
  forceKill(): void {
    if (this.pty && this.isLive) this.safeKill(this.pty, 'SIGKILL');
  }

  onStatusChange(listener: (status: TerminalSessionStatus) => void): Unsubscribe {
    return this.statusEmitter.on(listener);
  }

  onExit(listener: (event: PtyExitEvent) => void): Unsubscribe {
    return this.exitEmitter.on(listener);
  }

  snapshot(): TerminalSessionSnapshot {
    return {
      id: this.id,
      status: this.currentStatus,
      shell: this.shell,
      cwd: this.cwd,
      ...(this.pty ? { pid: this.pty.pid } : {}),
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt.toISOString(),
      lastActivityAt: this.lastActivityAt.toISOString(),
      ...(this.exit ? { exitCode: this.exit.exitCode } : {}),
      ...(this.exit?.signal !== undefined ? { exitSignal: this.exit.signal } : {}),
    };
  }

  private requireRunningPty(): PtyProcess {
    if (this.currentStatus !== 'running' || !this.pty) {
      throw new TerminalError(
        'SESSION_ALREADY_EXITED',
        this.isLive ? 'Terminal session is not running.' : 'Terminal session has already exited.',
      );
    }
    return this.pty;
  }

  private handleOutput(data: string): void {
    if (!this.isLive) return;
    this.touch();
    this.broadcast({ type: 'output', data });
  }

  private handleExit(event: PtyExitEvent): void {
    if (!this.isLive) return;
    this.finish(event);
  }

  private finish(event: PtyExitEvent): void {
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = undefined;
    for (const unsubscribe of this.ptySubscriptions) unsubscribe();
    this.ptySubscriptions = [];
    this.exit = event;
    this.touch();
    this.setStatus('exited');
    this.broadcast({
      type: 'exit',
      exitCode: event.exitCode,
      ...(event.signal !== undefined ? { signal: event.signal } : {}),
    });
    this.clients.clear();
    this.exitEmitter.emit(event);
    for (const resolve of this.exitWaiters.splice(0)) resolve();
    this.statusEmitter.clear();
    this.exitEmitter.clear();
  }

  private setStatus(status: TerminalSessionStatus): void {
    if (status === this.currentStatus) return;
    this.currentStatus = status;
    this.broadcast({ type: 'status', status });
    this.statusEmitter.emit(status);
  }

  private broadcast(event: TerminalClientEvent): void {
    for (const client of [...this.clients]) this.sendTo(client, event);
  }

  /** A client whose transport throws is dropped so it cannot affect the others. */
  private sendTo(client: TerminalClient, event: TerminalClientEvent): void {
    try {
      client.send(event);
    } catch {
      this.clients.delete(client);
    }
  }

  private safeKill(pty: PtyProcess, signal: string): void {
    try {
      pty.kill(signal);
    } catch {
      // The process may already be gone; the exit event settles the session either way.
    }
  }

  private touch(): void {
    this.lastActivityAt = this.now();
  }
}
