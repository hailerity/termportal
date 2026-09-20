import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalError } from '../domain/errors.js';
import { FakePtyFactory } from '../testing/fake-pty.js';
import {
  SessionManager,
  type SessionManagerEvent,
  type SessionManagerOptions,
} from './session-manager.js';

function setup(overrides: Partial<SessionManagerOptions> = {}) {
  const ptyFactory = new FakePtyFactory();
  const events: SessionManagerEvent[] = [];
  let counter = 0;
  const manager = new SessionManager({
    ptyFactory,
    shells: { bash: '/bin/bash', sh: '/bin/sh' },
    defaultShell: 'bash',
    defaultCwd: '/tmp',
    defaultCols: 120,
    defaultRows: 40,
    maxSessions: 3,
    isDirectory: async (cwd) => cwd !== '/missing',
    baseEnv: { PATH: '/usr/bin', HOME: '/home/u' },
    generateId: () => `term_test${String(++counter).padStart(4, '0')}`,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return { manager, ptyFactory, events };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TerminalError);
  expect((error as TerminalError).code).toBe(code);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('create', () => {
  it('applies the configured defaults', async () => {
    const { manager, ptyFactory } = setup();
    const session = await manager.create();
    expect(session).toMatchObject({
      id: 'term_test0001',
      status: 'running',
      shell: '/bin/bash',
      cwd: '/tmp',
      cols: 120,
      rows: 40,
      pid: ptyFactory.last.pid,
    });
    expect(ptyFactory.last.options).toMatchObject({
      file: '/bin/bash',
      cwd: '/tmp',
      cols: 120,
      rows: 40,
      env: { PATH: '/usr/bin', HOME: '/home/u', TERM: 'xterm-256color' },
    });
  });

  it('honours the request', async () => {
    const { manager, ptyFactory } = setup();
    const session = await manager.create({
      shell: 'sh',
      cwd: '/var',
      cols: 90,
      rows: 30,
      env: { TERM: 'vt100', LC_ALL: 'C' },
    });
    expect(session).toMatchObject({ shell: '/bin/sh', cwd: '/var', cols: 90, rows: 30 });
    expect(ptyFactory.last.options.env).toMatchObject({ TERM: 'vt100', LC_ALL: 'C' });
  });

  it('rejects unknown shells, including prototype keys and paths', async () => {
    const { manager, ptyFactory } = setup();
    await expectCode(manager.create({ shell: 'fish' }), 'INVALID_SHELL');
    await expectCode(manager.create({ shell: '/bin/bash' }), 'INVALID_SHELL');
    await expectCode(manager.create({ shell: 'constructor' }), 'INVALID_SHELL');
    expect(ptyFactory.spawned).toHaveLength(0);
  });

  it('rejects a missing working directory', async () => {
    await expectCode(setup().manager.create({ cwd: '/missing' }), 'INVALID_CWD');
  });

  it('rejects invalid dimensions', async () => {
    await expectCode(setup().manager.create({ cols: 0 }), 'INVALID_DIMENSIONS');
  });

  it('rejects environment overrides outside the allowlist', async () => {
    const { manager } = setup();
    await expectCode(manager.create({ env: { LD_PRELOAD: '/x.so' } }), 'INVALID_ENV');
    await expectCode(manager.create({ env: { PATH: '/evil' } }), 'INVALID_ENV');
  });

  it('reports spawn failures without registering the session', async () => {
    const { manager, ptyFactory, events } = setup();
    ptyFactory.failNextSpawnWith = new Error('forkpty failed');
    await expectCode(manager.create(), 'PTY_SPAWN_FAILED');
    expect(manager.list()).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ type: 'session.spawn_failed' })]);
  });

  it('enforces the session limit, even for concurrent creates', async () => {
    const { manager } = setup({ maxSessions: 2 });
    const results = await Promise.allSettled([
      manager.create(),
      manager.create(),
      manager.create(),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
    await expectCode(manager.create(), 'SESSION_LIMIT_REACHED');
  });

  it('frees a slot when a session exits', async () => {
    const { manager, ptyFactory } = setup({ maxSessions: 1 });
    await manager.create();
    ptyFactory.last.emitExit();
    await expect(manager.create()).resolves.toMatchObject({ status: 'running' });
  });
});

describe('configuration', () => {
  it('rejects a default shell that is not an own key of the shell map', () => {
    expect(() => setup({ defaultShell: 'toString' })).toThrow(/not a configured shell/);
  });
});

describe('get and list', () => {
  it('returns snapshots in creation order', async () => {
    const { manager } = setup();
    const a = await manager.create();
    const b = await manager.create();
    expect(manager.list().map((s) => s.id)).toEqual([a.id, b.id]);
    expect(manager.get(a.id)).toEqual(a);
    expect(manager.get('term_unknown1')).toBeUndefined();
  });
});

describe('exit policy', () => {
  it('keeps an exited session visible for the TTL, then removes it', async () => {
    const { manager, ptyFactory, events } = setup({ exitedSessionTtlMs: 1000 });
    const { id } = await manager.create();
    ptyFactory.last.emitExit({ exitCode: 7 });
    expect(manager.get(id)).toMatchObject({ status: 'exited', exitCode: 7 });
    vi.advanceTimersByTime(1000);
    expect(manager.get(id)).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual([
      'session.created',
      'session.exited',
      'session.removed',
    ]);
  });

  it('removes immediately when the TTL is zero', async () => {
    const { manager, ptyFactory } = setup({ exitedSessionTtlMs: 0 });
    const { id } = await manager.create();
    ptyFactory.last.emitExit();
    expect(manager.get(id)).toBeUndefined();
  });

  it('evicts by exit order, so a long-lived session stays visible after it exits', async () => {
    const { manager, ptyFactory } = setup({ maxSessions: 2 });
    const oldest = await manager.create();
    const oldestPty = ptyFactory.last;
    const exitedIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      await manager.create().then((s) => exitedIds.push(s.id));
      ptyFactory.last.emitExit();
    }
    oldestPty.emitExit({ exitCode: 5 });
    expect(manager.get(oldest.id)).toMatchObject({ status: 'exited', exitCode: 5 });
    expect(manager.get(exitedIds[0]!)).toBeUndefined();
  });

  it('caps retained exited sessions at maxSessions', async () => {
    const { manager, ptyFactory } = setup({ maxSessions: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push((await manager.create()).id);
      ptyFactory.last.emitExit();
    }
    expect(manager.list().map((s) => s.id)).toEqual(ids.slice(2));
  });
});

describe('attach', () => {
  it('attaches to a live session and reports client counts', async () => {
    const { manager, ptyFactory, events } = setup();
    const { id } = await manager.create();
    const received: unknown[] = [];
    const attachment = manager.attach(id, { send: (e) => received.push(e) });
    attachment.write('hi');
    attachment.detach();
    attachment.detach();
    expect(ptyFactory.last.writes).toEqual(['hi']);
    expect(received).toEqual([{ type: 'status', status: 'running' }]);
    expect(events.slice(1)).toEqual([
      { type: 'client.attached', sessionId: id, clients: 1 },
      { type: 'client.detached', sessionId: id, clients: 0 },
    ]);
  });

  it('reports clients dropped by the session as detached', async () => {
    const { manager, ptyFactory, events } = setup();
    const { id } = await manager.create();
    manager.attach(id, { send: () => {} });
    ptyFactory.last.emitExit();
    expect(events).toContainEqual({ type: 'client.detached', sessionId: id, clients: 0 });
  });

  it('propagates termination failures and keeps the session', async () => {
    const { manager, ptyFactory } = setup({ killTimeoutMs: 100, killGraceMs: 100 });
    const { id } = await manager.create();
    ptyFactory.last.exitOnSignals = new Set();
    const done = expectCode(manager.terminate(id), 'SESSION_TERMINATION_FAILED');
    await vi.advanceTimersByTimeAsync(200);
    await done;
    expect(manager.get(id)).toMatchObject({ status: 'terminating' });
  });

  it('rejects unknown and exited sessions', async () => {
    const { manager, ptyFactory } = setup();
    expect(() => manager.attach('term_unknown1', { send: () => {} })).toThrow(
      expect.objectContaining({ code: 'SESSION_NOT_FOUND' }),
    );
    const { id } = await manager.create();
    ptyFactory.last.emitExit();
    expect(() => manager.attach(id, { send: () => {} })).toThrow(
      expect.objectContaining({ code: 'SESSION_ALREADY_EXITED' }),
    );
  });
});

describe('terminate', () => {
  it('kills the PTY and forgets the session', async () => {
    const { manager, ptyFactory } = setup();
    const { id } = await manager.create();
    await manager.terminate(id);
    expect(ptyFactory.last.kills).toEqual(['SIGHUP']);
    expect(manager.get(id)).toBeUndefined();
    await expectCode(manager.terminate(id), 'SESSION_NOT_FOUND');
  });

  it('removes an already exited session without killing again', async () => {
    const { manager, ptyFactory } = setup();
    const { id } = await manager.create();
    ptyFactory.last.emitExit();
    await manager.terminate(id);
    expect(ptyFactory.last.kills).toEqual([]);
    expect(manager.list()).toEqual([]);
  });

  it('handles concurrent terminations of the same session', async () => {
    const { manager, ptyFactory } = setup();
    const { id } = await manager.create();
    ptyFactory.last.exitOnSignals = new Set();
    const both = Promise.all([manager.terminate(id), manager.terminate(id)]);
    ptyFactory.last.emitExit();
    await expect(both).resolves.toBeDefined();
    expect(ptyFactory.last.kills).toEqual(['SIGHUP']);
  });
});

describe('shutdown', () => {
  it('terminates every session and refuses new ones', async () => {
    const { manager, ptyFactory } = setup();
    await manager.create();
    await manager.create();
    await manager.shutdown(1000);
    expect(ptyFactory.spawned.every((pty) => pty.exited)).toBe(true);
    expect(manager.list()).toEqual([]);
    await expectCode(manager.create(), 'SESSION_LIMIT_REACHED');
  });

  it('force-kills sessions that outlive the timeout and waits for them', async () => {
    const { manager, ptyFactory, events } = setup({ killTimeoutMs: 60_000 });
    await manager.create();
    const stubborn = ptyFactory.last;
    stubborn.exitOnSignals = new Set(['SIGKILL']);
    const done = manager.shutdown(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(done).resolves.toEqual([]);
    expect(stubborn.kills).toEqual(['SIGHUP', 'SIGKILL']);
    expect(events.map((e) => e.type)).toContain('session.exited');
  });

  it('reports sessions that survive even SIGKILL', async () => {
    const { manager, ptyFactory } = setup({ killTimeoutMs: 60_000 });
    const { id } = await manager.create();
    ptyFactory.last.exitOnSignals = new Set();
    const done = manager.shutdown(2000, 500);
    await vi.advanceTimersByTimeAsync(2500);
    await expect(done).resolves.toEqual([id]);
    expect(manager.list()).toEqual([]);
  });

  it('resolves immediately when there is nothing to stop', async () => {
    await expect(setup().manager.shutdown(1000)).resolves.toEqual([]);
  });
});
