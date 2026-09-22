import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['src/rls.rehearsal.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
