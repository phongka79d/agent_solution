import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Adversarial suite (`pnpm test:adversarial`, Gate P0: "zero duplicate effects").
 *
 * The durable rows that arbitrate a repeated effect and the compare-and-increment that a stale
 * writer must not win: `agentos.effect_reservations` and the durable workflow task row. Both
 * repositories are exercised against scripted `pg` clients, so what is asserted is the
 * SQL-observable behaviour of the row transitions — the decision returned for a key, the version
 * restated as the CAS base, the refusal of an incomplete checkpoint or an `UNKNOWN` settlement —
 * with no database, no re-implementation of the guard inside the test and no skip path.
 *
 * Files are selected by the `*.adversarial.test.ts` naming convention, so adversarial tests added
 * by later Gate work join this suite without editing it; files written before the convention are
 * listed explicitly. Both listed files also run under `test:unit` (`vitest run`); this suite is the
 * Gate P0 invocation that names them, so a green `test:adversarial` means these arbitration and
 * CAS cases executed. The live half (RLS denial, cross-tenant foreign keys, the exact reservation
 * predicate) belongs to `src/rls.test.ts` under `pnpm test:rls-policies`, which needs a migrated
 * PostgreSQL instance and is not duplicated here.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: [
      'src/**/*.adversarial.test.ts',
      'src/repositories/effect-reservations.test.ts',
      'src/repositories/durable-workflows.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
