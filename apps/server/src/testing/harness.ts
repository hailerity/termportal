import { SessionManager, type SessionManagerOptions } from '@termportal/terminal-core';
import { FakePtyFactory } from '@termportal/terminal-core/testing';

/** A SessionManager wired to fake PTYs, for transport tests. */
export function createFakeSessions(overrides: Partial<SessionManagerOptions> = {}) {
  const ptyFactory = new FakePtyFactory();
  const sessions = new SessionManager({
    ptyFactory,
    shells: { bash: '/bin/bash', sh: '/bin/sh' },
    defaultShell: 'bash',
    defaultCwd: '/tmp',
    defaultCols: 120,
    defaultRows: 40,
    maxSessions: 3,
    isDirectory: async (cwd) => cwd !== '/missing',
    baseEnv: { PATH: '/usr/bin' },
    ...overrides,
  });
  return { sessions, ptyFactory };
}
