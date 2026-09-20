import type { SessionManagerEvent } from '@termportal/terminal-core';

interface Logger {
  info(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

/** Structured lifecycle logging. Events never contain terminal input or output (design §21). */
export function logSessionEvent(logger: Logger, event: SessionManagerEvent): void {
  switch (event.type) {
    case 'session.created': {
      const { id, shell, pid, cols, rows } = event.session;
      logger.info({ sessionId: id, shell, pid, cols, rows }, 'session created');
      return;
    }
    case 'session.terminating':
      logger.info({ sessionId: event.session.id }, 'session terminating');
      return;
    case 'session.exited': {
      const { id, exitCode, exitSignal } = event.session;
      logger.info({ sessionId: id, exitCode, exitSignal }, 'pty exited');
      return;
    }
    case 'session.removed':
      logger.info({ sessionId: event.sessionId }, 'session removed');
      return;
    case 'session.spawn_failed':
      logger.error(
        { sessionId: event.sessionId, shell: event.shell, err: event.error },
        'pty spawn failed',
      );
      return;
    case 'client.attached':
    case 'client.detached':
      logger.info(
        { sessionId: event.sessionId, clients: event.clients },
        event.type.replace('.', ' '),
      );
      return;
  }
}
