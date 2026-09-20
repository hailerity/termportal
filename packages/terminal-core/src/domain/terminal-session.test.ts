import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePty, FakePtyFactory } from '../testing/fake-pty.js';
import { TerminalError } from './errors.js';
import { TerminalSession, type TerminalClientEvent } from './terminal-session.js';

const spawnOptions = { file: '/bin/bash', args: [], cwd: '/tmp', env: {} };

function createSession(overrides: { now?: () => Date; killTimeoutMs?: number } = {}) {
  return new TerminalSession({
    id: 'term_test0001',
    shell: '/bin/bash',
    cwd: '/tmp',
    cols: 80,
    rows: 24,
    ...overrides,
  });
}

function startSession(overrides: { now?: () => Date; killTimeoutMs?: number } = {}) {
  const factory = new FakePtyFactory();
  const session = createSession(overrides);
  session.start((size) => factory.spawn({ ...spawnOptions, ...size }));
  return { session, pty: factory.last };
}

function recordingClient() {
  const events: TerminalClientEvent[] = [];
  return { events, send: (event: TerminalClientEvent) => void events.push(event) };
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TerminalError);
    expect((error as TerminalError).code).toBe(code);
    return;
  }
  throw new Error(`Expected a TerminalError with code ${code}.`);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('lifecycle', () => {
  it('starts in "starting" without a pid', () => {
    const session = createSession();
    expect(session.status).toBe('starting');
    expect(session.snapshot().pid).toBeUndefined();
  });

  it('becomes "running" with the PTY pid and the session dimensions', () => {
    const { session, pty } = startSession();
    expect(session.status).toBe('running');
    expect(session.snapshot()).toMatchObject({ pid: pty.pid, cols: 80, rows: 24 });
    expect(pty.options).toMatchObject({ cols: 80, rows: 24 });
  });

  it('becomes "failed" when the spawn throws and hides the cause from the message', () => {
    const session = createSession();
    expectCode(
      () =>
        session.start(() => {
          throw new Error('ENOENT /secret/path');
        }),
      'PTY_SPAWN_FAILED',
    );
    expect(session.status).toBe('failed');
    expect(session.isLive).toBe(false);
  });

  it('cannot be started twice', () => {
    const { session } = startSession();
    expect(() =>
      session.start(() => new FakePty(1, { ...spawnOptions, cols: 1, rows: 1 })),
    ).toThrow(/Cannot start/);
  });

  it('records the exit code and signal when the process exits', () => {
    const { session, pty } = startSession();
    const onExit = vi.fn();
    const statuses: string[] = [];
    session.onExit(onExit);
    session.onStatusChange((status) => statuses.push(status));
    pty.emitExit({ exitCode: 2, signal: 15 });
    expect(session.status).toBe('exited');
    expect(session.snapshot()).toMatchObject({ status: 'exited', exitCode: 2, exitSignal: 15 });
    expect(onExit).toHaveBeenCalledExactlyOnceWith({ exitCode: 2, signal: 15 });
    expect(statuses).toEqual(['exited']);
  });

  it('rejects invalid initial dimensions', () => {
    expectCode(
      () => new TerminalSession({ id: 'x', shell: 's', cwd: '/', cols: 0, rows: 24 }),
      'INVALID_DIMENSIONS',
    );
  });
});

describe('write', () => {
  it('forwards input to the PTY', () => {
    const { session, pty } = startSession();
    session.write('ls\r');
    expect(pty.writes).toEqual(['ls\r']);
  });

  it('is rejected before start and after exit', () => {
    expectCode(() => createSession().write('x'), 'SESSION_ALREADY_EXITED');
    const { session, pty } = startSession();
    pty.emitExit();
    expectCode(() => session.write('x'), 'SESSION_ALREADY_EXITED');
    expect(pty.writes).toEqual([]);
  });

  it('is rejected while terminating', () => {
    const { session, pty } = startSession();
    pty.exitOnSignals = new Set();
    void session.terminate();
    expectCode(() => session.write('x'), 'SESSION_ALREADY_EXITED');
  });
});

describe('resize', () => {
  it('resizes the PTY and the snapshot; the last resize wins', () => {
    const { session, pty } = startSession();
    session.resize(120, 40);
    session.resize(160, 50);
    expect(pty.resizes).toEqual([
      { cols: 120, rows: 40 },
      { cols: 160, rows: 50 },
    ]);
    expect(session.snapshot()).toMatchObject({ cols: 160, rows: 50 });
  });

  it('skips the PTY call when the size is unchanged', () => {
    const { session, pty } = startSession();
    session.resize(80, 24);
    expect(pty.resizes).toEqual([]);
  });

  it.each([
    [0, 24],
    [80, 0],
    [80.5, 24],
    [Number.NaN, 24],
    [100000, 24],
  ])('rejects %d x %d', (cols, rows) => {
    const { session, pty } = startSession();
    expectCode(() => session.resize(cols, rows), 'INVALID_DIMENSIONS');
    expect(pty.resizes).toEqual([]);
  });

  it('is rejected after exit', () => {
    const { session, pty } = startSession();
    pty.emitExit();
    expectCode(() => session.resize(100, 30), 'SESSION_ALREADY_EXITED');
  });
});

describe('clients', () => {
  it('sends the current status on attach, then output', () => {
    const { session, pty } = startSession();
    const client = recordingClient();
    session.attach(client);
    pty.emitData('hello');
    expect(client.events).toEqual([
      { type: 'status', status: 'running' },
      { type: 'output', data: 'hello' },
    ]);
  });

  it('broadcasts output, status and exit to every client', () => {
    const { session, pty } = startSession();
    const a = recordingClient();
    const b = recordingClient();
    session.attach(a);
    session.attach(b);
    pty.emitData('x');
    pty.emitExit({ exitCode: 0 });
    const expected = [
      { type: 'status', status: 'running' },
      { type: 'output', data: 'x' },
      { type: 'status', status: 'exited' },
      { type: 'exit', exitCode: 0 },
    ];
    expect(a.events).toEqual(expected);
    expect(b.events).toEqual(expected);
    expect(session.clientCount).toBe(0);
  });

  it('routes input and resize from any attachment to the one PTY', () => {
    const { session, pty } = startSession();
    const a = session.attach(recordingClient());
    const b = session.attach(recordingClient());
    a.write('from-a');
    b.write('from-b');
    b.resize(100, 30);
    expect(pty.writes).toEqual(['from-a', 'from-b']);
    expect(pty.resizes).toEqual([{ cols: 100, rows: 30 }]);
  });

  it('stops delivering to a detached client without ending the session', () => {
    const { session, pty } = startSession();
    const client = recordingClient();
    const attachment = session.attach(client);
    attachment.detach();
    attachment.detach();
    pty.emitData('after');
    expect(client.events).toEqual([{ type: 'status', status: 'running' }]);
    expect(session.status).toBe('running');
  });

  it('drops a client whose transport throws and keeps serving the others', () => {
    const { session, pty } = startSession();
    const healthy = recordingClient();
    let calls = 0;
    session.attach({
      send: () => {
        if (++calls > 1) throw new Error('socket closed');
      },
    });
    session.attach(healthy);
    pty.emitData('one');
    pty.emitData('two');
    expect(session.clientCount).toBe(1);
    expect(healthy.events.filter((e) => e.type === 'output')).toHaveLength(2);
  });

  it('rejects attaching to an exited session', () => {
    const { session, pty } = startSession();
    pty.emitExit();
    expectCode(() => session.attach(recordingClient()), 'SESSION_ALREADY_EXITED');
  });
});

describe('terminate', () => {
  it('sends SIGHUP, passes through "terminating" and resolves on exit', async () => {
    const { session, pty } = startSession();
    const client = recordingClient();
    session.attach(client);
    await session.terminate();
    expect(pty.kills).toEqual(['SIGHUP']);
    expect(session.status).toBe('exited');
    expect(client.events.map((e) => (e.type === 'status' ? e.status : e.type))).toEqual([
      'running',
      'terminating',
      'exited',
      'exit',
    ]);
  });

  it('is idempotent: repeated calls kill once and all resolve', async () => {
    const { session, pty } = startSession();
    pty.exitOnSignals = new Set();
    const first = session.terminate();
    const second = session.terminate();
    expect(pty.kills).toEqual(['SIGHUP']);
    pty.emitExit({ exitCode: 0, signal: 1 });
    await Promise.all([first, second]);
    await session.terminate();
    expect(pty.kills).toEqual(['SIGHUP']);
  });

  it('escalates to SIGKILL when the process ignores SIGHUP', async () => {
    const { session, pty } = startSession({ killTimeoutMs: 500 });
    pty.exitOnSignals = new Set(['SIGKILL']);
    const done = session.terminate();
    expect(session.status).toBe('terminating');
    vi.advanceTimersByTime(499);
    expect(pty.kills).toEqual(['SIGHUP']);
    vi.advanceTimersByTime(1);
    await done;
    expect(pty.kills).toEqual(['SIGHUP', 'SIGKILL']);
    expect(session.snapshot()).toMatchObject({ status: 'exited', exitSignal: 9 });
  });

  it('does not escalate once the process has exited', async () => {
    const { session, pty } = startSession({ killTimeoutMs: 500 });
    await session.terminate();
    vi.advanceTimersByTime(1000);
    expect(pty.kills).toEqual(['SIGHUP']);
  });

  it('settles a session that never started', async () => {
    const session = createSession();
    await session.terminate();
    expect(session.status).toBe('exited');
  });

  it('survives a PTY whose kill throws', async () => {
    const { session, pty } = startSession();
    pty.kill = () => {
      throw new Error('ESRCH');
    };
    const done = session.terminate();
    pty.emitExit({ exitCode: 0 });
    await expect(done).resolves.toBeUndefined();
  });
});

describe('timestamps', () => {
  it('tracks creation and last activity', () => {
    let time = Date.parse('2026-09-20T15:00:00.000Z');
    const { session, pty } = startSession({ now: () => new Date(time) });
    time += 1000;
    session.write('x');
    expect(session.snapshot().lastActivityAt).toBe('2026-09-20T15:00:01.000Z');
    time += 1000;
    pty.emitData('y');
    expect(session.snapshot()).toMatchObject({
      createdAt: '2026-09-20T15:00:00.000Z',
      lastActivityAt: '2026-09-20T15:00:02.000Z',
    });
  });
});
