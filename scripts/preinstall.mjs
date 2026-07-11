import { rmSync } from 'node:fs';

for (const lockfile of ['package-lock.json', 'yarn.lock']) {
  rmSync(lockfile, { force: true });
}

const userAgent = process.env.npm_config_user_agent ?? '';

if (!userAgent.startsWith('pnpm/')) {
  console.error('Use pnpm instead');
  process.exitCode = 1;
}
