import type { SessionManagerEvent } from '@termportal/terminal-core';

/**
 * In-process counters fed by session lifecycle events (design §21). Deliberately tiny: it has
 * no dependency and renders the Prometheus text format, so a scraper or a test can read it.
 */
export class Metrics {
  private sessionsCreated = 0;
  private sessionsExited = 0;
  private spawnFailures = 0;
  private sessionSecondsTotal = 0;
  private websocketConnections = 0;
  private websocketConnectionsTotal = 0;
  private protocolErrors = 0;

  /**
   * @param countActiveSessions Source of truth for the gauge. Deriving it from created/exited
   *   events would drift whenever a session is forgotten without an exit event, e.g. after a
   *   failed termination.
   */
  constructor(private readonly countActiveSessions: () => number = () => 0) {}

  onSessionEvent(event: SessionManagerEvent): void {
    switch (event.type) {
      case 'session.created':
        this.sessionsCreated++;
        return;
      case 'session.exited': {
        this.sessionsExited++;
        const { createdAt, lastActivityAt } = event.session;
        const seconds = (Date.parse(lastActivityAt) - Date.parse(createdAt)) / 1000;
        if (Number.isFinite(seconds) && seconds > 0) this.sessionSecondsTotal += seconds;
        return;
      }
      case 'session.spawn_failed':
        this.spawnFailures++;
        return;
      default:
        return;
    }
  }

  websocketOpened(): void {
    this.websocketConnections++;
    this.websocketConnectionsTotal++;
  }

  websocketClosed(): void {
    this.websocketConnections--;
  }

  protocolError(): void {
    this.protocolErrors++;
  }

  snapshot(): Record<string, number> {
    return {
      termportal_active_sessions: this.countActiveSessions(),
      termportal_session_created_total: this.sessionsCreated,
      termportal_session_exited_total: this.sessionsExited,
      termportal_pty_spawn_failures_total: this.spawnFailures,
      termportal_session_duration_seconds_total: this.sessionSecondsTotal,
      termportal_websocket_connections: this.websocketConnections,
      termportal_websocket_connections_total: this.websocketConnectionsTotal,
      termportal_websocket_protocol_errors_total: this.protocolErrors,
    };
  }

  /** Prometheus text exposition format. */
  render(): string {
    return Object.entries(this.snapshot())
      .map(([name, value]) => {
        const type = name.endsWith('_total') ? 'counter' : 'gauge';
        return `# TYPE ${name} ${type}\n${name} ${value}\n`;
      })
      .join('');
  }
}
