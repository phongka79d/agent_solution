import { spawnSync } from 'node:child_process';

process.env.ESLINT_USE_FLAT_CONFIG = 'true';

const result = spawnSync('eslint', ['.'], {
  stdio: 'inherit',
  shell: true,
  env: process.env,
});

process.exit(result.status ?? 1);
