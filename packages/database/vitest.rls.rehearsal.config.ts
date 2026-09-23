import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/** Privileged fixtures are inserted before assertions switch to the application role. */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['src/rls.rehearsal.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
