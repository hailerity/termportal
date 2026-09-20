// node-pty's macOS prebuilds ship `spawn-helper` without the executable bit, which makes every
// spawn fail with "posix_spawnp failed". Restore it after install.
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

try {
  const root = dirname(require.resolve('node-pty/package.json'));
  const candidates = [join(root, 'build', 'Release', 'spawn-helper')];
  const prebuilds = join(root, 'prebuilds');
  if (existsSync(prebuilds)) {
    for (const dir of readdirSync(prebuilds)) candidates.push(join(prebuilds, dir, 'spawn-helper'));
  }
  for (const file of candidates) if (existsSync(file)) chmodSync(file, 0o755);
} catch {
  // node-pty is not installed (e.g. a partial install); nothing to fix.
}
