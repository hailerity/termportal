import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isDirectory } from './cwd.js';

describe('isDirectory', () => {
  it('accepts an existing absolute directory', async () => {
    expect(await isDirectory(tmpdir())).toBe(true);
  });

  it.each([
    ['a file', fileURLToPath(import.meta.url)],
    ['a missing path', '/definitely/not/here'],
    ['a relative path', '.'],
    ['an empty string', ''],
    ['a NUL byte', '/tmp\0/x'],
  ])('rejects %s', async (_name, path) => {
    expect(await isDirectory(path)).toBe(false);
  });
});
