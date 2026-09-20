import {
  API_BASE_PATH,
  createSessionRequestSchema,
  sessionIdSchema,
  type ListSessionsResponse,
  type TerminalSessionResponse,
} from '@termportal/api-contract';
import type { SessionManager } from '@termportal/terminal-core';
import type { FastifyInstance } from 'fastify';
import { HttpError, httpErrorFromZod } from './errors.js';

function parseSessionId(params: unknown): string {
  const parsed = sessionIdSchema.safeParse((params as { id?: unknown }).id);
  if (!parsed.success) throw new HttpError('INVALID_SESSION_ID', 'Session id is invalid.');
  return parsed.data;
}

export function registerSessionRoutes(app: FastifyInstance, sessions: SessionManager): void {
  const base = `${API_BASE_PATH}/sessions`;

  app.post(base, async (request, reply): Promise<TerminalSessionResponse> => {
    // Only a missing body means "all defaults"; an explicit `null` is an invalid request.
    const body = request.body === undefined ? {} : request.body;
    const parsed = createSessionRequestSchema.safeParse(body);
    if (!parsed.success) throw httpErrorFromZod(parsed.error);
    const session = await sessions.create(parsed.data);
    reply.code(201).header('location', `${base}/${session.id}`);
    return session;
  });

  app.get(base, async (): Promise<ListSessionsResponse> => ({ sessions: sessions.list() }));

  app.get(`${base}/:id`, async (request): Promise<TerminalSessionResponse> => {
    const session = sessions.get(parseSessionId(request.params));
    if (!session) throw new HttpError('SESSION_NOT_FOUND', 'Terminal session was not found.');
    return session;
  });

  app.delete(`${base}/:id`, async (request, reply) => {
    await sessions.terminate(parseSessionId(request.params));
    reply.code(204);
  });
}
