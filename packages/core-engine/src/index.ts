import type { TenantBinding } from '@agentos/database/contracts';
import { loadApprovedDocuments } from '@agentos/second-brain';

export * from './contracts/index.js';
export { evaluateAuthorityVerdict } from './policy/authority.js';
export { computeEffectKey, computeRequestFingerprint } from './effects/effect-key.js';
export { RevenueOrchestrator } from './orchestrator/revenue-orchestrator.js';
export { LIFECYCLE_STAGES, assertValidTransition } from './lifecycle/stages.js';
export { assertOrchestratorBrokered } from './orchestrator/agent-boundary.js';

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
