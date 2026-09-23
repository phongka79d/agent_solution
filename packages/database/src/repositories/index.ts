/**
 * Repository layer of `packages/database` (implement/02 §5).
 *
 * Every implementation in this directory talks raw SQL to PostgreSQL inside a tenant-scoped
 * transaction; the database is the durable authority, so no repository reaches for an ORM, a cache,
 * or another runtime package. Structural input/output types live in `../contracts/index.ts`, which
 * this package publishes as a type-only entry point.
 */

export { EffectReservationRepository } from './effect-reservations.js';
export type { TenantTransactionRunner } from './effect-reservations.js';
export { DurableWorkflowRepository } from './durable-workflows.js';
export type {
  CreateDurableTaskInput,
  ClaimNextQueuedTaskInput,
  ClaimTaskResult,
  DurableTaskGuard,
  DurableTaskRecord,
  DurableTaskSnapshot,
  DurableTaskState,
  FailureClass,
  PersistedErrorClass,
  RecordTaskFailureInput,
  ReleaseTaskLeaseInput,
  RenewTaskLeaseInput,
  TaskFailureOutcome,
} from './durable-workflows.js';
export { ApprovalRepository } from './approvals.js';
export type {
  ApprovalDecision,
  ApprovalRecord,
  ClaimApprovalAndResumeInput,
  ClaimApprovalAndResumeResult,
  PauseForApprovalInput,
  PauseForApprovalResult,
} from './approvals.js';
export { AuditRepository, EvidenceRepository } from './audit-evidence.js';
export {
  AUDIT_HMAC_SECRET_ENV,
  AUTHORITY_LEVELS,
  EXECUTION_STATUSES,
  GENESIS_HASH,
  assertSha256Digest,
  auditChainHash,
  buildAuditPayload,
  evidenceChainHash,
  requireAuditHmacSecret,
  signEvidenceChainHash,
  verifyAuditChain,
  verifyEvidenceChain,
} from './audit-evidence.js';
export type {
  AgentRunLog,
  AgentRunLogRecord,
  AppendEvidenceInput,
  AuditChainReport,
  AuditRecord,
  AuditRecordInput,
  ChainBreak,
  ChainBreakKind,
  ChainReport,
  EvidenceChainReport,
  ExecutionStatus,
  ImmutableEvidenceRecord,
} from './audit-evidence.js';
export { ConversationRepository } from './conversations.js';
export type {
  AppendConversationMessageInput,
  BindOrCreateConversationInput,
  BoundConversationRecord,
  ConversationMessageRecord,
  ConversationMessageScope,
  ConversationRecord,
  ConversationState,
  MessageSenderType,
} from './conversations.js';
export { CustomerEventRepository } from './customer-events.js';
export type {
  AppendCustomerEventInput,
  CustomerEventAppendResult,
  CustomerEventReceipt,
  CustomerEventTimeline,
  CustomerEventTimelineItem,
  CustomerEventTimelineQuery,
} from './customer-events.js';
