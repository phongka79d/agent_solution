import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Adversarial suite (`pnpm test:adversarial`, Gate P0: "zero duplicate effects").
 *
 * The cases that must never pass, driven through the public port of the component under test: a
 * second dispatch for an effect whose key is already reserved, a replayed success served from the
 * stored receipt, two concurrent workers admitted against one key, an indeterminate outcome
 * recorded as a settlement, a presented key that is not the canonical derivation, and a reservation
 * whose window cannot be read being parked instead of dispatched. The durable authority here is an
 * in-memory reservation store with the row transitions of `agentos.effect_reservations`; it decides
 * nothing, which is exactly the point — a cache-facing or process-local decider could not pass
 * these cases.
 *
 * No PostgreSQL, no Redis, no network, no build step: the suite runs on source. Files are selected
 * by the `*.adversarial.test.ts` naming convention, so adversarial tests added by later Gate work
 * join this suite without editing it; files written before the convention are listed explicitly.
 *
 * The live half of the durability invariants (`implement/09` §3.1) needs a real PostgreSQL/Redis
 * durable store and belongs to the gate-environment rehearsal, not to this offline suite.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['src/**/*.adversarial.test.ts', 'src/durability/effect-guard.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
