import { z } from 'zod';

/** Stable machine-readable error codes shared by the REST and WebSocket APIs. */
export const ERROR_CODES = [
  'SESSION_NOT_FOUND',
  'SESSION_ALREADY_EXITED',
  'SESSION_LIMIT_REACHED',
  'INVALID_SESSION_ID',
  'INVALID_REQUEST',
  'INVALID_SHELL',
  'INVALID_CWD',
  'INVALID_DIMENSIONS',
  'INVALID_ENV',
  'INVALID_MESSAGE',
  'PTY_SPAWN_FAILED',
  'SESSION_TERMINATION_FAILED',
  'NOT_FOUND',
  'INTERNAL_ERROR',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    requestId: z.string().optional(),
  }),
});
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
