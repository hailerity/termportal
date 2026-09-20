import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/** True when `cwd` is an absolute path to an existing directory. */
export async function isDirectory(cwd: string): Promise<boolean> {
  if (!isAbsolute(cwd) || cwd.includes('\0')) return false;
  try {
    return (await stat(cwd)).isDirectory();
  } catch {
    return false;
  }
}
