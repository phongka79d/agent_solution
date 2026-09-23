import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Unit suite (`pnpm test:unit`): no PostgreSQL, no network.
 *
 * Live PostgreSQL suites are excluded here. `pnpm test:rls-policies` runs the
 * application-role policy suite; `vitest.rls.rehearsal.config.ts` runs the separate
 * privileged-fixture rehearsal. Unit runs stay database- and network-free.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['src/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'src/rls.test.ts',
      'src/rls.rehearsal.test.ts',
    ],
  },
});
