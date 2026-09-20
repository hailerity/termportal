import { z } from 'zod';

/** Prefix of every terminal session ID. */
export const SESSION_ID_PREFIX = 'term_';

/** `term_` followed by a URL-safe token; validated before any lookup. */
export const sessionIdSchema = z
  .string()
  .regex(/^term_[A-Za-z0-9_-]{8,64}$/, 'Invalid session id.')
  .brand<'SessionId'>();
export type SessionId = z.infer<typeof sessionIdSchema>;

export const terminalSessionStatusSchema = z.enum([
  'starting',
  'running',
  'exited',
  'terminating',
  'failed',
]);
export type TerminalSessionStatus = z.infer<typeof terminalSessionStatusSchema>;

/** Named shells only: the API never accepts an executable path (design §16). */
export const shellTypeSchema = z.enum(['bash', 'zsh', 'sh']);
export type ShellType = z.infer<typeof shellTypeSchema>;

export const TERMINAL_DIMENSION_LIMITS = {
  minCols: 2,
  maxCols: 1000,
  minRows: 1,
  maxRows: 500,
} as const;

export const colsSchema = z
  .number()
  .int()
  .min(TERMINAL_DIMENSION_LIMITS.minCols)
  .max(TERMINAL_DIMENSION_LIMITS.maxCols);
export const rowsSchema = z
  .number()
  .int()
  .min(TERMINAL_DIMENSION_LIMITS.minRows)
  .max(TERMINAL_DIMENSION_LIMITS.maxRows);

const envNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Invalid variable name.');

export const createSessionRequestSchema = z.strictObject({
  shell: shellTypeSchema.optional(),
  cwd: z.string().min(1).max(4096).optional(),
  cols: colsSchema.optional(),
  rows: rowsSchema.optional(),
  env: z.record(envNameSchema, z.string().max(32768)).optional(),
});
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const terminalSessionResponseSchema = z.object({
  id: z.string(),
  status: terminalSessionStatusSchema,
  shell: z.string(),
  cwd: z.string(),
  pid: z.number().int().optional(),
  cols: z.number().int(),
  rows: z.number().int(),
  createdAt: z.iso.datetime(),
  lastActivityAt: z.iso.datetime(),
  exitCode: z.number().int().optional(),
  exitSignal: z.number().int().optional(),
});
export type TerminalSessionResponse = z.infer<typeof terminalSessionResponseSchema>;

export const listSessionsResponseSchema = z.object({
  sessions: z.array(terminalSessionResponseSchema),
});
export type ListSessionsResponse = z.infer<typeof listSessionsResponseSchema>;
