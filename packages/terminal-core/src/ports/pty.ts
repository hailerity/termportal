/**
 * PTY port. `terminal-core` depends only on these interfaces; `terminal-pty` implements them
 * with node-pty, and tests implement them with `FakePty`.
 *
 * Ownership and lifecycle: a `PtyProcess` is owned by exactly one `TerminalSession`, which is the
 * only caller of `write`/`resize`/`kill`. The process is live from `PtyFactory.spawn` returning
 * until its single `onExit` event; after that event every method must be a harmless no-op.
 * `spawn` either returns a live process or throws synchronously — it never returns a dead one.
 */
export type Unsubscribe = () => void;

export interface PtyExitEvent {
  exitCode: number;
  /** Signal number that ended the process, when it was signalled. */
  signal?: number;
}

export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(handler: (data: string) => void): Unsubscribe;
  onExit(handler: (event: PtyExitEvent) => void): Unsubscribe;
}

export interface SpawnPtyOptions {
  /** Absolute path of the executable; resolved from a named shell, never taken from a request. */
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface PtyFactory {
  spawn(options: SpawnPtyOptions): PtyProcess;
}
