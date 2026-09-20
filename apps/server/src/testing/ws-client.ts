import {
  decodeServerMessage,
  type ClientMessage,
  type ServerMessage,
} from '@termportal/terminal-protocol';
import { WebSocket } from 'ws';

/** Test WebSocket client that records every server message and can wait for one. */
export class TestTerminalClient {
  readonly messages: ServerMessage[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private waiters: Array<() => void> = [];
  private outputText = '';

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const decoded = decodeServerMessage(data.toString());
      if (!decoded.ok) throw new Error(`Server sent an invalid message: ${data.toString()}`);
      this.messages.push(decoded.message);
      if (decoded.message.type === 'output') this.outputText += decoded.message.data;
      for (const wake of this.waiters.splice(0)) wake();
    });
    this.closed = new Promise((resolve) =>
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    );
  }

  static connect(url: string, headers: Record<string, string> = {}): Promise<TestTerminalClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      const client = new TestTerminalClient(ws);
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
    });
  }

  send(message: ClientMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  sendRaw(data: string | Buffer): void {
    this.ws.send(data);
  }

  /** All output received so far; accumulated incrementally so large streams stay cheap. */
  get output(): string {
    return this.outputText;
  }

  /** Resolves with the first recorded message matching `predicate`, waiting if necessary. */
  async waitFor<T extends ServerMessage>(
    predicate: (message: ServerMessage) => message is T,
    timeoutMs?: number,
  ): Promise<T>;
  async waitFor(
    predicate: (message: ServerMessage) => boolean,
    timeoutMs?: number,
  ): Promise<ServerMessage>;
  async waitFor(predicate: (message: ServerMessage) => boolean, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timed out. Received: ${JSON.stringify(this.messages).slice(0, 2000)}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /**
   * Waits until the output matches `pattern`. Only text that arrived since the previous check
   * (plus an overlap for matches spanning two frames) is scanned, so multi-megabyte streams do
   * not turn the wait quadratic.
   */
  waitForOutput(pattern: RegExp, timeoutMs = 5000): Promise<ServerMessage> {
    const OVERLAP = 1024;
    let scanned = 0;
    return this.waitFor(() => {
      const from = Math.max(0, scanned - OVERLAP);
      scanned = this.outputText.length;
      return pattern.test(this.outputText.slice(from));
    }, timeoutMs);
  }

  close(): Promise<{ code: number; reason: string }> {
    this.ws.close();
    return this.closed;
  }
}
