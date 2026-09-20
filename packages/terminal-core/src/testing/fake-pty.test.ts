import { describe, expect, it, vi } from 'vitest';
import { FakePtyFactory } from './fake-pty.js';

const options = { file: '/bin/sh', args: [], cwd: '/tmp', env: {}, cols: 80, rows: 24 };

describe('FakePty', () => {
  it('records writes, resizes and kills', () => {
    const pty = new FakePtyFactory().spawn(options);
    pty.exitOnSignals = new Set();
    pty.write('a');
    pty.resize(100, 30);
    pty.kill('SIGHUP');
    expect(pty.writes).toEqual(['a']);
    expect(pty.resizes).toEqual([{ cols: 100, rows: 30 }]);
    expect(pty.kills).toEqual(['SIGHUP']);
    expect(pty.options).toEqual(options);
  });

  it('delivers data until unsubscribed', () => {
    const pty = new FakePtyFactory().spawn(options);
    const handler = vi.fn();
    const unsubscribe = pty.onData(handler);
    pty.emitData('one');
    unsubscribe();
    pty.emitData('two');
    expect(handler.mock.calls).toEqual([['one']]);
  });

  it('exits exactly once and goes quiet afterwards', () => {
    const pty = new FakePtyFactory().spawn(options);
    const onExit = vi.fn();
    const onData = vi.fn();
    pty.onExit(onExit);
    pty.onData(onData);
    pty.emitExit({ exitCode: 3 });
    pty.emitExit({ exitCode: 4 });
    pty.emitData('late');
    pty.write('late');
    expect(onExit.mock.calls).toEqual([[{ exitCode: 3 }]]);
    expect(onData).not.toHaveBeenCalled();
    expect(pty.writes).toEqual([]);
  });

  it('exits when killed, by default', () => {
    const pty = new FakePtyFactory().spawn(options);
    const onExit = vi.fn();
    pty.onExit(onExit);
    pty.kill('SIGKILL');
    expect(onExit).toHaveBeenCalledWith({ exitCode: 0, signal: 9 });
  });

  it('assigns distinct pids and can fail a spawn', () => {
    const factory = new FakePtyFactory();
    const a = factory.spawn(options);
    const b = factory.spawn(options);
    expect(a.pid).not.toBe(b.pid);
    factory.failNextSpawnWith = new Error('boom');
    expect(() => factory.spawn(options)).toThrow('boom');
    expect(factory.spawn(options)).toBe(factory.last);
  });
});
