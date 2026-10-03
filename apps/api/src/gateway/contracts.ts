/**
 * @file Frozen wire contract of the `/api/v1` gateway (implement/06 §1, §8; error vocabulary
 * `06` §1 + `08` §8).
 *
 * This module is the single declaration point for every request/response shape the gateway
 * serves. The route modules import from here and never re-declare a parallel shape, so the
 * Command Center, the storefront widget and the worker all read one contract (`02` §6
 * "Wire DTOs ... owned by `06`").
 *
 * It contains declarations only: no route reads business state from it and no policy rule lives
 * here. Error codes are the canonical vocabulary of `08` §8 — the `ErrorResponse.error_code`
 * enum in `06` §1 is an illustrative subset, and this module extends it rather than
 * re-spelling it (`06` §8.0).
 */

// ============================================================================
// Error envelope (`06` §1 `ErrorResponse`, `06` §8.0 conventions)
// ============================================================================

/** The `06` §1 baseline subset. */
export type BaselineErrorCode =
  | 'AUTHENTICATION_FAILED'
  | 'CUSTOMER_UNVERIFIED'
  | 'CAPABILITY_NOT_ENABLED'
  | 'VALIDATION_FAILED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'APPROVAL_REQUIRED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_REJECTED'
  | 'RATE_LIMITED'
  | 'TASK_NOT_FOUND';

/** The business-rule and admission vocabulary owned by `08` §8 and `05` §8.1. */
export type RuleErrorCode =
  | 'P_FLOOR_UNAVAILABLE'
  | 'ERR_FLOOR_PRICE_VIOLATION'
  | 'AUTHORITATIVE_SOURCE_UNAVAILABLE'
  | 'CONSENT_REQUIRED'
  | 'EFFECT_KEY_REQUIRED'
  | 'REQUIRE_HUMAN_APPROVAL'
  | 'INSUFFICIENT_AUTHORITY'
  | 'INVALID_CLEARANCE'
  | 'PROHIBITED_ACTION'
  | 'PROMPT_INJECTION_BLOCKED'
  | 'EVIDENCE_REQUIRED'
  | 'SKILL_NOT_FOUND'
  | 'SKILL_DISABLED';

/** Approval-claim refusals of `06` §8.1.1 / `04` §4.2. */
export type ApprovalErrorCode =
  | 'APPROVAL_STALE_PAYLOAD'
  | 'APPROVAL_NOT_CLAIMABLE'
  | 'APPROVAL_EXPIRED'
  | 'APPROVER_MUST_DIFFER';

/** Gateway-owned refusals that are not business rules. */
export type GatewayErrorCode =
  | 'VERSION_CONFLICT'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'CONVERSATION_NOT_FOUND'
  | 'CONVERSATION_LOCKED'
  | 'TAKEOVER_LEASE_HELD'
  | 'TAKEOVER_LEASE_LOST'
  | 'TAKEOVER_LEASE_EXPIRED'
  | 'CONNECTOR_NOT_FOUND'
  | 'SIGNATURE_INVALID'
  | 'TENANT_BINDING_MISMATCH'
  | 'UNKNOWN_SKILL'
  | 'RUN_NOT_RETRYABLE'
  | 'RUN_NOT_RECONCILABLE'
  | 'RUN_LEASE_HELD'
  /** Client event payload attempted to provide a server-owned evidence field (06 §8.1.1/§8.1.2). */
  | 'CUSTOMER_EVENT_RESERVED_PAYLOAD_FIELD'
  | 'TOO_MANY_ATTEMPTS'
  | 'PREREQUISITES_UNMET'
  | 'DEPENDENCY_MISCONFIGURED'
  | 'CAPABILITY_UNAVAILABLE'
  /** An invitation token was unknown, expired or already consumed (T9.3). */
  | 'INVITATION_INVALID'
  /** Test Customer Lab refused: the tenant's system of record cannot be seeded (T7.2). */
  | 'SOR_SEED_UNSUPPORTED'
  | 'INTERNAL_ERROR';
export type GatewayErrorCode_ = BaselineErrorCode | RuleErrorCode | ApprovalErrorCode | GatewayErrorCode;

/** `ErrorResponse` (`06` §1). */
export interface ErrorResponse {
  readonly error_code: GatewayErrorCode_;
  readonly message: string;
  readonly retryable: boolean;
  readonly correlation_id: string;
  readonly details?: Record<string, unknown>;
}

/**
 * Internal carrier for a refusal. Every gateway path raises one of these and the transport layer
 * maps it to the `ErrorResponse` envelope, so no route hand-rolls a status code or leaks a raw
 * driver/exception message into a response body (`08` §9 "all free-text errors sanitized").
 */
export interface GatewayFailure {
  readonly error_code: GatewayErrorCode_;
  readonly http_status: number;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

/** Canonical HTTP status per refusal code; `409` is never returned for an identical replay. */
export const FAILURE_STATUS: Readonly<Partial<Record<GatewayErrorCode_, number>>> = Object.freeze({
  AUTHENTICATION_FAILED: 401,
  SIGNATURE_INVALID: 401,
  TENANT_BINDING_MISMATCH: 403,
  CUSTOMER_UNVERIFIED: 403,
  APPROVER_MUST_DIFFER: 403,
  INSUFFICIENT_AUTHORITY: 403,
  INVALID_CLEARANCE: 403,
  PROHIBITED_ACTION: 403,
  CAPABILITY_NOT_ENABLED: 403,
  SOR_SEED_UNSUPPORTED: 422,
  CONNECTOR_NOT_FOUND: 403,
  P_FLOOR_UNAVAILABLE: 422,
  ERR_FLOOR_PRICE_VIOLATION: 422,
  AUTHORITATIVE_SOURCE_UNAVAILABLE: 422,
  CONSENT_REQUIRED: 422,
  EFFECT_KEY_REQUIRED: 422,
  EVIDENCE_REQUIRED: 422,
  PROMPT_INJECTION_BLOCKED: 422,
  VALIDATION_FAILED: 400,
  IDEMPOTENCY_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  APPROVAL_STALE_PAYLOAD: 409,
  APPROVAL_NOT_CLAIMABLE: 409,
  APPROVAL_EXPIRED: 409,
  CONVERSATION_LOCKED: 409,
  TAKEOVER_LEASE_HELD: 409,
  TAKEOVER_LEASE_LOST: 409,
  TAKEOVER_LEASE_EXPIRED: 409,
  RUN_NOT_RETRYABLE: 409,
  RUN_NOT_RECONCILABLE: 409,
  RUN_LEASE_HELD: 409,
  PREREQUISITES_UNMET: 409,
  CUSTOMER_EVENT_RESERVED_PAYLOAD_FIELD: 422,
  APPROVAL_REQUIRED: 409,
  REQUIRE_HUMAN_APPROVAL: 409,
  TASK_NOT_FOUND: 404,
  NOT_FOUND: 404,
  CONVERSATION_NOT_FOUND: 404,
  UNKNOWN_SKILL: 404,
  SKILL_NOT_FOUND: 404,
  SKILL_DISABLED: 422,
  RATE_LIMITED: 429,
  TOO_MANY_ATTEMPTS: 429,
  PROVIDER_TIMEOUT: 503,
  PROVIDER_REJECTED: 502,
  DEPENDENCY_MISCONFIGURED: 503,
  CAPABILITY_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
  METHOD_NOT_ALLOWED: 405,
  INVITATION_INVALID: 422,
});

// ============================================================================
// Principal and tenant binding (`06` §8.0 "Tenant binding")
// ============================================================================

/**
 * How the request proved who it is. The gateway resolves this server-side from the presented
 * credential; a body/query/header `tenant_id` is at most a routing hint and never the isolation
 * factor (`06` §8.0, NFR-006).
 */
export type PrincipalKind = 'OPERATOR' | 'CHANNEL_SESSION' | 'WIDGET_SESSION' | 'PROVIDER';

/** Operator permissions the baseline routes require. */
/** Operator permissions the baseline and configuration routes require. */
export type OperatorPermission =
  | 'approval:decide'
  | 'approval:read'
  | 'campaign:draft'
  | 'conversation:takeover'
  | 'run:read'
  | 'run:retry'
  | 'run:reconcile'
  | 'customer:read'
  | 'telemetry:read'
  | 'platform:admin'
  | 'settings:manage'
  | 'integration:manage'
  | 'llm:manage'
  | 'knowledge:manage'
  | 'knowledge:approve'
  | 'skills:manage'
  | 'agents:manage'
  | 'testdata:manage'
  | 'run:retry:company'
  | 'platform:providers:write'
  | 'platform:companies:write'
  | 'platform:audit:read';

export interface GatewayPrincipal {
  readonly kind: PrincipalKind;
  /** Resolved by the gateway from the authenticated session/credential (`03` §2 RLS context). */
  readonly tenant_id: string;
  /** Present for `OPERATOR`; the authenticated decision principal, never payload-only authority. */
  readonly operator_id?: string;
  /** Present for an operator: the audience scope bound to the account. */
  readonly scope?: 'company' | 'platform';
  /** Present for a channel session: the channel the signed credential was issued for. */
  readonly channel?: ChannelId;
  /** Present for a session-bound caller: the conversation/session the credential is bound to. */
  readonly conversation_id?: string;
  readonly session_id?: string;
  readonly permissions: readonly OperatorPermission[];
}

// ============================================================================
// Wire status projections (`06` §8.3 C-3, C-5, C-8)
// ============================================================================

/** `06` §8.3 C-3: the wire enum stays authoritative; storage keeps `03` §1's `conversations.state`. */
export type ConversationWireStatus = 'ACTIVE' | 'HUMAN_TAKEOVER' | 'CLOSED';

/**
 * `06` §8.3 C-8: wire `accepted` ↔ stored `queued`; every other value is identical. R02/R03
 * return this vocabulary; R16 returns the stored `03` vocabulary.
 */
export type TaskWireStatus =
  | 'accepted'
  | 'running'
  | 'waiting'
  | 'awaiting_human'
  | 'in_flight'
  | 'completed'
  | 'stopped'
  | 'failed';

/** `03` §1 `task_lifecycle_state`, returned verbatim by the R16 read model. */
export type TaskStoredState =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'awaiting_human'
  | 'completed'
  | 'stopped'
  | 'failed';

/** Baseline API-003 channels plus the ASM-001-gated extension channels (`06` §4.0). */
export type ChannelId =
  | 'WEB_CHAT'
  | 'APP_CHAT'
  | 'MESSENGER'
  | 'INSTAGRAM'
  | 'TIKTOK'
  | 'ZALO'
  | 'EMAIL'
  | 'SMS'
  | 'LINE'
  | 'WHATSAPP';

/**
 * The source channel a run is admitted under. It is a customer channel (see {@link ChannelId}) or
 * the operator-command channel the Marketing domain contract binds as
 * `MARKETING_SIGNAL_SOURCE_CHANNELS`, which no provider or browser turn can present.
 */
export type RunSourceChannel = ChannelId | 'MARKETING_CAMPAIGN';

/** The six SRS API-003 baseline channels; all other members are `[OPTIONAL-EXTENSION][ASM-001]`. */
export const BASELINE_CHANNELS: readonly ChannelId[] = Object.freeze([
  'WEB_CHAT',
  'APP_CHAT',
  'MESSENGER',
  'TIKTOK',
  'ZALO',
  'EMAIL',
  'SMS',
]);

export type AgentModule = 'marketing' | 'sales' | 'support' | 'auto';

// ============================================================================
// R01 — POST /api/v1/conversations
// ============================================================================

export interface CreateConversationRequest {
  readonly channel: ChannelId;
  readonly customer_identifier: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ConversationSessionResponse {
  readonly conversation_id: string;
  readonly session_token: string;
  readonly status: ConversationWireStatus;
  readonly created_at: string;
}

// ============================================================================
// R02 — POST /api/v1/conversations/{id}/messages
// ============================================================================

export const MESSAGE_MAX_LENGTH = 4000;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

export interface PostMessageRequest {
  readonly module?: AgentModule;
  readonly message: string;
  readonly idempotency_key: string;
  readonly attachments?: readonly string[];
  readonly event_type?: string;
}

export interface TaskAcceptedResponse {
  readonly task_id: string;
  /**
   * The conversation the run belongs to, or `null` when the run is not bound to one. R02 and R11
   * always carry it; R13 answers `202` for a re-queued run and carries it only when the run is
   * conversation-bound, because an empty string would read as a conversation that exists.
   */
  readonly conversation_id: string | null;
  readonly status: TaskWireStatus;
  readonly task_version: number;
  readonly correlation_id: string;
}

// ============================================================================
// R03 — GET /api/v1/tasks/{id}
// ============================================================================

export interface TaskSourceRef {
  readonly source_record_id: string;
  readonly source_version: string;
  readonly source_file: string;
}

export interface TaskActionRef {
  readonly operation: string;
  readonly status: string;
  readonly provider_reference: string;
}

export interface TaskErrorProjection {
  readonly code: string;
  readonly class: string | null;
}

export interface TaskStateResponse {
  readonly task_id: string;
  readonly task_version: number;
  readonly status: TaskWireStatus;
  readonly answer?: string;
  readonly sources?: readonly TaskSourceRef[];
  readonly actions?: readonly TaskActionRef[];
  readonly evidence_reference?: string;
  readonly error: TaskErrorProjection | null;
  readonly correlation_id: string;
}

// ============================================================================
// R04 / R12 — POST /api/v1/events and /api/v1/storefront/events
// ============================================================================

export interface PlatformEventEnvelope {
  readonly event_id: string;
  readonly event_type: string;
  readonly source: string;
  readonly occurred_at: string;
  readonly payload: Record<string, unknown>;
}

export type EventIngestionStatus = 'QUEUED' | 'IGNORED' | 'PROCESSED';

export interface EventIngestionResponse {
  readonly event_id: string;
  readonly correlation_id: string;
  readonly status: EventIngestionStatus;
}

// ============================================================================
// R05 — POST /api/v1/approvals/{id}/decision
// ============================================================================

/** The five baseline SCR-003 actions; there is no sixth decision and no `/execute` route. */
export type ApprovalDecision = 'APPROVE' | 'REJECT' | 'MODIFY' | 'PAUSE' | 'CANCEL';

export interface ApprovalDecisionRequest {
  readonly decision: ApprovalDecision;
  readonly operator_id: string;
  /** Mandatory rationale; `REJECT` additionally requires the standardized rejection code form. */
  readonly reason: string;
  /** Digest the approver actually reviewed; re-verified inside the claim transaction. */
  readonly expected_payload_sha256: string;
  readonly modified_payload?: Record<string, unknown>;
}

/** The decision is queued as a durable worker handoff; the worker performs the guarded claim. */
export type ApprovalDecisionStatus = 'QUEUED';

export interface ApprovalDecisionResponse {
  readonly approval_id: string;
  readonly task_id: string;
  readonly status: ApprovalDecisionStatus;
  readonly queued_at: string;
  readonly correlation_id: string;
}

// ============================================================================
// R14 — GET /api/v1/approvals?status=PENDING  (+ §8.2.1 detail read)
// ============================================================================

/** Queue filters: the pending projection (`06` §8.1.3 R14) and the processed (decided) history. */
export type ApprovalQueueFilter = 'PENDING' | 'DECIDED';
/** Detail reads may report an approval that crossed its deadline. */
export type ApprovalQueueStatus =
  | 'PENDING'
  | 'EXPIRED'
  | 'APPROVED'
  | 'MODIFIED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'PAUSED';

/**
 * Reviewer-facing summary of an approval (`T6.8`): the sentence, context and evidence a human needs
 * to understand what they are about to authorize, without reading the raw payload.
 */
export interface ApprovalSummary {
  /** i18n key of the card sentence ("Gửi chiến dịch 'X' cho 320 khách qua Email"). */
  readonly title_key: string;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  /** Display key of the agent/skill that requested the approval. */
  readonly requesting_agent_key: string;
  /** Business domain the approval belongs to. */
  readonly domain: 'marketing' | 'sales' | 'care' | 'platform';
  readonly campaign_id: string | null;
  readonly customer_id: string | null;
  /** Coarse risk derived from the required authority. */
  readonly risk: 'low' | 'medium' | 'high';
  readonly evidence_count: number;
  /** MODIFY payloads; `before` is absent for legacy rows without a persisted original snapshot. */
  readonly modification: { readonly before?: unknown; readonly after: unknown } | null;
  readonly expires_at: string;
}

export interface ApprovalQueueItem {
  readonly approval_id: string;
  readonly run_id: string;
  readonly action_id: string;
  readonly effect_key: string;
  readonly payload: Record<string, unknown>;
  readonly reason: string;
  readonly status: ApprovalQueueStatus;
  readonly is_paused: boolean;
  readonly decided_by: string | null;
  readonly decided_at: string | null;
  readonly decision_notes: string | null;
  readonly created_at: string;
  /** Computed server-side (`06` §8.2.1); the decision precondition the approver reviewed. */
  readonly payload_sha256: string;
  /** Reviewer-facing sentence, context, risk and evidence (`T6.8`, spec §7.7). */
  readonly summary: ApprovalSummary;
}

/** `06` §8.2.1: the same item plus the reviewer-visible fields SCR-003 renders. */
export interface ApprovalDetailResponse extends ApprovalQueueItem {
  readonly tenant_id: string;
  readonly expires_at: string;
}

// ============================================================================
// R06 / R07 / R08 — conversation control
// ============================================================================

/**
 * `06` §8.3 C-2: the enum stays `FULL_CONTROL`/`CO_PILOT`; `HUMAN_ACTIVE` is display wording and
 * an unknown value is rejected `400`.
 */
export type TakeoverMode = 'FULL_CONTROL' | 'CO_PILOT';

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

// ============================================================================
// R11 — storefront
// ============================================================================

/** R11: a storefront chat turn — the R02 body plus an optional first-turn session binding. */
export interface StorefrontStreamRequest extends PostMessageRequest {
  readonly session_id?: string;
}

// ============================================================================
// R13 — POST /api/v1/operations/runs/{run_id}/retry
// ============================================================================

/**
 * The four verified side-effect-free failure classes of `06` §1.1 R13. An `UNKNOWN` outcome is
 * deliberately absent: it is never resolved with a blind retry.
 */
export type RetryableFailureClass =
  | 'SCHEMA_VALIDATION_FAILURE'
  | 'AUTHORITY_DENY'
  | 'FAIL_CLOSED'
  | 'PRE_DISPATCH_PROVIDER_REJECTION';

export interface RunRetryRequest {
  readonly operator_id?: string;
  readonly reason?: string;
}

// ============================================================================
// R18 — POST /api/v1/operations/runs/{run_id}/reconciliation
// ============================================================================

export type ReconciliationResolution =
  | 'PROVIDER_CONFIRMED_SUCCEEDED'
  | 'PROVIDER_CONFIRMED_ABSENT'
  | 'ESCALATE_MANUALLY';

export interface ReconciliationRequest {
  readonly resolution: ReconciliationResolution;
  readonly receipt?: Record<string, unknown>;
  readonly reason: string;
}

// ============================================================================
// R15 — GET /api/v1/customers/{customer_id}/timeline
// ============================================================================

/** The ten-stage projection vocabulary (`03` §8). */
export type EvidenceClassification = 'FACT' | 'SIGNAL' | 'HYPOTHESIS' | 'DECISION' | 'ACTION';
export type TimelineDomain = 'MARKETING' | 'SALES' | 'COMMERCE' | 'SUPPORT' | 'ORCHESTRATOR';

export interface TimelineEntry {
  readonly occurred_at: string;
  readonly source_record_id?: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly stage: string;
  readonly canonical_event: string | null;
  readonly classification: EvidenceClassification;
  readonly domain?: TimelineDomain;
  readonly summary?: string;
  readonly evidence_reference?: string;
  /** A gap is returned explicitly, never as a fabricated zero entry (06 §8.1.3 R15). */
  readonly gap_reason?: string;
}

// ============================================================================
// R16 — GET /api/v1/runs
// ============================================================================

export interface RunStepProjection {
  readonly step_index: number;
  readonly skill: string;
  readonly tool: string;
  readonly authority: string;
  readonly approval: string;
  readonly action: string;
  readonly execution_status:
    | 'pending'
    | 'executing'
    | 'success'
    | 'failed'
    | 'denied'
    | 'aborted';
  readonly evidence: string | null;
  readonly outcome: string | null;
  readonly error: string | null;
  readonly latency_ms: number;
  readonly cost: number | null;
  readonly started_at: string;
  readonly completed_at: string | null;
}

export interface RunProjection {
  readonly run_id: string;
  readonly domain: string;
  readonly agents: readonly string[];
  readonly title_key: string;
  readonly title_params: Readonly<Record<string, string | number | boolean>>;
  readonly state: TaskStoredState;
  readonly state_business: string;
  readonly state_raw: TaskStoredState;
  readonly created_at: string;
  readonly updated_at: string;
  readonly duration_ms: number;
  readonly cost: { readonly amount: number; readonly currency: string } | null;
  readonly tokens: { readonly input: number; readonly output: number; readonly total: number };
  readonly attempts: number;
  readonly failure: { readonly code: string; readonly reason_key: string; readonly class: string } | null;
  readonly retry_eligibility: { readonly retryable: boolean; readonly reason_code: string };
  readonly needs_reconciliation: boolean;
  /** Existing operator-console detail retained until its consumer migrates to the story/trace routes. */
  readonly task_version: number;
  readonly current_step: number;
  readonly retry_count: number;
  readonly last_error_class: 'RETRYABLE' | 'FATAL' | null;
  readonly steps: readonly RunStepProjection[];
  readonly correlation_id: string;
}


// ============================================================================
// Pagination (`06` §8.0 conventions: cursor-based, never page numbers or offsets)
// ============================================================================

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}
