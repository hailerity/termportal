import { describe, expect, it } from 'vitest';
import {
  MAX_INPUT_LENGTH,
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  encodeServerMessage,
  terminalSocketPath,
  type ClientMessage,
  type ServerMessage,
} from './index.js';

describe('client messages', () => {
  const valid: ClientMessage[] = [
    { type: 'input', data: 'ls -la\r' },
    { type: 'resize', cols: 160, rows: 50 },
    { type: 'ping' },
  ];

  it.each(valid)('round-trips $type', (message) => {
    expect(decodeClientMessage(encodeClientMessage(message))).toEqual({ ok: true, message });
  });

  it.each([
    ['not json', 'ls -la'],
    ['a JSON scalar', '42'],
    ['null', 'null'],
    ['an unknown type', JSON.stringify({ type: 'exec', command: 'id' })],
    ['a missing type', JSON.stringify({ data: 'x' })],
    ['non-string input', JSON.stringify({ type: 'input', data: 1 })],
    ['empty input', JSON.stringify({ type: 'input', data: '' })],
    ['oversized input', JSON.stringify({ type: 'input', data: 'x'.repeat(MAX_INPUT_LENGTH + 1) })],
    ['zero cols', JSON.stringify({ type: 'resize', cols: 0, rows: 10 })],
    ['fractional rows', JSON.stringify({ type: 'resize', cols: 80, rows: 10.5 })],
    ['missing rows', JSON.stringify({ type: 'resize', cols: 80 })],
    ['extra fields', JSON.stringify({ type: 'ping', extra: true })],
    ['a server-only message', JSON.stringify({ type: 'output', data: 'x' })],
  ])('rejects %s', (_name, raw) => {
    const result = decodeClientMessage(raw);
    expect(result.ok).toBe(false);
  });

  it('does not echo the payload in the rejection reason', () => {
    const result = decodeClientMessage(
      JSON.stringify({ type: 'input', data: 5, secret: 'hunter2' }),
    );
    expect(result).toEqual({ ok: false, reason: expect.not.stringContaining('hunter2') });
  });
});

describe('server messages', () => {
  const valid: ServerMessage[] = [
    { type: 'output', data: '\u001b[32mhello\u001b[0m\r\n' },
    { type: 'status', status: 'running' },
    { type: 'exit', exitCode: 0 },
    { type: 'exit', exitCode: 1, signal: 15 },
    { type: 'error', code: 'SESSION_NOT_FOUND', message: 'Terminal session was not found.' },
    { type: 'pong' },
  ];

  it.each(valid)('round-trips $type', (message) => {
    expect(decodeServerMessage(encodeServerMessage(message))).toEqual({ ok: true, message });
  });

  it('rejects unknown statuses and error codes', () => {
    expect(decodeServerMessage(JSON.stringify({ type: 'status', status: 'paused' })).ok).toBe(
      false,
    );
    expect(
      decodeServerMessage(JSON.stringify({ type: 'error', code: 'NOPE', message: 'x' })).ok,
    ).toBe(false);
  });
});

describe('terminalSocketPath', () => {
  it('builds the versioned endpoint path', () => {
    expect(terminalSocketPath('term_abcdefgh')).toBe('/api/v1/sessions/term_abcdefgh/terminal');
  });
});
