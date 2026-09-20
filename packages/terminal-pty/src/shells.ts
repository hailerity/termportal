import { accessSync, constants } from 'node:fs';

export type ShellName = 'bash' | 'zsh' | 'sh';

const CANDIDATES: Record<ShellName, string[]> = {
  bash: ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash'],
  zsh: ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/homebrew/bin/zsh'],
  sh: ['/bin/sh', '/usr/bin/sh'],
};

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Maps the named shells to the executables present on this host. Shells that are not installed
 * are left out, so requesting them fails with `INVALID_SHELL` instead of a spawn error.
 */
export function resolveShellMap(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = isExecutable,
): Partial<Record<ShellName, string>> {
  if (platform === 'win32') {
    throw new Error('Windows is not supported: bash, zsh and sh require a POSIX host.');
  }
  const map: Partial<Record<ShellName, string>> = {};
  for (const name of Object.keys(CANDIDATES) as ShellName[]) {
    const path = CANDIDATES[name].find(exists);
    if (path) map[name] = path;
  }
  return map;
}

/** zsh on macOS, bash elsewhere (design §16), falling back to whatever is installed. */
export function defaultShellName(
  shells: Partial<Record<ShellName, string>>,
  platform: NodeJS.Platform = process.platform,
): ShellName {
  const preferred: ShellName[] =
    platform === 'darwin' ? ['zsh', 'bash', 'sh'] : ['bash', 'sh', 'zsh'];
  const name = preferred.find((candidate) => shells[candidate]);
  if (!name) throw new Error('No supported shell (bash, zsh, sh) was found on this host.');
  return name;
}
