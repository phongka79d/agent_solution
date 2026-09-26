/**
 * @file apps/command-center/src/lib/api-types.ts
 * Authoritative wire DTOs and shared status/state vocabulary for the Command Center.
 * Aligned with apps/api/src/gateway/contracts.ts, implement/06-api-and-connectors-spec.md,
 * and implement/07-human-command-center-ui.md.
 *
 * Rules:
 * - Browser-safe local types only; no direct imports from workspace runtime packages.
 * - Base API prefix is /api/v1.
 * - Exact wire contracts aligned to authoritative backend definitions.
 * - Strict exactOptionalPropertyTypes compatibility (explicit | undefined on optional properties).
 */

// ============================================================================
// 1. Shared State & Status Vocabulary
// ============================================================================

/**
 * Shared UI state vocabulary per 07 §9.
 * Reflects operational reality without implying success without receipt.
 */
export type SharedUiState =
  | 'idle'
  | 'loading'
  | 'empty'
  | 'partial'
  | 'stale'
  | 'permission_denied'
  | 'dependency_unavailable'
  | 'version_conflict'
  | 'fail_closed';

/**
 * Telemetry source status per 06 §8.1.3 (R17) and 07 §9.
 * A metric without upstream source returns NOT_INSTRUMENTED; an instrumented but empty
 * window returns NO_DATA. Never fabricated zeros or demo values.
 */
export type SourceStatus =
  | 'LIVE'
  | 'STALE'
  | 'NO_DATA'
  | 'NOT_INSTRUMENTED'
  | 'UNAVAILABLE'
  | 'FAIL_CLOSED';

/**
 * Five-tier evidence separation per FR-C360-003, 07 §5.3, and 06 §8.1.3 R15.
 * Separates recorded ground truth from AI hypothesis.
 */
export type EvidenceClassification =
  | 'FACT'
  | 'SIGNAL'
  | 'HYPOTHESIS'
  | 'DECISION'
  | 'ACTION';

/**
 * Authority routing verdicts per 07 §3.3 and 06 §8.1 R16.
 * AUTH-4 marks high-risk human approval; AUTH-5 is a hard deny.
 */
export type AuthorityVerdict =
  | 'AUTH-0'
  | 'AUTH-1'
  | 'AUTH-2'
  | 'AUTH-3'
  | 'AUTH-4'
  | 'AUTH-5';

/**
 * Task lifecycle wire state vocabulary (06 §8.3 C-8).
 * Wire acknowledgement uses 'accepted' (R02/R03/R13); durable store reports 'queued' (R16).
 */
export type TaskWireStatus =
  | 'accepted'
  | 'running'
  | 'waiting'
  | 'awaiting_human'
  | 'completed'
  | 'stopped'
  | 'failed';

/**
 * Task stored state vocabulary (03 §1 task_lifecycle_state).
 */
export type TaskStoredState =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'awaiting_human'
  | 'completed'
  | 'stopped'
  | 'failed';

/**
 * Task lifecycle union vocabulary across wire and stored states.
 */
export type TaskLifecycleState =
  | 'accepted'
  | 'queued'
  | 'running'
  | 'waiting'
  | 'awaiting_human'
  | 'completed'
  | 'stopped'
  | 'failed';

/** Run step execution status per 06 §8.1.3 R16. */
export type StepExecutionStatus =
  | 'pending'
  | 'executing'
  | 'success'
  | 'failed'
  | 'denied'
  | 'aborted';

// ============================================================================
// 2. Standard API Error Envelope
// ============================================================================

/**
 * Standard gateway error response envelope (06 §1 ErrorResponse).
 */
export interface ApiErrorEnvelope {
  readonly error_code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly correlation_id: string;
  readonly details?: Record<string, unknown> | unknown | undefined;
}

// ============================================================================
// 3. R14: Approval Center & SCR-003 Decisions
// ============================================================================

/**
 * Baseline SCR-003 operator actions sent to POST /api/v1/approvals/{id}/decision.
 */
export type ApprovalDecision = 'APPROVE' | 'REJECT' | 'MODIFY' | 'PAUSE' | 'CANCEL';

/**
 * Approval decision status returned by POST /api/v1/approvals/{id}/decision (R05 queue-first contract).
 */
export type ApprovalDecisionStatus = 'QUEUED';

/**
 * Approval status enum across queue and outcomes.
 */
export type ApprovalStatus =
  | 'AWAITING_HUMAN'
  | 'PENDING'
  | 'PAUSED'
  | 'APPROVED'
  | 'REJECTED'
  | 'MODIFIED'
  | 'CANCELLED'
  | 'QUEUED';

/** Query parameters for R14 GET /api/v1/approvals */
export interface GetApprovalsParams {
  status?: 'PENDING' | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

/** Wire item projection from R14 approval queue (06 §8.1.3 R14) */
export interface ApprovalQueueItem {
  readonly approval_id: string;
  readonly run_id: string;
  readonly action_id: string;
  readonly effect_key: string;
  readonly payload: Record<string, unknown>;
  readonly reason: string;
  readonly status: 'PENDING' | ApprovalStatus;
  readonly is_paused: boolean;
  readonly decided_by: string | null;
  readonly decided_at: string | null;
  readonly decision_notes: string | null;
  readonly created_at: string;
  /** SHA-256 digest of canonical reviewed payload; mandatory precondition for decisions */
  readonly payload_sha256: string;
  readonly expires_at?: string | null | undefined;
  // Broad compatibility fields for UI consumers
  readonly id?: string | undefined;
  readonly title?: string | undefined;
  readonly agent_id?: string | undefined;
  readonly customer_id?: string | undefined;
}

/** Wire response from GET /api/v1/approvals */
export interface GetApprovalsResponse {
  readonly items: readonly ApprovalQueueItem[];
  readonly next_cursor: string | null;
  readonly total_count?: number | undefined;
}

/** Supplemental approval detail read: GET /api/v1/approvals/{id} (06 §8.2.1) */
export interface ApprovalDetailResponse extends ApprovalQueueItem {
  readonly tenant_id: string;
  readonly expires_at: string | null;
  readonly correlation_id?: string | undefined;
}

/** Wire request payload for POST /api/v1/approvals/{id}/decision */
export interface ApprovalDecisionRequest {
  readonly decision: ApprovalDecision;
  readonly operator_id: string;
  readonly reason: string;
  /** SHA-256 of reviewed payload; server refuses stale reviews with 409 APPROVAL_STALE_PAYLOAD */
  readonly expected_payload_sha256: string;
  /** Required when decision is MODIFY; triggers fresh validation */
  readonly modified_payload?: Record<string, unknown> | undefined;
}

/** Wire response from POST /api/v1/approvals/{id}/decision (R05 queue-first contract) */
export interface ApprovalDecisionResponse {
  readonly approval_id: string;
  readonly task_id: string;
  readonly status: ApprovalDecisionStatus;
  readonly queued_at: string;
  readonly correlation_id: string;
}

// ============================================================================
// 4. R15: Customer 360 & Timeline (SCR-004)
// ============================================================================

export interface CustomerTimelineParams {
  cursor?: string | undefined;
  limit?: number | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/** R15 wire timeline entry projection (06 §8.1.3 R15 / 03 §8) */
export interface TimelineEntry {
  readonly occurred_at: string;
  readonly source_record_id: string;
  readonly event_id: string;
  readonly stage: string;
  readonly canonical_event: string | null;
  readonly classification: EvidenceClassification;
  readonly evidence_reference: string | null;
  /** A gap is returned explicitly, never as a fabricated zero entry */
  readonly gap_reason?: string | undefined;
}

export type CustomerTimelineEntry = TimelineEntry;

/**
 * The verified Customer 360 profile a timeline read MAY carry alongside its page.
 *
 * R15 sends it only when it resolved a tenant-scoped profile for the requesting operator, so every
 * field is optional: an absent field is rendered as absent, never defaulted. A read that supplies
 * no `customer` renders no profile banner rather than a synthesized one.
 */
export interface CustomerTimelineProfile {
  readonly customer_id?: string | undefined;
  readonly name?: string | undefined;
  readonly tier?: string | undefined;
  readonly ltv_twd?: number | undefined;
  readonly aov_twd?: number | undefined;
  readonly churn_risk_score?: number | undefined;
}

/** Wire response from GET /api/v1/customers/{customer_id}/timeline */
export interface CustomerTimelineResponse {
  readonly items: readonly TimelineEntry[];
  readonly next_cursor: string | null;
  // Broad compatibility fields
  readonly entries?: readonly TimelineEntry[] | undefined;
  readonly events?: readonly TimelineEntry[] | undefined;
  readonly gaps?: readonly Record<string, unknown>[] | undefined;
  readonly nextCursor?: string | null | undefined;
  readonly customer_id?: string | undefined;
  /** Present only when the read resolved a verified, tenant-scoped profile. */
  readonly customer?: CustomerTimelineProfile | undefined;
}

// ============================================================================
// 5. R16: Agent Operations & Runs (SCR-002)
// ============================================================================

export interface GetRunsParams {
  cursor?: string | undefined;
  limit?: number | undefined;
  agent_id?: string | undefined;
  state?: string | undefined;
  status?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export interface AgentRunStep {
  readonly step_index?: number | undefined;
  readonly step_number?: number | undefined;
  readonly skill: string;
  readonly tool: string;
  readonly authority: AuthorityVerdict | string;
  readonly approval?: string | null | undefined;
  readonly action?: string | undefined;
  readonly execution_status: StepExecutionStatus;
  readonly evidence?: string | null | undefined;
  readonly outcome?: string | null | undefined;
  readonly latency_ms: number;
  readonly cost?: number | undefined;
  readonly error?: string | null | undefined;
  readonly started_at?: string | undefined;
  readonly completed_at?: string | null | undefined;
}

export interface AgentRunProjection {
  readonly run_id: string;
  readonly tenant_id?: string | undefined;
  readonly agent_id?: string | undefined;
  readonly state: TaskLifecycleState;
  readonly task_version: number;
  readonly current_step?: number | undefined;
  readonly retry_count: number;
  readonly last_error_class?: 'RETRYABLE' | 'FATAL' | string | null | undefined;
  readonly steps?: readonly AgentRunStep[] | undefined;
  readonly latency_ms?: number | undefined;
  readonly cost?: number | undefined;
  readonly error?: string | null | undefined;
  readonly started_at?: string | undefined;
  readonly completed_at?: string | null | undefined;
  readonly correlation_id?: string | undefined;
  // Broad compatibility fields for virtualized table UI
  readonly trigger?: string | undefined;
  readonly skill?: string | undefined;
  readonly tool?: string | undefined;
  readonly authority?: AuthorityVerdict | undefined;
  readonly execution_status?: StepExecutionStatus | undefined;
  readonly token_usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_cost_twd: number;
  } | undefined;
}

export interface GetRunsResponse {
  readonly items: readonly AgentRunProjection[];
  readonly next_cursor: string | null;
  readonly total_count?: number | undefined;
}

/** R13 operator retry request for failed, side-effect-free runs */
export interface RunRetryRequest {
  readonly operator_id?: string | undefined;
  readonly reason?: string | undefined;
}

// ============================================================================
// 6. R17: Executive KPI Snapshot & Realtime Telemetry (SCR-001)
// ============================================================================

export interface GetKpiSnapshotParams {
  window?: string | undefined;
  timezone?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
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

/** Telemetry SSE stream frame contract per 07 §10 */
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

// ============================================================================
// 7. Conversation Controls (SCR-005)
// ============================================================================

export type TakeoverMode = 'FULL_CONTROL' | 'CO_PILOT';
export type ConversationWireStatus = 'ACTIVE' | 'HUMAN_TAKEOVER' | 'CLOSED';

export interface ConversationTakeoverRequest {
  readonly operator_id: string;
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
  readonly operator_id: string;
  readonly extend_seconds: number;
}

export interface ConversationTakeoverHeartbeatResponse {
  readonly conversation_id: string;
  readonly status: 'HUMAN_TAKEOVER';
  readonly operator_id: string;
  readonly lease_expires_at: string;
}

export interface ConversationResumeRequest {
  readonly operator_id: string;
  readonly handoff_summary?: string | undefined;
  readonly next_agent_id?: string | undefined;
}

export interface ConversationResumeResponse {
  readonly conversation_id: string;
  readonly status: 'ACTIVE';
  readonly resumed_at: string;
}

export interface PostMessageRequest {
  readonly message: string;
  readonly idempotency_key: string;
  readonly module?: 'marketing' | 'sales' | 'support' | 'auto' | undefined;
  readonly attachments?: readonly string[] | undefined;
  readonly sender?: 'operator' | 'customer' | 'ai' | undefined;
}

// ============================================================================
// 8. Durable Tasks & Storefront
// ============================================================================

export interface TaskAcceptedResponse {
  readonly task_id: string;
  readonly conversation_id: string | null;
  readonly status: TaskLifecycleState;
  readonly task_version: number;
  readonly correlation_id: string;
}

export interface TaskStateResponse {
  readonly task_id: string;
  readonly task_version: number;
  readonly status: TaskLifecycleState;
  readonly answer?: string | undefined;
  readonly sources?: readonly {
    readonly source_record_id: string;
    readonly source_version: string;
    readonly source_file: string;
  }[] | undefined;
  readonly actions?: readonly {
    readonly operation: string;
    readonly status: string;
    readonly provider_reference: string;
  }[] | undefined;
  readonly evidence_reference?: string | undefined;
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
