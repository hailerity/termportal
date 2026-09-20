import type { TerminalSessionSnapshot } from '@termportal/terminal-core';
import { describe, expect, it } from 'vitest';
import { Metrics } from './metrics.js';

const session: TerminalSessionSnapshot = {
  id: 'term_abcdefgh',
  status: 'running',
  shell: '/bin/sh',
  cwd: '/tmp',
  cols: 80,
  rows: 24,
  createdAt: '2026-09-20T15:00:00.000Z',
  lastActivityAt: '2026-09-20T15:00:30.000Z',
};

describe('Metrics', () => {
  it('tracks sessions, spawn failures and durations', () => {
    const metrics = new Metrics();
    metrics.onSessionEvent({ type: 'session.created', session });
    metrics.onSessionEvent({ type: 'session.created', session });
    metrics.onSessionEvent({ type: 'session.exited', session });
    metrics.onSessionEvent({
      type: 'session.spawn_failed',
      sessionId: 'x',
      shell: 'sh',
      error: new Error('boom'),
    });
    metrics.onSessionEvent({ type: 'session.removed', sessionId: 'x' });
    expect(metrics.snapshot()).toMatchObject({
      termportal_active_sessions: 1,
      termportal_session_created_total: 2,
      termportal_session_exited_total: 1,
      termportal_pty_spawn_failures_total: 1,
      termportal_session_duration_seconds_total: 30,
    });
  });

  it('tracks websocket connections and renders the Prometheus text format', () => {
    const metrics = new Metrics();
    metrics.websocketOpened();
    metrics.websocketOpened();
    metrics.websocketClosed();
    metrics.protocolError();
    const text = metrics.render();
    expect(text).toContain(
      '# TYPE termportal_websocket_connections gauge\ntermportal_websocket_connections 1\n',
    );
    expect(text).toContain(
      '# TYPE termportal_websocket_connections_total counter\ntermportal_websocket_connections_total 2\n',
    );
    expect(text).toContain('termportal_websocket_protocol_errors_total 1\n');
  });
});
