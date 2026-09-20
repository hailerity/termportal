import { API_BASE_PATH } from '@termportal/api-contract';

export * from './codec.js';
export * from './messages.js';
export * from './schemas.js';

/**
 * Protocol versioning: the WebSocket protocol is versioned together with the HTTP API through
 * the `/api/v1` path prefix. Within a version, changes are additive only — new message types or
 * new optional fields. Clients must ignore server message types they do not know; the server
 * rejects unknown client messages with `INVALID_MESSAGE`. Anything breaking ships under `/api/v2`.
 */
export const PROTOCOL_VERSION = 1;

/** Path of the terminal WebSocket endpoint for a session. */
export function terminalSocketPath(sessionId: string): string {
  return `${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/terminal`;
}
