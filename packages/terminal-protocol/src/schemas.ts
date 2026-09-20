import {
  colsSchema,
  errorCodeSchema,
  rowsSchema,
  terminalSessionStatusSchema,
} from '@termportal/api-contract';
import { z } from 'zod';

/** Upper bound for one `input` payload, in UTF-16 code units. Large pastes are chunked by clients. */
export const MAX_INPUT_LENGTH = 64 * 1024;

/** Upper bound for a whole client frame; the WebSocket server enforces it as `maxPayload`. */
export const MAX_CLIENT_FRAME_BYTES = 256 * 1024;

export const inputMessageSchema = z.strictObject({
  type: z.literal('input'),
  data: z.string().min(1).max(MAX_INPUT_LENGTH),
});

export const resizeMessageSchema = z.strictObject({
  type: z.literal('resize'),
  cols: colsSchema,
  rows: rowsSchema,
});

export const pingMessageSchema = z.strictObject({ type: z.literal('ping') });

export const clientMessageSchema = z.discriminatedUnion('type', [
  inputMessageSchema,
  resizeMessageSchema,
  pingMessageSchema,
]);

export const outputMessageSchema = z.strictObject({
  type: z.literal('output'),
  data: z.string(),
});

export const statusMessageSchema = z.strictObject({
  type: z.literal('status'),
  status: terminalSessionStatusSchema,
});

export const exitMessageSchema = z.strictObject({
  type: z.literal('exit'),
  exitCode: z.number().int(),
  signal: z.number().int().optional(),
});

export const errorMessageSchema = z.strictObject({
  type: z.literal('error'),
  code: errorCodeSchema,
  message: z.string(),
});

export const pongMessageSchema = z.strictObject({ type: z.literal('pong') });

export const serverMessageSchema = z.discriminatedUnion('type', [
  outputMessageSchema,
  statusMessageSchema,
  exitMessageSchema,
  errorMessageSchema,
  pongMessageSchema,
]);
