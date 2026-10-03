import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const require = createRequire(import.meta.url);
const playwrightCli = require.resolve('@playwright/test/cli');
const result = spawnSync(
  process.execPath,
  [playwrightCli, 'test', '-c', 'tests/ui/playwright.stack.config.ts', ...process.argv.slice(2)],
  {
    cwd: root,
    env: { ...process.env, STACK_WITH_CONSOLES: '1' },
    stdio: 'inherit',
    windowsHide: true,
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
