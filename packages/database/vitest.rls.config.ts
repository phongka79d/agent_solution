import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Database-backed RLS policy suite. Migrations and tenant-scoped foreign keys must already
 * be applied, and `DATABASE_URL` must use a non-bypassing application role.
 * The privileged-fixture rehearsal in `src/rls.rehearsal.test.ts` runs separately
 * using its own database configuration.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['src/rls.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The suite seeds, mutates and cleans tenant-scoped fixtures; running its
    // files in parallel would make the isolation assertions racy.
    fileParallelism: false,
  },
});
