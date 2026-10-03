import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const result = spawnSync(
  process.execPath,
  [
    '--test',
    '--test-global-setup=tests/stack/global-setup.mjs',
    '--test-concurrency=1',
    'tests/stack/**/*.stack.test.mjs',
  ],
  {
    cwd: root,
    env: { ...process.env, STACK_AUTH_PROVIDER: 'db' },
    stdio: 'inherit',
    windowsHide: true,
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
