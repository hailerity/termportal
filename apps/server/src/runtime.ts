import type { AddressInfo } from 'node:net';
import { SessionManager, type PtyFactory } from '@termportal/terminal-core';
import {
  NodePtyFactory,
  defaultShellName,
  isDirectory,
  resolveShellMap,
} from '@termportal/terminal-pty';
import type { FastifyBaseLogger } from 'fastify';
import { buildApp } from './app.js';
import { CONFIG_VARIABLES, type ServerConfig } from './config/config.js';
import { Metrics } from './observability/metrics.js';
import { logSessionEvent } from './observability/session-logger.js';
import { createTerminalGateway } from './websocket/terminal-gateway.js';

const TRANSPORT_CLOSE_TIMEOUT_MS = 5000;

export interface RunningServer {
  readonly port: number;
  readonly sessions: SessionManager;
  /**
   * Stops accepting HTTP/WS traffic, terminates every PTY and waits for cleanup (design §20).
   * Resolves with the ids of sessions that could not be killed; idempotent.
   */
  stop(): Promise<string[]>;
}

export interface StartServerOptions {
  config: ServerConfig;
  logger?: FastifyBaseLogger;
  ptyFactory?: PtyFactory;
}

/**
 * The slow-client limit has to leave room for the replay, which is queued as a single frame on
 * attach — otherwise a freshly attached client would be dropped on the next output, and again
 * on every reconnect. JSON escapes control characters, so a frame can be up to six times the
 * size of the raw output.
 */
export function maxBufferedBytesFor(outputBufferBytes: number): number {
  const MIN = 16 * 1024 * 1024;
  return Math.max(MIN, outputBufferBytes * 6 + MIN / 2);
}

/**
 * The server's environment minus its own configuration. A shell that inherited `PORT=3000`
 * would, for example, make every dev server started inside the terminal fight for that port.
 */
export function shellBaseEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const base = { ...env };
  for (const name of CONFIG_VARIABLES) delete base[name];
  return base;
}

/** Composition root: wires configuration, the real PTY runtime, REST and WebSocket together. */
export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const { config, logger } = options;

  const shells = resolveShellMap();
  const defaultShell = config.defaultShell ?? defaultShellName(shells);
  if (!shells[defaultShell]) throw new Error(`DEFAULT_SHELL "${defaultShell}" is not installed.`);
  if (!(await isDirectory(config.defaultCwd))) {
    throw new Error(`DEFAULT_CWD "${config.defaultCwd}" is not a directory.`);
  }

  const metrics = new Metrics();
  const sessions = new SessionManager({
    ptyFactory: options.ptyFactory ?? new NodePtyFactory(),
    shells: shells as Record<string, string>,
    defaultShell,
    defaultCwd: config.defaultCwd,
    defaultCols: config.defaultCols,
    defaultRows: config.defaultRows,
    maxSessions: config.maxSessions,
    exitedSessionTtlMs: config.exitedSessionTtlMs,
    outputBufferBytes: config.outputBufferBytes,
    isDirectory,
    maxClientsPerSession: config.maxClientsPerSession,
    baseEnv: shellBaseEnvironment(process.env),
    onEvent: (event) => {
      metrics.onSessionEvent(event);
      if (logger) logSessionEvent(logger, event);
    },
  });

  let stopping: Promise<string[]> | undefined;
  const app = await buildApp({
    sessions,
    allowedOrigins: config.allowedOrigins,
    ...(logger ? { logger } : {}),
    isReady: () => stopping === undefined,
    metrics,
  });
  const gateway = createTerminalGateway({
    server: app.server,
    sessions,
    allowedOrigins: config.allowedOrigins,
    maxBufferedBytes: maxBufferedBytesFor(config.outputBufferBytes),
    metrics,
    ...(logger ? { logger } : {}),
  });

  await app.listen({ host: config.host, port: config.port });
  const port = (app.server.address() as AddressInfo).port;
  logger?.info(
    { host: config.host, port, shells: Object.keys(shells), defaultShell },
    'server started',
  );

  const stop = async () => {
    logger?.info('server stopping');
    // Sessions first: clients receive the final exit event before their sockets are closed.
    const survivors = await sessions.shutdown(config.shutdownTimeoutMs);
    if (survivors.length > 0) logger?.error({ survivors }, 'sessions survived shutdown');
    // Sockets that refuse to close must not keep the process alive past the deadline.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), TRANSPORT_CLOSE_TIMEOUT_MS);
    });
    const closed = gateway.close().then(() => app.close());
    if ((await Promise.race([closed, deadline])) === 'timeout') {
      logger?.warn({}, 'transport did not close in time');
    }
    clearTimeout(timer);
    logger?.info('server stopped');
    return survivors;
  };

  return {
    port,
    sessions,
    stop: () => (stopping ??= stop()),
  };
}
