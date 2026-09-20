import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('uses the documented defaults', () => {
    expect(loadConfig({})).toEqual({
      host: '127.0.0.1',
      port: 3000,
      defaultShell: undefined,
      defaultCwd: '/tmp',
      defaultCols: 120,
      defaultRows: 40,
      outputBufferBytes: 5242880,
      shutdownTimeoutMs: 10000,
      maxSessions: 100,
      exitedSessionTtlMs: 300000,
      allowedOrigins: ['http://localhost:4200', 'http://127.0.0.1:4200'],
      logLevel: 'info',
    });
  });

  it('reads overrides and ignores empty values', () => {
    const config = loadConfig({
      PORT: '8080',
      DEFAULT_SHELL: 'sh',
      MAX_SESSIONS: '5',
      ALLOWED_ORIGINS: 'https://a.example, https://b.example',
      HOST: '',
    });
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 8080,
      defaultShell: 'sh',
      maxSessions: 5,
      allowedOrigins: ['https://a.example', 'https://b.example'],
    });
  });

  it.each([
    { PORT: 'abc' },
    { PORT: '70000' },
    { DEFAULT_SHELL: '/bin/bash' },
    { MAX_SESSIONS: '0' },
    { DEFAULT_COLS: '1.5' },
  ])('rejects %j', (env) => {
    expect(() => loadConfig(env)).toThrow(/Invalid configuration/);
  });
});
