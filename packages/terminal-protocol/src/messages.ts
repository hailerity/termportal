import type { z } from 'zod';
import type { clientMessageSchema, serverMessageSchema } from './schemas.js';

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export type ClientMessageType = ClientMessage['type'];
export type ServerMessageType = ServerMessage['type'];
