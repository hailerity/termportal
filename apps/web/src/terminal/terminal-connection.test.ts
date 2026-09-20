import { describe, expect, it, vi } from 'vitest';
import {
  TerminalConnection,
  chunkInput,
  terminalSocketUrl,
  type CloseInfo,
  type ConnectionState,
} from './terminal-connection';

describe('terminalSocketUrl', () => {
  it.each([
    ['http://localhost:4200', 'ws://localhost:4200/api/v1/sessions/term_abcdefgh/terminal'],
    ['https://host.example/', 'wss://host.example/api/v1/sessions/term_abcdefgh/terminal'],
    [
      'https://host.example/proxy/',
      'wss://host.example/proxy/api/v1/sessions/term_abcdefgh/terminal',
    ],
  ])('maps %s', (base, expected) => {
    expect(terminalSocketUrl('term_abcdefgh', base)).toBe(expected);
  });
});

describe('chunkInput', () => {
  it('keeps short input whole and splits long input', () => {
    expect(chunkInput('ls\r')).toEqual(['ls\r']);
    expect(chunkInput('abcdefg', 3)).toEqual(['abc', 'def', 'g']);
    expect(chunkInput('')).toEqual([]);
  });

  it('never cuts a surrogate pair in half', () => {
    const chunks = chunkInput('ab😀cd', 3);
    expect(chunks).toEqual(['ab', '😀c', 'd']);
    expect(chunks.join('')).toBe('ab😀cd');
  });
});

class FakeSocket {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

function setup() {
  const socket = new FakeSocket();
  const states: Array<[ConnectionState, CloseInfo | undefined]> = [];
  const onMessage = vi.fn();
  let url = '';
  const connection = new TerminalConnection({
    sessionId: 'term_abcdefgh',
    baseUrl: 'http://server.test',
    onMessage,
    onStateChange: (state, close) => states.push([state, close]),
    createSocket: (u) => {
      url = u;
      return socket as unknown as WebSocket;
    },
  });
  return { socket, states, onMessage, connection, url: () => url };
}

describe('TerminalConnection', () => {
  it('connects to the session endpoint and reports its state', () => {
    const { socket, states, url } = setup();
    expect(url()).toBe('ws://server.test/api/v1/sessions/term_abcdefgh/terminal');
    socket.open();
    expect(states.map(([state]) => state)).toEqual(['connecting', 'open']);
  });

  it('sends protocol messages only while open', () => {
    const { socket, connection } = setup();
    connection.sendInput('early');
    socket.open();
    connection.sendInput('ls\r');
    connection.sendResize(100, 30);
    expect(socket.sent.map((s) => JSON.parse(s))).toEqual([
      { type: 'input', data: 'ls\r' },
      { type: 'resize', cols: 100, rows: 30 },
    ]);
  });

  it('delivers valid messages and ignores unknown or malformed ones', () => {
    const { socket, onMessage } = setup();
    socket.open();
    socket.onmessage?.({ data: JSON.stringify({ type: 'output', data: 'hi' }) });
    socket.onmessage?.({ data: JSON.stringify({ type: 'future-message' }) });
    socket.onmessage?.({ data: 'not json' });
    socket.onmessage?.({ data: new ArrayBuffer(1) });
    expect(onMessage.mock.calls).toEqual([[{ type: 'output', data: 'hi' }]]);
  });

  it('distinguishes a final close from a lost connection', () => {
    for (const [code, final] of [
      [1000, true],
      [4404, true],
      [1006, false],
      [1001, false],
    ] as const) {
      const { socket, states } = setup();
      socket.open();
      socket.onclose?.({ code });
      expect(states.at(-1)).toEqual(['closed', { code, final }]);
    }
  });

  it('goes silent after close()', () => {
    const { socket, states, onMessage, connection } = setup();
    socket.open();
    connection.close();
    socket.onmessage?.({ data: JSON.stringify({ type: 'output', data: 'late' }) });
    socket.onclose?.({ code: 1005 });
    expect(socket.closed).toBe(true);
    expect(onMessage).not.toHaveBeenCalled();
    expect(states.map(([state]) => state)).toEqual(['connecting', 'open']);
  });
});
