import { TerminalError } from '../domain/errors.js';

/**
 * Variables a create-session request may override. Entries ending in `*` match by prefix.
 * Everything else comes from the server's controlled base environment (design §17), so a request
 * cannot, for example, inject `LD_PRELOAD`, `PATH` or `NODE_OPTIONS` into the shell.
 */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  'TERM',
  'COLORTERM',
  'LANG',
  'LANGUAGE',
  'LC_*',
  'TZ',
  'EDITOR',
  'VISUAL',
  'PAGER',
];

export function isEnvOverrideAllowed(name: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) =>
    entry.endsWith('*') ? name.startsWith(entry.slice(0, -1)) : name === entry,
  );
}

/** Base environment + allowed overrides = PTY environment. Throws `INVALID_ENV` otherwise. */
export function buildPtyEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string>> | undefined,
  allowlist: readonly string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined) env[name] = value;
  }
  env.TERM ??= 'xterm-256color';
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (!isEnvOverrideAllowed(name, allowlist)) {
      throw new TerminalError(
        'INVALID_ENV',
        `Environment variable "${name}" cannot be overridden.`,
      );
    }
    env[name] = value;
  }
  return env;
}
