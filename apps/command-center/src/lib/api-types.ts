/**
 * @file apps/command-center/src/lib/api-types.ts
 * Authoritative wire DTOs and shared status/state vocabulary for the Command Center.
 * Aligned with implement/06-api-and-connectors-spec.md and implement/07-human-command-center-ui.md.
 *
 * Rules:
 * - Browser-safe local types only; no direct imports from workspace runtime packages.
 * - Base API prefix is /api/v1.
 * - Reflects exact wire names with broad compatibility for screen slices.
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
 * Five-tier evidence separation per FR-C360-003 and 07 §5.3.
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
 * Task lifecycle state vocabulary.
 * Wire acknowledgement uses 'accepted' (R02/R03); durable store reports 'queued'.
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
  readonly details?: Record<string, unknown> | unknown;
}

// ============================================================================
// 3. R14: Approval Center & SCR-003 Decisions
// ============================================================================

/**
 * Baseline SCR-003 operator actions sent to POST /api/v1/approvals/{id}/decision.
 */
export type ApprovalDecision = 'APPROVE' | 'REJECT' | 'MODIFY' | 'PAUSE' | 'CANCEL';

/**
 * Approval status enum.
 * AWAITING_HUMAN and PAUSED describe undecided queue items (PAUSED = stored PENDING + is_paused=TRUE).
 * APPROVED, REJECTED, MODIFIED, CANCELLED describe decided outcomes.
 */
export type ApprovalStatus =
  | 'AWAITING_HUMAN'
  | 'PENDING'
  | 'PAUSED'
  | 'APPROVED'
  | 'REJECTED'
  | 'MODIFIED'
  | 'CANCELLED';

/** Query parameters for R14 GET /api/v1/approvals */
export interface GetApprovalsParams {
  status?: 'PENDING';
  cursor?: string;
  limit?: number;
}

/** Wire item projection from R14 approval queue and supplemental detail read */
export interface ApprovalQueueItem {
  readonly approval_id: string;
  readonly run_id: string;
  readonly action_id: string;
  readonly effect_key: string;
  readonly payload: Record<string, unknown>;
  readonly reason: string;
  readonly status: 'PENDING' | ApprovalStatus;
  readonly is_paused: boolean;
  readonly decided_by?: string | null;
  readonly decided_at?: string | null;
  readonly decision_notes?: string | null;
  readonly created_at: string;
  /** SHA-256 digest of canonical reviewed payload; mandatory precondition for decisions */
  readonly payload_sha256: string;
  readonly expires_at?: string | null;
  // Broad compatibility fields for UI consumers
  readonly id?: string;
  readonly title?: string;
  readonly agent_id?: string;
  readonly customer_id?: string;
}

export interface GetApprovalsResponse {
  readonly items: readonly ApprovalQueueItem[];
  readonly next_cursor?: string | null;
  readonly total_count?: number;
}

/** Supplemental approval detail read: GET /api/v1/approvals/{id} */
export interface ApprovalDetailResponse {
  readonly approval_id: string;
  readonly run_id: string;
  readonly action_id: string;
  readonly effect_key: string;
  readonly payload: Record<string, unknown>;
  readonly reason: string;
  readonly status: ApprovalStatus;
  readonly is_paused: boolean;
  readonly payload_sha256: string;
  readonly created_at: string;
  readonly expires_at?: string | null;
  readonly decided_by?: string | null;
  readonly decided_at?: string | null;
  readonly decision_notes?: string | null;
  readonly agent_id?: string;
  readonly correlation_id?: string;
}

/** Wire request payload for POST /api/v1/approvals/{id}/decision */
export interface ApprovalDecisionRequest {
  readonly decision: ApprovalDecision;
  readonly operator_id: string;
  readonly reason: string;
  /** SHA-256 of reviewed payload; server refuses stale reviews with 409 APPROVAL_STALE_PAYLOAD */
  readonly expected_payload_sha256: string;
  /** Required when decision is MODIFY; triggers fresh validation */
  readonly modified_payload?: Record<string, unknown>;
}

/** Wire response from POST /api/v1/approvals/{id}/decision */
export interface ApprovalDecisionResponse {
  readonly approval_id: string;
  readonly task_id: string;
  readonly status: 'APPROVED' | 'REJECTED' | 'MODIFIED' | 'PAUSED' | 'CANCELLED';
  readonly decided_at: string;
  readonly correlation_id: string;
}

// ============================================================================
// 4. R15: Customer 360 & Timeline (SCR-004)
// ============================================================================

export interface CustomerTimelineParams {
  cursor?: string;
  limit?: number;
  from?: string;
  to?: string;
}

export interface EvidenceRecordRef {
  readonly system: string;
  readonly external_id: string;
  readonly verified_at: string;
}

export interface TimelineEvidenceCard {
  readonly evidence_id: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly classification: EvidenceClassification;
  readonly source_of_truth:
    | 'ERP'
    | 'POS'
    | 'WMS'
    | 'PAYMENT_GATEWAY'
    | 'AI_INFERENCE'
    | 'PLATFORM_ORCHESTRATOR';
  readonly confidence_score: number;
  readonly raw_record_ref?: EvidenceRecordRef;
  readonly payload: Record<string, unknown>;
}

export interface CustomerTimelineEntry {
  readonly occurred_at: string;
  readonly source_record_id: string;
  readonly event_name: string;
  readonly stage?: string;
  readonly classification: EvidenceClassification;
  readonly evidence_reference?: string;
  readonly evidence_card?: TimelineEvidenceCard;
  readonly summary?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface CustomerTimelineResponse {
  readonly customer_id: string;
  readonly identity_tier?:
    | 'TIER_0'
    | 'TIER_1'
    | 'TIER_2'
    | 'ANONYMOUS_GUEST'
    | 'IDENTIFIED_LEAD'
    | 'VERIFIED_CUSTOMER';
  readonly entries: readonly CustomerTimelineEntry[];
  readonly next_cursor?: string | null;
  readonly has_more?: boolean;
  readonly gap_detected?: boolean;
}

// ============================================================================
// 5. R16: Agent Operations & Runs (SCR-002)
// ============================================================================

export interface GetRunsParams {
  cursor?: string;
  limit?: number;
  agent_id?: string;
  state?: string;
  status?: string;
  from?: string;
  to?: string;
}

export interface AgentRunStep {
  readonly step_number?: number;
  readonly skill: string;
  readonly tool: string;
  readonly authority: AuthorityVerdict;
  readonly approval?: string | null;
  readonly action?: string;
  readonly execution_status: StepExecutionStatus;
  readonly evidence?: string;
  readonly outcome?: string;
  readonly latency_ms: number;
  readonly cost?: number;
  readonly error?: string | null;
}

export interface AgentRunProjection {
  readonly run_id: string;
  readonly tenant_id?: string;
  readonly agent_id: string;
  readonly state: TaskLifecycleState;
  readonly task_version: number;
  readonly current_step?: number;
  readonly retry_count: number;
  readonly last_error_class?: string | null;
  readonly steps?: readonly AgentRunStep[];
  readonly latency_ms?: number;
  readonly cost?: number;
  readonly error?: string | null;
  readonly started_at: string;
  readonly completed_at?: string | null;
  // Broad compatibility fields for virtualized table UI
  readonly trigger?: string;
  readonly skill?: string;
  readonly tool?: string;
  readonly authority?: AuthorityVerdict;
  readonly execution_status?: StepExecutionStatus;
  readonly token_usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_cost_twd: number;
  };
}

export interface GetRunsResponse {
  readonly runs: readonly AgentRunProjection[];
  readonly next_cursor?: string | null;
  readonly total_count?: number;
}

/** R13 operator retry request for failed, side-effect-free runs */
export interface RunRetryRequest {
  readonly operator_id?: string;
  readonly reason?: string;
}

// ============================================================================
// 6. R17: Executive KPI Snapshot & Realtime Telemetry (SCR-001)
// ============================================================================

export interface GetKpiSnapshotParams {
  window?: string;
  timezone?: string;
  cursor?: string;
  limit?: number;
}

export interface KpiMetricItem<T = unknown> {
  readonly name?: string;
  readonly value: T | null;
  readonly source_status: SourceStatus;
  readonly observed_at: string | null;
  readonly window?: string;
  readonly timezone?: string;
  readonly provisional?: boolean;
  readonly note?: string;
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
  readonly tenant_id?: string;
  readonly observed_at?: string;
  readonly timestamp?: string;
  readonly window?: string;
  readonly timezone?: string;
  readonly metrics: Record<string, KpiMetricItem<unknown>> & Partial<BaselineMetricsCollection>;
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
  readonly retry?: number;
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
  readonly handoff_summary?: string;
  readonly next_agent_id?: string;
}

export interface ConversationResumeResponse {
  readonly conversation_id: string;
  readonly status: 'ACTIVE';
  readonly resumed_at: string;
}

export interface PostMessageRequest {
  readonly message: string;
  readonly idempotency_key: string;
  readonly module?: 'marketing' | 'sales' | 'support' | 'auto';
  readonly attachments?: readonly string[];
  readonly sender?: 'operator' | 'customer' | 'ai';
}

// ============================================================================
// 8. Durable Tasks & Storefront
// ============================================================================

export interface TaskAcceptedResponse {
  readonly task_id: string;
  readonly conversation_id?: string;
  readonly status: TaskLifecycleState;
  readonly task_version: number;
  readonly correlation_id: string;
}

export interface TaskStateResponse {
  readonly task_id: string;
  readonly task_version: number;
  readonly status: TaskLifecycleState;
  readonly answer?: string;
  readonly sources?: readonly {
    readonly source_record_id: string;
    readonly source_version: string;
    readonly source_file: string;
  }[];
  readonly actions?: readonly {
    readonly operation: string;
    readonly status: string;
    readonly provider_reference: string;
  }[];
  readonly evidence_reference?: string;
  readonly correlation_id: string;
}

export interface StorefrontStreamRequest {
  readonly message: string;
  readonly idempotency_key: string;
  readonly session_id?: string;
  readonly module?: 'marketing' | 'sales' | 'support' | 'auto';
  readonly attachments?: readonly string[];
}

export interface PlatformEventEnvelope {
  readonly event_id: string;
  readonly event_type: string;
  readonly source: string;
  readonly occurred_at: string;
  readonly payload: Record<string, unknown>;
  readonly session_id?: string;
}

export interface EventIngestionResponse {
  readonly event_id: string;
  readonly correlation_id: string;
  readonly status: 'QUEUED' | 'IGNORED' | 'PROCESSED';
}
