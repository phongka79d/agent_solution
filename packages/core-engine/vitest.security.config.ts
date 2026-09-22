import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Security suite (`pnpm test:security`, Gate P0: "no authority-boundary violation").
 *
 * The policy enforcement point is exercised through its injected ports only. What the cases pin
 * down is the authority boundary: an AUTH-5 prohibited skill is denied before any queue row exists,
 * a self-declared AUTH-5 is honoured as a deny instead of being dropped, a privilege-elevation
 * attempt is blocked before it can reach the approval queue, the registry requirement wins over a
 * declared downgrade, identity comes from the binding rather than the payload, and a refused action
 * leaves the approval queue untouched.
 *
 * No PostgreSQL, no Redis, no network, no build step: the suite runs on source. Files are selected
 * by the `*.security.test.ts` naming convention, so security tests added by later Gate work join
 * this suite without editing it; files written before the convention are listed explicitly.
 *
 * These files also run under `test:unit` (`vitest run src`). This suite is the Gate P0 invocation
 * that names them, so a green `test:security` means these specific authority cases executed.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['src/**/*.security.test.ts', 'src/policy/policy.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
