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
import type { ServerConfig } from './config/config.js';
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

/** Composition root: wires configuration, the real PTY runtime, REST and WebSocket together. */
export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const { config, logger } = options;

  const shells = resolveShellMap();
  const defaultShell = config.defaultShell ?? defaultShellName(shells);
  if (!shells[defaultShell]) throw new Error(`DEFAULT_SHELL "${defaultShell}" is not installed.`);
  if (!(await isDirectory(config.defaultCwd))) {
    throw new Error(`DEFAULT_CWD "${config.defaultCwd}" is not a directory.`);
  }

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
    baseEnv: process.env,
    ...(logger ? { onEvent: (event) => logSessionEvent(logger, event) } : {}),
  });

  let stopping: Promise<string[]> | undefined;
  const app = await buildApp({
    sessions,
    allowedOrigins: config.allowedOrigins,
    ...(logger ? { logger } : {}),
    isReady: () => stopping === undefined,
  });
  const gateway = createTerminalGateway({
    server: app.server,
    sessions,
    allowedOrigins: config.allowedOrigins,
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
