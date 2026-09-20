import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import type { SessionManager } from '@termportal/terminal-core';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { HttpError, mapError } from './http/errors.js';
import { registerSessionRoutes } from './http/session-routes.js';

export interface AppOptions {
  sessions: SessionManager;
  allowedOrigins: string[];
  logger?: FastifyBaseLogger | boolean;
  /** Reported by `/ready`; flips to false once shutdown begins. */
  isReady?: () => boolean;
}

const MAX_BODY_BYTES = 64 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    ...(typeof options.logger === 'object'
      ? { loggerInstance: options.logger }
      : { logger: options.logger ?? false }),
    bodyLimit: MAX_BODY_BYTES,
    requestIdHeader: false,
    // Reuse a well-formed caller-supplied id so errors can be correlated across services.
    genReqId: (request) => {
      const header = request.headers['x-request-id'];
      return typeof header === 'string' && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
    },
  });

  await app.register(cors, {
    origin: options.allowedOrigins,
    methods: ['GET', 'POST', 'DELETE'],
    exposedHeaders: ['x-request-id', 'location'],
  });

  // JSON only. Without the default text/plain parser a cross-site "simple" POST gets a 415.
  app.removeContentTypeParser('text/plain');
  // Accept a JSON request without a body: every create-session field is optional.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    if (body === '') return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new HttpError('INVALID_REQUEST', 'Request body is not valid JSON.'));
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error, request.id);
    if (mapped.unexpected) request.log.error({ err: error }, 'request failed');
    else request.log.info({ code: mapped.body.error.code }, 'request rejected');
    reply.code(mapped.statusCode).send(mapped.body);
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .send(mapError(new HttpError('NOT_FOUND', 'Route was not found.'), request.id).body);
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_request, reply) => {
    const ready = options.isReady?.() ?? true;
    reply.code(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'shutting_down' };
  });

  registerSessionRoutes(app, options.sessions);
  return app;
}
