import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { PtyExitEvent, PtyProcess } from '@termportal/terminal-core';
import { afterEach, describe, expect, it } from 'vitest';
import { NodePtyFactory } from './node-pty-adapter.js';
import { resolveShellMap } from './shells.js';

const shell = resolveShellMap().bash ?? '/bin/sh';
const cwd = realpathSync(tmpdir());
const live: PtyProcess[] = [];

function spawn(overrides: { cols?: number; rows?: number; env?: Record<string, string> } = {}) {
  const pty = new NodePtyFactory().spawn({
    file: shell,
    args: [],
    cwd,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color', PS1: '$ ' },
    cols: 80,
    rows: 24,
    ...overrides,
  });
  live.push(pty);
  let output = '';
  pty.onData((data) => (output += data));
  const exit = new Promise<PtyExitEvent>((resolve) => pty.onExit(resolve));
  const waitFor = async (pattern: RegExp, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (!pattern.test(output)) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${pattern}: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { pty, exit, waitFor };
}

afterEach(() => {
  for (const pty of live.splice(0)) pty.kill('SIGKILL');
});

describe('NodePtyFactory (real PTY)', () => {
  it('spawns a shell, echoes a command, resizes and is killed', async () => {
    const { pty, exit, waitFor } = spawn();
    expect(pty.pid).toBeGreaterThan(0);

    // The arithmetic proves we see the command's output rather than the terminal echo.
    pty.write('echo hello-$((40+2))\r');
    await waitFor(/hello-42/);

    pty.resize(132, 43);
    pty.write('stty size\r');
    await waitFor(/43 132/);

    pty.kill('SIGHUP');
    const event = await exit;
    expect(event.signal).toBe(1);
  });

  it('starts in the requested directory with the requested size and environment', async () => {
    const { pty, waitFor } = spawn({
      cols: 100,
      rows: 30,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TERMPORTAL_TEST: 'from-env' },
    });
    pty.write('echo "[$PWD|$(stty size)|$TERMPORTAL_TEST]"\r');
    await waitFor(new RegExp(`\\[${cwd.replaceAll('/', '\\/')}\\|30 100\\|from-env\\]`));
  });

  it('reports the exit code when the shell exits by itself', async () => {
    const { pty, exit } = spawn();
    pty.write('exit 7\r');
    expect(await exit).toEqual({ exitCode: 7 });
  });

  it('turns calls after exit into no-ops', async () => {
    const { pty, exit } = spawn();
    pty.kill('SIGKILL');
    await exit;
    expect(() => {
      pty.write('x');
      pty.resize(90, 20);
      pty.kill();
    }).not.toThrow();
  });

  it('throws synchronously or exits when the executable does not exist', async () => {
    try {
      const pty = new NodePtyFactory().spawn({
        file: '/nonexistent/shell',
        args: [],
        cwd,
        env: {},
        cols: 80,
        rows: 24,
      });
      const event = await new Promise<PtyExitEvent>((resolve) => pty.onExit(resolve));
      expect(event.exitCode).not.toBe(0);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });
});
