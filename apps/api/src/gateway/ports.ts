/**
 * @file Ports the `/api/v1` gateway consumes (implement/06 §8, §10.1).
 *
 * The route modules depend on these declarations and never on a concrete implementation: the
 * composition root (`apps/api/src/runtime/`) binds the durable stores, the skill layer and the
 * adapter registry to them, so a route can be exercised against the real orchestrator or an
 * alternate binding without the route changing.
 *
 * Every port is tenant-scoped by signature. `tenant_id` is resolved server-side from the
 * authenticated principal (`06` §8.0) and is never read from a body, query or client header.
 */

import type { IEffectGuard } from '@agentos/core-engine/contracts';

import type {
  ApprovalDecision,
  ApprovalDetailResponse,
  ApprovalQueueItem,
  ApprovalQueueFilter,
  ChannelId,
  CursorPage,
  EventIngestionStatus,
  GatewayErrorCode_,
  KpiSnapshotResponse,
  ReconciliationResolution,
  RetryableFailureClass,
  RunProjection,
  TaskSourceRef,
  TaskStoredState,
  TelemetryFrame,
  TimelineEntry,
} from './contracts.js';

// ============================================================================
// Conversations (`03` §1 Entity 11 + 11.1)
// ============================================================================

/** Stored vocabulary of `conversations.state`; the wire projection is `06` §8.3 C-3. */
export type ConversationState = 'open' | 'paused_takeover' | 'closed';

export interface ConversationRecord {
  readonly conversation_id: string;
  readonly tenant_id: string;
  readonly customer_id: string | null;
  readonly channel: ChannelId;
  readonly external_thread_id: string;
  readonly active_agent: string;
  readonly state: ConversationState;
  readonly takeover_operator_id: string | null;
  readonly last_message_at: string;
  readonly created_at: string;
  /** `true` when this call bound an existing `(tenant, channel, external_thread_id)` row. */
  readonly bound: boolean;
}

export interface ConversationMessageInput {
  readonly tenant_id: string;
  readonly conversation_id: string;
  readonly sender_type: 'customer' | 'agent' | 'operator' | 'system';
  readonly sender_id: string;
  readonly content: string;
  readonly content_type?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ConversationPort {
  /**
   * Bind-or-create on `uq_conversations_tenant_thread`: a repeated R01 for the same thread
   * returns the existing conversation instead of inserting a second one.
   */
  bindOrCreate(input: {
    tenant_id: string;
    channel: ChannelId;
    external_thread_id: string;
    customer_id: string | null;
    active_agent?: string;
  }): Promise<ConversationRecord>;
  get(tenant_id: string, conversation_id: string): Promise<ConversationRecord | null>;
  /** Moves `conversations.state`; the wire value is never stored (`06` §8.3 C-3). */
  setState(
    tenant_id: string,
    conversation_id: string,
    state: ConversationState,
    takeover_operator_id: string | null,
  ): Promise<void>;
  appendMessage(input: ConversationMessageInput): Promise<void>;
  /** Server-issued session token bound to the conversation credential (`06` §8.0 tenant binding). */
  issueSessionToken(input: {
    tenant_id: string;
    conversation_id: string;
    channel: ChannelId;
  }): Promise<string>;
}

// ============================================================================
// Takeover lease (`03` §3 key registry; `06` §8.3 C-4: 60 s TTL, renewable)
// ============================================================================

export type TakeoverLeaseOutcome = 'ACQUIRED' | 'RENEWED' | 'HELD_BY_ANOTHER_OPERATOR' | 'NOT_HELD' | 'EXPIRED';

export interface TakeoverLease {
  readonly operator_id: string;
  readonly expires_at: string;
}

export interface TakeoverLeasePort {
  /** Single-key compare-and-set; a re-issue by the same operator renews instead of stacking. */
  acquire(input: {
    tenant_id: string;
    conversation_id: string;
    operator_id: string;
    ttl_seconds: number;
  }): Promise<{ outcome: TakeoverLeaseOutcome; lease: TakeoverLease | null }>;
  /** Extends, never creates: a lease that lapsed is `EXPIRED`, one held elsewhere is refused. */
  renew(input: {
    tenant_id: string;
    conversation_id: string;
    operator_id: string;
    extend_seconds: number;
  }): Promise<{ outcome: TakeoverLeaseOutcome; lease: TakeoverLease | null }>;
  /** Owner-checked release; a repeat when no lease is held is a no-op, never a double release. */
  release(input: {
    tenant_id: string;
    conversation_id: string;
    operator_id: string;
  }): Promise<{ outcome: TakeoverLeaseOutcome; lease: TakeoverLease | null }>;
  holder(tenant_id: string, conversation_id: string): Promise<TakeoverLease | null>;
}

// ============================================================================
// Durable runs, approvals, reservations (`04` §4, `03` §1 DOMAIN 5)
// ============================================================================

export interface StartedRun {
  readonly run_id: string;
  readonly task_version: number;
  readonly correlation_id: string;
  readonly lifecycle_state: TaskStoredState;
}

export interface RunPort {
  /**
   * Starts one durable run through the Revenue Orchestrator: the inbound identity becomes the
   * run's `request_id` and therefore the anchor of every derived `effect_key` (BR-005).
   */
  start(input: {
    tenant_id: string;
    correlation_id: string;
    request_id: string;
    source_channel: ChannelId;
    event_type: string;
    session_id: string;
    channel_type: string;
    channel_identifier?: string;
    verified_customer_id?: string;
    payload: Record<string, unknown>;
  }): Promise<StartedRun>;
  /** R03: durable task state plus the evidence/receipt references that actually exist. */
  read(input: { tenant_id: string; run_id: string }): Promise<{
    run_id: string;
    task_version: number;
    lifecycle_state: TaskStoredState;
    correlation_id: string;
    answer?: string;
    sources?: readonly TaskSourceRef[];
    actions?: readonly { operation: string; status: string; provider_reference: string }[];
    evidence_reference?: string;
  } | null>;
  /**
   * R13: the verified side-effect-free failure classes only. `UNKNOWN` is absent by construction —
   * an indeterminate outcome is reconciled (R18), never blind-retried.
   */
  classifyRetry(tenant_id: string, run_id: string): Promise<
    | { readonly retryable: true; readonly failure_class: RetryableFailureClass; readonly effect_key: string }
    | { readonly retryable: false; readonly reason: 'NOT_FOUND' | 'NOT_FAILED' | 'UNKNOWN' }
  >;
  /** R13: re-queues the failed run under its original `effect_key`. */
  retry(input: { tenant_id: string; run_id: string; operator_id: string; reason: string }): Promise<StartedRun>;
  /** R18: maps one operator resolution onto the durable reservation settlement. */
  reconcile(input: {
    tenant_id: string;
    run_id: string;
    resolution: ReconciliationResolution;
    receipt?: Record<string, unknown>;
    reason: string;
    operator_id: string;
  }): Promise<{ readonly accepted: true; readonly run_id: string }>;
  /** R16 read model. */
  list(input: {
    tenant_id: string;
    cursor?: string;
    limit?: number;
    agent_id?: string;
    state?: TaskStoredState;
    from?: string;
    to?: string;
  }): Promise<CursorPage<RunProjection>>;
}

export interface ApprovalPort {
  /** R14: the `PENDING` projection only (`03` §1 DOMAIN 5 `approval_queue`). */
  list(input: {
    tenant_id: string;
    status: ApprovalQueueFilter;
    cursor?: string;
    limit?: number;
  }): Promise<CursorPage<ApprovalQueueItem>>;
  /** §8.2.1 detail read; a cross-tenant id is `null` so the route answers `404`, never redacted. */
  detail(tenant_id: string, approval_id: string): Promise<ApprovalDetailResponse | null>;
  /**
   * R05: one-time compare-and-set claim on the `PENDING` row bound to
   * `(tenant_id, run_id, effect_key)`, with the reviewed digest re-verified in the same
   * transaction. A stale digest is `APPROVAL_STALE_PAYLOAD`; a decided row is
   * `APPROVAL_NOT_CLAIMABLE`.
   */
  decide(input: {
    tenant_id: string;
    approval_id: string;
    run_id: string;
    effect_key: string;
    expected_payload_sha256: string;
    decision: ApprovalDecision;
    operator_id: string;
    reason: string;
    modified_payload?: Record<string, unknown>;
  }): Promise<{
    readonly approval_id: string;
    readonly task_id: string;
    readonly status: 'APPROVED' | 'REJECTED' | 'MODIFIED' | 'PAUSED' | 'CANCELLED';
    readonly decided_at: string;
  }>;
}

// ============================================================================
// Event ingestion (`06` §3.0 canonical contract, §9.2)
// ============================================================================

export interface EventIngestResult {
  readonly status: EventIngestionStatus;
  readonly canonical_event: string | null;
  readonly stored_event_name: string;
  /** `true` when the `(tenant_id, source_event_id)` row already existed (`uq_customer_events_source`). */
  readonly deduplicated: boolean;
}

export interface EventPort {
  /**
   * One bounded event delivery, already signature-verified by the caller. The canonical derivation
   * and the `event_id` dedupe live in the connector layer (`packages/adapters` API-002); this port
   * owns the durable append only.
   */
  append(input: {
    tenant_id: string;
    source_event_id: string;
    event_name: string;
    session_id: string;
    channel: string;
    customer_id: string | null;
    occurred_at: string;
    payload: Record<string, unknown>;
  }): Promise<{ readonly inserted: boolean }>;
  /**
   * The stored delivery receipt of one `(tenant, source_event_id)`: what a redelivery answers from.
   * `payload_sha256` is the digest the platform recorded for the accepted envelope, and comparing it
   * is how a redelivery proves it carries the same bytes rather than claiming an identity that
   * already means something else (`06` §8.1.1 R04).
   */
  receipt(
    tenant_id: string,
    source_event_id: string,
  ): Promise<{
    readonly event_id: string;
    readonly event_name: string;
    readonly occurred_at: string;
    readonly payload_sha256: string | null;
  } | null>;
  /** R15 timeline projection over `customer_events` (`03` §8 ten-stage mapping). */
  timeline(input: {
    tenant_id: string;
    customer_id: string;
    cursor?: string;
    limit?: number;
    from?: string;
    to?: string;
  }): Promise<CursorPage<TimelineEntry>>;
}

// ============================================================================
// Realtime and KPI projections (`06` §8.1.2, §8.1.3)
// ============================================================================

export interface StreamPort {
  /** Resumes from `Last-Event-ID`/`cursor`; a replayed frame keeps its original `id`. */
  subscribe(input: {
    tenant_id: string;
    metric?: string;
    channel?: string;
    cursor?: string;
    signal: AbortSignal;
  }): AsyncIterable<TelemetryFrame>;
  /** R10: the socket never mutates state; control actions go through R06/R07/R08. */
  onCommand?(input: {
    tenant_id: string;
    operator_id: string;
    command: string;
    payload: Record<string, unknown>;
  }): Promise<{ readonly acknowledged: boolean; readonly events: readonly { event: string; data: Record<string, unknown> }[] }>;
}

export interface KpiPort {
  snapshot(input: {
    tenant_id: string;
    window?: string;
    timezone?: string;
    cursor?: string;
    limit?: number;
  }): Promise<KpiSnapshotResponse>;
}

// ============================================================================
// Identity and audit (`04` §5, NFR-002)
// ============================================================================

export interface IdentityPort {
  /**
   * Server-side identity resolution. A payload-asserted phone/email/tax id never resolves a
   * customer (`04` §5, `06` §9.1); an unresolved subject yields `null` and the route returns a
   * truthful `CUSTOMER_UNVERIFIED`/empty projection instead of inventing an identity.
   */
  resolveCustomer(input: {
    tenant_id: string;
    session_id: string;
    channel_type: string;
    channel_identifier?: string;
    claimed_customer_id?: string;
  }): Promise<{ readonly customer_id: string | null; readonly verdict: string }>;
}

/**
 * Inbound verification boundary (`06` §4.2, §9.3). Verification runs BEFORE any agent routing:
 * a delivery whose signature does not verify is refused `401` and nothing is queued (`TC-CON-004`,
 * V-01). The provider schemes themselves live in `packages/adapters`; this port is what the
 * gateway calls so the route never holds a secret or a provider-specific digest rule.
 */
export interface WebhookVerificationPort {
  verify(input: {
    tenant_id: string;
    /** `null` for the platform event ingress, which is not channel-bound. */
    channel: ChannelId | null;
    /** Raw, unparsed body — a re-serialized JSON payload never verifies. */
    raw_body: string;
    headers: Readonly<Record<string, string | undefined>>;
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly error_code: GatewayErrorCode_ }>;
}

/** One audit row per gateway operation (`06` §8.0); reads audit too and write no evidence row. */
export interface GatewayAuditPort {
  record(input: {
    tenant_id: string;
    correlation_id: string;
    operation: string;
    principal_kind: string;
    operator_id?: string;
    outcome: 'ACCEPTED' | 'REFUSED';
    error_code?: string;
    detail?: Record<string, unknown>;
  }): Promise<void>;
}

/** The single exit path from a route to the durable reservation protocol (`04` §4.4). */
export interface ReceiptPort {
  /** Returns the cached receipt for an identical replay; never re-executes the effect. */
  receiptFor(tenant_id: string, effect_key: string): Promise<Record<string, unknown> | null>;
  /** Records the receipt produced by the first accepted dispatch, keyed by `(tenant, key)`. */
  storeReceipt(tenant_id: string, effect_key: string, receipt: Record<string, unknown>): Promise<void>;
}

// ============================================================================
// Runtime bundle
// ============================================================================

/**
 * Everything a route group needs, injected at composition time. The bundle is deliberately
 * explicit: a missing binding fails at composition, never at request time.
 */
export interface GatewayRuntime {
  readonly conversations: ConversationPort;
  readonly takeover: TakeoverLeasePort;
  readonly runs: RunPort;
  readonly approvals: ApprovalPort;
  readonly events: EventPort;
  readonly timeline: EventPort;
  readonly streams: StreamPort;
  readonly kpi: KpiPort;
  readonly identity: IdentityPort;
  readonly webhooks: WebhookVerificationPort;
  readonly audit: GatewayAuditPort;
  readonly receipts: ReceiptPort;
  /**
   * The durable reservation protocol (`04` §4.4, BR-005/BR-006). Route-level idempotency for R02,
   * R04 and R12 is expressed through this guard — never through a second receipt table — so a
   * replay returns the stored receipt and a changed payload under the same key is
   * `IDEMPOTENCY_CONFLICT`.
   */
  readonly effects: IEffectGuard;
  /** Injected clock; a route never calls `Date.now()` directly. */
  readonly clock: () => Date;
  /** Injected identifier source, so a route body stays deterministic under test. */
  readonly ids: () => string;
}
