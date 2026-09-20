import type { ClientMessage, ServerMessage } from './messages.js';
import { clientMessageSchema, serverMessageSchema } from './schemas.js';

export type DecodeResult<T> = { ok: true; message: T } | { ok: false; reason: string };

function decode<T>(
  raw: string,
  schema: { safeParse(v: unknown): { success: boolean; data?: T } },
): DecodeResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'Message is not valid JSON.' };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: 'Message does not match the protocol schema.' };
  return { ok: true, message: parsed.data as T };
}

/** Parses and validates one text frame sent by a browser client. */
export function decodeClientMessage(raw: string): DecodeResult<ClientMessage> {
  return decode<ClientMessage>(raw, clientMessageSchema);
}

/** Parses and validates one text frame sent by the server. */
export function decodeServerMessage(raw: string): DecodeResult<ServerMessage> {
  return decode<ServerMessage>(raw, serverMessageSchema);
}

export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message);
}

export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}
