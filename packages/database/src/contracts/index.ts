/**
 * Persistence contracts for `@agentos/database`.
 *
 * This module is deliberately runtime-free: it imports no `pg`, Redis, or Qdrant
 * client, so higher layers can type their persistence boundaries through
 * `@agentos/database/contracts` without pulling a driver into their process.
 */

/**
 * Authenticated tenant identifier, issued as a UUID v7 at tenant provisioning.
 */
export type TenantId = string & { readonly __brand: 'TenantId' };

/**
 * Every tenant-scoped row carries the tenant that owns it (NFR-006).
 */
export interface TenantBinding {
  readonly tenant_id: TenantId;
}

/**
 * Value class a persistence write carries. A HYPOTHESIS is a derived AI guess and
 * is never promoted to customer FACT (SRS §5 / FR-C360-003); the write-side
 * enforcement is `assertEpistemicWrite()`.
 */
export type EpistemicClass = 'FACT' | 'SIGNAL' | 'HYPOTHESIS' | 'DECISION' | 'ACTION';

/**
 * Taxonomy class stored in `agentos.evidences.taxonomy_type`.
 */
export type EvidenceTaxonomyType = EpistemicClass;

/**
 * SoR-mirror table (`agentos.*`) whose rows are authoritative facts and therefore
 * closed to HYPOTHESIS writes.
 */
export type SoRFactTable =
  | 'customers'
  | 'products'
  | 'skus'
  | 'prices'
  | 'inventories'
  | 'orders'
  | 'invoices';

/**
 * Row of the `agentos.customer_360_profiles` FACT read projection.
 */
export interface CustomerProfileRow {
  readonly customer_id: string;
  readonly tenant_id: string;
  readonly verified_phone: string | null;
  readonly verified_email: string | null;
  /** NUMERIC aggregate: money stays a string so no float rounding enters the FACT store. */
  readonly total_spent: string;
  readonly order_count: number;
  /** Derived RFM label; read-only hypothesis, never written back into `agentos.customers`. */
  readonly rfm_segment_hypothesis: string;
  readonly consent_marketing: boolean;
  readonly consent_updated_at: Date | null;
  readonly suppression_active: boolean;
  readonly line_user_id: string | null;
  readonly created_at: Date;
}

/**
 * FACT columns accepted by `insertFact()`, the only write path into `agentos.customers`.
 * Omitted columns keep their DDL default.
 */
export interface CustomerFactInsert {
  readonly id?: string;
  readonly external_crm_id?: string;
  readonly primary_phone?: string;
  readonly primary_email?: string;
  readonly display_name?: string;
  readonly verification_status?: string;
  readonly customer_tier?: string;
  readonly total_spent?: string;
  readonly order_count?: number;
  readonly last_interaction_at?: Date;
  readonly metadata?: Record<string, unknown>;
  /**
   * Declared only so the refusal is reachable for callers that carry a projection
   * row around: a derived RFM label is a HYPOTHESIS and any own property with this
   * name is rejected by `insertFact()` (FR-C360-003).
   */
  readonly rfm_segment_hypothesis?: unknown;
}

/**
 * Row written to `agentos.customers` by `insertFact()`.
 */
export interface CustomerFactRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly external_crm_id: string | null;
  readonly primary_phone: string | null;
  readonly primary_email: string | null;
  readonly display_name: string | null;
  readonly verification_status: string;
  readonly customer_tier: string;
  readonly total_spent: string;
  readonly order_count: number;
  readonly last_interaction_at: Date | null;
  readonly metadata: Record<string, unknown>;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/**
 * Channel identifier mapping accepted by `insertIdentity()`.
 */
export interface CustomerIdentityInsert {
  readonly customer_id: string;
  /** `line`, `whatsapp`, `web`, `zalo`, `phone`, or `email`. */
  readonly channel_type: string;
  readonly channel_identifier: string;
  /** Caller-computed digest of the channel identifier; raw handles are never stored twice. */
  readonly identifier_hash: string;
  readonly is_primary?: boolean;
  readonly verified_at?: Date;
}

/**
 * Row of `agentos.customer_identities`.
 */
export interface CustomerIdentityRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly customer_id: string;
  readonly channel_type: string;
  readonly channel_identifier: string;
  readonly identifier_hash: string;
  readonly is_primary: boolean;
  readonly verified_at: Date | null;
  readonly created_at: Date;
}

/**
 * Consent evidence accepted by `insertConsent()` (BR-004).
 */
export interface ConsentInsert {
  readonly customer_id: string;
  /** `marketing_messaging`, `order_updates`, or `analytics`. */
  readonly consent_type: string;
  /** `line`, `whatsapp`, `email`, or `sms`. */
  readonly channel: string;
  /** `web_form`, `chat_optin`, or `pos_checkbox`. */
  readonly opt_in_method: string;
  readonly is_granted?: boolean;
  /** Defaults to the insert instant when omitted; never cleared by a revocation. */
  readonly opt_in_timestamp?: Date;
  readonly opt_out_timestamp?: Date;
  readonly evidence_text?: string;
}

/**
 * Row of `agentos.consents`. Opt-in history is preserved: a revocation only adds
 * `opt_out_timestamp` and flips `is_granted`.
 */
export interface ConsentRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly customer_id: string;
  readonly consent_type: string;
  readonly channel: string;
  readonly is_granted: boolean;
  readonly opt_in_method: string;
  readonly opt_in_timestamp: Date;
  readonly opt_out_timestamp: Date | null;
  readonly evidence_text: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/**
 * Grounding evidence accepted by `insertEvidence()`; the append-only sink where a
 * HYPOTHESIS is allowed to live (FR-C360-003).
 */
export interface EvidenceInsert {
  readonly run_id: string;
  readonly taxonomy_type: EvidenceTaxonomyType;
  readonly claim: string;
  readonly source_uri: string;
  readonly source_version: string;
  readonly verified_by: string;
  readonly customer_id?: string;
  readonly conditions?: Record<string, unknown>;
}

/**
 * Row of `agentos.evidences`; the table is immutable after insert.
 */
export interface EvidenceRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly customer_id: string | null;
  readonly run_id: string;
  readonly taxonomy_type: string;
  readonly claim: string;
  readonly source_uri: string;
  readonly source_version: string;
  readonly conditions: Record<string, unknown>;
  readonly verified_by: string;
  readonly created_at: Date;
}

/**
 * Stored state of `agentos.workflows.status`.
 */
export type WorkflowStatus = 'running' | 'waiting_approval' | 'completed' | 'failed';

/**
 * Durable orchestration accepted by `insertWorkflow()`.
 */
export interface WorkflowInsert {
  readonly workflow_name: string;
  readonly correlation_id: string;
  readonly current_step?: number;
  readonly status?: WorkflowStatus;
  readonly context_data?: Record<string, unknown>;
}

/**
 * Progress columns of `agentos.workflows`; `updated_at` does not exist on the table,
 * so only these four columns can move after creation.
 */
export interface WorkflowProgressUpdate {
  readonly current_step?: number;
  readonly status?: WorkflowStatus;
  readonly context_data?: Record<string, unknown>;
  readonly completed_at?: Date;
}

/**
 * Row of `agentos.workflows`.
 */
export interface WorkflowRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly workflow_name: string;
  readonly correlation_id: string;
  readonly current_step: number;
  readonly status: string;
  readonly context_data: Record<string, unknown>;
  readonly started_at: Date;
  readonly completed_at: Date | null;
}

/**
 * Reservation state of an `effect_key` (NFR-003).
 */
export type IdempotencyStatus = 'PENDING' | 'RESOLVED';

/**
 * Outcome of `reserveEffectKey()`: whether this call reserved the effect, and the
 * cached response of the first execution when one was already resolved.
 */
export interface IdempotencyReservation {
  readonly isNew: boolean;
  readonly status: IdempotencyStatus;
  readonly cachedResponse?: unknown;
}

/**
 * Injected Redis client surface used by the mutex and idempotency helpers. This
 * package never constructs a client of its own, and a caller must never supply a
 * key that is not tenant-scoped.
 */
export interface RedisInjectedClient {
  set(
    key: string,
    value: string,
    ...args: ReadonlyArray<string | number>
  ): Promise<string | null>;
  get(key: string): Promise<string | null>;
  eval(
    script: string,
    numberOfKeys: number,
    ...args: ReadonlyArray<string | number>
  ): Promise<unknown>;
}

/**
 * One of the eight Second Brain namespaces.
 */
export type KnowledgeNamespace =
  | 'company'
  | 'customer'
  | 'product'
  | 'brand'
  | 'marketing'
  | 'sales'
  | 'customer-care'
  | 'policy';

/**
 * Document lifecycle of a knowledge chunk; only `approved` is retrievable.
 */
export type KnowledgeDocumentStatus = 'draft' | 'review' | 'approved';

/**
 * Payload stored on every point of the `second_brain_knowledge` collection.
 */
export interface KnowledgeChunkPayload {
  readonly tenant_id: string;
  readonly namespace: KnowledgeNamespace;
  readonly file_path: string;
  readonly source_version: string;
  readonly document_status: KnowledgeDocumentStatus;
  readonly owner: string;
  readonly heading: string;
  readonly chunk_index: number;
  readonly text_content: string;
  readonly updated_at: string;
  /** Present only on customer-namespace chunks; the customer filter keys on it. */
  readonly customer_id?: string;
}

/**
 * A single Qdrant `must` condition: a payload key matched against one value.
 */
export interface QdrantFieldCondition {
  readonly key: string;
  readonly match: { readonly value: string };
}

/**
 * Qdrant filter envelope. Every retrieval is a conjunction of `must` conditions,
 * so a filter can never widen access by omission.
 */
export interface QdrantFilter {
  readonly must: ReadonlyArray<QdrantFieldCondition>;
}

/**
 * Input of `buildOrganizationalKnowledgeFilter()`.
 */
export interface OrganizationalKnowledgeFilterInput {
  readonly tenantId: string;
  readonly namespace: KnowledgeNamespace;
}

/**
 * Input of `buildCustomerKnowledgeFilter()`.
 */
export interface CustomerKnowledgeFilterInput {
  readonly tenantId: string;
  readonly customerId: string;
  readonly namespace: KnowledgeNamespace;
}
/**
 * Durable status of one effect reservation (implement/03 §1 DOMAIN 5 `effect_reservations.status`).
 *
 * `RESERVED` is the honest state of an effect whose provider outcome is unproven: a dispatch
 * time-out leaves the row `RESERVED` instead of inventing an `unknown` status, so a later reader
 * can never mistake uncertainty for a confirmed no-op (implement/04 §3.2.4).
 */
export type EffectReservationStatus = 'RESERVED' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED';

/**
 * The two values a settlement may store. `RESERVED` and `EXPIRED` describe an effect that is still
 * unproven or has been escalated, so they are deliberately not settleable statuses.
 */
export type EffectReservationSettlementStatus = Exclude<
  EffectReservationStatus,
  'RESERVED' | 'EXPIRED'
>;

/**
 * One durable reservation row of `agentos.effect_reservations`, the PostgreSQL authority for
 * at-most-once execution (NFR-003, BR-005, BR-006). Redis, when present, is only a latency cache
 * for the same key and never decides idempotency on its own.
 *
 * The three `TIMESTAMPTZ` columns are published as ISO-8601 UTC strings so the record survives
 * serialization unchanged; `expired` is derived on the database clock, which is the only clock
 * the durable decision table (implement/04 §3.2.3) trusts.
 */
export interface EffectReservationRecord {
  /** Tenant that owns the row; every statement is bound to it by transaction-local RLS. */
  readonly tenant_id: string;
  /** Deterministic key derived from the immutable inbound identity; never from `run_id`. */
  readonly effect_key: string;
  /** Immutable inbound identity (`signal_id` / delivery id / message id) the key was derived from. */
  readonly request_id: string;
  /** Bare lowercase hex SHA-256 of the canonical request payload, compared on every reserve. */
  readonly request_fingerprint: string;
  /** Run that first reserved the effect; a later replay carries its own run id and never rewrites this one. */
  readonly run_id: string;
  readonly step_index: number;
  readonly skill_id: string;
  readonly status: EffectReservationStatus;
  /** Provider receipt stored by `resolve()`; `NULL` while the outcome is unproven or absent. */
  readonly response_receipt: unknown;
  readonly reserved_at: string;
  /** Settlement time; `NULL` while `RESERVED`, set by a settlement and by an `EXPIRED` escalation. */
  readonly resolved_at: string | null;
  /** End of the durable idempotency/reconciliation window supplied when the row was written. */
  readonly expires_at: string;
  /**
   * `expires_at` has elapsed on the database clock. An expired `RESERVED` row is still claimed and
   * still unproven: it requires provider reconciliation, never a blind re-dispatch (implement/04 §4.4).
   */
  readonly expired: boolean;
}

/** The durable uniqueness key of a reservation: `PRIMARY KEY (tenant_id, effect_key)`. */
export interface EffectReservationKey {
  readonly tenant_id: string;
  readonly effect_key: string;
}

/**
 * Input of `reserve()` / `insertReservation()`: the canonical reservation request of
 * implement/04 §3.2.3.
 *
 * `action_revision` is carried for structural compatibility with `IEffectGuard.reserve()` — it is
 * bound into `effect_key` by the guard and has no column of its own in implement/03 §1 DOMAIN 5.
 * Omitting `expires_at` accepts the durable column default (the 72 h window), which keeps exactly
 * one definition of the window; a caller that owns the TTL supplies an ISO-8601 timestamp.
 */
export interface EffectReservationRequest extends EffectReservationKey {
  readonly run_id: string;
  readonly request_id: string;
  readonly request_fingerprint: string;
  readonly skill_id: string;
  readonly step_index: number;
  readonly action_revision?: number;
  readonly expires_at?: string;
}

/**
 * Input of `reopenReservation()`: after a provider-confirmed absence the same key may be dispatched
 * exactly once more, so the row returns to `RESERVED` with a fresh window (implement/04 §4.4 step 3).
 */
export interface EffectReservationReopen extends EffectReservationKey {
  readonly expires_at: string;
}

/** Input of `resolve()` / `settleReservation()`. */
export interface EffectReservationSettlement extends EffectReservationKey {
  readonly status: EffectReservationSettlementStatus;
  /** Durable receipt of what the provider proved; an absent receipt stores SQL `NULL`. */
  readonly receipt?: unknown;
}

/**
 * Scope of the reconciliation load (implement/04 §4.4 step 1): the still-open reservations of one
 * durable run, which is what a worker reclaiming a parked task has to reconcile before resuming.
 */
export interface EffectReservationRunScope {
  readonly tenant_id: string;
  readonly run_id: string;
}

/**
 * Reservation decision of implement/04 §3.2.3, structurally identical to the core-engine port's
 * `ReservationOutcome` so the guard can bind this repository without importing its module.
 *
 * `RESERVED` is the only outcome that permits a dispatch; `REPLAY` carries the stored receipt and
 * performs no call; `IN_FLIGHT` waits; `RECONCILE_REQUIRED` asks the provider what happened before
 * anything is re-dispatched; `CONFLICT` aborts with `IDEMPOTENCY_CONFLICT`.
 */
export type EffectReservationOutcome =
  | { readonly kind: 'RESERVED' }
  | { readonly kind: 'REPLAY'; readonly receipt: unknown }
  | { readonly kind: 'IN_FLIGHT' }
  | { readonly kind: 'RECONCILE_REQUIRED' }
  | { readonly kind: 'CONFLICT' };
