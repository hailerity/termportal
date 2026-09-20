import { Emitter } from '../domain/emitter.js';
import type {
  PtyExitEvent,
  PtyFactory,
  PtyProcess,
  SpawnPtyOptions,
  Unsubscribe,
} from '../ports/pty.js';

/** In-memory `PtyProcess` for tests: records what the session does and lets tests drive events. */
export class FakePty implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  readonly kills: Array<string | undefined> = [];
  /** Signals that make the fake exit by itself when received. Defaults to every signal. */
  exitOnSignals: ReadonlySet<string> | 'all' = 'all';
  exited = false;

  private readonly data = new Emitter<string>();
  private readonly exit = new Emitter<PtyExitEvent>();

  constructor(
    readonly pid: number,
    readonly options: SpawnPtyOptions,
  ) {}

  write(data: string): void {
    if (!this.exited) this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.exited) this.resizes.push({ cols, rows });
  }

  kill(signal?: string): void {
    if (this.exited) return;
    this.kills.push(signal);
    if (this.exitOnSignals === 'all' || this.exitOnSignals.has(signal ?? 'SIGHUP')) {
      this.emitExit({ exitCode: 0, signal: signal === 'SIGKILL' ? 9 : 1 });
    }
  }

  onData(handler: (data: string) => void): Unsubscribe {
    return this.data.on(handler);
  }

  onExit(handler: (event: PtyExitEvent) => void): Unsubscribe {
    return this.exit.on(handler);
  }

  /** Simulates the process printing `data`. */
  emitData(data: string): void {
    if (!this.exited) this.data.emit(data);
  }

  /** Simulates the process ending. Only the first call has an effect, like a real process. */
  emitExit(event: PtyExitEvent = { exitCode: 0 }): void {
    if (this.exited) return;
    this.exited = true;
    this.exit.emit(event);
  }
}

export class FakePtyFactory implements PtyFactory {
  readonly spawned: FakePty[] = [];
  /** When set, the next `spawn` throws it. */
  failNextSpawnWith: Error | undefined;
  private nextPid = 1000;

  spawn(options: SpawnPtyOptions): FakePty {
    if (this.failNextSpawnWith) {
      const error = this.failNextSpawnWith;
      this.failNextSpawnWith = undefined;
      throw error;
    }
    const pty = new FakePty(this.nextPid++, options);
    this.spawned.push(pty);
    return pty;
  }

  get last(): FakePty {
    const pty = this.spawned.at(-1);
    if (!pty) throw new Error('No PTY has been spawned.');
    return pty;
  }
}
