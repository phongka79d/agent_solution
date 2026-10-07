import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Worker unit suite (`pnpm test:unit`).
 *
 * The two offline pilot harnesses are owned by `test:pilots`
 * (`vitest run src/runtime/care/pilot-04.test.ts src/runtime/sales/pilot-02.test.ts`), and the
 * E2E files are owned by `test:e2e` (`vitest.e2e.config.ts`), so they are excluded here. The union
 * of `test:unit`, `test:pilots` and `test:e2e` therefore executes every worker assertion exactly
 * once in CI; `test:pilots` names its files explicitly, so a rename cannot silently drop them.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    testTimeout: 15000,
    include: ['src/**/*.test.ts'],
    exclude: [
      'src/e2e/**',
      '**/*.e2e.test.ts',
      'src/runtime/care/pilot-04.test.ts',
      'src/runtime/sales/pilot-02.test.ts',
      '**/node_modules/**',
      '**/dist/**',
    ],
  },
});
