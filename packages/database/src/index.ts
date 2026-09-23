export const packageName = '@agentos/database';

export { getPool } from './client.js';
export { assertTenantContext, withTenantContext } from './rls.js';
export { assertEpistemicWrite, SOR_FACT_TABLES } from './epistemic.js';
export { getProfile, insertFact } from './repositories/customer-360.js';
export { findIdentity, insertIdentity } from './repositories/identity.js';
export { findConsent, insertConsent, revokeConsent } from './repositories/consent.js';
export { insertEvidence } from './repositories/evidence.js';
export { getWorkflow, insertWorkflow, updateWorkflowProgress } from './repositories/workflow.js';
export {
  acquireSessionMutex,
  acquireSessionTakeover,
  EFFECT_RESERVATION_TTL_SECONDS,
  effectReservationKey,
  rateLimitKey,
  readSessionTakeover,
  releaseSessionMutex,
  releaseSessionTakeover,
  renewSessionTakeover,
  reserveEffectKey,
  SESSION_MUTEX_TTL_MS,
  SESSION_TAKEOVER_LOCK_TTL_MS,
  sessionMutexKey,
  sessionTakeoverLockKey,
  TASK_LEASE_TTL_MS,
  taskLeaseKey,
  workingMemoryKey,
} from './memory/redis.js';
export {
  APPROVED_DOCUMENT_STATUS,
  buildCustomerKnowledgeFilter,
  buildOrganizationalKnowledgeFilter,
  KNOWLEDGE_NAMESPACES,
  KNOWLEDGE_PAYLOAD_INDEXES,
  SECOND_BRAIN_COLLECTION,
} from './memory/qdrant.js';
export type * from './contracts/index.js';

/** Durable PostgreSQL repositories and their structural ports. */
export * from './repositories/index.js';
