import type {
  PtyExitEvent,
  PtyFactory,
  PtyProcess,
  SpawnPtyOptions,
  Unsubscribe,
} from '@termportal/terminal-core';
import * as nodePty from 'node-pty';

class NodePtyProcess implements PtyProcess {
  private exited = false;

  constructor(private readonly pty: nodePty.IPty) {
    pty.onExit(() => {
      this.exited = true;
    });
  }

  get pid(): number {
    return this.pty.pid;
  }

  // node-pty throws when its file descriptor is already closed; the port promises no-ops instead.
  write(data: string): void {
    if (!this.exited) this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.exited) this.pty.resize(cols, rows);
  }

  kill(signal?: string): void {
    if (!this.exited) this.pty.kill(signal);
  }

  onData(handler: (data: string) => void): Unsubscribe {
    const subscription = this.pty.onData(handler);
    return () => subscription.dispose();
  }

  onExit(handler: (event: PtyExitEvent) => void): Unsubscribe {
    const subscription = this.pty.onExit(({ exitCode, signal }) =>
      handler({ exitCode, ...(signal ? { signal } : {}) }),
    );
    return () => subscription.dispose();
  }
}

/** `PtyFactory` backed by node-pty: spawns a real operating-system pseudoterminal. */
export class NodePtyFactory implements PtyFactory {
  spawn(options: SpawnPtyOptions): PtyProcess {
    const pty = nodePty.spawn(options.file, options.args, {
      name: options.env.TERM ?? 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
    });
    return new NodePtyProcess(pty);
  }
}
