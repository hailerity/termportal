import {
  apiErrorResponseSchema,
  listSessionsResponseSchema,
  terminalSessionResponseSchema,
} from '@termportal/api-contract';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createFakeSessions } from '../testing/harness.js';

let app: FastifyInstance;
let harness: ReturnType<typeof createFakeSessions>;
let ready = true;

beforeEach(async () => {
  ready = true;
  harness = createFakeSessions();
  app = await buildApp({
    sessions: harness.sessions,
    allowedOrigins: ['http://localhost:4200'],
    isReady: () => ready,
  });
});

afterEach(() => app.close());

const create = (payload?: object) =>
  app.inject({ method: 'POST', url: '/api/v1/sessions', ...(payload ? { payload } : {}) });

function expectError(
  response: { statusCode: number; json(): unknown },
  status: number,
  code: string,
) {
  expect(response.statusCode).toBe(status);
  const body = apiErrorResponseSchema.parse(response.json());
  expect(body.error.code).toBe(code);
  return body.error;
}

describe('POST /api/v1/sessions', () => {
  it('creates a session with defaults when there is no body', async () => {
    const response = await create();
    expect(response.statusCode).toBe(201);
    const session = terminalSessionResponseSchema.parse(response.json());
    expect(session).toMatchObject({ status: 'running', shell: '/bin/bash', cols: 120, rows: 40 });
    expect(response.headers.location).toBe(`/api/v1/sessions/${session.id}`);
  });

  it('accepts an empty JSON body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(response.statusCode).toBe(201);
  });

  it('rejects an explicit null body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { 'content-type': 'application/json' },
      payload: 'null',
    });
    expectError(response, 400, 'INVALID_REQUEST');
  });

  it('creates a session from the documented request', async () => {
    const response = await create({
      shell: 'sh',
      cwd: '/var',
      cols: 100,
      rows: 30,
      env: { TERM: 'xterm-256color' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ shell: '/bin/sh', cwd: '/var', cols: 100, rows: 30 });
    expect(harness.ptyFactory.last.options.env.TERM).toBe('xterm-256color');
  });

  it.each([
    [{ shell: 'fish' }, 'INVALID_SHELL'],
    [{ shell: '/bin/bash' }, 'INVALID_SHELL'],
    [{ cols: 0 }, 'INVALID_DIMENSIONS'],
    [{ rows: 100000 }, 'INVALID_DIMENSIONS'],
    [{ cwd: '' }, 'INVALID_CWD'],
    [{ cwd: '/missing' }, 'INVALID_CWD'],
    [{ env: { 'BAD NAME': 'x' } }, 'INVALID_ENV'],
    [{ env: { LD_PRELOAD: '/x.so' } }, 'INVALID_ENV'],
    [{ command: 'id' }, 'INVALID_REQUEST'],
  ])('rejects %j with %s', async (payload, code) => {
    expectError(await create(payload), 400, code);
    expect(harness.ptyFactory.spawned).toHaveLength(0);
  });

  it('rejects malformed JSON, non-JSON bodies and oversized bodies', async () => {
    const post = (headers: Record<string, string>, payload: string) =>
      app.inject({ method: 'POST', url: '/api/v1/sessions', headers, payload });
    expectError(
      await post({ 'content-type': 'application/json' }, '{nope'),
      400,
      'INVALID_REQUEST',
    );
    expectError(await post({ 'content-type': 'text/plain' }, '{}'), 415, 'INVALID_REQUEST');
    expectError(
      await post(
        { 'content-type': 'application/json' },
        JSON.stringify({ cwd: 'x'.repeat(70000) }),
      ),
      413,
      'INVALID_REQUEST',
    );
  });

  it('returns 429 at the session limit', async () => {
    for (let i = 0; i < 3; i++) expect((await create()).statusCode).toBe(201);
    expectError(await create(), 429, 'SESSION_LIMIT_REACHED');
  });

  it('hides spawn failure details', async () => {
    harness.ptyFactory.failNextSpawnWith = new Error('execvp(3) failed: /secret/path');
    const response = await create();
    expectError(response, 500, 'PTY_SPAWN_FAILED');
    expect(response.body).not.toContain('secret');
  });
});

describe('GET /api/v1/sessions', () => {
  it('lists sessions', async () => {
    expect((await app.inject('/api/v1/sessions')).json()).toEqual({ sessions: [] });
    const created = (await create()).json();
    const list = listSessionsResponseSchema.parse((await app.inject('/api/v1/sessions')).json());
    expect(list.sessions).toEqual([created]);
  });
});

describe('GET /api/v1/sessions/:id', () => {
  it('returns one session, including its exit state', async () => {
    const { id } = (await create()).json();
    expect((await app.inject(`/api/v1/sessions/${id}`)).json()).toMatchObject({
      id,
      status: 'running',
    });
    harness.ptyFactory.last.emitExit({ exitCode: 3 });
    expect((await app.inject(`/api/v1/sessions/${id}`)).json()).toMatchObject({
      status: 'exited',
      exitCode: 3,
    });
  });

  it('distinguishes unknown from malformed ids', async () => {
    expectError(await app.inject('/api/v1/sessions/term_unknown12345'), 404, 'SESSION_NOT_FOUND');
    expectError(await app.inject('/api/v1/sessions/nope'), 400, 'INVALID_SESSION_ID');
  });
});

describe('DELETE /api/v1/sessions/:id', () => {
  it('terminates the session and then reports it as gone', async () => {
    const { id } = (await create()).json();
    const response = await app.inject({ method: 'DELETE', url: `/api/v1/sessions/${id}` });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(harness.ptyFactory.last.kills).toEqual(['SIGHUP']);
    expectError(
      await app.inject({ method: 'DELETE', url: `/api/v1/sessions/${id}` }),
      404,
      'SESSION_NOT_FOUND',
    );
  });
});

describe('cross-cutting', () => {
  it('serves health and readiness', async () => {
    expect((await app.inject('/health')).json()).toEqual({ status: 'ok' });
    expect((await app.inject('/ready')).statusCode).toBe(200);
    ready = false;
    const response = await app.inject('/ready');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'shutting_down' });
  });

  it('uses the error shape for unknown routes', async () => {
    expectError(await app.inject('/api/v1/nope'), 404, 'NOT_FOUND');
  });

  it('correlates errors with a request id, reusing a well-formed one', async () => {
    const generated = await app.inject('/api/v1/sessions/nope');
    expect(generated.json().error.requestId).toBe(generated.headers['x-request-id']);
    const supplied = await app.inject({
      url: '/api/v1/sessions/nope',
      headers: { 'x-request-id': 'trace-123' },
    });
    expect(supplied.json().error.requestId).toBe('trace-123');
    const malicious = await app.inject({
      url: '/api/v1/sessions/nope',
      headers: { 'x-request-id': 'bad id\twith spaces' },
    });
    expect(malicious.json().error.requestId).not.toContain(' ');
  });

  it('allows configured browser origins only', async () => {
    const allowed = await app.inject({
      url: '/api/v1/sessions',
      headers: { origin: 'http://localhost:4200' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:4200');
    const denied = await app.inject({
      url: '/api/v1/sessions',
      headers: { origin: 'https://evil.example' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    expectError(denied, 403, 'ORIGIN_NOT_ALLOWED');
  });

  it('refuses a body-less cross-site POST, which needs no CORS preflight', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { origin: 'https://evil.example' },
    });
    expectError(response, 403, 'ORIGIN_NOT_ALLOWED');
    expect(harness.ptyFactory.spawned).toHaveLength(0);
  });

  it('does not trust the Host header: a rebinding page matches it by construction', async () => {
    const rebinding = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { origin: 'http://evil.example:3000', host: 'evil.example:3000' },
    });
    expectError(rebinding, 403, 'ORIGIN_NOT_ALLOWED');
  });

  it('accepts origin-less requests from non-browser clients', async () => {
    expect((await create()).statusCode).toBe(201);
  });
});
