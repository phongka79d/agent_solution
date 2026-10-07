/**
 * Repository layer of `packages/database` (implement/02 §5).
 *
 * Every implementation in this directory talks raw SQL to PostgreSQL inside a tenant-scoped
 * transaction; the database is the durable authority, so no repository reaches for an ORM, a cache,
 * or another runtime package. Structural input/output types live in `../contracts/index.ts`, which
 * this package publishes as a type-only entry point.
 */
export { canonicalizeJson, sha256CanonicalJson } from './canonical-json.js';


export {
  admitCareTurn,
  CONVERSATION_TURN_SKILL,
} from './run-admission.js';
export type {
  AdmitCareTurnInput,
  AdmissionOutcome,
} from './run-admission.js';

export {
  insertReservationRow,
  lockReservationRow,
  insertEffectReservation,
  lockEffectReservation,
} from './effect-reservations.js';
export { EffectReservationRepository } from './effect-reservations.js';
export type { TenantTransactionRunner } from './effect-reservations.js';
export { DurableWorkflowRepository, assertCompleteCheckpoint } from './durable-workflows.js';
export { insertDurableTask } from './durable-workflows.js';
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
  QueueReconciliationInput,
  ReleaseTaskLeaseInput,
  RenewTaskLeaseInput,
} from './durable-workflows.js';
export { RunResponseRepository } from './run-responses.js';
export {
  RUN_STAGES,
  RunStageEventsRepository,
  RunStageEventRepository,
  ProviderCallLedgerRepository,
} from './run-stage-events.js';
export type {
  RunStage,
  RunStageEventRecord,
  AppendRunStageEventInput,
  ProviderCallObservedStatus,
  ProviderCallLedgerRecord,
  AppendProviderCallInput,
} from './run-stage-events.js';
export type { RunResponseRecord, SaveRunResponseInput } from './run-responses.js';
export { ApprovalRepository } from './approvals.js';
export type {
  ApprovalActionDraft,
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
export { CareHandoffRepository } from './care-handoffs.js';
export {
  admitCrossDomainHandoff,
  listCrossDomainHandoffs,
  readCrossDomainHandoff,
  readCrossDomainLifecycle,
} from './cross-domain-handoffs.js';
export type {
  CareHandoffClaimOutcome,
  CareHandoffCompletionOutcome,
  CareHandoffEnqueueResult,
  CareHandoffExecutionReceipt,
  CareHandoffOutput,
  CareHandoffReconciliation,
  ClaimCareHandoffInput,
  CompleteCareHandoffInput,
  EnqueueCareHandoffInput,
  ReconcileCareHandoffInput,
} from '../contracts/care-handoffs.js';
export { P5AutonomyRepository, AutonomyRepository } from './p5-autonomy.js';
export type {
  AppendAutonomyPolicyEventInput,
  AppendTokenCostRecordInput,
  AutonomyPolicyEventRecord,
  AutonomyPolicyRecord,
  AutonomyPolicyState,
  CommitAutonomyPolicyInput,
  CommitTenantAutonomyControlInput,
  TenantAutonomyControlRecord,
  TokenCostRecord,
} from './p5-autonomy.js';
export { P5ProvisioningRepository, ProvisioningRepository } from './p5-provisioning.js';
export type {
  AppendOwnerInputInput,
  AppendProvisioningEventInput,
  AppendShopifyWebhookDeliveryInput,
  CommitConnectorConfigurationInput,
  CommitNamespaceBindingInput,
  CommitResidencyConfigurationInput,
  CommitShopifyInstallationInput,
  CommitTenantCapabilityInput,
  CommitTenantWorkspaceInput,
  ConnectorConfigurationRecord,
  ConnectorConfigurationStatus,
  NamespaceBindingRecord,
  OwnerInputRecord,
  ProvisionTenantShellInput,
  ProvisioningEventRecord,
  ResidencyConfigurationRecord,
  ResidencyStatus,
  ShopifyInstallationRecord,
  ShopifyInstallationStatus,
  ShopifyWebhookDeliveryRecord,
  TenantCapabilityRecord,
  TenantRecord,
  TenantWorkspaceRecord,
} from './p5-provisioning.js';
export {
  PlatformDirectoryRepository,
  withPlatformRole,
} from './platform-directory.js';
export type {
  PlatformDirectoryRepositoryOptions,
  PlatformTransactionRunner,
  PlatformTenantRecord,
  PlatformTenantReadinessRecord,
  PlatformUsageRecord,
} from './platform-directory.js';
export { TenantGovernanceRepository } from './tenant-governance.js';
export type { TenantGovernanceSettingsRecord } from './tenant-governance.js';
export {
  CompanyProjectionRepository,
  CompanyProjectionsRepository,
} from './company-projections.js';
export type {
  CompanyActivityProjectionSource,
  CompanyAgentProjectionSource,
  CompanyApprovalProjectionSource,
  CompanyConnectorProjectionSource,
  CompanyHandoffProjectionSource,
  CompanyOwnerInputProjectionSource,
  CompanyProjectionSources,
  CompanyReconciliationProjectionSource,
  CompanyRunProjectionSource,
} from './company-projections.js';
export { CompanyCrmProjectionRepository } from './company-crm-projections.js';
export type {
  CampaignListInput,
  CampaignListPage,
  CompanyCrmCampaignEngagementRow,
  CompanyCrmCampaignRow,
  CompanyCrmConversationRow,
  CompanyCrmConversationSummaryRow,
  CompanyCrmCustomerProfileRow,
  CompanyCrmCustomerRow,
  CompanyCrmIdentityRow,
  CompanyCrmOrderRow,
  CompanyCrmRecommendationRow,
  CompanyCrmServiceCaseRow,
  CustomerListInput,
  CustomerListPage,
} from './company-crm-projections.js';
