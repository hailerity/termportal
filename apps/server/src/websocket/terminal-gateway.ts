import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { API_BASE_PATH, sessionIdSchema, type ErrorCode } from '@termportal/api-contract';
import {
  isTerminalError,
  type SessionManager,
  type TerminalAttachment,
  type TerminalClientEvent,
} from '@termportal/terminal-core';
import {
  MAX_CLIENT_FRAME_BYTES,
  decodeClientMessage,
  encodeServerMessage,
  type ServerMessage,
} from '@termportal/terminal-protocol';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { isOriginAllowed } from '../http/origin.js';
import type { Metrics } from '../observability/metrics.js';

interface Logger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

export interface TerminalGatewayOptions {
  server: Server;
  sessions: SessionManager;
  /** Browser origins allowed to open terminal sockets, besides the server's own origin. */
  allowedOrigins: string[];
  logger?: Logger;
  metrics?: Pick<Metrics, 'websocketOpened' | 'websocketClosed' | 'protocolError'>;
  heartbeatIntervalMs?: number;
  /** A client that lets this many bytes queue up is disconnected instead of buffered forever. */
  maxBufferedBytes?: number;
  /** Consecutive invalid messages tolerated before the connection is closed. */
  maxProtocolErrors?: number;
  /** How long `close()` waits for close handshakes before destroying the remaining sockets. */
  closeGraceMs?: number;
}

/** Application close codes (4000-4999 are reserved for applications by RFC 6455). */
export const CLOSE_CODES = {
  normal: 1000,
  goingAway: 1001,
  policyViolation: 1008,
  tryAgainLater: 1013,
  invalidSessionId: 4400,
  sessionNotFound: 4404,
  sessionExited: 4409,
  clientLimitReached: 4429,
} as const;

const TERMINAL_PATH = new RegExp(`^${API_BASE_PATH}/sessions/([^/]+)/terminal$`);
const noopLogger: Logger = { info: () => {}, warn: () => {} };

export interface TerminalGateway {
  /** Number of open terminal sockets. */
  readonly connections: number;
  close(): Promise<void>;
}

/**
 * WebSocket data plane: `WS /api/v1/sessions/:id/terminal`. Owns no terminal state — it only
 * translates between protocol messages and a `TerminalAttachment`.
 */
export function createTerminalGateway(options: TerminalGatewayOptions): TerminalGateway {
  const { server, sessions } = options;
  const logger = options.logger ?? noopLogger;
  const maxBufferedBytes = options.maxBufferedBytes ?? 16 * 1024 * 1024;
  const maxProtocolErrors = options.maxProtocolErrors ?? 20;
  const alive = new WeakSet<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_FRAME_BYTES });

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (request.url ?? '').split('?')[0] ?? '';
    const match = TERMINAL_PATH.exec(path);
    if (!match) return refuse(socket, 404, 'Not Found');
    const { origin } = request.headers;
    if (!isOriginAllowed(origin, options.allowedOrigins)) {
      logger.warn({ origin }, 'websocket origin rejected');
      return refuse(socket, 403, 'Forbidden');
    }
    let rawId: string;
    try {
      rawId = decodeURIComponent(match[1] ?? '');
    } catch {
      rawId = '';
    }
    wss.handleUpgrade(request, socket, head, (ws) => handleConnection(ws, rawId));
  };
  server.on('upgrade', onUpgrade);

  function handleConnection(ws: WebSocket, rawId: string): void {
    // Registered before anything else: ws keeps parsing frames while a rejected socket closes,
    // and an 'error' event without a listener (oversized or malformed frame) would crash the
    // process along with every session.
    ws.on('error', (error) => {
      logger.warn({ sessionId: rawId.slice(0, 80), err: error.message }, 'websocket error');
    });

    const send = (message: ServerMessage) => ws.send(encodeServerMessage(message));
    const reject = (code: ErrorCode, message: string, closeCode: number) => {
      send({ type: 'error', code, message });
      ws.close(closeCode, code);
    };

    // The upgrade is always completed so that browsers can read why a session is unavailable;
    // a failed HTTP upgrade is opaque to the WebSocket API.
    const id = sessionIdSchema.safeParse(rawId);
    if (!id.success) {
      return reject('INVALID_SESSION_ID', 'Session id is invalid.', CLOSE_CODES.invalidSessionId);
    }
    const sessionId = id.data;

    let attachment: TerminalAttachment;
    try {
      attachment = sessions.attach(sessionId, {
        send(event: TerminalClientEvent) {
          if (ws.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not open.');
          if (ws.bufferedAmount > maxBufferedBytes) {
            logger.warn({ sessionId }, 'websocket client too slow; disconnecting');
            ws.close(CLOSE_CODES.tryAgainLater, 'Client is too slow.');
            throw new Error('WebSocket client is too slow.');
          }
          send(event);
          if (event.type === 'exit') ws.close(CLOSE_CODES.normal, 'Session exited.');
        },
      });
    } catch (error) {
      if (isTerminalError(error) && error.code === 'SESSION_NOT_FOUND') {
        return reject(error.code, error.message, CLOSE_CODES.sessionNotFound);
      }
      if (isTerminalError(error) && error.code === 'SESSION_ALREADY_EXITED') {
        return reject(error.code, error.message, CLOSE_CODES.sessionExited);
      }
      if (isTerminalError(error) && error.code === 'CLIENT_LIMIT_REACHED') {
        return reject(error.code, error.message, CLOSE_CODES.clientLimitReached);
      }
      logger.warn({ sessionId, err: error }, 'websocket attach failed');
      return ws.close(1011, 'Attach failed.');
    }

    logger.info({ sessionId }, 'websocket connected');
    options.metrics?.websocketOpened();
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));

    let protocolErrors = 0;
    const protocolError = (code: ErrorCode, message: string) => {
      // Never log the payload: terminal input may contain secrets.
      logger.warn({ sessionId, code }, 'websocket protocol error');
      options.metrics?.protocolError();
      send({ type: 'error', code, message });
      if (++protocolErrors >= maxProtocolErrors) {
        ws.close(CLOSE_CODES.policyViolation, 'Too many invalid messages.');
      }
    };

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return protocolError('INVALID_MESSAGE', 'Binary frames are not supported.');
      const decoded = decodeClientMessage(data.toString());
      if (!decoded.ok) return protocolError('INVALID_MESSAGE', decoded.reason);
      protocolErrors = 0;
      const message = decoded.message;
      try {
        if (message.type === 'input') attachment.write(message.data);
        else if (message.type === 'resize') attachment.resize(message.cols, message.rows);
        else send({ type: 'pong' });
      } catch (error) {
        if (isTerminalError(error)) {
          return send({ type: 'error', code: error.code, message: error.message });
        }
        // E.g. the PTY runtime throwing on a process that is just going away. One client's
        // keystroke must never take the server down.
        logger.warn({ sessionId, err: error }, 'websocket message handling failed');
        send({ type: 'error', code: 'INTERNAL_ERROR', message: 'Internal server error.' });
      }
    });

    ws.on('close', (code) => {
      // Detaching never terminates the session (design §12).
      attachment.detach();
      options.metrics?.websocketClosed();
      logger.info({ sessionId, code }, 'websocket disconnected');
    });
  }

  // Drop connections whose peer vanished without closing, e.g. a laptop that went to sleep.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, options.heartbeatIntervalMs ?? 30_000);
  heartbeat.unref();

  return {
    get connections() {
      return wss.clients.size;
    },
    close() {
      clearInterval(heartbeat);
      server.off('upgrade', onUpgrade);
      for (const ws of wss.clients) ws.close(CLOSE_CODES.goingAway, 'Server is shutting down.');
      // A vanished peer never answers the close handshake; do not let it stall shutdown.
      const force = setTimeout(() => {
        for (const ws of wss.clients) ws.terminate();
      }, options.closeGraceMs ?? 1000);
      return new Promise((resolve) =>
        wss.close(() => {
          clearTimeout(force);
          resolve();
        }),
      );
    },
  };
}

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
