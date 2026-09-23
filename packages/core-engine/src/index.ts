import type { TenantBinding } from '@agentos/database/contracts';
import { loadApprovedDocuments } from '@agentos/second-brain';

export * from './contracts/index.js';
export { evaluateAuthorityVerdict } from './policy/authority.js';
export { computeEffectKey, computeRequestFingerprint } from './effects/effect-key.js';
export { RevenueOrchestrator } from './orchestrator/revenue-orchestrator.js';
export { LIFECYCLE_STAGES, assertValidTransition } from './lifecycle/stages.js';
export { assertOrchestratorBrokered } from './orchestrator/agent-boundary.js';
export * from './durability/canonical-json.js';
export * from './durability/effect-guard.js';
export * from './durability/evidence.js';
export * from './durability/redis-client.js';
export * from './policy/index.js';
// The in-memory guard is the canonical `IEffectGuard` bound to a Map, so a route or connector test
// exercises the real effect-key derivation, fingerprinting and reservation protocol instead of a
// hand-rolled double. `EffectReservationStatus` is deliberately not re-exported: `contracts/types.ts`
// already owns that name with the full stored vocabulary.
export {
  MemoryEffectGuard,
  EFFECT_RESERVATION_WINDOW_MS,
} from './effects/memory-effect-guard.js';
export type {
  MemoryEffectGuardOptions,
  EffectReservationRow,
} from './effects/memory-effect-guard.js';

/** Package identity surfaced by `apps/api` and `apps/worker` health payloads. */
export const packageName = '@agentos/core-engine';

/**
 * Declares the persistence edge the engine is allowed to hold: persistence contracts are
 * type-only, so no `@agentos/database` runtime module can be reached from this package.
 */
export interface EngineBoundary {
  readonly package: typeof packageName;
  readonly tenantBinding: TenantBinding;
}

/**
 * Lists the owner-approved knowledge documents available to the engine.
 *
 * @param rootDir Root directory of the second-brain knowledge base.
 * @returns The approved documents only; drafts are excluded by the loader.
 */
export async function listApprovedKnowledge(
  rootDir: string,
): Promise<readonly { path: string; status: string }[]> {
  return loadApprovedDocuments(rootDir);
}
