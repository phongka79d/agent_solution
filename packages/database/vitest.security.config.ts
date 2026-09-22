import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Security suite (`pnpm test:security`, Gate P0: "AUTH-4 approval is exact-bound and single-use",
 * "audit chain integrity").
 *
 * Two append-only authorities are exercised here through their repositories, against scripted `pg`
 * clients so no database service is required:
 *
 *   - the approval queue: a pause binds exactly one run, effect key and payload digest, only an
 *     AUTH-4 decision may claim it, a claimed approval cannot be claimed twice, and a MODIFIED
 *     revision is what the next claim sees;
 *   - the audit and evidence chains: per-tenant hash links, `payload_sha256` and the
 *     `previous | payload | effect_key | step_index` formula with the HMAC signature, plus the
 *     tamper, missing-link and duplicate-append cases that must fail verification.
 *
 * Files are selected by the `*.security.test.ts` naming convention, so security tests added by
 * later Gate work join this suite without editing it; files written before the convention are
 * listed explicitly. Both listed files also run under `test:unit` (`vitest run`); this suite is the
 * Gate P0 invocation that names them, so a green `test:security` means these approval-binding and
 * chain-integrity cases executed — and a file that is renamed away makes the suite fail with "no
 * test files found" rather than pass with less coverage.
 *
 * The live half of the durable invariants (RLS denial, the exact approval-window predicate,
 * cross-tenant refusal) runs in job 3 through `pnpm test:rls-policies`; the offline cases here
 * cannot substitute for it (`implement/09` §3.1).
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: [
      'src/**/*.security.test.ts',
      'src/repositories/approvals.test.ts',
      'src/repositories/audit-evidence.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
