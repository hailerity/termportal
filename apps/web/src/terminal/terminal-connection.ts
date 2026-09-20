import {
  MAX_INPUT_LENGTH,
  decodeServerMessage,
  encodeClientMessage,
  terminalSocketPath,
  type ClientMessage,
  type ServerMessage,
} from '@termportal/terminal-protocol';

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface CloseInfo {
  code: number;
  /** True when the server ended the stream on purpose: session exited, missing, or invalid. */
  final: boolean;
}

export interface TerminalConnectionOptions {
  sessionId: string;
  /** HTTP(S) base URL of the server; defaults to the page's own origin. */
  baseUrl?: string;
  onMessage(message: ServerMessage): void;
  onStateChange(state: ConnectionState, close?: CloseInfo): void;
  createSocket?: (url: string) => WebSocket;
}

/**
 * `http://host/x` → `ws://host/x/api/v1/sessions/:id/terminal` (and https → wss). A relative
 * `baseUrl` such as `/proxy` — which the REST client accepts too — is resolved against `origin`.
 */
export function terminalSocketUrl(sessionId: string, baseUrl: string, origin?: string): string {
  const url = new URL(baseUrl, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = url.pathname.replace(/\/$/, '') + terminalSocketPath(sessionId);
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Splits input so that every frame respects the protocol limit without cutting a surrogate pair. */
export function chunkInput(data: string, maxLength = MAX_INPUT_LENGTH): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + maxLength, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff && end - start > 1) end--;
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
}

const OPEN = 1;

/** WebSocket client for one terminal session. Knows the protocol, nothing about rendering. */
export class TerminalConnection {
  private readonly socket: WebSocket;
  private closedByUser = false;

  constructor(private readonly options: TerminalConnectionOptions) {
    // An absolute base never consults the origin, which keeps this usable outside a browser.
    const origin = typeof window === 'undefined' ? undefined : window.location.origin;
    const url = terminalSocketUrl(options.sessionId, options.baseUrl || origin || '', origin);
    this.socket = (options.createSocket ?? ((u) => new WebSocket(u)))(url);
    options.onStateChange('connecting');

    this.socket.onopen = () => {
      if (!this.closedByUser) options.onStateChange('open');
    };
    this.socket.onmessage = (event: MessageEvent) => {
      if (this.closedByUser || typeof event.data !== 'string') return;
      const decoded = decodeServerMessage(event.data);
      // Unknown message types are ignored so that additive protocol changes do not break clients.
      if (decoded.ok) options.onMessage(decoded.message);
    };
    this.socket.onclose = (event: CloseEvent) => {
      if (this.closedByUser) return;
      const final = event.code === 1000 || (event.code >= 4000 && event.code < 5000);
      options.onStateChange('closed', { code: event.code, final });
    };
  }

  sendInput(data: string): void {
    for (const chunk of chunkInput(data)) this.send({ type: 'input', data: chunk });
  }

  sendResize(cols: number, rows: number): void {
    this.send({ type: 'resize', cols, rows });
  }

  /** Closes the socket without reporting further events; the session keeps running. */
  close(): void {
    this.closedByUser = true;
    this.socket.close();
  }

  private send(message: ClientMessage): void {
    if (this.socket.readyState === OPEN) this.socket.send(encodeClientMessage(message));
  }
}
