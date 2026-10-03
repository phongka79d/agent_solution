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
  AuditPageQuery,
  PlatformAuditPage,
  PlatformAuditPageQuery,
  AppendProviderCallInput,
  CareHandoffClaimOutcome,
  CareHandoffCompletionOutcome,
  ClaimCareHandoffInput,
  CompleteCareHandoffInput,
  CompanyCrmCampaignRow,
  CompanyCrmCampaignSegment,
  CompanyCrmConversationSummaryRow,
  CompanyCrmCustomerProfileRow,
  CompanyCrmCustomerRow,
  CompanyProjectionSources,
  CompanyActivityPageOptions,
  ConnectorBindingActor,
  ConnectorBindingRecord,
  ConnectorProbeResult,
  PutConnectorConfigInput,
  PutTenantSecretInput,
  SecretAuditContext,
  TenantSecretDescription,
  AgentActivationAction,
  AgentActivationActor,
  AgentActivationDomain,
  AgentActivationSnapshot,
  PlatformRunTraceDetails as PlatformRunTraceDetailsRecord,
} from '@agentos/database';

import type {
  ApprovalDecision,
  ApprovalDetailResponse,
  ApprovalQueueItem,
  ApprovalQueueFilter,
  ChannelId,
  CursorPage,
  EventIngestionStatus,
  GatewayErrorCode_,
  ReconciliationResolution,
  RetryableFailureClass,
  RunProjection,
  RunSourceChannel,
  TaskErrorProjection,
  TaskSourceRef,
  TaskStoredState,
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
  readonly customer_display_name?: string | null;
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
  /** Bounded caller request key; a replay returns the original message instead of a second one. */
  readonly request_id?: string;
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
  list(tenant_id: string, limit?: number): Promise<readonly ConversationRecord[]>;
  listMessages(input: { tenant_id: string; conversation_id: string; limit?: number }): Promise<
    readonly { message_id: string; sender_type: ConversationMessageInput['sender_type']; sender_id: string; content: string; created_at: string }[]
  >;
  listWidgetMessages(input: {
    readonly tenant_id: string;
    readonly conversation_id: string;
    readonly after?: string;
    readonly limit?: number;
  }): Promise<{
    readonly messages: readonly {
      readonly message_id: string;
      readonly sender_type: ConversationMessageInput['sender_type'];
      readonly sender_id: string;
      readonly content: string;
      readonly created_at: string;
      readonly delivery_status?: 'STORED' | 'DELIVERED' | 'FAILED';
    }[];
    readonly next_cursor: string | null;
  }>;
  handoffState(tenant_id: string, conversation_id: string): Promise<{
    readonly has_enqueued_handoff: boolean;
    readonly has_assigned_handoff: boolean;
  }>;
  /** Compare-and-sets `conversations.state` from the caller's observed state and owner. */
  setState(
    tenant_id: string,
    conversation_id: string,
    expected_state: ConversationState,
    expected_takeover_operator_id: string | null,
    state: ConversationState,
    takeover_operator_id: string | null,
  ): Promise<'UPDATED' | 'CONFLICT'>;
  /**
   * Returns a conversation to agent control only when its persisted takeover marker still belongs
   * to the operator whose lease was observed as expired. This conditional transition prevents stale
   * expiry cleanup from clearing a newer operator's takeover.
   */
  clearTakeoverIfOwned(
    tenant_id: string,
    conversation_id: string,
    operator_id: string,
  ): Promise<boolean>;
  appendMessage(input: ConversationMessageInput): Promise<string>;
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

/** Durable assignment/completion operations for an enqueued human handoff. */
export interface CareHandoffPort {
  claim(input: ClaimCareHandoffInput): Promise<CareHandoffClaimOutcome>;
  complete(input: CompleteCareHandoffInput): Promise<CareHandoffCompletionOutcome>;
}

// ============================================================================
// Durable runs, approvals, reservations (`04` §4, `03` §1 DOMAIN 5)
// ============================================================================

export type RunAdmission = 'ADMITTED' | 'REPLAY' | 'IN_FLIGHT';

export interface StartedRun {
  readonly run_id: string;
  readonly task_version: number;
  readonly correlation_id: string;
  readonly lifecycle_state: TaskStoredState;
  /** Immutable conversation owner when the run is bound to a customer conversation. */
  readonly conversation_id?: string;
  /** Which delivery owns the reservation; absent only for legacy injected test ports. */
  readonly admission?: RunAdmission;
  /** Persisted receipt when the reservation was already settled as a replay. */
  readonly receipt?: Record<string, unknown>;
}

/** A reservation claimed before provider classification; the run binding persists it exactly once. */
export interface AdmissionReservation {
  readonly run_id: string;
  readonly effect_key: string;
  readonly request_fingerprint: string;
  readonly customer_message?: {
    readonly conversation_id: string;
    readonly sender_id: string;
    readonly content: string;
    readonly request_id?: string;
  };
}

export type RunRetryClassification =
  | { readonly retryable: true; readonly failure_class: RetryableFailureClass; readonly effect_key: string }
  | { readonly retryable: false; readonly reason: 'NOT_FOUND' | 'NOT_FAILED' | 'UNKNOWN' };

export interface RunPort {
  /**
   * Starts one durable run through the Revenue Orchestrator: the inbound identity becomes the
   * run's `request_id` and therefore the anchor of every derived `effect_key` (BR-005).
   */
  start(input: {
    tenant_id: string;
    correlation_id: string;
    readonly request_id: string;
    /** Reservation claimed before intent classification; the run binding must not reserve again. */
    readonly admission_reservation?: AdmissionReservation;
    /** Internal gateway admission class; never sourced from a client field. */
    admission_skill_id?: 'campaign.draft';
    /** Persisted campaign row created atomically with this run when supplied. */
    readonly campaign?: {
      readonly campaign_id: string;
      readonly name: string;
      readonly objective: string;
      readonly channels: readonly string[];
      readonly audience_count: number;
    };
    source_channel: RunSourceChannel;
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
    error: TaskErrorProjection | null;
    /** Immutable admission owner; absent for non-conversation runs. */
    conversation_id?: string;
    session_id?: string;
    answer?: string;
    sources?: readonly TaskSourceRef[];
    actions?: readonly { operation: string; status: string; provider_reference: string }[];
    evidence_reference?: string;
  } | null>;
  /**
   * R13: the verified side-effect-free failure classes only. `UNKNOWN` is absent by construction —
   * an indeterminate outcome is reconciled (R18), never blind-retried.
   */
  classifyRetry(tenant_id: string, run_id: string): Promise<RunRetryClassification>;
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
  /** Tenant-scoped company narrative and operator-only diagnostic trace. */
  story(tenant_id: string, run_id: string): Promise<object | null>;
  trace(tenant_id: string, run_id: string): Promise<object | null>;
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
   * R05: authenticate and queue one durable human decision. The worker later performs the
   * lease/policy/checkpoint-fenced claim, so this port never reports a terminal decision here.
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
    readonly status: 'QUEUED';
    readonly queued_at: string;
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

/** Redacted provider-call telemetry; prompts, completions, credentials, and URLs never cross this port. */
export interface ProviderCallPort {
  appendProviderCall(input: AppendProviderCallInput): Promise<unknown>;
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

export interface CompanyProfileRecord {
  readonly tenant_id: string;
  readonly company_name: string;
  readonly industry: string | null;
  readonly locale: string;
  readonly timezone: string;
  readonly currency: string;
  readonly brand_profile: Readonly<Record<string, unknown>>;
  readonly version: number;
  readonly updated_at: string;
}

export interface CompanyProfileValues {
  readonly company_name: string;
  readonly industry: string | null;
  readonly locale: string;
  readonly timezone: string;
  readonly currency: string;
  readonly brand_profile: Readonly<Record<string, unknown>>;
}

export interface CompanyProfileUpdateInput {
  readonly tenant_id: string;
  readonly values: CompanyProfileValues;
  readonly expected_version: number;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly correlation_id: string;
}

export type CompanyProfileUpdateResult =
  | { readonly status: 'UPDATED'; readonly profile: CompanyProfileRecord }
  | { readonly status: 'VERSION_CONFLICT'; readonly current_version: number };

/** Tenant-scoped company profile reads and audited optimistic-concurrency updates. */
export interface CompanyProfilePort {
  get(tenant_id: string): Promise<CompanyProfileRecord | null>;
  update(input: CompanyProfileUpdateInput): Promise<CompanyProfileUpdateResult>;
}

export interface GovernanceSettings {
  readonly tenant_id: string;
  readonly require_distinct_approver: boolean;
  readonly approval_expiry_hours: number;
  readonly takeover_lease_seconds: number;
  readonly version: number;
  readonly updated_at: string;
}

export interface GovernanceUpdateInput {
  readonly require_distinct_approver: boolean;
  readonly approval_expiry_hours: number;
  readonly takeover_lease_seconds: number;
  readonly expected_version: number;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly correlation_id: string;
}

/** Tenant-scoped governance settings and audited optimistic-concurrency updates. */
export interface GovernancePort {
  get(tenant_id: string): Promise<GovernanceSettings>;
  update(tenant_id: string, input: GovernanceUpdateInput): Promise<GovernanceSettings | null>;
}
/** Cross-tenant platform directory; implementations call only the privileged SQL projections. */
export interface PlatformDirectoryPort {
  listTenants(): Promise<readonly {
    readonly tenant_id: string;
    readonly display_name: string;
    readonly status: string;
    readonly created_at: string;
    readonly enabled_modules: readonly string[] | null;
  }[]>;
  getTenant(tenant_id: string): Promise<{
    readonly tenant_id: string;
    readonly display_name: string;
    readonly status: string;
    readonly created_at: string;
    readonly enabled_modules: readonly string[] | null;
  } | null>;
  readiness(tenant_id: string): Promise<{
    readonly tenant_id: string;
    readonly capability_count: number | null;
    readonly capability_statuses: Readonly<Record<string, string>> | null;
    readonly connector_count: number | null;
    readonly connector_statuses: Readonly<Record<string, string>> | null;
    readonly owner_input_count: number | null;
    readonly owner_input_statuses: Readonly<Record<string, string>> | null;
    readonly workspace_status: string | null;
    readonly residency_status: string | null;
  } | null>;
  usage(from: string, to: string): Promise<readonly {
    readonly tenant_id: string;
    readonly display_name: string;
    readonly usage_day: string;
    readonly domain: string | null;
    readonly model: string | null;
    readonly currency: string | null;
    readonly cost_recorded: boolean;
    readonly record_count: number;
    readonly input_tokens_total: number;
    readonly output_tokens_total: number;
    readonly cached_tokens_total: number;
    readonly tokens_total: number;
    readonly cost_total: string | null;
    readonly monthly_token_budget: number | null;
  }[]>;
  /** Cross-company run list of derived fields only (no customer data, no raw payloads). */
  listRuns(input: {
    tenant_id?: string;
    state?: string;
    domain?: string;
    limit?: number;
    before?: string;
    search?: string;
  }): Promise<readonly PlatformRunListItem[]>;
  runDetail(tenant_id: string, run_id: string): Promise<PlatformRunDetail | null>;
  runTraceDetails(tenant_id: string, run_id: string): Promise<PlatformRunTraceDetailsRecord>;
  runsSummary(): Promise<readonly PlatformRunsSummaryRow[]>;
  reconciliationQueue(input?: {
    tenant_id?: string;
    limit?: number;
  }): Promise<readonly PlatformReconciliationItem[]>;
  companyOverview(tenant_id: string): Promise<PlatformCompanyOverview | null>;
}

/** Derived platform run projections; every field is a scalar, never a raw payload. */
export interface PlatformRunListItem {
  readonly tenant_id: string;
  readonly display_name: string;
  readonly run_id: string;
  readonly domain: string;
  readonly current_step: number;
  readonly state: string;
  readonly failure_class: string | null;
  readonly retry_eligible: boolean;
  readonly attempts: number;
  readonly max_retries: number;
  readonly duration_ms: number | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly correlation_id: string;
}

export interface PlatformRunDetail {
  readonly tenant_id: string;
  readonly display_name: string;
  readonly run_id: string;
  readonly domain: string;
  readonly correlation_id: string;
  readonly current_step: number;
  readonly state: string;
  readonly task_version: number;
  readonly failure_class: string | null;
  readonly retry_eligible: boolean;
  readonly attempts: number;
  readonly max_retries: number;
  readonly lease_owner: string | null;
  readonly lease_expires_at: string | null;
  readonly conversation_id: string | null;
  readonly error_code: string | null;
  readonly duration_ms: number | null;
  readonly stage_event_count: number;
  readonly evidence_count: number;
  readonly cost_breakdown: readonly {
    readonly currency: string | null;
    readonly cost_recorded: boolean;
    readonly record_count: number;
    readonly cost_total: string | null;
  }[];
  readonly input_tokens_total: number;
  readonly output_tokens_total: number;
  readonly cached_tokens_total: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PlatformRunsSummaryRow {
  readonly state: string;
  readonly run_count: number;
  readonly tenant_count: number;
  readonly retry_eligible_count: number;
  readonly reconciliation_count: number;
}

export interface PlatformReconciliationItem {
  readonly tenant_id: string;
  readonly display_name: string;
  readonly run_id: string;
  readonly domain: string;
  readonly state: string;
  readonly failure_class: string | null;
  readonly attempts: number;
  readonly max_retries: number;
  readonly reason: string;
  readonly correlation_id: string;
  readonly updated_at: string;
}

export interface PlatformCompanyOverview {
  readonly tenant_id: string;
  readonly display_name: string;
  readonly status: string;
  readonly data_class: string;
  readonly created_at: string;
  readonly runs_total: number;
  readonly runs_failed: number;
  readonly runs_running: number;
  readonly runs_waiting: number;
  readonly retry_eligible_count: number;
  readonly reconciliation_count: number;
  readonly needs_attention: boolean;
  readonly last_activity_at: string | null;
}

/** Platform-only tenant lifecycle commands, executed in the target tenant's RLS context. */
export interface PlatformCompanyCommandsPort {
  suspend(input: { tenant_id: string; reason?: string }): Promise<{ readonly tenant_id: string; readonly status: string }>;
  resume(input: { tenant_id: string; reason?: string }): Promise<{ readonly tenant_id: string; readonly status: string }>;
}

/** Role bundles a company membership may hold; the wire vocabulary of `tenant_memberships`. */
export type CompanyUserRole = 'COMPANY_ADMIN' | 'OPERATOR' | 'VIEWER';
export type InvitationRoleBundle = CompanyUserRole | 'PLATFORM_ADMIN';
export type CompanyUserStatus = 'INVITED' | 'ACTIVE' | 'DEACTIVATED';

export type IdentityScope = 'company' | 'platform';

/** Platform administrator row; email stays private until the route masks it. */
export interface PlatformAdminRecord {
  readonly user_id: string | null;
  readonly display_name: string | null;
  readonly email: string;
  readonly status: CompanyUserStatus;
  readonly last_sign_in_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PlatformAdminInvitationRecord {
  readonly invitation_id: string;
  readonly email: string;
  readonly expires_at: string;
}

/** Platform-only admin directory and invitation capability. */
export interface PlatformAdminsPort {
  list(): Promise<readonly PlatformAdminRecord[]>;
  invite(input: {
    readonly tenant_id: string;
    readonly email: string;
    readonly created_by: string;
  }): Promise<PlatformAdminInvitationRecord | null>;
}

/** One company member as both consoles list it. */
export interface CompanyUserRecord {
  readonly user_id: string;
  readonly display_name: string | null;
  readonly email: string;
  readonly role_bundle: CompanyUserRole;
  readonly status: CompanyUserStatus;
  readonly last_sign_in_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** The single-use invitation that was just issued and handed to the email sender. */
export interface CompanyInvitationRecord {
  readonly invitation_id: string;
  readonly email: string;
  readonly role_bundle: CompanyUserRole;
  readonly expires_at: string;
}

/**
 * Company user administration (T9.3): the invite/change/deactivate lifecycle behind both the
 * platform company wizard and the company settings "Người dùng" tab. The raw invitation token is
 * created, hashed and delivered inside this port; a route never sees or stores it.
 */
export interface CompanyUserAdminPort {
  listUsers(tenant_id: string): Promise<readonly CompanyUserRecord[]>;
  invite(input: {
    readonly tenant_id: string;
    readonly email: string;
    readonly role_bundle: CompanyUserRole;
    /** The authenticated issuer's user id, recorded as the invitation author. */
    readonly created_by: string;
  }): Promise<CompanyInvitationRecord | null>;
  updateUser(input: {
    readonly tenant_id: string;
    readonly user_id: string;
    readonly role_bundle?: CompanyUserRole;
    readonly status?: CompanyUserStatus;
  }): Promise<CompanyUserRecord | null>;
}

/** Redemption of an invitation from the public accept page. */
/** Redemption of a company or platform invitation from its public accept page. */
export interface InvitationAcceptPort {
  inspect(token: string): Promise<{
    readonly email: string;
    readonly tenant_id: string;
    readonly role_bundle: InvitationRoleBundle;
    readonly scope: IdentityScope;
    readonly expires_at: string;
  } | null>;
  /** `null` for an unknown, expired or already-consumed token. */
  accept(input: {
    readonly token: string;
    readonly password: string;
    readonly display_name?: string;
  }): Promise<{
    readonly user_id: string;
    readonly email: string;
    readonly tenant_id: string;
    readonly role_bundle: InvitationRoleBundle;
    readonly scope: IdentityScope;
  } | null>;
}

/**
 * Delivery of an outbound email. The default local/CI transport is log-only; the optional file
 * transport stores invitation links only in a private local/CI outbox and never writes them to logs.
 */
export interface EmailSenderPort {
  sendInvitation(input: {
    readonly to: string;
    readonly tenant_id: string;
    readonly role_bundle: InvitationRoleBundle;
    readonly scope?: IdentityScope;
    /** Contains a single-use token; never write this value to process logs. */
    readonly invitation_url: string;
    readonly expires_at: string;
  }): Promise<void>;
}

/** Provider metadata intentionally contains no credentials, URLs, or model secrets. */
export interface PlatformProvidersPort {
  list(): Promise<readonly {
    readonly provider: string;
    readonly configured: boolean;
    readonly mode: string;
  }[]>;
}
/** Read-only audit history projections; writes remain inside the setting's own transaction. */
export interface PlatformAuditPort {
  listForTenant(tenant_id: string, query?: AuditPageQuery): Promise<PlatformAuditPage>;
  listForPlatform(query?: PlatformAuditPageQuery): Promise<PlatformAuditPage>;
}
/** Tenant-scoped read-only sources for the company console projections. */
export interface CompanyProjectionPort {
  getSources(tenant_id: string, activityPage?: CompanyActivityPageOptions): Promise<CompanyProjectionSources>;
}
export type CompanyProjectionsPort = CompanyProjectionPort;
export interface CompanyCrmPort {
  listCustomers(input: {
    readonly tenant_id: string;
    readonly query?: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<{
    readonly items: readonly CompanyCrmCustomerRow[];
    readonly next_cursor: string | null;
  }>;
  getCustomerProfile(tenant_id: string, customer_id: string): Promise<CompanyCrmCustomerProfileRow | null>;
  listCampaignSegments(tenant_id: string): Promise<readonly CompanyCrmCampaignSegment[]>;
  listCampaigns(input: {
    readonly tenant_id: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<{
    readonly items: readonly CompanyCrmCampaignRow[];
    readonly next_cursor: string | null;
  }>;
  getCampaign(tenant_id: string, run_id: string): Promise<CompanyCrmCampaignRow | null>;
  getConversationSummary(
    tenant_id: string,
    conversation_id: string,
  ): Promise<CompanyCrmConversationSummaryRow | null>;
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
export interface CompanyIntegrationsPort {
  listBindings(tenant_id: string): Promise<readonly ConnectorBindingRecord[]>;
  getBinding(tenant_id: string, connector_id: string): Promise<ConnectorBindingRecord | null>;
  /** Environment mock eligibility, scoped to DEMO data; callers must also check a pristine binding. */
  demoErpEligibleForTenant?(tenant_id: string): Promise<boolean>;
  putConfig(
    tenant_id: string,
    connector_id: string,
    input: PutConnectorConfigInput,
    actor: ConnectorBindingActor,
    expectedVersion: number,
  ): Promise<ConnectorBindingRecord>;
  recordProbe(tenant_id: string, connector_id: string, result: ConnectorProbeResult): Promise<ConnectorBindingRecord>;
  disconnect(
    tenant_id: string,
    connector_id: string,
    actor: ConnectorBindingActor,
    expectedVersion: number,
  ): Promise<ConnectorBindingRecord>;
  putSecret(tenant_id: string, input: PutTenantSecretInput): Promise<TenantSecretDescription>;
  describeSecret(tenant_id: string, secret_id: string): Promise<TenantSecretDescription | null>;
  revokeSecret(tenant_id: string, secret_id: string, context: SecretAuditContext): Promise<boolean>;
  resolveSecret(tenant_id: string, secret_id: string): Promise<string>;
}

export interface TestCustomerArtifactPort {
  purge(input: { readonly tenant_id: string; readonly customer_ids: readonly string[] }): Promise<void>;
}

export interface GatewayRuntime {
  readonly conversations: ConversationPort;
  readonly takeover: TakeoverLeasePort;
  readonly handoffs: CareHandoffPort;
  readonly runs: RunPort;
  readonly approvals: ApprovalPort;
  readonly events: EventPort;
  readonly timeline: EventPort;

  readonly identity: IdentityPort;
  readonly testCustomerArtifacts?: TestCustomerArtifactPort;
  readonly webhooks: WebhookVerificationPort;
  readonly companyProfile?: CompanyProfilePort;
  readonly companyCrm?: CompanyCrmPort;
  readonly companyProjections?: CompanyProjectionPort;
  readonly companyIntegrations?: CompanyIntegrationsPort;
  readonly companyAiTeam?: {
    getState(tenant_id: string, domain: AgentActivationDomain): Promise<AgentActivationSnapshot | null>;
    transition(input: {
      readonly tenant_id: string;
      readonly domain: AgentActivationDomain;
      readonly action: AgentActivationAction;
      readonly actor: AgentActivationActor;
    }): Promise<AgentActivationSnapshot>;
  };
  readonly governance?: GovernancePort;
  readonly auditHistory?: PlatformAuditPort;
  readonly audit: GatewayAuditPort;
  readonly providerCalls?: ProviderCallPort;
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
