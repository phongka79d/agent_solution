import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Database-backed RLS rehearsal suite.
 *
 * The unit config (`vitest.config.ts`) excludes `src/rls.rehearsal.test.ts`
 * because it needs a real PostgreSQL instance; this config runs it after
 * `pnpm --filter @agentos/database db:migrate:rehearse` has applied the schema,
 * the composite tenant-scoped foreign keys, and the RLS policies, and has
 * created the `agentos_app` / `agentos_migrator` roles. Without `DATABASE_URL`
 * the file still runs: the pool fail-closed case executes and every database
 * case skips.
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
