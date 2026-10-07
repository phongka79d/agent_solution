/**
 * Tenant-console HTTP DTOs for the existing /api/v1 contracts.
 * Shared status and lifecycle vocabulary comes from @agentos/ui-foundation.
 */

import type {
  ApprovalDecisionRequest,
  ApprovalDecisionResponse,
  CompanyGovernanceResponse,
} from '@agentos/api-contract';
import type {
  EvidenceClassification,
  SourceStatus,
  TaskLifecycleState,
} from '@agentos/ui-foundation';

export type { AuthSession, Permission, TenantMembership, UserIdentity } from '@agentos/ui-foundation/auth';
export type {
  ApprovalDecisionRequest,
  ApprovalDecisionResponse,
  ApprovalDetailResponse,
  ApprovalQueueItem,
  CompanyActivityItem,
  CompanyActivityResponse,
  CompanyAiTeamAgent,
  CompanyAiTeamResponse,
  CompanyAttentionItem,
  CompanyAttentionResponse,
  CompanyGovernanceResponse,
  CompanyIntegrationItem,
  CompanyIntegrationsResponse,
  CompanyOverviewResponse,
  GetApprovalsParams,
  GetApprovalsResponse,
} from '@agentos/api-contract';

// R14: Approval Center
export type ApprovalDecision = ApprovalDecisionRequest['decision'];
export type ApprovalDecisionStatus = ApprovalDecisionResponse['status'];
export type ApprovalStatus =
  | 'AWAITING_HUMAN'
  | 'PENDING'
  | 'PAUSED'
  | 'APPROVED'
  | 'REJECTED'
  | 'MODIFIED'
  | 'CANCELLED'
  | 'QUEUED';

export type GovernanceSettingsResponse = CompanyGovernanceResponse;

// R15: Customer 360 timeline
export interface CustomerTimelineParams {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export interface TimelineEntry {
  readonly occurred_at: string;
  readonly source_record_id: string;
  readonly event_id: string;
  readonly stage: string;
  readonly canonical_event: string | null;
  readonly classification: EvidenceClassification;
  readonly evidence_reference: string | null;
  readonly gap_reason?: string | undefined;
}

export type CustomerTimelineEntry = TimelineEntry;

export interface CustomerTimelineProfile {
  readonly customer_id?: string | undefined;
  readonly name?: string | undefined;
  readonly tier?: string | undefined;
  readonly ltv_twd?: number | undefined;
  readonly aov_twd?: number | undefined;
  readonly churn_risk_score?: number | undefined;
}

export interface CustomerTimelineResponse {
  readonly items: readonly TimelineEntry[];
  readonly next_cursor: string | null;
  readonly entries?: readonly TimelineEntry[] | undefined;
  readonly events?: readonly TimelineEntry[] | undefined;
  readonly gaps?: readonly Record<string, unknown>[] | undefined;
  readonly nextCursor?: string | null | undefined;
  readonly customer_id?: string | undefined;
  readonly customer?: CustomerTimelineProfile | undefined;
}

// R17: Executive KPI snapshot and telemetry
export interface GetKpiSnapshotParams {
  readonly window?: string | undefined;
  readonly timezone?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface KpiMetricItem<T = unknown> {
  readonly metric?: string | undefined;
  readonly name?: string | undefined;
  readonly value: T | null;
  readonly source_status: SourceStatus;
  readonly observed_at: string | null;
  readonly window?: string | undefined;
  readonly timezone?: string | undefined;
  readonly provisional?: boolean | undefined;
  readonly reason?: string | undefined;
  readonly note?: string | undefined;
}

export interface RevenueMetricValue {
  readonly totalRevenue: number;
  readonly organicBaselineRevenue: number;
}
export interface LeadsMetricValue {
  readonly total: number;
  readonly marketingQualified: number;
}
export interface ConversionMetricValue {
  readonly overallPercent: number;
  readonly aiAssisted: number;
  readonly unassisted: number;
  readonly relativeLiftPercent: number;
}
export interface ActiveCampaignsMetricValue {
  readonly liveCount: number;
  readonly pendingApprovalCount: number;
}
export interface AiAttributedRevenueMetricValue {
  readonly directCheckout: number;
  readonly cartRecovery: number;
  readonly crossSellUpsell: number;
  readonly total: number;
  readonly shareOfTotalRevenuePercent: number;
}
export interface CustomerServiceStatusMetricValue {
  readonly firstResponseSeconds: number;
  readonly escalationRatePercent: number;
  readonly openTicketCount: number;
}
export interface RetentionMetricValue {
  readonly repeatCustomerRatePercent: number;
  readonly churnRatePercent: number;
}
export interface AiActionsMetricValue {
  readonly executedCount: number;
}
export interface ApprovalPendingMetricValue {
  readonly awaitingSignOffCount: number;
}
export interface AbnormalEventsMetricValue {
  readonly warningCount: number;
  readonly criticalCount: number;
}
export interface BaselineMetricsCollection {
  readonly revenue: KpiMetricItem<RevenueMetricValue | number>;
  readonly leads: KpiMetricItem<LeadsMetricValue | number>;
  readonly conversion: KpiMetricItem<ConversionMetricValue | number>;
  readonly activeCampaigns: KpiMetricItem<ActiveCampaignsMetricValue | number>;
  readonly aiGeneratedRevenue: KpiMetricItem<AiAttributedRevenueMetricValue | number>;
  readonly customerServiceStatus: KpiMetricItem<CustomerServiceStatusMetricValue | string>;
  readonly retention: KpiMetricItem<RetentionMetricValue | number>;
  readonly aiActions: KpiMetricItem<AiActionsMetricValue | number>;
  readonly approvalPending: KpiMetricItem<ApprovalPendingMetricValue | number>;
  readonly abnormalEvents: KpiMetricItem<AbnormalEventsMetricValue | number>;
}

export interface KpiSnapshotResponse {
  readonly window: string;
  readonly timezone: string;
  readonly observed_at: string;
  readonly metrics:
    | readonly KpiMetricItem<unknown>[]
    | (Record<string, KpiMetricItem<unknown>> & Partial<BaselineMetricsCollection>);
  readonly cursor: string | null;
  readonly tenant_id?: string | undefined;
  readonly timestamp?: string | undefined;
}

export interface TelemetrySSEFrame<T = unknown> {
  readonly id: string;
  readonly event:
    | 'telemetry.snapshot'
    | 'run.updated'
    | 'approval.pending'
    | 'approval.decided'
    | 'conversation.message'
    | 'takeover.acquired'
    | 'takeover.heartbeat'
    | 'takeover.released'
    | 'stream.error'
    | string;
  readonly data: T;
  readonly retry?: number | undefined;
}

// SCR-005: Conversation takeover and messaging
export type TakeoverMode = 'FULL_CONTROL' | 'CO_PILOT';
export type ConversationWireStatus = 'ACTIVE' | 'HUMAN_TAKEOVER' | 'CLOSED';

export interface ConversationTakeoverRequest {
  readonly reason: string;
  readonly takeover_mode: TakeoverMode;
}
export interface ConversationTakeoverResponse {
  readonly conversation_id: string;
  readonly status: 'HUMAN_TAKEOVER';
  readonly operator_id: string;
  readonly taken_over_at: string;
  readonly lease_expires_at: string;
}
export interface ConversationTakeoverHeartbeatRequest {
  readonly extend_seconds?: number | undefined;
}
export interface ConversationTakeoverHeartbeatResponse {
  readonly conversation_id: string;
  readonly status: 'HUMAN_TAKEOVER';
  readonly operator_id: string;
  readonly lease_expires_at: string;
}
export interface ConversationResumeRequest {
  readonly handoff_summary?: string | undefined;
  readonly next_agent_id?: string | undefined;
}
export interface ConversationResumeResponse {
  readonly conversation_id: string;
  readonly status: 'ACTIVE';
  readonly resumed_at: string;
}
export interface ConversationListParams {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}
export interface ConversationListResponse {
  readonly items: readonly Record<string, unknown>[];
  readonly next_cursor?: string | null | undefined;
  readonly nextCursor?: string | null | undefined;
}
export interface ConversationMessagesResponse {
  readonly items: readonly Record<string, unknown>[];
  readonly next_cursor?: string | null | undefined;
  readonly nextCursor?: string | null | undefined;
}
export interface ConversationSummaryResponse extends Record<string, unknown> {}
export interface CustomerListParams {
  readonly query?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}
export interface CustomerListResponse {
  readonly items: readonly Record<string, unknown>[];
  readonly next_cursor?: string | null | undefined;
  readonly nextCursor?: string | null | undefined;
}
export interface CustomerProfileResponse extends Record<string, unknown> {}
export interface PostMessageRequest {
  readonly message: string;
  readonly idempotency_key?: string | undefined;
  readonly module?: 'marketing' | 'sales' | 'support' | 'auto' | undefined;
  readonly attachments?: readonly string[] | undefined;
  readonly sender?: 'operator' | 'customer' | 'ai' | undefined;
}

// Durable task acknowledgement and storefront integration
export interface TaskAcceptedResponse {
  readonly task_id: string;
  readonly conversation_id: string | null;
  readonly status: TaskLifecycleState;
  readonly task_version: number;
  readonly correlation_id: string;
}
export interface StorefrontStreamRequest {
  readonly message: string;
  readonly idempotency_key: string;
  readonly session_id?: string | undefined;
  readonly module?: 'marketing' | 'sales' | 'support' | 'auto' | undefined;
  readonly attachments?: readonly string[] | undefined;
}
export interface PlatformEventEnvelope {
  readonly event_id: string;
  readonly event_type: string;
  readonly source: string;
  readonly occurred_at: string;
  readonly payload: Record<string, unknown>;
  readonly session_id?: string | undefined;
}
export interface EventIngestionResponse {
  readonly event_id: string;
  readonly correlation_id: string;
  readonly status: 'QUEUED' | 'IGNORED' | 'PROCESSED';
}

