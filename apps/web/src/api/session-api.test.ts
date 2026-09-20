import { describe, expect, it, vi } from 'vitest';
import { ApiError, createSessionApi } from './session-api';

const session = {
  id: 'term_abcdefgh',
  status: 'running',
  shell: '/bin/bash',
  cwd: '/tmp',
  pid: 1,
  cols: 120,
  rows: 40,
  createdAt: '2026-09-20T15:00:00.000Z',
  lastActivityAt: '2026-09-20T15:00:00.000Z',
};

function respond(status: number, body?: unknown) {
  return vi.fn(async () =>
    status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
  );
}

describe('createSessionApi', () => {
  it('creates a session with a JSON body', async () => {
    const fetchFn = respond(201, session);
    const api = createSessionApi('http://server.test', fetchFn as unknown as typeof fetch);
    expect(await api.create({ shell: 'bash' })).toEqual(session);
    expect(fetchFn).toHaveBeenCalledWith('http://server.test/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"shell":"bash"}',
    });
  });

  it('lists, gets and terminates', async () => {
    const list = createSessionApi(
      '',
      respond(200, { sessions: [session] }) as unknown as typeof fetch,
    );
    expect(await list.list()).toEqual([session]);
    const get = createSessionApi('', respond(200, session) as unknown as typeof fetch);
    expect(await get.get(session.id)).toEqual(session);
    const fetchFn = respond(204);
    await createSessionApi('', fetchFn as unknown as typeof fetch).terminate(session.id);
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/sessions/term_abcdefgh', { method: 'DELETE' });
  });

  it('surfaces the server error code and message', async () => {
    const api = createSessionApi(
      '',
      respond(429, {
        error: {
          code: 'SESSION_LIMIT_REACHED',
          message: 'The maximum number of sessions is reached.',
        },
      }) as unknown as typeof fetch,
    );
    await expect(api.create()).rejects.toMatchObject({
      name: 'ApiError',
      status: 429,
      code: 'SESSION_LIMIT_REACHED',
      message: 'The maximum number of sessions is reached.',
    });
  });

  it('reports network failures and unexpected payloads', async () => {
    const offline = createSessionApi('', (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    await expect(offline.list()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });

    const garbage = createSessionApi('', respond(200, { nope: true }) as unknown as typeof fetch);
    await expect(garbage.list()).rejects.toBeInstanceOf(ApiError);
    const htmlError = createSessionApi('', respond(502, 'Bad gateway') as unknown as typeof fetch);
    await expect(htmlError.list()).rejects.toMatchObject({
      status: 502,
      code: 'UNEXPECTED_RESPONSE',
    });
  });
});
