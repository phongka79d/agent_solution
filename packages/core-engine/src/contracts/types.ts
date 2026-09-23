/**
 * @file Canonical orchestration contracts (implement/04 §3.1): authority vocabulary, gate
 * verdicts, lifecycle states and the record shapes exchanged across the orchestrator boundary.
 *
 * Declarations plus the total, dependency-free invariants over that vocabulary (the rank table,
 * the epistemic write guard and `OrchestratorError`). The stateful guard algorithms and the
 * orchestrator runtime deliberately live elsewhere — `../durability/` owns the canonical JSON,
 * effect-key and evidence-chaining rules — matching the §02 rule that this directory is the single
 * home of shared orchestration contracts.
 */

export type EpistemicClassification = 'FACT' | 'SIGNAL' | 'HYPOTHESIS' | 'DECISION' | 'ACTION';

/**
 * Canonical authority vocabulary (SRS §12). All six labels exist; only the first four are
 * assignable clearances that take part in a numeric comparison.
 */
export type AuthorityLevel = 'AUTH-0' | 'AUTH-1' | 'AUTH-2' | 'AUTH-3' | 'AUTH-4' | 'AUTH-5';

/** Agent grants hold only AUTH-0..3; registry requirements separately admit AUTH-4 routing. */
export type AssignableAuthority = 'AUTH-0' | 'AUTH-1' | 'AUTH-2' | 'AUTH-3';

/**
 * Ordered clearance table. AUTH-4 and AUTH-5 are deliberately ABSENT: they are verdicts, not
 * clearance levels. AUTH-4 ("Approval Required") is resolved by the human approvals gate and
 * AUTH-5 ("Prohibited") is an immediate hard deny. Neither is ever rank-compared, granted to an
 * agent, or raised by an approval.
 */
export const AUTHORITY_RANK: Readonly<Record<AssignableAuthority, number>> = Object.freeze({
  'AUTH-0': 0, // Observe
  'AUTH-1': 1, // Recommend
  'AUTH-2': 2, // Draft
  'AUTH-3': 3, // Bounded Execute
});

/** Verdict produced by the authority gate (step [7. APPROVAL]). */
export type AuthorityVerdict =
  | 'AUTO_APPROVED'           // requirement ∈ AUTH-0..AUTH-3 and granted rank ≥ required rank
  | 'AWAITING_HUMAN_APPROVAL' // requirement = AUTH-4: persist one PENDING approval and pause
  | 'DENIED';                 // requirement = AUTH-5 (prohibited) or granted rank < required rank

/**
 * Canonical audit value for the 18-field Agent Run record (SRS §17). Exactly the six values the
 * append-only tables accept (`agent_run_logs.execution_status`, `audit_records.execution_status`
 * — §03 DOMAIN 5, §08 4.1); there is no seventh status.
 *
 * A dispatch time-out is therefore recorded as `failed` with `error.outcome = 'UNKNOWN'`. The
 * uncertainty itself is not lost: it lives in the `effect_reservations` row, which is left
 * RESERVED (never settled) until the provider is reconciled by `effect_key` (§4.4). Nothing is
 * ever recorded as `success` without a verified provider receipt, and nothing is recorded as a
 * provable no-op while the effect may have landed.
 */
export type ExecutionStatus =
  | 'pending'
  | 'executing'
  | 'success'
  | 'failed'
  | 'denied'
  | 'aborted';

/**
 * In-process failure classification (§3.2.4). `UNKNOWN` is a reconciliation state, not a stored
 * error class: an indeterminate external outcome parks the durable task in `waiting` and is
 * resolved by provider reconciliation (§4.4), so it is never written to
 * `platform_durable_tasks.last_error_class`.
 */
export type RetryClass = 'RETRYABLE' | 'FATAL' | 'UNKNOWN';

/** The subset of `RetryClass` that `platform_durable_tasks.last_error_class` accepts (§03). */
export type PersistedErrorClass = Exclude<RetryClass, 'UNKNOWN'>;

export type TaskLifecycleState =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'awaiting_human'
  | 'completed'
  | 'stopped'
  | 'failed';

/** Genesis chain link for a new run (predecessor of the first evidence record). */
export const GENESIS_HASH = '0'.repeat(64);

export class OrchestratorError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'OrchestratorError';
  }
}

/**
 * Inbound signal envelope. Trust is expressed in the type: `subject.verified_customer_id` may be
 * populated ONLY by the API gateway, from an authenticated channel session or a completed
 * identity verification. Client-supplied phone/email values are never accepted as identity
 * assertions anywhere in the orchestrator (BR-003, NFR-008); a phone-authenticated flow must be
 * converted into `verified_customer_id` by the identity service first.
 */
export interface SignalEnvelope {
  readonly signal_id: string; // immutable inbound identity → becomes `request_id`
  readonly tenant_id: string; // UUID
  readonly correlation_id: string;
  readonly source_channel: string;
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
  readonly subject: SignalSubject;
  readonly timestamp: string;
}

export interface SignalSubject {
  /** Server-issued, unique per conversation/visit. Mandatory, including for anonymous traffic. */
  readonly session_id: string;
  readonly channel_type: string; // 'line' | 'whatsapp' | 'web' | 'sms' | ...
  /** Channel-native UID (LINE UID, WhatsApp WAID, web visitor id). Exact-match join key only. */
  readonly channel_identifier?: string;
  /** Trusted, server-resolved customer UUID; absent ⇒ anonymous session (no Customer 360 FACT). */
  readonly verified_customer_id?: string;
}

export interface Customer360Fact {
  readonly customer_id: string;
  readonly tenant_id: string;
  /** NULL unless a per-handle, server-verified identity row exists (§03 §1 DOMAIN 5). */
  readonly verified_phone: string | null;
  readonly verified_email: string | null;
  readonly total_spent: number;
  readonly order_count: number;
  /**
   * DERIVED, HYPOTHESIS-class (FR-C360-003). Computed from mirrored transaction aggregates and
   * tenant thresholds; never written back to `customers` or any other SoR mirror (§03 §1.2).
   */
  readonly rfm_segment_hypothesis: string;
  readonly consent_marketing: boolean;
  readonly consent_updated_at: string | null;
  readonly suppression_active: boolean;
  readonly created_at: string;
}

export interface WorkingMemoryContext {
  /** Server-issued unique session id. Anonymous sessions are isolated per `session_id`. */
  readonly session_id: string;
  readonly active_cart_id?: string;
  readonly last_touch_channel: string;
  readonly turn_count: number;
  /** Live projection of `tenant:{tid}:session:{sid}:takeover_lock` (SCR-005). */
  readonly takeover_active: boolean;
}

export interface HydratedContext {
  readonly correlation_id: string;
  readonly tenant_id: string;
  readonly customer: Customer360Fact | null;
  readonly working_memory: WorkingMemoryContext;
  readonly knowledge_citations: Array<{ document_id: string; path: string; score: number }>;
  readonly hydrated_at: string;
}

export interface HypothesisRecord {
  readonly classification: 'HYPOTHESIS'; // Strictly enforced constant
  readonly intent: string;
  readonly confidence: number;
  readonly churn_risk_score: number;
  readonly purchase_propensity: number;
  readonly reasoning: string;
  readonly derived_from_signals: string[];
}

/** Classification of a write destination: a System-of-Record mirror, or an explicitly derived one. */
export type EpistemicWriteTarget = 'FACT' | 'HYPOTHESIS';

/**
 * Epistemic write guard (FR-C360-003, §04 §1.1 invariant 2): an AI-derived value is never written
 * or promoted into a customer `FACT`, and never written back into a System-of-Record mirror (§03
 * §1.2). Only a `FACT` may be written to a `FACT` target; every other classification — including
 * `HYPOTHESIS`, `SIGNAL`, `DECISION` and `ACTION` — is confined to an explicitly derived target.
 *
 * The rule is total and dependency-free, so it can wrap every derived-attribute write path
 * (`Customer360Fact.rfm_segment_hypothesis` and friends) without a model or a database handle.
 *
 * @param params.target - Destination classification: `FACT` (SoR mirror column) or `HYPOTHESIS`
 *   (a derived `*_hypothesis` projection column).
 * @param params.source - Classification of the value being written.
 * @param params.target_ref - Destination name used in the refusal, e.g. `customers.rfm_segment`.
 * @throws OrchestratorError `HYPOTHESIS_PROMOTION_REJECTED` when a non-`FACT` source targets a
 *   `FACT` destination.
 */
export function assertNoHypothesisPromotion(params: {
  readonly target: EpistemicWriteTarget;
  readonly source: EpistemicClassification;
  readonly target_ref: string;
}): void {
  if (params.target !== 'FACT' || params.source === 'FACT') {
    return;
  }

  throw new OrchestratorError(
    'HYPOTHESIS_PROMOTION_REJECTED',
    `${params.source} content must never be written to the FACT target ${params.target_ref} `
      + '(FR-C360-003): a derived value is writable only to an explicitly derived target.',
  );
}

export type PlatformAgentId =
  | 'MKT-01' | 'MKT-02' | 'MKT-03' | 'MKT-04' | 'MKT-05' | 'MKT-06'
  | 'SAL-01' | 'SAL-02' | 'SAL-03' | 'SAL-04' | 'SAL-05'
  | 'CS-01'  | 'CS-02'
  | 'HUMAN_HANDOFF';

export interface RoutingDecision {
  readonly target_agent: PlatformAgentId;
  readonly requires_clarification: boolean;
  readonly clarification_prompt?: string;
  readonly rationalization: string;
}

export interface PlannedStep {
  readonly step_index: number;
  readonly agent_id: PlatformAgentId;
  readonly skill_id: string;
  readonly adapter_target: string;
  readonly input_parameters: Record<string, unknown>;
  readonly required_authority: AuthorityLevel;
  /** Registry-declared: true ⇒ the step has an external effect that must be reserved/reconciled. */
  readonly mutating: boolean;
  /** Required registry classification; price-bearing rows cannot omit this intent. */
  readonly price_bearing: boolean;
  /** Registry-declared: true ⇒ replaying the same key is safe (BR-006, §05 retry policy). */
  readonly idempotent: boolean;
  /** Registry-declared hard deadline (§05 field 10) enforced by the dispatch guard (`dispatchWithDeadline()`). */
  readonly timeout_ms: number;
  /** Predecessor step indexes. Absent or empty means the step follows sequential index order. */
  readonly depends_on_steps?: number[];
  readonly computed_price_floor?: number;
  readonly floor_source?: string;
  readonly proposed_price?: number;
}

export interface ExecutionPlan {
  readonly plan_id: string;
  readonly steps: PlannedStep[];
  readonly fallback_strategy: 'FAIL_CLOSED' | 'ESCALATE_HUMAN';
}

export interface ActionDraft {
  /** Primary key of the `agentos.actions` row. The column is `UUID`, so this is a real UUID. */
  readonly action_id: string;
  readonly run_id: string;
  readonly tenant_id: string;
  readonly agent_id: PlatformAgentId;
  readonly skill_id: string;
  readonly adapter_target: string;
  readonly step_index: number;
  /**
   * Registry-declared effect flag (§05), copied from the `PlannedStep`. Only a mutating action is
   * reserved in `effect_reservations` and reconciled by key; a read-only action carries no
   * external effect, is dispatched unreserved, and stays freely retryable (§4.4).
   */
  readonly mutating: boolean;
  /** Explicit registry classification copied from PlannedStep. */
  readonly price_bearing: boolean;
  /** Immutable inbound identity bound into `effect_key` (never the random `run_id`). */
  readonly request_id: string;
  /** 0 unless a human MODIFY created a new action revision through the approvals gate. */
  readonly action_revision: number;
  /** Deterministic, run-independent idempotency key (§3.2.3, BR-005). */
  readonly effect_key: string;
  readonly required_authority: AuthorityLevel;
  readonly payload: Record<string, unknown>;
  /** Candidate floor mirror; usable only after owner/provenance checks in §8.2. Never LLM-derived. */
  readonly computed_price_floor?: number;
  readonly floor_source?: string;
  readonly proposed_price?: number;
  /** Set only when an AUTH-4 approval authorized this exact action. */
  readonly approval_id?: string;
}

export interface ApprovalGateResult {
  readonly verdict: AuthorityVerdict;
  /** Present when a stored approval covers this action; policy evaluation itself creates no row. */
  readonly approval_id?: string;
  readonly reason: string;
}

export interface ExecutionReceipt {
  readonly execution_id: string;
  readonly adapter_status: 'SUCCESS' | 'ERROR' | 'TIMEOUT';
  readonly provider_reference: string | null;
  readonly response_payload: Record<string, unknown>;
  readonly latency_ms: number;
  readonly token_usage: { prompt: number; completion: number; total_cost_usd: number };
}

export interface ImmutableEvidenceRecord {
  readonly evidence_id: string;
  readonly run_id: string;
  readonly tenant_id: string;
  readonly correlation_id: string;
  readonly step_index: number;
  readonly effect_key: string;
  /** Predecessor's `chain_hash`; GENESIS_HASH for the first record of a run. */
  readonly previous_evidence_hash: string;
  readonly payload_sha256: string; // SHA-256(RFC 8785 canonical raw_payload)
  readonly chain_hash: string;     // SHA-256(previous | payload_sha256 | effect_key | step_index)
  readonly signature: string;      // HMAC-SHA256 over chain_hash
  readonly created_at: string;
}

/** SRS §17 / §08 4.1 canonical 18-field Agent Run record. */
export interface AgentRunLogRecord {
  readonly run_id: string;
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly customer_or_entity_id: string;
  readonly trigger: string;
  readonly context: unknown;
  readonly skill: string;
  readonly step_index: number;
  readonly tool: string;
  readonly decision: unknown;
  readonly authority: AuthorityLevel;
  readonly approval: unknown | null;
  readonly action: unknown;
  readonly execution_status: ExecutionStatus;
  readonly evidence: unknown;
  readonly outcome: unknown | null;
  readonly latency_ms: number;
  readonly cost: unknown;
  readonly error: unknown | null;
  readonly started_at: string;
  readonly completed_at: string;
}

export interface BusinessOutcome {
  readonly outcome_id: string;
  readonly run_id: string;
  readonly revenue_impact: number;
  readonly currency: string;
  readonly conversion_type: 'PURCHASE' | 'CART_RECOVERED' | 'TICKET_RESOLVED' | 'DROPOUT';
  readonly csat_score?: number;
  readonly verified_by_source: string;
  readonly recorded_at: string;
}

export interface OrchestratorRunResult {
  readonly run_id: string;
  readonly lifecycle_state: TaskLifecycleState;
  readonly evidence?: ImmutableEvidenceRecord;
  readonly message?: string;
}

export interface ResolvedSubject {
  readonly customer_id: string | null;
  /** SESSION_BOUND or a provider-authenticated, verified CHANNEL_IDENTIFIER_EXACT binding may attach facts. */
  readonly resolution: 'SESSION_BOUND' | 'CHANNEL_IDENTIFIER_EXACT' | 'UNRESOLVED';
  readonly session_id: string;
}

/**
 * `platform_durable_tasks.state_payload` for a plan that paused or parked (`awaiting_human`,
 * `waiting`) — §4.2, §4.4.
 *
 * It carries the immutable inbound `request_id` on purpose: a later step drafted while resuming
 * must derive the SAME deterministic `effect_key` (§3.2.3) as the original run would have, and
 * `run_id` / timestamps / random UUIDs are never inputs to that key. Everything the resume path
 * needs to re-enter the plan without re-deciding anything is stored here, including the evidence
 * chain cursor, so the resumed step continues the same hash chain.
 *
 * Write discipline: every transition into `waiting` or `awaiting_human` writes a complete
 * checkpoint (`parkTask()` / `pauseForApproval()`), and `resumeTask` fails closed with
 * `CHECKPOINT_INCOMPLETE` rather than re-deciding a plan when one is missing.
 */
export interface DurableTaskCheckpoint {
  readonly plan: ExecutionPlan;
  readonly current_step: number;
  readonly pending_action: ActionDraft | null;
  readonly context: HydratedContext;
  readonly previous_evidence_hash: string;
  readonly request_id: string;
}

/* ------------------------------------------------------------------------------------------------
 * Durable idempotency ports (§04 §3.2.3, §4.4)
 * ---------------------------------------------------------------------------------------------- */

/**
 * `effect_reservations.status` (§03 §1 DOMAIN 5). There is deliberately no "unknown" member: an
 * unconfirmed provider outcome leaves the row `RESERVED`, which is the only canonical way to say
 * "the effect may or may not have landed" (§04 §3.2.4).
 */
export type EffectReservationStatus = 'RESERVED' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED';

/** One durable row of `agentos.effect_reservations`; the column names are the contract (§03 DOMAIN 5). */
export interface EffectReservationRecord {
  readonly tenant_id: string;
  readonly effect_key: string;
  readonly request_id: string;
  readonly request_fingerprint: string;
  readonly run_id: string;
  readonly step_index: number;
  readonly skill_id: string;
  readonly status: EffectReservationStatus;
  /** Provider receipt returned verbatim on replay; NULL while the effect is unproven. */
  readonly response_receipt: unknown | null;
  readonly reserved_at: string;
  readonly resolved_at: string | null;
  readonly expires_at: string;
}

/**
 * The single row a reservation attempt may create. `expires_at` is computed by the engine (the
 * 72-hour idempotency window of §03 §3) rather than by the database, so the durable row and the
 * decision that read it agree on the same instant.
 *
 * `action_revision` is deliberately ABSENT even though `IEffectGuard.reserve()` carries it: the
 * revision is already bound into the canonical `effect_key` itself, and §03 DOMAIN 5 declares no
 * column for it.
 */
export interface ReserveEffectInput {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly request_id: string;
  readonly effect_key: string;
  readonly request_fingerprint: string;
  readonly skill_id: string;
  readonly step_index: number;
  readonly expires_at: string;
}

/**
 * Durable half of the idempotency guarantee (BR-005/BR-006, NFR-003): the tenant-scoped port over
 * `agentos.effect_reservations`. `IEffectGuard` owns the decision; this port owns the durable fact
 * the decision is made from, so no cache or process-local map can ever decide correctness.
 *
 * Every method is tenant-scoped — `tenant_id` leads the primary key and every predicate — and is
 * expected to run inside `withTenantContext()` (§03 §2) so Row-Level Security applies. Each
 * transition is a compare-and-set reporting whether it applied exactly one row, so a concurrent
 * writer can never be mistaken for success.
 */
export interface EffectReservationRepository {
  /**
   * Claims the key: `INSERT ... ON CONFLICT (tenant_id, effect_key) DO NOTHING RETURNING *`.
   *
   * @returns The inserted row, or `null` when a row already existed — the caller lost the race and
   *   must read the durable row instead of dispatching.
   */
  insertReservation(input: ReserveEffectInput): Promise<EffectReservationRecord | null>;

  /**
   * Tenant-scoped read of the reservation for one key.
   *
   * @returns The row, or `null` when this tenant holds no reservation for the key.
   */
  getReservation(tenant_id: string, effect_key: string): Promise<EffectReservationRecord | null>;

  /**
   * Settles a `RESERVED` row: `SUCCEEDED` with the verified receipt, or `FAILED` for a
   * provider-confirmed absence. An indeterminate outcome is NOT a settlement and is never
   * expressed here — the row stays `RESERVED` (§04 §3.2.4).
   *
   * @returns `true` when exactly one `RESERVED` row was settled.
   */
  settleReservation(input: {
    readonly tenant_id: string;
    readonly effect_key: string;
    readonly status: 'SUCCEEDED' | 'FAILED';
    readonly receipt?: unknown;
  }): Promise<boolean>;

  /**
   * §04 §4.4 step 3: a provider-confirmed absence admits exactly one re-dispatch under the SAME
   * `effect_key`, expressed as `FAILED -> RESERVED` with a fresh window.
   *
   * @returns `true` when exactly one `FAILED` row was reopened.
   */
  reopenReservation(input: {
    readonly tenant_id: string;
    readonly effect_key: string;
    readonly expires_at: string;
  }): Promise<boolean>;

  /**
   * §04 §4.4 step 4: bounds how long the engine waits for a proof before escalating the
   * indeterminate effect to a human (`RESERVED -> EXPIRED`).
   *
   * @returns `true` when exactly one `RESERVED` row was expired.
   */
  expireReservation(input: {
    readonly tenant_id: string;
    readonly effect_key: string;
  }): Promise<boolean>;
}

/**
 * The only component allowed to decide idempotency (§04 §3.2.2); instantiated by
 * `durability/EffectGuard` over an injected `EffectReservationRepository`.
 *
 * Three rules are absolute:
 *   * `effect_key` is derived from the immutable inbound request identity and NEVER from `run_id`,
 *     a retry counter, a timestamp or a random UUID, so a redelivered request that starts a new
 *     run still reproduces the same key (§3.2.3, TC-ORC-010).
 *   * a reservation is made durable BEFORE every mutating dispatch, and never for a read-only
 *     action, which has no external effect to deduplicate (§4.4).
 *   * an unconfirmed outcome is never settled and never re-dispatched: the row stays `RESERVED`
 *     and the provider is reconciled by `effect_key` instead (§3.2.4, §4.4).
 *
 * Correctness never depends on a cache: an L1 mirror may only ever degrade latency, never safety.
 */
export interface IEffectGuard {
  computeEffectKey(input: {
    tenant_id: string;
    skill_id: string;
    step_index: number;
    action_revision: number;
    request_id: string;
  }): string;
  computeRequestFingerprint(payload: Record<string, unknown>): string;
  reserve(input: {
    tenant_id: string;
    run_id: string;
    request_id: string;
    effect_key: string;
    request_fingerprint: string;
    skill_id: string;
    step_index: number;
    action_revision: number;
  }): Promise<ReservationOutcome>;
  /**
   * Settles a reservation: `SUCCEEDED` (with the receipt) or `FAILED` (provider-confirmed
   * absence). An indeterminate outcome is deliberately NOT a settlement — the row is left
   * `RESERVED`, which is the only canonical way to express "the effect may or may not have
   * landed" (`effect_reservations.status` accepts RESERVED | SUCCEEDED | FAILED | EXPIRED).
   */
  resolve(input: {
    tenant_id: string;
    effect_key: string;
    status: 'SUCCEEDED' | 'FAILED';
    receipt?: unknown;
  }): Promise<void>;
  /**
   * Provider-side reconciliation of an unsettled effect (§4.4): the stored `response_receipt` is
   * returned verbatim for a confirmed `SUCCEEDED` effect, so a replay never has to synthesize an
   * adapter response for a call that this process did not make. Never a blind re-dispatch.
   */
  reconcile(input: {
    tenant_id: string;
    effect_key: string;
    skill_id: string;
  }): Promise<{ outcome: 'SUCCEEDED' | 'FAILED' | 'INDETERMINATE'; receipt?: unknown }>;
}

/**
 * Reservation decision table (§04 §3.2.3), evaluated against the durable row for
 * `(tenant_id, effect_key)`:
 *
 * | Storage state                                        | Outcome            | Action                          |
 * |------------------------------------------------------|--------------------|---------------------------------|
 * | no row                                                | RESERVED           | dispatch once                   |
 * | same fingerprint, status SUCCEEDED                    | REPLAY             | return stored receipt, no call  |
 * | same fingerprint, status RESERVED, not expired        | IN_FLIGHT          | wait/backoff, never re-dispatch |
 * | same fingerprint, status RESERVED (expired) / FAILED  | RECONCILE_REQUIRED | provider reconciliation (§4.4)  |
 * | different fingerprint                                 | CONFLICT           | abort with IDEMPOTENCY_CONFLICT |
 *
 * The primary key `(tenant_id, effect_key)` makes two workers reserving concurrently resolve to
 * exactly one `RESERVED` outcome. A dispatch whose outcome was never confirmed leaves the row in
 * the `RESERVED` state above — it is never rewritten to an "unknown" status; `expires_at` then
 * bounds how long the engine waits before escalating to a human (§4.4 step 4).
 */
export type ReservationOutcome =
  | { readonly kind: 'RESERVED' }
  | { readonly kind: 'REPLAY'; readonly receipt: unknown }
  | { readonly kind: 'IN_FLIGHT' }
  | { readonly kind: 'RECONCILE_REQUIRED' }
  | { readonly kind: 'CONFLICT' };

/* ------------------------------------------------------------------------------------------------
 * Durable workflow, evidence and audit ports (§04 §3.3)
 * ---------------------------------------------------------------------------------------------- */

/**
 * `platform_durable_tasks` as the resume path reads it (§03 DOMAIN 5, §04 §4.2). `state_payload` is
 * the JSONB blob: a complete `DurableTaskCheckpoint` for a task parked in `waiting` /
 * `awaiting_human`, and the progress payload written by `updateTaskProgress()` otherwise. It stays
 * `unknown` because only the caller may narrow it — and `resumeTask` fails closed with
 * `CHECKPOINT_INCOMPLETE` rather than re-deciding a plan when it cannot.
 */
export interface DurableTaskSnapshot {
  readonly task_version: number;
  readonly state: TaskLifecycleState;
  readonly correlation_id: string;
  readonly state_payload: unknown;
  readonly lease_owner?: string | null;
  readonly lease_expires_at?: string | null;
}
/**
 * Optimistic and fencing guard for durable task writes (§04 §4.2).
 */
export interface DurableTaskGuard {
  readonly expected_task_version?: number;
  readonly lease_owner?: string | null;
}

/** The durable FSM of §04 §4.1–§4.2; persistence is owned by `platform_durable_tasks`, never a cache. */
export interface IStatefulWorkflowEngine {
  /** Every durable-task method is tenant-scoped: the primary key and the RLS predicate both lead with `tenant_id` (NFR-006). */
  createTask(task: {
    run_id: string;
    tenant_id: string;
    correlation_id: string;
    current_step: number;
    state: TaskLifecycleState;
    state_payload?: unknown;
    lease_owner?: string | null;
    lease_expires_at?: string | null;
  }): Promise<void>;
  updateTaskProgress(
    tenant_id: string,
    run_id: string,
    stepIndex: number,
    checkpointPayload: unknown,
    guard?: DurableTaskGuard
  ): Promise<void>;
  transitionTask(
    tenant_id: string,
    run_id: string,
    state: TaskLifecycleState,
    reason: string,
    checkpointPayload?: unknown,
    guard?: DurableTaskGuard
  ): Promise<void>;
  getTask(tenant_id: string, run_id: string): Promise<DurableTaskSnapshot | null>;
  /** One transaction: INSERT the PENDING approval row + pause the task (§4.2). */
  pauseForApproval(params: {
    tenant_id: string;
    run_id: string;
    expected_task_version: number;
    checkpoint: unknown;
    approval: { action_id: string; effect_key: string; payload: unknown; reason: string };
  }): Promise<{ approval_id: string }>;
  /** One transaction: decide and resume/stop, or retain PENDING + awaiting_human for PAUSE (§4.2). */
  claimApprovalAndResume(params: {
    tenant_id: string;
    run_id: string;
    approval_id: string;
    effect_key: string;
    expected_payload_sha256: string;
    authorized_action: ActionDraft | null;
    decision: 'APPROVED' | 'MODIFIED' | 'REJECTED' | 'PAUSE' | 'CANCELLED';
    operator_id: string;
    review_comment: string | null;
  }): Promise<{ claimed: boolean }>;
  /** §4.4 durable recovery: classify, count, re-queue or fail terminally. */
  recordFailure(params: {
    tenant_id: string;
    run_id: string;
    /** `last_error_class` accepts only RETRYABLE | FATAL; UNKNOWN is a reconciliation state (§4.4). */
    error_class: PersistedErrorClass;
    error_details: Record<string, unknown>;
    expected_task_version?: number;
    guard?: DurableTaskGuard;
  }): Promise<{ requeued: boolean }>;
}

/**
 * Append-only writer of the per-run evidence chain (§04 §6.1) — `evidence_records`,
 * `agent_run_logs` and `pending_outcome_attributions`, the three objects of §6.2. The digest and
 * chain rules are owned by `durability/evidence.ts`; this port only persists their result.
 */
export interface IEvidenceLogger {
  createImmutableRecord(params: {
    run_id: string;
    tenant_id: string;
    correlation_id: string;
    step_index: number;
    effect_key: string;
    previous_evidence_hash: string;
    payload: Record<string, unknown>;
  }): Promise<ImmutableEvidenceRecord>;
  initializeOutcomeWatch(params: { tenant_id: string; run_id: string; effect_key: string; skill_id: string }): Promise<void>;
  logAgentRun(runLog: AgentRunLogRecord): Promise<void>;
}

/**
 * Canonical chained compliance writer (`audit_records`, §08 §4.1). The engine appends EVERY event
 * of a step here — the AUTH-4 pause, each failing attempt, each retry, each reconciliation attempt
 * and the terminal outcome — so exactly one writer owns the tenant's hash chain (NFR-002).
 */
export interface IAuditTrail {
  append(record: AgentRunLogRecord): Promise<void>;
}
