import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Contract suite (`pnpm test:contracts`, Gate P0: "locked contracts").
 *
 * The byte and vocabulary contracts the rest of the platform is built on: canonical JSON, the
 * SHA-256/HMAC primitives every durable digest is computed with, and the authority-rank vocabulary
 * the policy boundary compares against. The expectations in these files are fixed byte strings and
 * fixed digests rather than calls back into the module, because a writer and a verifier running in
 * different processes must agree on them without sharing an implementation.
 *
 * No PostgreSQL, no Redis, no network, no build step: the suite runs on source. Files are selected
 * by the `*.contracts.test.ts` naming convention, so contract tests added by later Gate work join
 * this suite without editing it; files written before the convention are listed explicitly.
 *
 * These files also run under `test:unit` (`vitest run src`). This suite is the Gate P0 invocation
 * that names them, so a green `test:contracts` means these specific contract cases executed.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: [
      'src/**/*.contracts.test.ts',
      'src/durability/canonical-json.test.ts',
      'src/authority-rank.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
