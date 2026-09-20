import { pino } from 'pino';
import { loadConfig } from './config/config.js';
import { startServer } from './runtime.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.logLevel });
  const server = await startServer({ config, logger });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'signal received');
    void server.stop().then((survivors) => process.exit(survivors.length > 0 ? 1 : 0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
