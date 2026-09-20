import type { ApiErrorResponse, ErrorCode } from '@termportal/api-contract';
import { isTerminalError } from '@termportal/terminal-core';
import type { ZodError } from 'zod';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  SESSION_NOT_FOUND: 404,
  NOT_FOUND: 404,
  SESSION_ALREADY_EXITED: 409,
  SESSION_LIMIT_REACHED: 429,
  INVALID_SESSION_ID: 400,
  INVALID_REQUEST: 400,
  INVALID_SHELL: 400,
  INVALID_CWD: 400,
  INVALID_DIMENSIONS: 400,
  INVALID_ENV: 400,
  INVALID_MESSAGE: 400,
  ORIGIN_NOT_ALLOWED: 403,
  PTY_SPAWN_FAILED: 500,
  SESSION_TERMINATION_FAILED: 500,
  INTERNAL_ERROR: 500,
};

/** An error that is safe to describe to API clients. */
export class HttpError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = STATUS_BY_CODE[code];
  }
}

const CODE_BY_FIELD: Record<string, ErrorCode> = {
  shell: 'INVALID_SHELL',
  cwd: 'INVALID_CWD',
  cols: 'INVALID_DIMENSIONS',
  rows: 'INVALID_DIMENSIONS',
  env: 'INVALID_ENV',
};

const MESSAGE_BY_CODE: Partial<Record<ErrorCode, string>> = {
  INVALID_SHELL: 'Unsupported shell.',
  INVALID_CWD: 'Working directory is invalid.',
  INVALID_DIMENSIONS: 'Terminal dimensions are invalid.',
  INVALID_ENV: 'Environment variables are invalid.',
  INVALID_REQUEST: 'Request body is invalid.',
};

/** Maps a body validation failure to the most specific documented error code. */
export function httpErrorFromZod(error: ZodError): HttpError {
  const field = error.issues[0]?.path[0];
  const code = (typeof field === 'string' && CODE_BY_FIELD[field]) || 'INVALID_REQUEST';
  return new HttpError(code, MESSAGE_BY_CODE[code] ?? 'Request is invalid.');
}

export interface MappedError {
  statusCode: number;
  body: ApiErrorResponse;
  /** True when the cause is a server fault that deserves an error-level log entry. */
  unexpected: boolean;
}

/**
 * Converts anything thrown while handling a request into the public error shape. Only messages
 * written for clients are passed through; unknown errors become a generic 500 so stack traces
 * and filesystem details never leak (design §18).
 */
export function mapError(error: unknown, requestId: string): MappedError {
  const build = (code: ErrorCode, message: string, statusCode = STATUS_BY_CODE[code]) => ({
    statusCode,
    body: { error: { code, message, requestId } },
    unexpected: statusCode >= 500,
  });

  if (error instanceof HttpError) return build(error.code, error.message);
  if (isTerminalError(error)) return build(error.code, error.message);

  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    // Fastify's own client errors: malformed JSON, payload too large, unsupported media type…
    const message =
      statusCode === 413
        ? 'Request body is too large.'
        : statusCode === 415
          ? 'Unsupported media type.'
          : 'Request is invalid.';
    return build('INVALID_REQUEST', message, statusCode);
  }
  return build('INTERNAL_ERROR', 'Internal server error.');
}
