import { pino } from 'pino';
import { loadConfig } from './config/config.js';
import { startServer } from './runtime.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.logLevel });
  const server = await startServer({ config, logger });

  let signals = 0;
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'signal received');
    // A second signal means "stop waiting". PTYs still get SIGHUP when their master fds close.
    if (++signals > 1) process.exit(1);
    server.stop().then(
      (survivors) => process.exit(survivors.length > 0 ? 1 : 0),
      (err: unknown) => {
        logger.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
