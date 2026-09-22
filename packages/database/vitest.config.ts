import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Unit suite (`pnpm test:unit`): no PostgreSQL, no network.
 *
 * `src/rls.test.ts` is excluded here because it is a live-policy suite against a
 * real PostgreSQL instance; it runs under `vitest.rls.config.ts`
 * (`pnpm test:rls-policies`) where DATABASE_URL and the migrated schema are
 * available.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'src/rls.test.ts'],
  },
});
