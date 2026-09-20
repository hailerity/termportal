import { SessionManager } from '@termportal/terminal-core';
import {
  NodePtyFactory,
  defaultShellName,
  isDirectory,
  resolveShellMap,
} from '@termportal/terminal-pty';
import { pino } from 'pino';
import { buildApp } from './app.js';
import { loadConfig } from './config/config.js';
import { logSessionEvent } from './observability/session-logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.logLevel });

  const shells = resolveShellMap();
  const defaultShell = config.defaultShell ?? defaultShellName(shells);
  if (!shells[defaultShell]) throw new Error(`DEFAULT_SHELL "${defaultShell}" is not installed.`);
  if (!(await isDirectory(config.defaultCwd))) {
    throw new Error(`DEFAULT_CWD "${config.defaultCwd}" is not a directory.`);
  }

  const sessions = new SessionManager({
    ptyFactory: new NodePtyFactory(),
    shells: shells as Record<string, string>,
    defaultShell,
    defaultCwd: config.defaultCwd,
    defaultCols: config.defaultCols,
    defaultRows: config.defaultRows,
    maxSessions: config.maxSessions,
    exitedSessionTtlMs: config.exitedSessionTtlMs,
    isDirectory,
    baseEnv: process.env,
    onEvent: (event) => logSessionEvent(logger, event),
  });

  let shuttingDown = false;
  const app = await buildApp({
    sessions,
    allowedOrigins: config.allowedOrigins,
    logger,
    isReady: () => !shuttingDown,
  });

  // Stop accepting connections, then terminate every PTY so no shell is orphaned (design §20).
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'server stopping');
    const closed = app.close().catch((err: unknown) => logger.error({ err }, 'http close failed'));
    const survivors = await sessions.shutdown(config.shutdownTimeoutMs);
    if (survivors.length > 0) logger.error({ survivors }, 'sessions survived shutdown');
    await closed;
    logger.info('server stopped');
    process.exit(survivors.length > 0 ? 1 : 0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  logger.info({ shells: Object.keys(shells), defaultShell }, 'server started');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
