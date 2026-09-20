import { describe, expect, it } from 'vitest';
import {
  apiErrorResponseSchema,
  createSessionRequestSchema,
  listSessionsResponseSchema,
  sessionIdSchema,
  terminalSessionResponseSchema,
} from './index.js';

const session = {
  id: 'term_01HZXABCDEFGH',
  status: 'running',
  shell: '/bin/bash',
  cwd: '/tmp',
  pid: 12345,
  cols: 120,
  rows: 40,
  createdAt: '2026-09-20T15:00:00.000Z',
  lastActivityAt: '2026-09-20T15:00:00.000Z',
};

describe('sessionIdSchema', () => {
  it('accepts prefixed URL-safe ids', () => {
    expect(sessionIdSchema.safeParse('term_abcDEF123-_x').success).toBe(true);
  });

  it.each(['', 'abc', 'term_', 'term_short', 'term_../../etc/passwd', 'TERM_abcdefgh1'])(
    'rejects %j',
    (id) => {
      expect(sessionIdSchema.safeParse(id).success).toBe(false);
    },
  );
});

describe('createSessionRequestSchema', () => {
  it('accepts an empty body: every field is optional', () => {
    expect(createSessionRequestSchema.parse({})).toEqual({});
  });

  it('accepts the documented request', () => {
    const body = {
      shell: 'bash',
      cwd: '/tmp',
      cols: 120,
      rows: 40,
      env: { TERM: 'xterm-256color' },
    };
    expect(createSessionRequestSchema.parse(body)).toEqual(body);
  });

  it('rejects executable paths as shells', () => {
    expect(createSessionRequestSchema.safeParse({ shell: '/bin/bash' }).success).toBe(false);
  });

  it.each([
    { cols: 0 },
    { cols: 1.5 },
    { cols: 100000 },
    { rows: 0 },
    { rows: -1 },
    { rows: '40' },
  ])('rejects invalid dimensions %j', (body) => {
    expect(createSessionRequestSchema.safeParse(body).success).toBe(false);
  });

  it('rejects malformed environment variable names', () => {
    expect(createSessionRequestSchema.safeParse({ env: { 'A=B': 'x' } }).success).toBe(false);
    expect(createSessionRequestSchema.safeParse({ env: { FOO: 1 } }).success).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(createSessionRequestSchema.safeParse({ command: 'rm -rf /' }).success).toBe(false);
  });
});

describe('response schemas', () => {
  it('accepts a running session', () => {
    expect(terminalSessionResponseSchema.parse(session)).toEqual(session);
  });

  it('accepts an exited session with exit details', () => {
    const exited = { ...session, status: 'exited', exitCode: 0, exitSignal: 0 };
    expect(terminalSessionResponseSchema.parse(exited)).toEqual(exited);
  });

  it('rejects unknown statuses and bad timestamps', () => {
    expect(terminalSessionResponseSchema.safeParse({ ...session, status: 'paused' }).success).toBe(
      false,
    );
    expect(
      terminalSessionResponseSchema.safeParse({ ...session, createdAt: 'yesterday' }).success,
    ).toBe(false);
  });

  it('wraps lists in a sessions property', () => {
    expect(listSessionsResponseSchema.parse({ sessions: [session] }).sessions).toHaveLength(1);
    expect(listSessionsResponseSchema.safeParse([session]).success).toBe(false);
  });
});

describe('apiErrorResponseSchema', () => {
  it('accepts the documented error shape', () => {
    const body = { error: { code: 'INVALID_SHELL', message: 'Unsupported shell.' } };
    expect(apiErrorResponseSchema.parse(body)).toEqual(body);
  });

  it('rejects unknown error codes', () => {
    expect(
      apiErrorResponseSchema.safeParse({ error: { code: 'WHATEVER', message: 'x' } }).success,
    ).toBe(false);
  });
});
