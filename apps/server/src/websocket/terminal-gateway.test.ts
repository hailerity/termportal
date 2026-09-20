import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildApp } from '../app.js';
import { maxBufferedBytesFor } from '../runtime.js';
import { createFakeSessions } from '../testing/harness.js';
import { TestTerminalClient } from '../testing/ws-client.js';
import { CLOSE_CODES, createTerminalGateway, type TerminalGateway } from './terminal-gateway.js';

let app: FastifyInstance;
let gateway: TerminalGateway;
let harness: ReturnType<typeof createFakeSessions>;
let baseUrl: string;
const clients: TestTerminalClient[] = [];
const REPLAY_BYTES = 256 * 1024;

/** Runs on every attach; lets a test make the PTY print in the same tick as the replay. */
let onAttached: (() => void) | undefined;

async function start(
  options: { maxProtocolErrors?: number; maxBufferedBytes?: number; closeGraceMs?: number } = {},
) {
  harness = createFakeSessions({
    outputBufferBytes: REPLAY_BYTES,
    onEvent: (event) => {
      if (event.type === 'client.attached') onAttached?.();
    },
  });
  app = await buildApp({ sessions: harness.sessions, allowedOrigins: ['http://localhost:4200'] });
  gateway = createTerminalGateway({
    server: app.server,
    sessions: harness.sessions,
    allowedOrigins: ['http://localhost:4200'],
    ...options,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

async function connect(sessionId: string, headers?: Record<string, string>) {
  const client = await TestTerminalClient.connect(
    `${baseUrl}/api/v1/sessions/${sessionId}/terminal`,
    headers,
  );
  clients.push(client);
  return client;
}

const isError = (code: string) => (m: { type: string; code?: string }) =>
  m.type === 'error' && m.code === code;

beforeEach(() => start());

afterEach(async () => {
  onAttached = undefined;
  for (const client of clients.splice(0)) client.ws.terminate();
  await gateway.close();
  await app.close();
});

describe('connection', () => {
  it('sends the session status first', async () => {
    const { id } = await harness.sessions.create();
    const client = await connect(id);
    await client.waitFor((m) => m.type === 'status');
    expect(client.messages[0]).toEqual({ type: 'status', status: 'running' });
    expect(gateway.connections).toBe(1);
  });

  it('reports an unknown session and closes', async () => {
    const client = await connect('term_unknown12345');
    expect(await client.closed).toMatchObject({ code: CLOSE_CODES.sessionNotFound });
    expect(client.messages).toEqual([
      { type: 'error', code: 'SESSION_NOT_FOUND', message: 'Terminal session was not found.' },
    ]);
  });

  it('reports a malformed session id and closes', async () => {
    const client = await connect('nope');
    expect(await client.closed).toMatchObject({ code: CLOSE_CODES.invalidSessionId });
    expect(client.messages[0]).toMatchObject({ type: 'error', code: 'INVALID_SESSION_ID' });
  });

  it('refuses to attach to an exited session', async () => {
    const { id } = await harness.sessions.create();
    harness.ptyFactory.last.emitExit();
    const client = await connect(id);
    expect(await client.closed).toMatchObject({ code: CLOSE_CODES.sessionExited });
    expect(client.messages[0]).toMatchObject({ type: 'error', code: 'SESSION_ALREADY_EXITED' });
  });

  it('rejects upgrades on other paths', async () => {
    await expect(TestTerminalClient.connect(`${baseUrl}/api/v1/sessions`)).rejects.toThrow(/404/);
  });

  it('allows configured browser origins only, never trusting the Host header', async () => {
    const { id } = await harness.sessions.create();
    await expect(connect(id, { origin: 'https://evil.example' })).rejects.toThrow(/403/);
    await expect(connect(id, { origin: 'null' })).rejects.toThrow(/403/);
    await expect(connect(id, { origin: baseUrl.replace('ws:', 'http:') })).rejects.toThrow(/403/);
    await expect(connect(id, { origin: 'http://localhost:4200' })).resolves.toBeDefined();
  });

  it('survives an oversized frame on a rejected connection', async () => {
    const client = await connect('term_unknown12345');
    client.sendRaw('x'.repeat(300 * 1024));
    await client.closed;
    const { id } = await harness.sessions.create();
    const healthy = await connect(id);
    await healthy.waitFor((m) => m.type === 'status');
  });
});

describe('messages', () => {
  it('routes input and resize to the PTY and streams output back', async () => {
    const { id } = await harness.sessions.create();
    const pty = harness.ptyFactory.last;
    const client = await connect(id);
    await client.waitFor((m) => m.type === 'status');

    client.send({ type: 'input', data: 'ls -la\r' });
    client.send({ type: 'resize', cols: 160, rows: 50 });
    client.send({ type: 'ping' });
    await client.waitFor((m) => m.type === 'pong');
    expect(pty.writes).toEqual(['ls -la\r']);
    expect(pty.resizes).toEqual([{ cols: 160, rows: 50 }]);
    expect(harness.sessions.get(id)).toMatchObject({ cols: 160, rows: 50 });

    pty.emitData('\u001b[32mhello\u001b[0m\r\n');
    await client.waitForOutput(/hello/);
    expect(client.output).toBe('\u001b[32mhello\u001b[0m\r\n');
  });

  it.each([
    ['malformed JSON', '{nope'],
    ['an unknown type', JSON.stringify({ type: 'exec', command: 'id' })],
    ['invalid dimensions', JSON.stringify({ type: 'resize', cols: 0, rows: 0 })],
    ['a binary frame', Buffer.from([1, 2, 3])],
  ])('answers %s with INVALID_MESSAGE and stays connected', async (_name, frame) => {
    const { id } = await harness.sessions.create();
    const client = await connect(id);
    client.sendRaw(frame);
    await client.waitFor(isError('INVALID_MESSAGE'));
    client.send({ type: 'ping' });
    await client.waitFor((m) => m.type === 'pong');
    expect(harness.ptyFactory.last.writes).toEqual([]);
  });

  it('closes after too many consecutive invalid messages', async () => {
    await gateway.close();
    await app.close();
    await start({ maxProtocolErrors: 3 });
    const { id } = await harness.sessions.create();
    const client = await connect(id);
    for (let i = 0; i < 3; i++) client.sendRaw('garbage');
    expect(await client.closed).toMatchObject({ code: CLOSE_CODES.policyViolation });
  });

  it('closes the connection on an oversized frame', async () => {
    const { id } = await harness.sessions.create();
    const client = await connect(id);
    client.sendRaw('x'.repeat(300 * 1024));
    expect((await client.closed).code).toBe(1009);
    expect(harness.sessions.get(id)?.status).toBe('running');
  });

  it('contains unexpected PTY errors instead of crashing', async () => {
    const { id } = await harness.sessions.create();
    harness.ptyFactory.last.write = () => {
      throw new Error('EIO /dev/ptmx');
    };
    const client = await connect(id);
    client.send({ type: 'input', data: 'x' });
    const error = await client.waitFor(isError('INTERNAL_ERROR'));
    expect(JSON.stringify(error)).not.toContain('ptmx');
    client.send({ type: 'ping' });
    await client.waitFor((m) => m.type === 'pong');
  });

  it('reports input sent while the session is terminating', async () => {
    const { id } = await harness.sessions.create();
    harness.ptyFactory.last.exitOnSignals = new Set();
    const client = await connect(id);
    void harness.sessions.terminate(id);
    await client.waitFor((m) => m.type === 'status' && m.status === 'terminating');
    client.send({ type: 'input', data: 'x' });
    await client.waitFor(isError('SESSION_ALREADY_EXITED'));
    harness.ptyFactory.last.emitExit();
  });
});

describe('lifecycle', () => {
  it('sends status and exit when the session is terminated, then closes', async () => {
    const { id } = await harness.sessions.create();
    const client = await connect(id);
    await client.waitFor((m) => m.type === 'status');
    await harness.sessions.terminate(id);
    expect(await client.closed).toMatchObject({ code: CLOSE_CODES.normal });
    expect(client.messages).toEqual([
      { type: 'status', status: 'running' },
      { type: 'status', status: 'terminating' },
      { type: 'status', status: 'exited' },
      { type: 'exit', exitCode: 0, signal: 1 },
    ]);
  });

  it('keeps the session running when the client disconnects', async () => {
    const { id } = await harness.sessions.create();
    const client = await connect(id);
    await client.waitFor((m) => m.type === 'status');
    await client.close();
    await expect.poll(() => gateway.connections).toBe(0);
    expect(harness.sessions.get(id)?.status).toBe('running');
    expect(harness.ptyFactory.last.kills).toEqual([]);

    const again = await connect(id);
    await again.waitFor((m) => m.type === 'status');
  });

  it('replays recent output to a client that reconnects', async () => {
    const { id } = await harness.sessions.create();
    const pty = harness.ptyFactory.last;
    const first = await connect(id);
    await first.waitFor((m) => m.type === 'status');
    pty.emitData('before-disconnect ');
    await first.waitForOutput(/before-disconnect/);
    await first.close();

    pty.emitData('while-away ');
    const second = await connect(id);
    await second.waitForOutput(/while-away/);
    pty.emitData('after-reconnect');
    await second.waitForOutput(/after-reconnect/);
    expect(second.messages[0]).toEqual({ type: 'status', status: 'running' });
    expect(second.output).toBe('before-disconnect while-away after-reconnect');
  });

  it('broadcasts to every client and accepts input from each', async () => {
    const { id } = await harness.sessions.create();
    const pty = harness.ptyFactory.last;
    const a = await connect(id);
    const b = await connect(id);
    await Promise.all([a, b].map((c) => c.waitFor((m) => m.type === 'status')));

    a.send({ type: 'input', data: 'from-a' });
    b.send({ type: 'input', data: 'from-b' });
    await expect.poll(() => [...pty.writes].sort()).toEqual(['from-a', 'from-b']);

    pty.emitData('shared');
    await Promise.all([a.waitForOutput(/shared/), b.waitForOutput(/shared/)]);

    a.ws.terminate();
    await expect.poll(() => gateway.connections).toBe(1);
    pty.emitData(' still-here');
    await b.waitForOutput(/still-here/);
  });

  it('disconnects a client that cannot keep up instead of buffering without bound', async () => {
    await gateway.close();
    await app.close();
    await start({ maxBufferedBytes: 1024 });
    const { id } = await harness.sessions.create();
    const client = await connect(id);
    await client.waitFor((m) => m.type === 'status');
    client.ws.pause();
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 200; i++) harness.ptyFactory.last.emitData(chunk);
    client.ws.resume();
    expect((await client.closed).code).toBe(CLOSE_CODES.tryAgainLater);
    expect(harness.sessions.get(id)?.status).toBe('running');
  });

  it('does not wait for a peer that never completes the close handshake', async () => {
    await gateway.close();
    await app.close();
    await start({ closeGraceMs: 50 });
    const { id } = await harness.sessions.create();
    const client = await connect(id);
    await client.waitFor((m) => m.type === 'status');
    client.ws.pause();
    const startedAt = Date.now();
    await gateway.close();
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  describe('a full replay followed immediately by live output', () => {
    // Escape characters are the worst case: JSON inflates each one to six bytes on the wire.
    async function attachToBusySession(maxBufferedBytes: number) {
      await gateway.close();
      await app.close();
      await start({ maxBufferedBytes });
      const { id } = await harness.sessions.create();
      const pty = harness.ptyFactory.last;
      pty.emitData('\u001b'.repeat(REPLAY_BYTES));
      onAttached = () => pty.emitData('live-output');
      return connect(id);
    }

    it('drops the fresh client when the queue limit ignores the replay size', async () => {
      const client = await attachToBusySession(REPLAY_BYTES);
      expect((await client.closed).code).toBe(CLOSE_CODES.tryAgainLater);
    });

    it('keeps the client when the limit is derived from the replay size', async () => {
      const client = await attachToBusySession(maxBufferedBytesFor(REPLAY_BYTES));
      await client.waitForOutput(/live-output/);
      expect(client.output).toHaveLength(REPLAY_BYTES + 'live-output'.length);
    });
  });

  it('sizes the queue limit to hold a worst-case replay frame', () => {
    for (const bytes of [0, 1024, 5 * 1024 * 1024, 16 * 1024 * 1024]) {
      expect(maxBufferedBytesFor(bytes)).toBeGreaterThan(bytes * 6);
      expect(maxBufferedBytesFor(bytes)).toBeGreaterThanOrEqual(16 * 1024 * 1024);
    }
  });

  it('closes open sockets when the gateway shuts down', async () => {
    const { id } = await harness.sessions.create();
    const client = await connect(id);
    await client.waitFor((m) => m.type === 'status');
    void gateway.close();
    expect(await client.closed).toMatchObject({ code: CLOSE_CODES.goingAway });
    expect(client.ws.readyState).toBe(WebSocket.CLOSED);
  });
});
