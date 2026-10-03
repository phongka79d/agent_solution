/**
 * Repository layer of `packages/database` (implement/02 §5).
 *
 * Every implementation in this directory talks raw SQL to PostgreSQL inside a tenant-scoped
 * transaction; the database is the durable authority, so no repository reaches for an ORM, a cache,
 * or another runtime package. Structural input/output types live in `../contracts/index.ts`, which
 * this package publishes as a type-only entry point.
 */
export { canonicalizeJson, sha256CanonicalJson } from './canonical-json.js';
export { SecretRepository } from './secrets.js';
export type {
  EncryptedSecret,
  EncryptedTenantSecret,
  PlatformSecretDescription,
  PutPlatformSecretInput,
  PutTenantSecretInput,
  SecretAuditContext,
  SecretEncryptor,
  TenantSecretDescription,
} from './secrets.js';
export { IdentityRepository } from './auth-identity.js';
export type {
  AuthTransactionRunner,
  IdentityAcceptedInvitation,
  IdentityActiveMembership,
  IdentityInvitation,
  IdentityInvitationInspection,
  IdentityMembershipScope,
  IdentityPlatformAdmin,
  IdentityMembership,
  IdentityMembershipStatus,
  IdentityRepositoryOptions,
  IdentityRoleBundle,
  IdentitySession,
  IdentityTenantMember,
  IdentityUserCredential,
} from './auth-identity.js';



export {
  admitCareTurn,
  CONVERSATION_TURN_SKILL,
} from './run-admission.js';
export type {
  AdmitCareTurnInput,
  AdmissionOutcome,
  CampaignAdmission,
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
  QueueReconciliationInput,
  QueueRetryTimerInput,
  ReconciliationCandidate,
  RecordTaskFailureInput,
  ReleaseTaskLeaseInput,
  RenewTaskLeaseInput,
  RetryTimerCandidate,
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
  RunStageResultStatus,
  RunStageResultRecord,
  AppendRunStageResultInput,
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
  WidgetConversationMessagePage,
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
  ReserveLlmTokenBudgetInput,
  AutonomyPolicyRecord,
  AutonomyPolicyState,
  AutonomyPromotionRequestRecord,
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
  ConnectorMode,
  NamespaceBindingRecord,
  OwnerInputRecord,
  ProvisionTenantShellInput,
  ProvisioningEventRecord,
  ResolveOwnerInputInput,
  ResolveOwnerInputResult,
  TenantDataClass,
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
  PlatformActiveTenantRecord,
  PlatformRunListItem,
  PlatformRunCostBreakdown,
  PlatformRunDetail,
  PlatformRunStepDiagnostic,
  PlatformRunStageDiagnostic,
  PlatformRunProviderCall,
  PlatformRunAuditEntry,
  PlatformRunApproval,
  PlatformRunHandoff,
  PlatformRunTraceDetails,
  PlatformRunsSummaryRow,
  PlatformReconciliationItem,
  PlatformCompanyOverview,
} from './platform-directory.js';
export { PlatformCompanyRepository } from './platform-commands.js';
export type {
  PlatformCompanyRepositoryOptions,
  PlatformTenantStatusRecord,
} from './platform-commands.js';
export { TenantGovernanceRepository } from './tenant-governance.js';
export type { TenantGovernanceSettingsRecord } from './tenant-governance.js';
export {
  CompanyProjectionRepository,
  CompanyProjectionsRepository,
} from './company-projections.js';
export type {
  CompanyActivityProjectionSource,
  CompanyActivityPageOptions,
  CompanyAgentProjectionSource,
  CompanyApprovalProjectionSource,
  CompanyCampaignProjectionSource,
  CompanyConnectorProjectionSource,
  CompanyConversationProjectionSource,
  CompanyHandoffProjectionSource,
  CompanyOwnerInputProjectionSource,
  CompanyProjectionSources,
  CompanyReconciliationProjectionSource,
  CompanyRunProjectionSource,
} from './company-projections.js';
export { CompanyAnalyticsRepository, COMPANY_ANALYTICS_WINDOWS } from './company-analytics.js';
export type {
  CompanyAnalyticsBreakdownEntry,
  CompanyAnalyticsKpi,
  CompanyAnalyticsQuery,
  CompanyAnalyticsSnapshot,
  CompanyAnalyticsSourceStatus,
  CompanyAnalyticsWindow,
} from './company-analytics.js';
export { CompanyCrmProjectionRepository } from './company-crm-projections.js';
export type {
  CampaignListInput,
  CampaignListPage,
  CompanyCrmCampaignEngagementRow,
  CompanyCrmCampaignRow,
  CompanyCrmCampaignSegment,
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
export {
  PlatformAuditRepository,
  appendConfigAudit,
} from './platform-audit.js';
export type {
  AuditPageQuery,
  ConfigAuditInput,
  PlatformAuditEvent,
  PlatformAuditPage,
  PlatformAuditPageQuery,
} from './platform-audit.js';
export { ConnectorBindingRepository, isPristineConnectorBinding } from './connector-bindings.js';
export type {
  ConnectorBindingActor,
  ConnectorBindingMode,
  ConnectorBindingRecord,
  ConnectorBindingStatus,
  ConnectorProbeName,
  ConnectorProbeOutcome,
  ConnectorProbeResult,
  PutConnectorConfigInput,
} from './connector-bindings.js';
export { AgentActivationRepository } from './agent-activation.js';
export type {
  AgentActivationAction,
  AgentActivationActor,
  AgentActivationAgent,
  AgentActivationDomain,
  AgentActivationSnapshot,
  AgentActivationStatus,
  AgentActivationRepositoryOptions,
} from './agent-activation.js';
export { KnowledgeRepository, KNOWLEDGE_NAMESPACES, KNOWLEDGE_TYPES } from './knowledge.js';
export type {
  KnowledgeActor,
  KnowledgeDocumentInput,
  KnowledgeDocumentRecord,
  KnowledgeDocumentNamespace,
  KnowledgePage,
  KnowledgeUsageRecord,
  KnowledgePageQuery,
  KnowledgeRepositoryOptions,
  KnowledgeStatus,
  KnowledgeType,
  KnowledgeVersionRecord,
} from './knowledge.js';
export { SkillCatalogRepository, SkillCatalogRefusal, syncSkillCatalogAtBoot } from './skill-catalog.js';
export type {
  RecordSkillTestInput,
  SkillCatalogActor,
  SkillCatalogManifestRow,
  SkillCatalogRecord,
  SkillCatalogRepositoryOptions,
  SkillCatalogSyncResult,
  SkillEffectClass,
  SkillHealthSnapshot,
  SkillStageOutcomeRow,
  SkillTestMode,
  SkillTestOutcome,
  SkillTestResultRecord,
  TenantSkillSettingsRecord,
  UpsertSkillSettingsInput,
} from './skill-catalog.js';
export { PlatformSkillFleetHealthRepository } from './platform-skill-health.js';
export type {
  PlatformSkillFleetHealthRecord,
  PlatformSkillFleetHealthRepositoryOptions,
} from './platform-skill-health.js';
export { TenantProfileRepository } from './tenant-profiles.js';
export type {
  TenantProfileRecord,
  TenantProfileValues,
  UpdateTenantProfileInput,
  UpdateTenantProfileResult,
} from './tenant-profiles.js';
export { LlmConfigRepository } from './llm-configs.js';
export type {
  LlmConfigActor,
  LlmConfigMode,
  LlmConfigRepositoryOptions,
  LlmProbeResult,
  LlmProbeScope,
  LlmProviderStatus,
  LlmStructuredMode,
  PlatformLlmProviderInput,
  PlatformLlmProviderListing,
  PlatformLlmProviderRecord,
  PlatformLlmProbeSummary,
  TenantLlmConfigRecord,
  TenantLlmOverrideInput,
} from './llm-configs.js';
export { TestDataRepository } from './test-data.js';
export type {
  TestDataRepositoryOptions,
  TestDataResetResult,
} from './test-data.js';
export { TestCustomersRepository } from './test-customers.js';
export type {
  CreateTestCustomerInput,
  TestCustomerConsentInput,
  TestCustomerConsentRecord,
  TestCustomerDetail,
  TestCustomerEventInput,
  TestCustomerEventRecord,
  TestCustomerHandoffInput,
  TestCustomerIdentityInput,
  TestCustomerIdentityRecord,
  TestCustomerListPage,
  TestCustomerListQuery,
  TestCustomerMutationContext,
  TestCustomerOrderInput,
  TestCustomerOrderRecord,
  TestCustomerRecord,
  TestCustomerServiceCaseRecord,
  TestCustomerSupportInput,
  TestCustomersRepositoryOptions,
  TestDataClass,
} from './test-customers.js';
