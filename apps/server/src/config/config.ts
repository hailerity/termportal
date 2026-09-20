import { z } from 'zod';

const integer = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const list = z.string().transform((value) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
);

const envSchema = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: integer(0, 65535).default(3000),
  DEFAULT_SHELL: z.enum(['bash', 'zsh', 'sh']).optional(),
  DEFAULT_CWD: z.string().min(1).default('/tmp'),
  DEFAULT_COLS: integer(2, 1000).default(120),
  DEFAULT_ROWS: integer(1, 500).default(40),
  OUTPUT_BUFFER_BYTES: integer(0, 16 * 1024 * 1024).default(5 * 1024 * 1024),
  SHUTDOWN_TIMEOUT_MS: integer(0, 600_000).default(10_000),
  MAX_SESSIONS: integer(1, 10_000).default(100),
  EXITED_SESSION_TTL_MS: integer(0, 86_400_000).default(5 * 60 * 1000),
  /** Browser origins allowed to call the API and open terminal WebSockets. */
  ALLOWED_ORIGINS: list.default(['http://localhost:4200', 'http://127.0.0.1:4200']),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface ServerConfig {
  host: string;
  port: number;
  defaultShell: 'bash' | 'zsh' | 'sh' | undefined;
  defaultCwd: string;
  defaultCols: number;
  defaultRows: number;
  outputBufferBytes: number;
  shutdownTimeoutMs: number;
  maxSessions: number;
  exitedSessionTtlMs: number;
  allowedOrigins: string[];
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
}

/** Reads the configuration from environment variables (design §24). Throws on invalid values. */
export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const parsed = envSchema.safeParse(
    Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')),
  );
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration — ${details}`);
  }
  const e = parsed.data;
  return {
    host: e.HOST,
    port: e.PORT,
    defaultShell: e.DEFAULT_SHELL,
    defaultCwd: e.DEFAULT_CWD,
    defaultCols: e.DEFAULT_COLS,
    defaultRows: e.DEFAULT_ROWS,
    outputBufferBytes: e.OUTPUT_BUFFER_BYTES,
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
    maxSessions: e.MAX_SESSIONS,
    exitedSessionTtlMs: e.EXITED_SESSION_TTL_MS,
    allowedOrigins: e.ALLOWED_ORIGINS,
    logLevel: e.LOG_LEVEL,
  };
}
