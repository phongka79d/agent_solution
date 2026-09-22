import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Contract suite (`pnpm test:contracts`).
 *
 * The locked contracts the skill layer is built on: the registry completeness invariants of
 * implement/05 §6.1 against the real §4 row schemas, the deterministic JSON Schema behaviour, and
 * the dispatch order of §6.3. The expectations are observable outcomes — a refusal code, an adapter
 * call count, a stored row — rather than calls back into the module under test.
 *
 * No PostgreSQL, no Redis, no network, no build step: the suite runs on source. Files are selected
 * by the `*.contracts.test.ts` convention, so contract tests added by later Gate work join this
 * suite without editing it.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['src/**/*.contracts.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
