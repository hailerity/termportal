import { describe, expect, it } from 'vitest';
import { defaultShellName, resolveShellMap } from './shells.js';

describe('resolveShellMap', () => {
  it('maps each named shell to the first installed candidate', () => {
    const installed = new Set(['/usr/bin/bash', '/bin/sh']);
    expect(resolveShellMap('linux', (path) => installed.has(path))).toEqual({
      bash: '/usr/bin/bash',
      sh: '/bin/sh',
    });
  });

  it('finds the shells of the current host', () => {
    expect(resolveShellMap().sh).toBe('/bin/sh');
  });

  it('refuses Windows', () => {
    expect(() => resolveShellMap('win32')).toThrow(/not supported/);
  });
});

describe('defaultShellName', () => {
  const all = { bash: '/bin/bash', zsh: '/bin/zsh', sh: '/bin/sh' };

  it('prefers zsh on macOS and bash elsewhere', () => {
    expect(defaultShellName(all, 'darwin')).toBe('zsh');
    expect(defaultShellName(all, 'linux')).toBe('bash');
  });

  it('falls back to an installed shell', () => {
    expect(defaultShellName({ sh: '/bin/sh' }, 'linux')).toBe('sh');
    expect(() => defaultShellName({}, 'linux')).toThrow(/No supported shell/);
  });
});
