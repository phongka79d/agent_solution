# Core Engine and Revenue Orchestrator Specification

> **BLUEPRINT STATUS — target design; NOT IMPLEMENTED, DEPLOYED, MEASURED, or runtime evidence.**
> This document owns the future orchestrator contract for SRS §12, §17, §19 / NFR-003, NFR-006, NFR-007, and NFR-008.
> Every code, workflow, and interface block is a **target snippet**, not a present runtime artifact.

Status: Target Blueprint Specification (Gate P0) — not an implemented system
System Component: Core Platform Engine (Layer 1)
Document Version: 1.0.0
Target Directory: `implement/04-core-engine-and-orchestrator.md`


---

## 1. Executive Summary and Architectural Invariants

The Core Platform Engine forms the domain-agnostic, tenant-isolated foundation of the AI Agent Platform. It coordinates the actions of all domain agents (Marketing, Sales, Customer Care) through a centralized, strictly governed execution loop.

### 1.1. Core Invariants
1. **Zero Direct Agent-to-Agent Coupling**: Domain agents (`MKT-*`, `SAL-*`, `CS-*`) are strictly isolated cognitive units. They cannot invoke, message, or depend on each other directly. All cross-domain interactions, context handoffs, and workflows are brokered through the centralized **Revenue Orchestrator**.
2. **Epistemic Boundary Separation (FR-C360-003)**:
   - `FACT`: Verified historical and transactional data retrieved from a System of Record (ERP/POS/Web/App).
   - `SIGNAL`: Raw, real-time observable user actions and event telemetry (Web/App, Webhooks).
   - `HYPOTHESIS`: Probabilistic AI inferences, churn scores, intent classifications, propensity estimates, and every platform-derived attribute (RFM segment, lead readiness, opportunity score).
   - **Hard Invariant**: An AI `HYPOTHESIS` shall NEVER be written or promoted into a Customer `FACT`, and never written back into a System-of-Record mirror table, without explicit validation from a System of Record. Derived attributes therefore carry an explicit `_hypothesis` suffix in every projection and skill output (§03 §1.2).
3. **Authority Verdict Model (SRS §12, BR-008, BR-009)**: `AUTH-0`..`AUTH-3` are the only assignable clearance levels and the only values that take part in a numeric comparison. `AUTH-4` is a **verdict** — "prepared, not executed; requires human approval" — and `AUTH-5` is a **verdict** — "prohibited: hard deny". Neither ever appears in an agent grant, in a numeric comparison, or in a resume path: an approval authorizes one specific action (`tenant_id`, `run_id`, `effect_key`) exactly once and never raises an agent's clearance.
4. **Fail-Closed Execution Policy (NFR-008)**: If any required context, consent record, authoritative floor price ($P_{floor}$), verified customer identity, or authority verdict cannot be validated with 100% certainty, the system halts the step, enters a safe fallback state, and escalates to a human operator (`SCR-003` / `SCR-005`). An unregistered skill, an unknown authority value, and an unresolved identity are hard failures — never client-side fallbacks.
5. **Idempotency Guarantee (NFR-003, BR-005, BR-006)**: Every mutating external action is bound to a deterministic `effect_key` derived from the immutable inbound request identity — never from `run_id`, a timestamp, or a random UUID — and reserved durably in `effect_reservations` before its network call. (A read-only action has no external effect to deduplicate, is therefore never reserved, and stays freely retryable under its declared policy — §4.4.) Re-execution with an identical `effect_key` yields the previously committed receipt without side effects; an in-flight or timed-out attempt is reconciled, never blindly retried.
6. **Strict Multi-Tenant and Per-Customer Isolation (NFR-006)**: Every memory lookup, vector query, database transaction, message envelope, and working-memory bucket is scoped by `tenant_id` and, for customer data, by the resolved `customer_id` or a unique server-issued `session_id`. Anonymous traffic is isolated per session; there is no shared anonymous bucket, so customer A's context can never be hydrated into customer B's.
7. **Human Takeover Supremacy (NFR-007, SCR-005)**: While a human operator holds the session takeover lock, no agent step may be drafted or dispatched. The check is re-evaluated before every step and every retry, and the operator can return the conversation to the agent, which releases the lock and restores normal routing.

---

## 2. The 11-Step Revenue Orchestrator Pipeline

The Revenue Orchestrator executes a deterministic 11-step lifecycle for every incoming signal.

```
+----------------------------------------------------------------------------------------------------+
|                                    11-STEP REVENUE ORCHESTRATOR                                    |
+----------------------------------------------------------------------------------------------------+
| [1. SIGNAL]      Receive raw external event (Web/App, POS, Chat, Webhook)                          |
|        |                                                                                           |
| [2. CONTEXT]     Hydrate Customer 360 (Fact), Active Session, Consent, Policies                    |
|        |                                                                                           |
| [3. HYPOTHESIS]  Derive probabilistic intent, opportunity score, churn risk (Tagged HYPOTHESIS)   |
|        |                                                                                           |
| [4. DECISION]    Determine business objective, route to authorized Agent (FR-ORC-001)              |
|        |                                                                                           |
| [5. PLAN]        Formulate step-by-step multi-agent execution workflow (FR-ORC-002)                |
|        |                                                                                           |
| [6. ACTION]      Draft tool payloads, verify mathematical floor price P_floor, generate effect_key |
|        |                                                                                           |
| [7. APPROVAL]    Authority verdict: AUTH-0..3 auto; AUTH-4 -> SCR-003 gate; AUTH-5 -> hard deny |
|        |                                                                                           |
| [8. EXECUTION]   Reserve effect_key durably, then dispatch via Plug-and-Play Adapters            |
|        |                                                                                           |
| [9. EVIDENCE]    Capture cryptographically signed provider response and transaction hashes         |
|        |                                                                                           |
| [10. OUTCOME]    Observe actual business conversion, financial settlement, CSAT impact             |
|        |                                                                                           |
| [11. LEARNING]   Update model weights, policy reflection parameters, and Learning Memory           |
+----------------------------------------------------------------------------------------------------+
```

### 2.1. Stage-by-Stage Specification

| Step | Stage Name | Inputs | Outputs | Core Responsibilities & Invariants |
|---|---|---|---|---|
| **1** | `SIGNAL` | Inbound HTTP/Webhook payload, timestamp, source adapter | Normalized `SignalEnvelope` | Ingests telemetry, assigns `correlation_id`, validates schema, checks basic tenant authorization. |
| **2** | `CONTEXT` | `SignalEnvelope`, `tenant_id`, `subject` (`session_id` + trusted `verified_customer_id`) | `HydratedContext` | Resolves identity server-side (§5.1), fetches Customer 360 (Facts), Consent tokens (BR-004), the session-scoped scratchpad, and Second Brain citations. Anonymous sessions stay isolated by `session_id`; a tenant mismatch fails closed. |
| **3** | `HYPOTHESIS` | `HydratedContext`, `SignalEnvelope` | `HypothesisRecord` | Computes intent probability, lead readiness, churn likelihood. Explicitly tags records as `HYPOTHESIS`. Prohibits overwriting `FACT` and any SoR mirror. |
| **4** | `DECISION` | `HypothesisRecord`, `TenantPolicies` | `RoutingDecision` | Selects target Agent (`marketing`, `sales`, `support`) or triggers clarification rule (Single Question Rule). |
| **5** | `PLAN` | `RoutingDecision`, `HydratedContext` | `ExecutionPlan` | Constructs sequential/parallel DAG of skill invocations, channel allocations, and timeout parameters. |
| **6** | `ACTION` | `ExecutionPlan`, `AgentDraftPayload` | `ActionDraft` | Synthesizes tool invocation payloads, verifies the authoritative pricing floor ($P_{floor}$ + provenance), and derives the deterministic `effect_key` from the inbound request identity (§3.2.3). |
| **7** | `APPROVAL` | `ActionDraft`, `AuthorityPolicy` | `ApprovalGateResult` | Applies the canonical authority verdict: `AUTH-0`..`AUTH-3` auto-approve by rank; `AUTH-4` persists one PENDING `approvals` row and pauses for SCR-003; `AUTH-5` is an immediate hard deny that is never queued. |
| **8** | `EXECUTION` | Approved `ActionDraft`, Adapter Binding | `ExecutionReceipt` | Reserves the `effect_key` durably (`effect_reservations`) **before** dispatching a mutating action to the external provider (ERP, LINE, Stripe) via Adapter under the step deadline; a read-only action has no external effect to reserve. A dispatch time-out leaves the reservation `RESERVED` and is recorded as `execution_status = 'failed'` with `error.outcome = 'UNKNOWN'` — the six-value audit vocabulary has no `unknown` status — then reconciled by `effect_key`, never retried blind. |
| **9** | `EVIDENCE` | `ExecutionReceipt`, `ActionDraft` | `ImmutableEvidenceRecord` | Computes SHA-256 payload digests, extends the `chain_hash` chain, and stores the immutable proof in PostgreSQL `evidence_records`. |
| **10** | `OUTCOME` | `ImmutableEvidenceRecord`, Downstream Events | `OutcomeAttribution` | Matches async business outcomes (order settled, payment received, cart cleared, CSAT scored) to originating `run_id`. |
| **11** | `LEARNING` | `OutcomeAttribution`, `HypothesisRecord` | `MemoryOptimizationRecord`| Computes reward signal, updates prompt few-shot demonstrations, updates strategy priors in Second Brain Learning Memory. |

---

## 3. Concrete Orchestrator Implementation (TypeScript Core)

The listings below are the normative control-flow contract of the Core Engine. Injected dependencies (`IContextAggregator`, `IAgentRuntime`, `IPolicyEngine`, `IStatefulWorkflowEngine`, `IEvidenceLogger`, `IAuditTrail`, `IAdapterDispatcher`, `IEffectGuard`, `IIdentityResolver`, `ISessionControl`, `DurableLeaseManager`) are runtime bindings supplied by the platform; the orchestrator never fabricates their results. Subroutines that require a model call (hypothesis derivation, routing, plan formulation) are declared as interfaces and **fail closed** if the binding is absent — the engine never returns a hard-coded score, a canned routing decision, or a placeholder SKU as if it were production evidence.

### 3.1. Canonical Types, Enums and Constants

```typescript
/**
 * @file 11-step-revenue-orchestrator.ts
 * @description Core Revenue Orchestrator Engine enforcing the 11-step E2E lifecycle.
 */

import { createHash, randomUUID } from 'crypto';
import { EventEmitter } from 'events';

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

/** Mutable chain cursor shared across plan steps (previous_evidence_hash threading). */
interface EvidenceChain {
  previous: string;
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
```

### 3.2. Authoritative Guard Algorithms

#### 3.2.1. Authority verdict (canonical, shared with §08)

```typescript
/**
 * Evaluates the authority gate for one drafted action. The only numeric comparison in the whole
 * platform is `AUTHORITY_RANK[granted] < AUTHORITY_RANK[required]`, and it is reachable only
 * when BOTH values are assignable clearances (AUTH-0..AUTH-3). AUTH-4 and AUTH-5 short-circuit:
 *
 *   required = AUTH-4 → never executable by an agent; persist exactly one PENDING approval row
 *                       (`approvals`, SCR-003) and pause. The approval authorizes one specific
 *                       (tenant_id, run_id, effect_key) execution and never raises a clearance.
 *   required = AUTH-5 → prohibited: deny immediately. Never queued, never approvable, never
 *                       dispatched; an audit record with execution_status = 'denied' is written.
 */
export function evaluateAuthorityVerdict(
  granted: AssignableAuthority,
  required: AuthorityLevel
): { verdict: AuthorityVerdict; reason: string } {
  if (!Object.hasOwn(AUTHORITY_RANK, granted)) {
    return { verdict: 'DENIED', reason: `INVALID_CLEARANCE: '${String(granted)}' is not assignable.` };
  }
  if (required === 'AUTH-5') {
    return { verdict: 'DENIED', reason: 'PROHIBITED_ACTION: AUTH-5 is a hard deny verdict (SRS §12, BR-008).' };
  }
  if (required === 'AUTH-4') {
    return { verdict: 'AWAITING_HUMAN_APPROVAL', reason: 'APPROVAL_REQUIRED: AUTH-4 requires a bound human decision (BR-007).' };
  }
  if (!Object.hasOwn(AUTHORITY_RANK, required)) {
    return { verdict: 'DENIED', reason: `INVALID_AUTHORITY_REQUIREMENT: '${String(required)}' is unknown.` };
  }
  if (AUTHORITY_RANK[granted] < AUTHORITY_RANK[required as AssignableAuthority]) {
    return { verdict: 'DENIED', reason: `INSUFFICIENT_AUTHORITY: requires ${required}, granted ${granted}.` };
  }
  return { verdict: 'AUTO_APPROVED', reason: `AUTHORIZED: ${granted} covers ${required}.` };
}
```

#### 3.2.2. Identity and session binding

* `IEffectGuard`, `IIdentityResolver` and `ISessionControl` are the only components allowed to decide idempotency, customer binding, and takeover state. They fail closed: an unresolved identity yields `customer = null` (anonymous context) and **any skill whose schema requires a customer identifier refuses to run**; a missing `session_id` aborts the run at step [1. SIGNAL].
* Per-customer verification is never inferred from payload phone/email/handle or VIP flags. `SESSION_BOUND` is gateway-authenticated; `CHANNEL_IDENTIFIER_EXACT` requires a provider-authenticated sender and an exact tenant/channel identity row whose `verified_at` is non-null. An unverified match stays `UNRESOLVED` with `customer_id = null`; §5.1 owns this boundary.
* Working memory is keyed by the unique server-issued `session_id` (`tenant:{tid}:wm:{sid}`). Anonymous sessions never share a bucket, so customer A's scratchpad can never be hydrated into customer B's context (NFR-006).

#### 3.2.3. Deterministic `effect_key` and reservation protocol

```typescript
/**
 * BR-005 canonical shape: SHA-256(tenant_id + action_type + unique_context_id).
 * This engine instantiates it as:
 *
 *   effect_key = hex(SHA-256(RFC8785({
 *     tenant_id, skill_id, step_index, action_revision, request_id
 *   })))
 *
 * `request_id` is the immutable inbound identity (signal_id / webhook delivery id / message id).
 * run_id, retry counters, timestamps and random UUIDs are NEVER inputs: a new run (worker crash,
 * redelivered webhook, operator retry) that replays the same inbound request reproduces the same
 * key and therefore cannot duplicate the external effect.
 *
 * `request_fingerprint = hex(SHA-256(RFC8785(payload)))` is stored alongside the key so that a
 * replayed key carrying a different payload is detected as a conflict instead of being merged.
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
  /**
   * Durable-first reservation of an effect key, called before EVERY mutating dispatch (BR-005)
   * and never for a read-only action, which has no external effect to deduplicate. Layer 1 is
   * Redis (`tenant:{tid}:effect:{effect_key}`, 72 h); the durable authority is
   * `effect_reservations` (§03 §1 DOMAIN 5). Correctness never depends on Redis:
   * an unavailable cache degrades latency, not safety.
   */
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
   * Settles a reservation: SUCCEEDED (with the receipt) or FAILED (provider-confirmed absence).
   * An indeterminate outcome is deliberately NOT a settlement — the row is left RESERVED, which
   * is the only canonical way to express "the effect may or may not have landed"
   * (`effect_reservations.status` accepts RESERVED | SUCCEEDED | FAILED | EXPIRED, §03 DOMAIN 5).
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

export type ReservationOutcome =
  | { readonly kind: 'RESERVED' }                            // first delivery: safe to dispatch
  | { readonly kind: 'REPLAY'; readonly receipt: unknown }    // same key + payload, already SUCCEEDED: return the stored receipt, no call
  | { readonly kind: 'IN_FLIGHT' }                            // identical key, RESERVED and unexpired
  | { readonly kind: 'RECONCILE_REQUIRED' }                   // expired RESERVED row, or a prior FAILED attempt
  | { readonly kind: 'CONFLICT' };                            // same key, different canonical payload

/**
 * Reservation decision table (implemented by `IEffectGuard`, persisted in
 * `effect_reservations` through `INSERT ... ON CONFLICT (tenant_id, effect_key) DO NOTHING`):
 *
 * | Storage state for (tenant_id, effect_key)              | Outcome            | Action                          |
 * |--------------------------------------------------------|--------------------|---------------------------------|
 * | no row                                                  | RESERVED           | dispatch once                   |
 * | same fingerprint, status SUCCEEDED                      | REPLAY             | return stored receipt, no call  |
 * | same fingerprint, status RESERVED, not expired          | IN_FLIGHT          | wait/backoff, never re-dispatch |
 * | same fingerprint, status RESERVED (expired) / FAILED    | RECONCILE_REQUIRED | provider reconciliation (§4.4)  |
 * | different fingerprint                                   | CONFLICT           | abort with IDEMPOTENCY_CONFLICT |
 *
 * A dispatch whose outcome was never confirmed leaves the row in the `RESERVED` row state above
 * (it is never rewritten to an "unknown" status); `expires_at` then bounds how long the engine
 * waits before escalating to a human (§4.4 step 4). The primary key (tenant_id, effect_key)
 * makes two workers reserving concurrently resolve to exactly one RESERVED outcome; Redis never
 * decides correctness on its own.
 *
 * Only a mutating action is ever presented to this guard (§3.3 `acquireEffectSlot`): a read-only
 * action has no external effect, is never inserted here, and is therefore freely retryable.
 */
```

#### 3.2.4. Failure classification

Every failure is classified before any state change. `UNKNOWN` is reserved for an unconfirmed
outcome on a step with an **external effect** (dispatch time-out, transport error, unparsable
provider body): the provider may or may not have applied the effect, so the engine reconciles by
`effect_key` instead of retrying (§4.4). Because the six-value audit vocabulary has no "unknown"
status, such an attempt is recorded as `execution_status = 'failed'` with
`error = { code: 'DISPATCH_TIMEOUT' | 'PROVIDER_INDETERMINATE', outcome: 'UNKNOWN' }`, and the
reservation is left RESERVED — the audit trail therefore never claims a success it cannot prove
and never pretends the provider is known to be untouched.

`RETRYABLE` is the normal transient class and is never applied to a step whose first attempt may
have landed: read-only steps (no external effect) may be retried under their declared retry
policy, and an effect-bearing step only after a reconciliation has proven the absence of the
effect. `FATAL` terminates the task. The mapping lives in `classifyFailure()` below and is
consumed by the durable recovery path.

The classification is only reachable because the **dispatch guard** (`dispatchWithDeadline()`,
§3.3) enforces the step deadline and normalizes a bare, non-canonical adapter error into
`PROVIDER_INDETERMINATE`: an adapter that raises without a verifiable receipt cannot be shown to be
a no-op, so it is treated as an unproven effect instead of a terminal failure. `UNKNOWN` is never
applied to a read-only step — with no reservation there is nothing to reconcile, so an
unconfirmed read failure is re-queued as `RETRYABLE` under its declared policy.

### 3.3. The Orchestrator

```typescript
export class RevenueOrchestrator {
  private readonly eventBus: EventEmitter;

  constructor(
    private readonly dependencies: {
      contextAggregator: IContextAggregator;
      agentRuntime: IAgentRuntime;
      policyEngine: IPolicyEngine;
      workflowEngine: IStatefulWorkflowEngine;
      evidenceLogger: IEvidenceLogger;
      auditTrail: IAuditTrail;
      adapterDispatcher: IAdapterDispatcher;
      effectGuard: IEffectGuard;
      sessionControl: ISessionControl;
      leaseManager: DurableLeaseManager;
      workerId?: string;
    }
  ) {
    this.eventBus = new EventEmitter();
  }

  private get workerId(): string {
    return this.dependencies.workerId ?? `worker_${randomUUID().substring(0, 8)}`;
  }

  /**
   * Executes the full 11-step E2E lifecycle (FR-ORC-002 multi-step DAG included).
   */
  public async processSignal(signal: SignalEnvelope): Promise<OrchestratorRunResult> {
    // STEP 1: SIGNAL VALIDATION — fail closed before any durable write.
    this.validateSignalEnvelope(signal);

    const request_id = signal.signal_id; // immutable inbound identity (idempotency anchor)
    const run_id = `run_${randomUUID()}`;
    const chain: EvidenceChain = { previous: GENESIS_HASH };

    const leaseAcquired = await this.dependencies.leaseManager.acquireLease(signal.tenant_id, run_id, this.workerId);
    if (!leaseAcquired) {
      throw new OrchestratorError('CONCURRENT_TASK_LOCK', `Unable to acquire execution lease for ${run_id}`);
    }

    await this.dependencies.workflowEngine.createTask({
      run_id,
      tenant_id: signal.tenant_id,
      correlation_id: signal.correlation_id,
      current_step: 1,
      state: 'running',
    });

    try {
      // STEP 2: CONTEXT HYDRATION (trusted identity resolution + session-scoped memory)
      const context = await this.dependencies.contextAggregator.hydrateContext(
        signal.tenant_id,
        signal.subject,
        signal.correlation_id
      );
      const sessionId = context.working_memory.session_id;

      if (await this.dependencies.sessionControl.isTakenOver(signal.tenant_id, sessionId)) {
        await this.dependencies.workflowEngine.transitionTask(signal.tenant_id, run_id, 'stopped', 'HUMAN_TAKEOVER at step [2. CONTEXT] (SCR-005)');
        return { run_id, lifecycle_state: 'stopped', message: 'Session locked by human operator' };
      }

      // STEP 3: HYPOTHESIS FORMATION (explicitly HYPOTHESIS-class, cannot write to FACT)
      const hypothesis = await this.dependencies.agentRuntime.deriveHypothesis(signal, context);
      this.enforceEpistemicSeparation(hypothesis);

      // STEP 4: DECISION & ROUTING (FR-ORC-001)
      const routing = await this.dependencies.agentRuntime.resolveRouting(signal, context, hypothesis);

      if (routing.target_agent === 'HUMAN_HANDOFF') {
        await this.dependencies.workflowEngine.transitionTask(signal.tenant_id, run_id, 'awaiting_human', 'Routed to human agent queue');
        return { run_id, lifecycle_state: 'awaiting_human', message: 'Escalated to human operator' };
      }

      // STEP 5: PLAN FORMULATION. The Single Clarification Rule produces a one-step plan, so a
      // clarification message passes the SAME authority, reservation and evidence guards as any
      // other outbound action (it is a real external mutation).
      const plan = routing.requires_clarification
        ? this.buildClarificationPlan(routing, signal, context)
        : await this.dependencies.agentRuntime.formulatePlan(routing, context, hypothesis);

      // STEPS 6-9: GUARDED STEP LOOP (the single guarded step engine, shared with the resume path)
      const outcome = await this.executeSteps({
        signal,
        tenant_id: signal.tenant_id,
        run_id,
        correlation_id: signal.correlation_id,
        request_id,
        plan,
        context,
        chain,
        from_step: 1,
        approved_action: null,
        approval_ref: null,
      });
      if (outcome.lifecycle_state !== 'completed') {
        return { run_id, lifecycle_state: outcome.lifecycle_state, evidence: outcome.evidence, message: outcome.message };
      }

      // STEPS 10-11: OUTCOME BASELINE & LEARNING UPDATE
      await this.updateLearningMemory(signal.tenant_id, run_id, hypothesis, outcome.evidence);
      await this.dependencies.workflowEngine.transitionTask(signal.tenant_id, run_id, 'completed', 'All plan steps verified');

      return { run_id, lifecycle_state: 'completed', evidence: outcome.evidence };
    } catch (error) {
      // Durable recovery (§4.4). `UNKNOWN` is not a persisted error class: an indeterminate
      // external outcome is a reconciliation state, so the durable task is parked in `waiting`
      // and the scheduler resolves it by `effect_key` — it is neither failed nor re-dispatched.
      const failure_class = this.classifyFailure(error);
      if (failure_class === 'UNKNOWN') {
        await this.dependencies.workflowEngine.transitionTask(
          signal.tenant_id,
          run_id,
          'waiting',
          'EFFECT_UNKNOWN: provider outcome indeterminate; reconciliation scheduled (§4.4)'
        );
        return {
          run_id,
          lifecycle_state: 'waiting',
          message: 'Provider outcome is UNKNOWN; reconciling by effect_key before any retry',
        };
      }
      // RETRYABLE (re-queued under max_retries) or FATAL (terminal): hand the classified failure
      // to the durable scheduler.
      await this.dependencies.workflowEngine.recordFailure({
        tenant_id: signal.tenant_id,
        run_id,
        error_class: failure_class,
        error_details: this.serializeError(error),
      });
      throw error;
    } finally {
      await this.dependencies.leaseManager.releaseLease(signal.tenant_id, run_id, this.workerId);
    }
  }

  /**
   * The single guarded step engine (steps 6-9): draft → floor → authority → reserve → dispatch →
   * evidence. `processSignal` and `resumeTask` both call it, so a resumed run re-applies the
   * IDENTICAL guard sequence to every remaining step. Every step, including a released action,
   * rechecks the current grant, registry, consent, identity, source/floor and takeover policy.
   * A bound claimed approval satisfies only its own AUTH-4 pause; it never becomes a clearance.
   *
   * Takeover is re-checked before every step — hence before every retry and every resume.
   *
   * `approved_action` is the persisted action a human decision released, bound to
   * `(tenant_id, run_id, effect_key)` and claimed exactly once (§4.2). It is dispatched as
   * persisted under its own deterministic key and skips no independent safety gate.
   */
  private async executeSteps(params: {
    signal: SignalEnvelope | null;
    tenant_id: string;
    run_id: string;
    correlation_id: string;
    request_id: string;
    plan: ExecutionPlan;
    context: HydratedContext;
    chain: EvidenceChain;
    /** Plan steps below this index already executed and are evidenced; they are not re-run. */
    from_step: number;
    approved_action: ActionDraft | null;
    approval_ref: {
      approval_id: string | null;
      decision: 'APPROVED' | 'MODIFIED' | null;
      operator_id: string | null;
    } | null;
  }): Promise<{ lifecycle_state: TaskLifecycleState; evidence?: ImmutableEvidenceRecord; message?: string }> {
    const { tenant_id, run_id, correlation_id, request_id, plan, context, chain } = params;
    const sessionId = context.working_memory.session_id;
    // A first pass carries the inbound event; a resume carries the decision that released it.
    const trigger = params.signal ? params.signal.event_type : 'task.resume';
    let latestEvidence: ImmutableEvidenceRecord | undefined;

    for (const step of plan.steps) {
      if (step.step_index < params.from_step) {
        continue; // already executed and chained before the pause
      }
      const stepStartTime = Date.now();
      const stepStartedAt = new Date(stepStartTime).toISOString();

      // SCR-005 guard, per step (hence per retry and per resume): a takeover landing mid-run stops
      // the very next dispatch rather than only the first.
      if (await this.dependencies.sessionControl.isTakenOver(tenant_id, sessionId)) {
        const reason = 'HUMAN_TAKEOVER: session lock held by operator (SCR-005)';
        await this.dependencies.workflowEngine.transitionTask(tenant_id, run_id, 'stopped', reason);
        await this.logRun({
          tenant_id, run_id, correlation_id, trigger, step, context,
          startedAt: stepStartedAt, startTime: stepStartTime,
          execution_status: 'aborted', authority: step.required_authority, approval: null,
          action: { drafted: false, reason: 'HUMAN_TAKEOVER' },
          evidence: { recorded: false, reason: 'HUMAN_TAKEOVER' },
          error: { code: 'HUMAN_TAKEOVER' },
          disposition: 'terminal',
        });
        return { lifecycle_state: 'stopped', message: reason };
      }

      await this.dependencies.workflowEngine.updateTaskProgress(tenant_id, run_id, step.step_index, {
        plan_id: plan.plan_id,
        current_step: step.step_index,
        skill_id: step.skill_id,
        agent_id: step.agent_id,
      });

      // STEPS 6-7: ACTION DRAFTING (deterministic effect_key + authoritative floor).
      const released = params.approved_action !== null
        && params.approved_action.step_index === step.step_index;
      const action: ActionDraft = released
        ? (params.approved_action as ActionDraft)
        : await this.draftAction(step, context, run_id, tenant_id, request_id, 0);
      this.verifyFloorPrice(action);

      // STEP 7: recheck current policy even after a human decision was claimed.
      // A stored claim satisfies only AUTH-4 for its exact action/digest; consent, source,
      // floor, identity, grant and takeover checks still run and may refuse dispatch.
      if (released) {
        const approvalRef = params.approval_ref;
        if (
          action.required_authority !== 'AUTH-4'
          || !approvalRef?.approval_id
          || action.approval_id !== approvalRef.approval_id
          || !params.approved_action
          || params.approved_action.effect_key !== action.effect_key
        ) {
          throw new OrchestratorError(
            'APPROVAL_BINDING_REQUIRED',
            'A released action must carry the claimed AUTH-4 approval bound to its exact effect key.'
          );
        }
      }
      const authorization = await this.dependencies.policyEngine.evaluateAuthority(action, context);

      if (authorization.verdict === 'DENIED') {
        await this.dependencies.workflowEngine.transitionTask(tenant_id, run_id, 'stopped', `Authority denied: ${authorization.reason}`);
        await this.logRun({
          tenant_id, run_id, correlation_id, trigger, step, context,
          startedAt: stepStartedAt, startTime: stepStartTime,
          execution_status: 'denied', authority: action.required_authority, approval: null,
          action,
          evidence: { recorded: false, reason: 'AUTHORITY_DENIED' },
          error: { code: 'AUTHORITY_DENIED', reason: authorization.reason },
          disposition: 'terminal',
        });
        return { lifecycle_state: 'stopped', message: authorization.reason };
      }

      if (authorization.verdict === 'AWAITING_HUMAN_APPROVAL') {
        if (released) {
          throw new OrchestratorError(
            'APPROVAL_CLAIM_NOT_RECOGNIZED',
            'The bound approval no longer satisfies the current authority verdict; dispatch is refused.'
          );
        }
        const currentTask = await this.dependencies.workflowEngine.getTask(tenant_id, run_id);
        if (!currentTask) throw new OrchestratorError('TASK_NOT_FOUND', run_id);
        const taskVersion = currentTask.task_version;
        // One transaction: INSERT the PENDING approval row and pause the durable task together,
        // bound to this tenant, this run and this effect key. The approval row (never a queue
        // copy) is the only resume authority (§03 Entity 24).
        const paused = await this.dependencies.workflowEngine.pauseForApproval({
          tenant_id,
          run_id,
          expected_task_version: taskVersion,
          checkpoint: {
            plan,
            current_step: step.step_index,
            pending_action: action,
            context,
            previous_evidence_hash: chain.previous,
            request_id,
          },
          approval: {
            action_id: action.action_id,
            effect_key: action.effect_key,
            payload: action.payload,
            reason: authorization.reason,
          },
        });

        // A PENDING approval means "prepared, not executed": the step's disposition is not decided
        // yet, so the audit trail records `pending` (never `success`) and the step's single
        // `agent_run_logs` row is appended only when the decision resolves the step.
        await this.logRun({
          tenant_id, run_id, correlation_id, trigger, step, context,
          startedAt: stepStartedAt, startTime: stepStartTime,
          execution_status: 'pending', authority: action.required_authority,
          approval: { approval_id: paused.approval_id, verdict: authorization.verdict, reason: authorization.reason },
          action: { ...action, approval_id: paused.approval_id },
          evidence: { recorded: false, reason: 'AWAITING_HUMAN_APPROVAL' },
          error: null,
          disposition: 'attempt',
        });
        return {
          lifecycle_state: 'awaiting_human',
          message: `Paused for Human Approval at step ${step.step_index} in SCR-003 (approval ${paused.approval_id})`,
        };
      }

      // What authorized this step: the human decision that released it, or the autonomous verdict.
      const approvalRecord = this.approvalField(released ? params.approval_ref : null);

      // STEP 8: RESERVATION THEN DISPATCH. `acquireEffectSlot()` reserves the deterministic
      // `effect_key` durably before every mutating dispatch; a read-only action is dispatched
      // unreserved because it has no external effect to deduplicate.
      const slot = await this.acquireEffectSlot(action, run_id);
      if (slot.kind === 'WAIT') {
        await this.parkTask({
          tenant_id, run_id, reason: slot.reason, plan, current_step: step.step_index,
          pending_action: action, context, previous_evidence_hash: chain.previous, request_id,
        });
        return { lifecycle_state: 'waiting', message: slot.reason };
      }

      // A REPLAY is not a dispatch: the effect already landed under this exact key, so the stored
      // receipt of the durable reservation is reused verbatim and the provider is never called
      // again (BR-006). The engine does not synthesize an adapter response it did not receive;
      // `providerReceipt` is whatever the reservation stored (possibly `null`).
      const replayed = slot.kind === 'REPLAY';
      let providerReceipt: unknown = replayed ? slot.receipt : null;
      let dispatchedReceipt: ExecutionReceipt | null = null;

      if (!replayed) {
        try {
          dispatchedReceipt = await this.dispatchWithDeadline(action, step);
          providerReceipt = dispatchedReceipt;
        } catch (error) {
          const classified = this.classifyFailure(error);
          // `UNKNOWN` is reserved for a step with an external effect (§3.2.4): a read-only step
          // reserved nothing, so an unconfirmed outcome is a transient provider failure that is
          // re-queued under its declared retry policy instead of parking the task for a
          // reconciliation it has no effect to reconcile.
          const failure_class: RetryClass = step.mutating || classified !== 'UNKNOWN' ? classified : 'RETRYABLE';
          const dispatchFailure = step.mutating || classified !== 'UNKNOWN'
            ? error
            : new OrchestratorError(
                'PROVIDER_UNAVAILABLE',
                `Read-only step ${step.step_index} returned no verifiable outcome: ${JSON.stringify(this.serializeError(error))}`
              );
          await this.logRun({
            tenant_id, run_id, correlation_id, trigger, step, context,
            startedAt: stepStartedAt, startTime: stepStartTime,
            execution_status: 'failed',
            authority: action.required_authority,
            approval: approvalRecord,
            action,
            evidence: { recorded: false, reason: 'DISPATCH_FAILED' },
            error: { ...this.serializeError(dispatchFailure), outcome: failure_class === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED' },
            // `UNKNOWN` and `RETRYABLE` leave the step undecided (it is parked or re-queued), so
            // only a terminal classification appends the step's single run-log row.
            disposition: failure_class === 'FATAL' ? 'terminal' : 'attempt',
          });
          if (failure_class === 'UNKNOWN') {
            // The deadline or the transport failed after the request left the process: the
            // provider may already have applied the effect. The reservation is deliberately NOT
            // settled (it stays RESERVED), the task is parked WITH its checkpoint, and §4.4
            // reconciles by `effect_key` — only a provider-confirmed absence may be re-dispatched.
            await this.parkTask({
              tenant_id, run_id,
              reason: 'EFFECT_UNKNOWN: mutating dispatch produced no verifiable outcome; reconciliation scheduled (§4.4)',
              plan, current_step: step.step_index, pending_action: action, context,
              previous_evidence_hash: chain.previous, request_id,
            });
            return { lifecycle_state: 'waiting', message: 'Provider outcome is UNKNOWN; reconciling by effect_key before any retry' };
          }
          throw dispatchFailure;
        }

        if (dispatchedReceipt.adapter_status !== 'SUCCESS') {
          if (step.mutating) {
            // An unparsable/error body from an effect-bearing call is NOT proof of a no-op: the
            // provider may have applied the effect. Keep the reservation open, park the task and
            // reconcile by key; only a confirmed absence may be retried.
            await this.logRun({
              tenant_id, run_id, correlation_id, trigger, step, context,
              startedAt: stepStartedAt, startTime: stepStartTime,
              execution_status: 'failed',
              authority: action.required_authority,
              approval: approvalRecord,
              action,
              evidence: { recorded: false, reason: 'PROVIDER_INDETERMINATE' },
              error: { code: 'PROVIDER_INDETERMINATE', outcome: 'UNKNOWN', adapter_status: dispatchedReceipt.adapter_status },
              disposition: 'attempt',
            });
            await this.parkTask({
              tenant_id, run_id, reason: 'PROVIDER_INDETERMINATE: effect UNKNOWN, reconciliation scheduled (§4.4)',
              plan, current_step: step.step_index, pending_action: action, context,
              previous_evidence_hash: chain.previous, request_id,
            });
            return {
              lifecycle_state: 'waiting',
              message: `Adapter returned ${dispatchedReceipt.adapter_status} for step ${step.step_index}; effect outcome UNKNOWN and will be reconciled`,
            };
          }
          // Read-only step: nothing was reserved, so there is no effect to reconcile and the
          // failure is terminal.
          await this.logRun({
            tenant_id, run_id, correlation_id, trigger, step, context,
            startedAt: stepStartedAt, startTime: stepStartTime,
            execution_status: 'failed',
            authority: action.required_authority,
            approval: approvalRecord,
            action,
            evidence: { recorded: false, reason: 'PROVIDER_ERROR' },
            error: { code: 'PROVIDER_ERROR', adapter_status: dispatchedReceipt.adapter_status },
            disposition: 'terminal',
          });
          throw new OrchestratorError(
            'PROVIDER_ERROR',
            `Adapter returned ${dispatchedReceipt.adapter_status} for read-only step ${step.step_index}: ${JSON.stringify(dispatchedReceipt.response_payload)}`
          );
        }

        if (step.mutating) {
          await this.dependencies.effectGuard.resolve({
            tenant_id: action.tenant_id,
            effect_key: action.effect_key,
            status: 'SUCCEEDED',
            receipt: dispatchedReceipt,
          });
        }
      }

      // STEP 9: CHAINED IMMUTABLE EVIDENCE
      const stepEvidence = await this.dependencies.evidenceLogger.createImmutableRecord({
        run_id,
        tenant_id,
        correlation_id,
        step_index: step.step_index,
        effect_key: action.effect_key,
        previous_evidence_hash: chain.previous,
        payload: { action, receipt: providerReceipt, replayed },
      });
      chain.previous = stepEvidence.chain_hash; // link to the predecessor's chain hash
      latestEvidence = stepEvidence;

      await this.logRun({
        tenant_id, run_id, correlation_id, trigger, step, context,
        startedAt: stepStartedAt, startTime: stepStartTime,
        execution_status: 'success', authority: action.required_authority,
        approval: approvalRecord,
        action, evidence: stepEvidence, error: null,
        cost: dispatchedReceipt?.token_usage,
        disposition: 'terminal',
      });

      if (step.mutating) {
        // Watch for the asynchronous business outcome (step [10. OUTCOME]). The watcher row is
        // unique per (tenant_id, effect_key), so a replay is a no-op rather than a second watcher.
        await this.dependencies.evidenceLogger.initializeOutcomeWatch({
          tenant_id,
          run_id,
          effect_key: action.effect_key,
          skill_id: action.skill_id,
        });
      }
    }

    return { lifecycle_state: 'completed', evidence: latestEvidence };
  }

  /**
   * Resumes a paused task after a human decision (SCR-003) or a schedule/reconciliation event.
   * The approval row is claimed and the task re-activated in ONE transaction, so an approval can
   * never be consumed twice and can never resume a task it was not bound to.
   */
  public async resumeTask(
    run_id: string,
    resumeEvent: {
      tenant_id: string;
      event_type: 'human.approval' | 'human.modify' | 'human.reject' | 'human.pause' | 'human.cancel' | 'human.reconcile' | 'timer.expired' | 'reconcile.completed';
      approval_id?: string;
      expected_payload_sha256?: string; // required for every approval decision; digest of reviewed payload
      operator_id?: string;
      reconciliation_resolution?: 'PROVIDER_CONFIRMED_SUCCEEDED' | 'PROVIDER_CONFIRMED_ABSENT' | 'ESCALATE_MANUALLY';
      reconciliation_receipt?: unknown;
      modifications?: Record<string, unknown>;
      reason?: string;
    }
  ): Promise<OrchestratorRunResult> {
    const task = await this.dependencies.workflowEngine.getTask(resumeEvent.tenant_id, run_id);
    if (!task) {
      throw new OrchestratorError('TASK_NOT_FOUND', `Task ${run_id} does not exist`);
    }
    if (task.state !== 'awaiting_human' && task.state !== 'waiting') {
      throw new OrchestratorError('INVALID_TASK_STATE', `Cannot resume task currently in '${task.state}'`);
    }

    const checkpoint: DurableTaskCheckpoint = task.state_payload;
    if (!checkpoint?.plan || !checkpoint.context || !checkpoint.request_id) {
      // Re-entering a plan requires the checkpoint that carries the immutable `request_id`, the
      // context and the evidence cursor. Re-drafting from scratch would re-decide the plan and
      // re-derive keys from a different identity, so an incomplete checkpoint fails closed and is
      // escalated to SCR-003 instead of guessed at.
      throw new OrchestratorError(
        'CHECKPOINT_INCOMPLETE',
        `Task ${run_id} has no complete resume checkpoint; a human operator must resolve it in SCR-003.`
      );
    }
    const pendingAction: ActionDraft | null = checkpoint.pending_action ?? null;
    const isReconciliationResolution = resumeEvent.event_type === 'human.reconcile';
    const isHumanApprovalDecision = resumeEvent.event_type === 'human.approval'
      || resumeEvent.event_type === 'human.modify'
      || resumeEvent.event_type === 'human.reject'
      || resumeEvent.event_type === 'human.pause'
      || resumeEvent.event_type === 'human.cancel';
    const isAutomaticResume = resumeEvent.event_type === 'timer.expired'
      || resumeEvent.event_type === 'reconcile.completed';
    if ((isHumanApprovalDecision && task.state !== 'awaiting_human')
      || (isReconciliationResolution && task.state !== 'awaiting_human')
      || (isAutomaticResume && task.state !== 'waiting')) {
      throw new OrchestratorError('INVALID_TASK_STATE', 'Resume event does not match the durable waiting state.');
    }

    // The lease is taken BEFORE the approval is claimed: an approval authorizes exactly one
    // execution, so it must never be consumed by a worker that cannot actually run the task.
    const leaseAcquired = await this.dependencies.leaseManager.acquireLease(resumeEvent.tenant_id, run_id, this.workerId);
    if (!leaseAcquired) {
      throw new OrchestratorError('CONCURRENT_TASK_LOCK', `Unable to acquire lease to resume ${run_id}`);
    }

    let executionResumed = false;
    try {
      let releasedAction: ActionDraft | null = null;
      let approvalRef: {
        approval_id: string | null;
        decision: 'APPROVED' | 'MODIFIED' | null;
        operator_id: string | null;
      } | null = null;

      if (isReconciliationResolution) {
        if (!resumeEvent.operator_id || !resumeEvent.reconciliation_resolution || !pendingAction) {
          throw new OrchestratorError('RECONCILIATION_BINDING_REQUIRED', 'Manual reconciliation requires an authenticated operator, resolution and pending action.');
        }
        if (resumeEvent.reconciliation_resolution === 'ESCALATE_MANUALLY') {
          return { run_id, lifecycle_state: 'awaiting_human', message: 'Provider outcome remains unresolved; no dispatch was authorized.' };
        }
        await this.dependencies.effectGuard.resolve({
          tenant_id: resumeEvent.tenant_id,
          effect_key: pendingAction.effect_key,
          status: resumeEvent.reconciliation_resolution === 'PROVIDER_CONFIRMED_SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
          receipt: resumeEvent.reconciliation_receipt,
        });
        await this.dependencies.workflowEngine.transitionTask(resumeEvent.tenant_id, run_id, 'running', 'Manual provider reconciliation resolved');
        executionResumed = true;
      }

      if (isHumanApprovalDecision) {
        if (!resumeEvent.approval_id || !pendingAction || !resumeEvent.operator_id || !resumeEvent.expected_payload_sha256) {
          throw new OrchestratorError('APPROVAL_BINDING_REQUIRED', 'Decision requires authenticated operator, approval and reviewed digest.');
        }
        const decision: 'APPROVED' | 'MODIFIED' | 'REJECTED' | 'PAUSE' | 'CANCELLED' =
          resumeEvent.event_type === 'human.approval' ? 'APPROVED'
          : resumeEvent.event_type === 'human.modify' ? 'MODIFIED'
          : resumeEvent.event_type === 'human.reject' ? 'REJECTED'
          : resumeEvent.event_type === 'human.pause' ? 'PAUSE'
          : 'CANCELLED';
        if (decision === 'MODIFIED' && !resumeEvent.modifications) {
          throw new OrchestratorError('MODIFICATION_REQUIRED', 'MODIFY requires a proposed payload delta.');
        }
        const candidate = decision === 'MODIFIED'
          ? await this.applyModification(pendingAction, resumeEvent.modifications!, checkpoint.context)
          : pendingAction;
        if (decision === 'APPROVED' || decision === 'MODIFIED') {
          this.verifyFloorPrice(candidate);
          const eligibility = await this.dependencies.policyEngine.evaluateAuthority(candidate, checkpoint.context);
          if (eligibility.verdict === 'DENIED') {
            throw new OrchestratorError('AUTHORITY_DENIED', eligibility.reason);
          }
        }
        // Lock current task/action/approval; check the reviewed digest and operator; atomically
        // save the authorized revision. The store's full transaction contract is §4.2(4).
        const claimed = await this.dependencies.workflowEngine.claimApprovalAndResume({
          tenant_id: resumeEvent.tenant_id,
          run_id,
          approval_id: resumeEvent.approval_id,
          effect_key: pendingAction.effect_key,
          expected_payload_sha256: resumeEvent.expected_payload_sha256,
          authorized_action: decision === 'APPROVED' || decision === 'MODIFIED' ? candidate : null,
          decision,
          operator_id: resumeEvent.operator_id,
          review_comment: resumeEvent.reason ?? null,
        });
        if (!claimed.claimed) {
          throw new OrchestratorError('APPROVAL_NOT_CLAIMABLE', 'Approval is stale, decided, or bound to a different action.');
        }
        if (decision === 'PAUSE') {
          return { run_id, lifecycle_state: 'awaiting_human', message: 'Approval remains pending under an explicit human pause' };
        }
        if (decision === 'REJECTED' || decision === 'CANCELLED') {
          return { run_id, lifecycle_state: 'stopped', message: `Task ${decision.toLowerCase()} by human operator` };
        }
        executionResumed = true;
        releasedAction = { ...candidate, approval_id: resumeEvent.approval_id };
        approvalRef = { approval_id: resumeEvent.approval_id, decision, operator_id: resumeEvent.operator_id };
      }

      if (isAutomaticResume && !executionResumed) {
        await this.dependencies.workflowEngine.transitionTask(resumeEvent.tenant_id, run_id, 'running', `Resumed by ${resumeEvent.event_type}`);
        executionResumed = true;
      }

      // The human path already committed its transition. All resumed steps recheck safety;
      // the claimed decision satisfies only AUTH-4 and cannot outlive a policy revocation.
      const outcome = await this.executeSteps({
        signal: null,
        tenant_id: resumeEvent.tenant_id,
        run_id,
        correlation_id: task.correlation_id,
        request_id: checkpoint.request_id,
        plan: checkpoint.plan,
        context: checkpoint.context,
        chain: { previous: checkpoint.previous_evidence_hash ?? GENESIS_HASH },
        from_step: checkpoint.current_step,
        approved_action: releasedAction,
        approval_ref: approvalRef,
      });
      if (outcome.lifecycle_state !== 'completed') {
        return { run_id, lifecycle_state: outcome.lifecycle_state, evidence: outcome.evidence, message: outcome.message };
      }

      await this.dependencies.workflowEngine.transitionTask(resumeEvent.tenant_id, run_id, 'completed', 'All resumed steps verified');
      return { run_id, lifecycle_state: 'completed', evidence: outcome.evidence };
    } catch (error) {
      // A refused human decision must not fail or re-queue the still-pending task.
      if (!executionResumed) throw error;
      // Identical durable-recovery contract to the first pass (§4.4). An indeterminate external
      // outcome never reaches this block: the guarded step engine parks it as `waiting` with its
      // checkpoint and with the reservation still RESERVED, so only RETRYABLE and FATAL failures
      // are classified and handed to the durable scheduler here.
      const failure_class = this.classifyFailure(error);
      if (failure_class === 'UNKNOWN') {
        await this.parkTask({
          tenant_id: resumeEvent.tenant_id,
          run_id,
          reason: 'EFFECT_UNKNOWN: provider outcome indeterminate; reconciliation scheduled (§4.4)',
          plan: checkpoint.plan,
          current_step: checkpoint.current_step,
          pending_action: checkpoint.pending_action ?? null,
          context: checkpoint.context,
          previous_evidence_hash: checkpoint.previous_evidence_hash ?? GENESIS_HASH,
          request_id: checkpoint.request_id,
        });
        return {
          run_id,
          lifecycle_state: 'waiting',
          message: 'Provider outcome is UNKNOWN; reconciling by effect_key before any retry',
        };
      }
      await this.dependencies.workflowEngine.recordFailure({
        tenant_id: resumeEvent.tenant_id,
        run_id,
        error_class: failure_class,
        error_details: this.serializeError(error),
      });
      throw error;
    } finally {
      await this.dependencies.leaseManager.releaseLease(resumeEvent.tenant_id, run_id, this.workerId);
    }
  }

  /**
   * Operator hands the conversation back to the agent (SCR-005). Releases the takeover lock and
   * restores normal routing; the stopped task stays terminal and the next inbound signal starts a
   * fresh run that re-hydrates context.
   */
  public async returnToAgent(tenant_id: string, session_id: string, operator_id: string): Promise<void> {
    await this.dependencies.sessionControl.returnToAgent(tenant_id, session_id, operator_id);
  }

  // ==========================================================================
  // INVARIANT GUARDS & SHARED SUBROUTINES
  // ==========================================================================

  /**
   * Reserves the effect slot for one action and reports what the reservation permits. Called
   * before EVERY mutating dispatch (BR-005) and never for a read-only action: a read-only action
   * has no external effect to deduplicate, so it is dispatched unreserved and stays freely
   * retryable under its declared policy (§4.4).
   *
   * Returns WAIT when the outcome cannot be proven yet — the caller parks the durable task instead
   * of guessing, and never re-dispatches on an unproven effect.
   */
  private async acquireEffectSlot(
    action: ActionDraft,
    run_id: string
  ): Promise<{ kind: 'DISPATCH' } | { kind: 'REPLAY'; receipt: unknown | null } | { kind: 'WAIT'; reason: string }> {
    if (!action.mutating) {
      return { kind: 'DISPATCH' };
    }

    const outcome = await this.dependencies.effectGuard.reserve({
      tenant_id: action.tenant_id,
      run_id,
      request_id: action.request_id,
      effect_key: action.effect_key,
      request_fingerprint: this.dependencies.effectGuard.computeRequestFingerprint(action.payload),
      skill_id: action.skill_id,
      step_index: action.step_index,
      action_revision: action.action_revision,
    });

    switch (outcome.kind) {
      case 'RESERVED':
        return { kind: 'DISPATCH' };
      case 'REPLAY':
        // Same key, same fingerprint, already SUCCEEDED: the reservation's stored receipt is
        // returned verbatim so the caller re-emits the evidence link without calling the provider.
        return { kind: 'REPLAY', receipt: outcome.receipt ?? null };
      case 'IN_FLIGHT':
        return { kind: 'WAIT', reason: 'EFFECT_IN_FLIGHT: an identical effect is still in flight' };
      case 'CONFLICT':
        throw new OrchestratorError(
          'IDEMPOTENCY_CONFLICT',
          `effect_key ${action.effect_key} was already used with a different payload (BR-005).`
        );
      case 'RECONCILE_REQUIRED': {
        // Expired RESERVED row or a prior FAILED attempt: ask the provider what actually happened,
        // by key, before anything is re-dispatched (BR-006).
        const reconciled = await this.dependencies.effectGuard.reconcile({
          tenant_id: action.tenant_id,
          effect_key: action.effect_key,
          skill_id: action.skill_id,
        });
        if (reconciled.outcome === 'SUCCEEDED') {
          // The effect is confirmed applied: replay the stored receipt, never re-dispatch.
          return { kind: 'REPLAY', receipt: reconciled.receipt ?? null };
        }
        if (reconciled.outcome === 'FAILED') {
          // Provider-confirmed absence is the only condition that clears the way for a re-dispatch
          // under the same key (BR-006).
          return { kind: 'DISPATCH' };
        }
        return { kind: 'WAIT', reason: 'EFFECT_UNKNOWN: reconciliation pending (§4.4)' };
      }
    }
  }

  /**
   * The dispatch guard (§3.1 `PlannedStep.timeout_ms`, §4.4): it enforces the registry-declared hard
   * deadline around the adapter call and reports the outcome in the one vocabulary the engine
   * classifies (§3.2.4).
   *
   *   * The deadline fires, or the request dies on the wire after it left the process → the effect
   *     is UNPROVEN, so the attempt is raised as `DISPATCH_TIMEOUT` / `PROVIDER_INDETERMINATE`
   *     (both `UNKNOWN`). The caller parks the durable task with its checkpoint and reconciles by
   *     `effect_key`; nothing is retried on transport grounds.
   *   * A bare, non-canonical adapter error is treated the same way, never as a terminal failure:
   *     a call that returned no verifiable receipt cannot be shown to be a no-op, and fail-closed
   *     beats guessing that a possibly-applied effect never landed.
   *   * A canonical `OrchestratorError` raised by the adapter (the platform's connector error
   *     vocabulary) passes through unchanged and keeps its own classification, so this guard never
   *     widens what may be retried.
   */
  private async dispatchWithDeadline(action: ActionDraft, step: PlannedStep): Promise<ExecutionReceipt> {
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const inFlight = this.dependencies.adapterDispatcher.dispatch(action, { timeout_ms: step.timeout_ms });
      // A settlement that arrives after the deadline is late, not unhandled.
      inFlight.catch(() => undefined);
      return await Promise.race([
        inFlight,
        new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(
            () => reject(new OrchestratorError(
              'DISPATCH_TIMEOUT',
              `Adapter call for step ${step.step_index} exceeded its ${step.timeout_ms}ms deadline`
            )),
            step.timeout_ms
          );
        }),
      ]);
    } catch (error) {
      if (error instanceof OrchestratorError) {
        throw error;
      }
      throw new OrchestratorError(
        'PROVIDER_INDETERMINATE',
        `Adapter call for step ${step.step_index} returned no verifiable outcome (${JSON.stringify(this.serializeError(error))}).`
      );
    } finally {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
      }
    }
  }

  /**
   * Parks the task in `waiting` with the checkpoint the resume path needs (§4.4): a task that is
   * parked without one could only be resumed by re-deciding its plan, which is exactly what the
   * durable checkpoint exists to prevent.
   */
  private async parkTask(params: {
    tenant_id: string;
    run_id: string;
    reason: string;
    plan: ExecutionPlan;
    current_step: number;
    pending_action: ActionDraft | null;
    context: HydratedContext;
    previous_evidence_hash: string;
    request_id: string;
  }): Promise<void> {
    await this.dependencies.workflowEngine.transitionTask(params.tenant_id, params.run_id, 'waiting', params.reason, {
      plan: params.plan,
      current_step: params.current_step,
      pending_action: params.pending_action,
      context: params.context,
      previous_evidence_hash: params.previous_evidence_hash,
      request_id: params.request_id,
    });
  }

  /**
   * The audit record's `approval` field (§08 4.1 field 11): the human decision that released the
   * action, or the verdict under which it ran autonomously. It records what authorized the step —
   * it is never a clearance, and it never authorizes any other step.
   */
  private approvalField(ref: {
    approval_id: string | null;
    decision: 'APPROVED' | 'MODIFIED' | null;
    operator_id: string | null;
  } | null): Record<string, unknown> {
    return ref === null
      ? { verdict: 'AUTO_APPROVED' }
      : { approval_id: ref.approval_id, decision: ref.decision ?? 'APPROVED', operator_id: ref.operator_id };
  }

  private validateSignalEnvelope(signal: SignalEnvelope): void {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(signal.tenant_id)) {
      throw new OrchestratorError('INVALID_TENANT_ID', 'tenant_id must be a UUID (NFR-006).');
    }
    if (!signal.signal_id || !signal.correlation_id || !signal.source_channel) {
      throw new OrchestratorError('INVALID_SIGNAL', 'Missing mandatory envelope routing metadata (SRS §17).');
    }
    if (!signal.subject?.session_id) {
      throw new OrchestratorError(
        'INVALID_SESSION',
        'A unique server-issued session_id is mandatory for every signal, including anonymous traffic (NFR-006).'
      );
    }
  }

  /** Hard Invariant FR-C360-003: HYPOTHESIS records can never be promoted to FACT. */
  private enforceEpistemicSeparation(hypothesis: HypothesisRecord): void {
    if (hypothesis.classification !== 'HYPOTHESIS') {
      throw new OrchestratorError('SECURITY_VIOLATION', 'Inferred data must be stamped classification: HYPOTHESIS');
    }
  }

  /** Hard Invariant BR-001 / BR-002 / BR-003: a price-bearing action needs an authoritative floor. */
  private verifyFloorPrice(action: ActionDraft): void {
    const payloadPriceBearing = action.payload['price_bearing'] === true
      || action.payload['offer_id'] !== undefined
      || action.payload['discount_amount'] !== undefined
      || action.payload['discount_percent'] !== undefined
      || action.proposed_price !== undefined;
    if (!action.price_bearing && !payloadPriceBearing) return;
    if (!Number.isFinite(action.proposed_price)
      || !Number.isFinite(action.computed_price_floor)
      || !action.floor_source?.trim()) {
      throw new OrchestratorError(
        'P_FLOOR_UNAVAILABLE',
        `No owner-approved P_floor with provenance for ${action.skill_id}; refusing to price (BR-001, BR-003, NFR-008).`
      );
    }
    if (action.proposed_price < action.computed_price_floor) {
      throw new OrchestratorError(
        'ERR_FLOOR_PRICE_VIOLATION',
        `Proposed price ${action.proposed_price} < P_floor ${action.computed_price_floor} (${action.floor_source}).`
      );
    }
  }

  private classifyFailure(error: unknown): RetryClass {
    if (error instanceof OrchestratorError) {
      switch (error.code) {
        case 'DISPATCH_TIMEOUT':
        case 'PROVIDER_INDETERMINATE':
        case 'EFFECT_UNKNOWN':
          return 'UNKNOWN';
        case 'PROVIDER_RATE_LIMITED':
        case 'PROVIDER_UNAVAILABLE':
        case 'CONCURRENT_TASK_LOCK':
          return 'RETRYABLE';
        default:
          return 'FATAL';
      }
    }
    return 'FATAL';
  }

  private serializeError(error: unknown): Record<string, unknown> {
    if (error instanceof OrchestratorError) {
      return { code: error.code, message: error.message };
    }
    return { code: 'UNCLASSIFIED', message: error instanceof Error ? error.message : String(error) };
  }

  private async applyModification(base: ActionDraft, delta: Record<string, unknown>, context: HydratedContext): Promise<ActionDraft> {
    const action_revision = base.action_revision + 1;
    return this.dependencies.policyEngine.validateAction({
      ...base,
      payload: { ...base.payload, ...delta },
      action_revision,
      effect_key: this.dependencies.effectGuard.computeEffectKey({
        tenant_id: base.tenant_id,
        skill_id: base.skill_id,
        step_index: base.step_index,
        action_revision,
        request_id: base.request_id,
      }),
    }, context);
  }

  /**
   * Drafts the action for one step. `action_id` is a real UUID because `agentos.actions.id` is
   * `UUID`, and `effect_key` comes from `IEffectGuard` — never from `run_id`, a timestamp or a
   * random UUID (§3.2.3).
   */
  private async draftAction(
    step: PlannedStep,
    context: HydratedContext,
    run_id: string,
    tenant_id: string,
    request_id: string,
    action_revision: number
  ): Promise<ActionDraft> {
    return this.dependencies.policyEngine.validateAction({
      action_id: randomUUID(), run_id, tenant_id, request_id, action_revision,
      agent_id: step.agent_id, skill_id: step.skill_id, adapter_target: step.adapter_target,
      step_index: step.step_index, mutating: step.mutating, price_bearing: step.price_bearing,
      effect_key: this.dependencies.effectGuard.computeEffectKey({
        tenant_id, skill_id: step.skill_id, step_index: step.step_index, action_revision, request_id,
      }),
      required_authority: step.required_authority,
      payload: { ...step.input_parameters, tenant_id },
      computed_price_floor: step.computed_price_floor,
      floor_source: step.floor_source,
      proposed_price: step.proposed_price,
    }, context);
  }

  private buildClarificationPlan(
    routing: RoutingDecision,
    signal: SignalEnvelope,
    context: HydratedContext
  ): ExecutionPlan {
    return {
      plan_id: `plan_${randomUUID()}`,
      steps: [
        {
          step_index: 1,
          agent_id: routing.target_agent,
          skill_id: 'skill.sales.send_message',
          adapter_target: signal.source_channel,
          input_parameters: {
            tenant_id: signal.tenant_id,
            recipient_id: signal.subject.channel_identifier ?? context.working_memory.session_id,
            channel: signal.source_channel,
            message_content: { text: routing.clarification_prompt ?? '' },
          },
          required_authority: 'AUTH-3',
          mutating: true,
          price_bearing: false,
          idempotent: false,
          timeout_ms: 3000,
          depends_on_steps: [],
        },
      ],
      fallback_strategy: 'FAIL_CLOSED',
    };
  }

  /**
   * Writes the canonical SRS §17 / §08 4.1 Agent Run record for one step attempt.
   *
   * Two destinations, two key contracts:
   *   * `agentos.audit_records` — the chained compliance trail (NFR-002). It accepts EVERY event of
   *     a step: the AUTH-4 pause, each failing attempt, each retry, each reconciliation attempt and
   *     the final outcome. Appended through the canonical §08 §4.1 writer so one writer owns the
   *     tenant chain.
   *   * `agentos.agent_run_logs` — the operational per-step log, keyed by
   *     `(tenant_id, run_id, skill, step_index)` and append-only. A step therefore gets exactly ONE
   *     row, written only at its terminal disposition (`disposition: 'terminal'`); an attempt or a
   *     pause writes `attempt` and stays in the audit trail. That is what keeps a retried, a
   *     paused-then-resumed, or a reconciled step from colliding on the primary key while still
   *     recording every attempt.
   *
   * `action` and `evidence` are `NOT NULL` in both tables, so a step that legitimately has no
   * drafted action or no evidence yet stores an explicit marker object
   * (`{ drafted: false, reason }` / `{ recorded: false, reason }`) rather than SQL NULL. The
   * genuinely nullable columns (`approval`, `outcome`, `error`) stay NULL when absent.
   */
  private async logRun(input: {
    tenant_id: string;
    run_id: string;
    correlation_id: string;
    trigger: string;
    step: PlannedStep;
    context: HydratedContext;
    startedAt: string;
    startTime: number;
    execution_status: ExecutionStatus;
    authority: AuthorityLevel;
    approval: unknown | null;
    action: unknown;
    evidence: unknown;
    error: unknown | null;
    cost?: unknown;
    disposition: 'terminal' | 'attempt';
  }): Promise<void> {
    const record: AgentRunLogRecord = {
      run_id: input.run_id,
      tenant_id: input.tenant_id,
      agent_id: input.step.agent_id,
      customer_or_entity_id: input.context.customer?.customer_id ?? input.context.working_memory.session_id,
      trigger: input.trigger,
      context: input.context,
      skill: input.step.skill_id,
      step_index: input.step.step_index,
      tool: input.step.adapter_target,
      decision: { planned_authority: input.step.required_authority },
      authority: input.authority,
      approval: input.approval,
      action: input.action,
      execution_status: input.execution_status,
      evidence: input.evidence,
      outcome: null,
      latency_ms: Date.now() - input.startTime,
      cost: input.cost ?? { prompt: 0, completion: 0, total_cost_usd: 0 },
      error: input.error,
      started_at: input.startedAt,
      completed_at: new Date().toISOString(),
    };
    await this.dependencies.auditTrail.append(record);
    if (input.disposition === 'terminal') {
      await this.dependencies.evidenceLogger.logAgentRun(record);
    }
  }

  private async updateLearningMemory(
    tenant_id: string,
    run_id: string,
    hypothesis: HypothesisRecord,
    receipt?: ImmutableEvidenceRecord
  ): Promise<void> {
    // Learning Memory writer contract (§07 /learning/): persists prediction alignment, latency and
    // cost for the completed run, always tenant-scoped (NFR-006). Implemented by the Learning
    // pipeline; the orchestrator schedules it and never fabricates a learning record inline.
  }
}

// ============================================================================
// DEPENDENCY INTERFACES (runtime bindings; not implemented in this blueprint)
// ============================================================================

export interface IContextAggregator {
  hydrateContext(tenant_id: string, subject: SignalSubject, correlation_id: string): Promise<HydratedContext>;
}

/**
 * Cognitive layer binding (MKT/SAL/CS agents + LLM). The orchestrator depends on the contract and
 * fails closed when the binding is absent; it never substitutes hard-coded scores or routings.
 */
export interface IAgentRuntime {
  deriveHypothesis(signal: SignalEnvelope, context: HydratedContext): Promise<HypothesisRecord>;
  resolveRouting(signal: SignalEnvelope, context: HydratedContext, hypothesis: HypothesisRecord): Promise<RoutingDecision>;
  formulatePlan(routing: RoutingDecision, context: HydratedContext, hypothesis: HypothesisRecord): Promise<ExecutionPlan>;
}

export interface IPolicyEngine {
  /** Normalize with the registered skill schema; reject unknown fields, bind tenant/subject,
   * and resolve price/floor metadata from trusted sources. Plan/delta policy fields are not proof. */
  validateAction(action: ActionDraft, context: HydratedContext): Promise<ActionDraft>;
  /** Re-read registry/grant, identity, consent, policy, source/floor and takeover state.
   * Create no queue here. A claimed approval covering this exact action satisfies AUTH-4 only;
   * invalid/revoked bindings are DENIED. Checkpoint context is not a freshness proof. */
  evaluateAuthority(action: ActionDraft, context: HydratedContext): Promise<ApprovalGateResult>;
}

export interface IStatefulWorkflowEngine {
  /** Every durable-task method is tenant-scoped: the primary key and the RLS predicate both lead with `tenant_id` (NFR-006). */
  createTask(task: {
    run_id: string;
    tenant_id: string;
    correlation_id: string;
    current_step: number;
    state: TaskLifecycleState;
  }): Promise<void>;
  updateTaskProgress(tenant_id: string, run_id: string, stepIndex: number, checkpointPayload: unknown): Promise<void>;
  transitionTask(tenant_id: string, run_id: string, state: TaskLifecycleState, reason: string, checkpointPayload?: unknown): Promise<void>;
  getTask(tenant_id: string, run_id: string): Promise<{ task_version: number; state: TaskLifecycleState; correlation_id: string; state_payload: any } | null>;
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
    operator_id: string; // must match the authenticated decision principal, never payload-only authority
    review_comment: string | null;
  }): Promise<{ claimed: boolean }>;
  /** §4.4 durable recovery: classify, count, re-queue or fail terminally. */
  recordFailure(params: {
    tenant_id: string;
    run_id: string;
    /** `platform_durable_tasks.last_error_class` accepts only RETRYABLE | FATAL; UNKNOWN is a reconciliation state, not a stored class (§4.4). */
    error_class: PersistedErrorClass;
    error_details: Record<string, unknown>;
  }): Promise<{ requeued: boolean }>;
}

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

export interface IAdapterDispatcher {
  /**
   * Dispatches one action under the step deadline. The adapter owns the provider-specific error
   * vocabulary and either returns a receipt (including `adapter_status = 'TIMEOUT'` when the
   * provider reported a deadline breach) or raises a canonical `OrchestratorError`; `UNKNOWN` is
   * never the adapter's call to make (§3.2.4). The engine's dispatch guard wraps this call, so a
   * thrown non-canonical error is normalized to an unproven effect instead of a terminal failure.
   */
  dispatch(action: ActionDraft, options?: { timeout_ms?: number }): Promise<ExecutionReceipt>;
}

/**
 * Canonical chained compliance writer (`audit_records`, §08 §4.1). The engine appends EVERY event
 * of a step here — the AUTH-4 pause, each failing attempt, each retry, each reconciliation attempt
 * and the terminal outcome — so exactly one writer owns the tenant's hash chain (NFR-002).
 */
export interface IAuditTrail {
  append(record: AgentRunLogRecord): Promise<void>;
}

export interface IIdentityResolver {
  /** Server-side identity resolution; never matches raw contact handles (§5.1). */
  resolveSubject(tenant_id: string, subject: SignalSubject): Promise<ResolvedSubject>;
}

export interface ISessionControl {
  /** Live check of `tenant:{tid}:session:{sid}:takeover_lock` (SCR-005). */
  isTakenOver(tenant_id: string, session_id: string): Promise<boolean>;
  /** Operator returns the conversation to the agent; releases the lock and restores routing. */
  returnToAgent(tenant_id: string, session_id: string, operator_id: string): Promise<void>;
}
```

---

## 4. Stateful Workflow Engine (FSM & Durable Lifecycle)

The Task Engine manages durable tasks that survive process restarts, power loss, and network partitions.

### 4.1. Task Lifecycle State Transition Matrix

```
                      [SIGNAL RECEIVED]
                              │
                              ▼
                         ┌─────────┐
                         │ queued  │
                         └────┬────┘
                              │ lease acquired
                              ▼
                         ┌─────────┐
            ┌───────────►│ running ├────────────┐
            │            └────┬────┘            │
            │                 │                 │
     event  │                 │ await external  │ requires human
     resume │                 ▼ event / timer   ▼ approval (AUTH-4)
            │           ┌─────────┐       ┌────────────────┐
            └───────────┤ waiting │       │ awaiting_human │
                        └────┬────┘       └───────┬────────┘
                             │                    │
              timeout / term │                    │ human decision:
                             │                    │ approve / reject / cancel
                             ▼                    ▼
                        ┌─────────┐          ┌─────────┐
                        │ stopped │          │ running │ (or stopped)
                        └─────────┘          └─────────┘
                             ▲                    ▲
                             │ terminal           │
                        ┌────┴────┐          ┌────┴──────┐
                        │ failed  │          │ completed │
                        └─────────┘          └───────────┘
```

| Current State | Transition Event | Target State | Guard Conditions & Actions |
|---|---|---|---|
| `queued` | `task.claim` | `running` | Worker claims the task with the optimistic guard of §4.2 (`task_version` checked, lease stamped in `platform_durable_tasks`, Redis lease acquired). `task_version += 1`. |
| `running` | `task.await_event` | `waiting` | Task registers a timer, webhook listener, or effect reconciliation; the execution lease is released. |
| `running` | `task.effect_in_flight` | `waiting` | A concurrent attempt holds the same `effect_key` reservation. The step is parked, never re-dispatched. |
| `running` | `task.dispatch_timeout` | `waiting` | Mutating dispatch returned no verifiable outcome. Reservation stays open; provider reconciliation is scheduled (§4.4). Never a blind retry. |
| `running` | `task.require_auth4` | `awaiting_human`| `AUTH-4` verdict. One PENDING `approvals` row is inserted and the task paused **in the same transaction** (§4.2); notification goes to SCR-003. |
| `running` | `task.success` | `completed` | All plan steps verified. Immutable evidence hashed and chained. |
| `running` | `task.retryable_error` | `queued` | `retry_count < max_retries`; `last_error_class = 'RETRYABLE'`; backoff timer set. No evidence or state is rolled back. |
| `running` | `task.fatal_error` | `failed` | Non-retryable error, or `retry_count >= max_retries`. Fail-closed; `error_details` and an audit record are written. |
| `waiting` | `event.received` | `running` | Correlation ID verified; state re-hydrated; worker lease re-acquired. |
| `waiting` | `timer.expired` | `running` | Scheduled delay reached (e.g., 24-hr abandoned cart sequence). |
| `waiting` | `reconcile.completed` | `running` | The outstanding effect was confirmed applied or confirmed absent; execution resumes from `current_step`. |
| `awaiting_human`| `human.approval` | `running` | Reviewed digest and operator checked; approval and task claimed transactionally; current policy rechecked before the same effect key dispatches. |
| `awaiting_human`| `human.modify` | `running` | Normalized new payload/revision is explicitly authorized after all guards; action, approval and checkpoint change atomically; the old digest authorizes nothing further. |
| `awaiting_human` | `human.pause` | `awaiting_human` | Reviewed digest and operator checked; set `is_paused=TRUE`, retain PENDING and its action binding; audit without dispatch. Repeated PAUSE conflicts; a later explicit terminal decision may resolve it. |
| `awaiting_human`| `human.reject` / `human.cancel` | `stopped` | Terminal. The approval row is decided in the same transaction; the reason is written to the audit trail. |
| `*` | `human.takeover` | `stopped` | Immediate hard kill of bot execution on the session (`SCR-005`). Re-checked before every step, retry and resume; a late takeover never leaves a queued dispatch behind. |
| `stopped` | `human.resume` | `stopped` | Operator returns the conversation to the agent: the takeover lock is released, `conversations.state` returns to `open`, `active_agent` to `auto`. The stopped task stays terminal — the next inbound signal starts a fresh run. |

### 4.2. Durable Task State, Transition Guards and Approval Binding

The canonical DDL for `platform_durable_tasks`, `approvals` and `effect_reservations` lives in **§03 §1 DOMAIN 5** and is not re-declared here: a single definition prevents the engine's schema and the database contract from drifting apart. This section specifies the guards that must wrap every write to it. All statements are tenant-scoped (`tenant_id UUID`), run inside `withTenantContext()` (§03 §2) so RLS applies, and every task write is either an optimistic-version update or a no-op.

```sql
-- (1) task.claim — lease without a read-modify-write race.
--     A stale lease (owner dead past expiry) is reclaimable; a live one is not.
UPDATE agentos.platform_durable_tasks
   SET state = CASE WHEN state = 'queued' THEN 'running'::agentos.task_lifecycle_state ELSE state END,
       lease_owner = $3,
       lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '30 seconds',
       task_version = task_version + 1,
       updated_at = CURRENT_TIMESTAMP
 WHERE tenant_id = $1
   AND run_id = $2
   AND state IN ('queued', 'running', 'waiting', 'awaiting_human')
   AND task_version = $expected_task_version
   AND (lease_owner IS NULL OR lease_owner = $3 OR lease_expires_at < CURRENT_TIMESTAMP)
RETURNING task_version;           -- 0 rows ⇒ another worker owns a live lease ⇒ CONCURRENT_TASK_LOCK

-- (2) progress checkpoint — only the lease owner may advance the cursor.
UPDATE agentos.platform_durable_tasks
   SET current_step = $4, state_payload = state_payload || $5::jsonb,
       task_version = task_version + 1, updated_at = CURRENT_TIMESTAMP
 WHERE tenant_id = $1 AND run_id = $2 AND lease_owner = $3 AND state = 'running'
   AND task_version = $expected_task_version AND lease_expires_at > CURRENT_TIMESTAMP
RETURNING task_version;

-- (3) task.require_auth4 — pause and record the approval atomically (SCR-003, §03 Entity 24).
--     `approvals.action_id` references `actions(id)`, so the action row must be inserted first
--     in the same transaction; the approval row is the ONLY resume authority.
BEGIN;
  INSERT INTO agentos.actions (id, tenant_id, decision_id, skill_name, effect_key, target_channel, action_payload, status)
  VALUES ($action_id, $1, $decision_id, $skill_id, $effect_key, $channel, $payload, 'pending');

  INSERT INTO agentos.approvals (tenant_id, run_id, action_id, campaign_id, effect_key, payload, reason, decision, is_paused)
  VALUES ($1, $2, $action_id, $campaign_id, $effect_key, $payload, $reason, 'PENDING', FALSE)
  RETURNING id;                   -- → approval_id shown in SCR-003

  UPDATE agentos.platform_durable_tasks
     SET state = 'awaiting_human',
         paused_for_approval_id = $approval_id,
         state_payload = $checkpoint::jsonb,
         task_version = task_version + 1,
         updated_at = CURRENT_TIMESTAMP
   WHERE tenant_id = $1 AND run_id = $2 AND task_version = $expected_task_version
     AND state = 'running' AND lease_owner = $worker_id AND lease_expires_at > CURRENT_TIMESTAMP;
   -- 0 rows ⇒ another worker already advanced this task ⇒ abort and retry the read.
COMMIT;

-- (4) Human decision uses the transactional procedure specified immediately below this block.
-- Digest normalization is RFC 8785 in the application, never PostgreSQL JSON text formatting.

-- (5) Stale-lease requeue (crash recovery). Only tasks whose owner stopped heart-beating are
--     re-queued; a task parked in `waiting` / `awaiting_human` is never touched.
UPDATE agentos.platform_durable_tasks
   SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL,
       task_version = task_version + 1, updated_at = CURRENT_TIMESTAMP
 WHERE tenant_id = $1 AND state = 'running' AND lease_expires_at < CURRENT_TIMESTAMP;

-- No approval-expiry sweep is defined: there is no approved TTL source/column in §03.
-- The provisional 72h effect-cache/reconciliation window is NOT an approval lifetime.
```

**(4) Human-decision transaction — target procedure, not optional checks.** `claimApprovalAndResume` runs under tenant RLS and the authenticated operator identity. Lock the task, action and approval in that order with `SELECT ... FOR UPDATE`; require `awaiting_human`, matching `paused_for_approval_id`, unexpired owned worker lease, and the pending `(tenant_id, run_id, effect_key)` binding. Recompute SHA-256 over RFC 8785 canonical `approvals.payload` while locked and compare it with `expected_payload_sha256`; mismatch returns `409 APPROVAL_STALE_PAYLOAD` without writes. A decided claim or repeated PAUSE returns `APPROVAL_NOT_CLAIMABLE`; a paused PENDING item may still receive an explicit terminal decision. The skill dispatch digest check separately uses `APPROVAL_PAYLOAD_MISMATCH` for an action not covered by its authorization (`05`).

For APPROVE, persist the unchanged authorized action. For MODIFY, allow only the registered schema's editable payload fields; preserve tenant, subject, skill and inbound identity, increment `action_revision`, and derive its new deterministic key. Revalidate all policy/source/consent/identity/floor checks, compare the normalized authorized payload, and refuse if the old effect was ever dispatched or is indeterminate. Atomically update `actions.action_payload`/`effect_key`, `approvals.payload`/`effect_key`, and the checkpoint's pending action; append audit containing old/new digests, keys, revision, policy versions and operator. The explicit MODIFY decision is authorization for this new revision, not reuse of the previous digest.

For any terminal decision, write the approval decision/operator/reason/time, clear `is_paused`, increment the locked task version, and clear `paused_for_approval_id`. APPROVED/MODIFIED transitions to `running`; REJECTED/CANCELLED to `stopped`. Every expected update must affect exactly one row and audit must append, or the entire transaction rolls back. `PAUSE` uses the same reviewed-digest/operator checks, sets only `is_paused=TRUE`, keeps PENDING/`awaiting_human`, increments task version and audits; a subsequent explicit human decision can decide that paused item through the same five-decision route. No timer or automatic worker may clear a pause.

After commit, dispatch rechecks current policy and the stored binding; the one-time decision does not authorize future steps. Approval expiry is `[OWNER-DECISION-REQUIRED]` for Business/Operations with `03`/`04`: until a policy/version and server-observable deadline are specified, no automated expiry or UI countdown is enabled. Stale policy, revoked permission, changed digest and decided rows are refused independently of TTL.

**Binding rules.**

3. The approval authorizes exactly one execution. It does not change the agent's clearance: a valid claim short-circuits only the released action's `AUTH-4` routing verdict after the transaction checks the exact binding and digest. The resume path then re-enters `executeSteps`; every later step evaluates the ordinary PEP path and any later `AUTH-4` step pauses again.
4. A paused task, its approval row and the pending action are all visible in SCR-003 through the single `approval_queue` view over `approvals` (§03 DOMAIN 5) — there is no second queue table to diverge from.

### 4.3. Distributed Worker Lease Management (Redis Mutex)

Leases use the platform-wide key namespace of §03 §3 (`tenant:{tid}:…`) so that every per-tenant key is greppable, TTL-bound, and impossible to collide across tenants. Redis is the *fast* coordinator for leases only; the durable schedule of record stays in `platform_durable_tasks` (§4.2), so a Redis flush never loses a task.

```typescript
/**
 * @file durable-lease-manager.ts
 * @description Distributed lease management preventing double-execution of steps.
 */
import Redis from 'ioredis';

export class DurableLeaseManager {
  private readonly redis: Redis;
  private readonly leaseTtlMs: number = 30000; // 30 seconds

  constructor(redisClient: Redis) {
    this.redis = redisClient;
  }

  /**
   * Attempts to acquire the exclusive task lease. The durable `task.claim` guard (§4.2) is the
   * authority; this lock short-circuits the hot path and must always be followed by it.
   */
  public async acquireLease(tenantId: string, runId: string, workerId: string): Promise<boolean> {
    const lockKey = `tenant:${tenantId}:task:${runId}:lease`;
    const result = await this.redis.set(lockKey, workerId, 'PX', this.leaseTtlMs, 'NX');
    return result === 'OK';
  }

  /**
   * Heartbeat to renew the lease while a step is actively executing. The engine renews at
   * TTL/3; a missed renewal lets the stale-lease requeue (§4.2 statement 5) recover the task.
   */
  public async renewLease(tenantId: string, runId: string, workerId: string): Promise<boolean> {
    const lockKey = `tenant:${tenantId}:task:${runId}:lease`;
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;
    const result = await this.redis.eval(luaScript, 1, lockKey, workerId, this.leaseTtlMs);
    return result === 1;
  }

  /**
   * Explicit release upon completion or wait transition.
   */
  public async releaseLease(tenantId: string, runId: string, workerId: string): Promise<void> {
    const lockKey = `tenant:${tenantId}:task:${runId}:lease`;
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await this.redis.eval(luaScript, 1, lockKey, workerId);
  }
}
```

### 4.4. Retryable Failure, Timeout UNKNOWN and Durable Recovery

NFR-004 requires durable workflows with finite exponential backoff, timeouts and state checkpointing; BR-006 requires that a retry never duplicates an external effect. The two obligations meet in one rule: **a failure is only retried when re-execution is provably safe.**

**Failure classes** (produced by `classifyFailure()`, §3.3):

| Class | Examples | Action |
|---|---|---|
| `RETRYABLE` | transport reset, HTTP 429/5xx, `CONCURRENT_TASK_LOCK`, provider unavailable | Re-queue the task with `retry_count + 1` and exponential backoff + jitter, while `retry_count < max_retries`. The step's `effect_key` is unchanged, so the reservation makes the retry at-most-once. |
| `FATAL` | schema validation failure, authority `DENIED`, price-floor violation, `IDEMPOTENCY_CONFLICT`, human rejection | Terminate the task (`state = 'failed'` or `'stopped'`), write `error_details` and the audit record. No retry. |
| `UNKNOWN` | dispatch time-out, socket error after the request was sent, unparsable provider body (all normalized by the dispatch guard `dispatchWithDeadline()`, §3.3, and never applied to a read-only step) | **Never retried.** The reservation stays open and the provider is reconciled by `effect_key` before anything else happens. |

**Durable recovery loop** (runs in the scheduler/worker for every task in `waiting` with an open reservation):

```text
1. LOAD  the durable task (tenant-scoped) and its open effect_reservations rows
         (status = 'RESERVED', where the step outcome was never confirmed).
2. RECONCILE  for each open reservation:
     a. ask the adapter for the effect bound to this effect_key
        (provider reference lookup / idempotent create-with-key / order-by-external-id):
        • effect present  → status = 'SUCCEEDED', store the provider receipt.
        • effect absent   → status = 'FAILED'  (provider-confirmed no-op; safe to re-execute).
        • indeterminate   → keep 'RESERVED' and back off; do NOT dispatch.
     b. write one evidence record for the reconciliation attempt (chain continues).
3. RESUME  the task from `current_step` when every reservation for the step is settled:
     • SUCCEEDED → the step is complete: emit the business outcome watch, advance the cursor,
                   continue with the next step (never re-dispatch this effect).
     • FAILED    → re-dispatch once under the SAME effect_key. If the action is AUTH-4, reuse the
                   existing approvals row bound to that key; never insert a second approval.
4. ESCALATE  when an indeterminate reservation reaches `expires_at` (default 72 h, = the
             idempotency window): mark the reservation EXPIRED, park the task in
             `awaiting_human`, and raise an SCR-003 exception item so a human resolves the
             provider state. The run is never silently abandoned.
5. RETRY  a task in `queued`/`running` whose lease expired is reclaimed by the stale-lease
          requeue (§4.2 statement 5); `retry_count` is incremented only on a `RETRYABLE` failure,
          and the task fails terminally at `max_retries`.
```

**Backoff.** Delay is `initial_interval_ms × backoff_multiplier^(retry_count - 1)` with full jitter, capped by the step's `timeout_ms` budget for the whole attempt sequence. The schedule lives in the durable task row, so a crashed worker resumes the wait instead of restarting it.

**Invariants.**
1. `retry_count` counts *attempts*, not failures of the external effect; a SETTLED reservation never increments it.
2. A reconciliation that cannot prove the outcome is never treated as failure — it stays UNKNOWN and escalates (§ above, step 4). "Unknown" is a first-class state, not a silent success or a silent failure.
3. Every retry and every reconciliation attempt writes its own evidence record and its own
   Agent Run record (`audit_records`), with `execution_status = 'failed'` plus
   `error = { code: 'DISPATCH_TIMEOUT' | 'PROVIDER_INDETERMINATE', outcome: 'UNKNOWN' }` while the
   effect is unproven — the append-only vocabulary has no `unknown` status, and the reservation
   stays `RESERVED` — so the 18-field audit trail reflects exactly what happened.

---

## 5. Context Aggregator: High-Speed Triple-Source Hydration

The Context Aggregator hydrates customer state with a strict latency budget ($\le 50\text{ms}$ p95) using concurrent multi-source querying:

```
                      ┌─────────────────────────────────────────┐
                      │            Signal Arrives               │
                      └────────────────────┬────────────────────┘
                                           │
                           Promise.allSettled() Concurrent
                     ┌─────────────────────┼────────────────────┐
                     ▼                     ▼                    ▼
            ┌─────────────────┐   ┌─────────────────┐  ┌─────────────────┐
            │ PostgreSQL C360 │   │  Redis Working  │  │  Second Brain   │
            │ Profile + Facts │   │     Memory      │  │  Vector Index   │
            └────────┬────────┘   └────────┬────────┘  └────────┬────────┘
                     │                     │                    │
                     └─────────────────────┼────────────────────┘
                                           ▼
                              ┌─────────────────────────┐
                              │ Consolidated Context    │
                              │ Epistemic Verification  │
                              └─────────────────────────┘
```

### 5.1. Context Aggregator Implementation

Hydration splits into two phases with different trust rules:

1. **Identity resolution (trusted, server-side).** `IIdentityResolver` maps the subject to a customer without ever trusting a payload assertion:
   * `SESSION_BOUND` — gateway-authenticated login or completed OTP verification bound to this session; permits the verified customer's profile.
   * `CHANNEL_IDENTIFIER_EXACT` — provider-authenticated sender matches exactly one tenant/channel identity row with `verified_at` non-null. Only that verified binding may attach a profile; an unverified match resolves to `UNRESOLVED`, never a private-data lookup.
   * `UNRESOLVED` — anonymous. `customer = null`, and every skill whose input schema requires `customer_id` refuses to run; order lookups refuse; marketing outreach refuses (BR-004).
   * Never used: fuzzy phone/email matching, `customers.primary_phone` fallback, `verification_status`/VIP flags, or any value echoed from the client payload (BR-003, NFR-008).
2. **Fact hydration** then reads `customer_360_profiles` by the resolved `customer_id` **only** (the view's RLS-covered base tables apply). Working memory is keyed by the unique server-issued `session_id`, so an anonymous visitor can never land in another visitor's scratchpad.

```typescript
/**
 * @file context-aggregator.ts
 * @description Fast concurrent hydration of customer facts, working memory, and citations.
 */
import { Pool } from 'pg';
import Redis from 'ioredis';

export class FastContextAggregator implements IContextAggregator {
  constructor(
    private readonly pgPool: Pool,
    private readonly redis: Redis,
    private readonly identityResolver: IIdentityResolver,
    private readonly vectorSearchClient: IVectorSearchClient
  ) {}

  public async hydrateContext(
    tenantId: string,
    subject: SignalSubject,
    correlationId: string
  ): Promise<HydratedContext> {
    const startTime = Date.now();

    if (!subject.session_id) {
      throw new OrchestratorError(
        'INVALID_SESSION',
        'Refusing to hydrate a session without a unique server-issued session_id (NFR-006).'
      );
    }

    // Phase 1: trusted identity resolution (never a payload assertion).
    const resolved: ResolvedSubject = await this.identityResolver.resolveSubject(tenantId, subject);

    // Phase 2: concurrent hydration, scoped by (tenant_id, customer_id) and (tenant_id, session_id).
    const [c360Result, memoryResult, vectorResult] = await Promise.allSettled([
      this.fetchCustomer360(tenantId, resolved.customer_id),
      this.fetchWorkingMemory(tenantId, resolved.session_id),
      this.fetchKnowledgeCitations(tenantId, correlationId),
    ]);

    // 1. Process Customer 360 (Fact Store)
    if (c360Result.status === 'rejected') {
      console.error(
        `[CRITICAL_DATA_HYDRATION_ERROR] Failed to query customer_360_profiles for tenant ${tenantId}, correlation ${correlationId}:`,
        c360Result.reason
      );
    }
    const customer = c360Result.status === 'fulfilled' ? c360Result.value : null;

    // 2. Process Working Memory (Redis, per unique session). A miss creates a fresh, empty
    //    scratchpad for THIS session — never a bucket shared with other anonymous visitors.
    const working_memory: WorkingMemoryContext =
      memoryResult.status === 'fulfilled' && memoryResult.value
        ? memoryResult.value
        : {
            session_id: resolved.session_id,
            last_touch_channel: subject.channel_type ?? 'unknown',
            turn_count: 1,
            takeover_active: await this.isTakenOver(tenantId, resolved.session_id),
          };

    // 3. Process Vector Search (Second Brain)
    const knowledge_citations = vectorResult.status === 'fulfilled' ? vectorResult.value : [];

    const latency = Date.now() - startTime;
    if (latency > 50) {
      console.warn(`[PERF_ALERT] Context hydration exceeded 50ms budget: ${latency}ms`);
    }

    return {
      correlation_id: correlationId,
      tenant_id: tenantId,
      customer,
      working_memory,
      knowledge_citations,
      hydrated_at: new Date().toISOString(),
    };
  }

  /**
   * Reads the Customer 360 projection by the server-resolved customer id only. No fuzzy handle
   * matching, no "first row that happens to match a phone" — that lookup shape is exactly how
   * tenant A's order can be shown to tenant B's caller.
   */
  private async fetchCustomer360(tenantId: string, customerId: string | null): Promise<Customer360Fact | null> {
    if (!customerId) {
      return null; // anonymous session: no FACT profile is released
    }
    const query = `
      SELECT
        customer_id, tenant_id, verified_phone, verified_email,
        total_spent, order_count, rfm_segment_hypothesis, consent_marketing,
        consent_updated_at, suppression_active, created_at
      FROM customer_360_profiles
      WHERE tenant_id = $1 AND customer_id = $2
      LIMIT 1;
    `;
    const res = await this.pgPool.query(query, [tenantId, customerId]);
    return res.rows.length > 0 ? (res.rows[0] as Customer360Fact) : null;
  }

  private async fetchWorkingMemory(tenantId: string, sessionId: string): Promise<WorkingMemoryContext | null> {
    const key = `tenant:${tenantId}:wm:${sessionId}`;
    const raw = await this.redis.get(key);
    return raw ? JSON.parse(raw) : null;
  }

  private async isTakenOver(tenantId: string, sessionId: string): Promise<boolean> {
    const lock = await this.redis.get(`tenant:${tenantId}:session:${sessionId}:takeover_lock`);
    return lock !== null;
  }

  private async fetchKnowledgeCitations(tenantId: string, queryText: string): Promise<Array<{ document_id: string; path: string; score: number }>> {
    return this.vectorSearchClient.searchByTenant(tenantId, queryText, 3);
  }
}

export interface IVectorSearchClient {
  searchByTenant(tenantId: string, query: string, limit: number): Promise<Array<{ document_id: string; path: string; score: number }>>;
}
```

**Isolation guarantees.**

| Scenario | Guarantee |
|---|---|
| Anonymous visitor A and anonymous visitor B in one tenant | Distinct `session_id` ⇒ distinct `tenant:{tid}:wm:{sid}` buckets and `customer = null` for both. No shared bucket exists. |
| Client sends `verified_customer_id` directly | Ignored: the field is only read from the gateway-authenticated envelope; `IIdentityResolver` re-resolves server-side. |
| Client asserts a phone number it does not own | Never resolves a customer; only `SESSION_BOUND` or `CHANNEL_IDENTIFIER_EXACT` may attach a profile, and neither reads the payload. |
| Customer A's session asks for customer B's order | Refused: context is hydrated for A only and the order-lookup skill requires the verified identity of the order owner (§05 skill 17). |
| `takeover_active` observed at hydration | The engine stops before step 3 and never dispatches; the per-step re-check covers takeovers that land mid-run. |

---

## 6. Evidence & Outcome Logger: Cryptographic Audit Trail

Every mutating action generates an immutable evidence record. Records form a hash-chained Merkle sequence guaranteeing auditability (NFR-002).

### 6.1. Cryptographic Record Specification (RFC 8785 Canonical JSON)

To ensure tamper-evidence:
1. Payloads are canonicalized following RFC 8785 (keys sorted alphabetically, no insignificant whitespace).
2. The digest is calculated as `SHA-256(canonical_payload)`.
3. The chain hash is calculated as `SHA-256(previous_hash + current_payload_hash + effect_key + step_index)`.

```typescript
/**
 * @file evidence-logger.ts
 * @description Cryptographically secure, append-only Evidence Logger.
 */
import { createHash, createHmac } from 'crypto';
import { Pool } from 'pg';

export class CryptographicEvidenceLogger implements IEvidenceLogger {
  /** No default value: an unsigned or hard-coded-secret audit chain is not an audit chain. */
  private readonly hmacSecret: string | null;

  constructor(private readonly pgPool: Pool) {
    this.hmacSecret = process.env.AUDIT_HMAC_SECRET ?? null;
  }

  public async createImmutableRecord(params: {
    run_id: string;
    tenant_id: string;
    correlation_id: string;
    step_index: number;
    effect_key: string;
    previous_evidence_hash: string;
    payload: Record<string, unknown>;
  }): Promise<ImmutableEvidenceRecord> {
    const evidence_id = `ev_${createHash('sha256').update(`${params.tenant_id}|${params.run_id}|${params.effect_key}|${params.step_index}`).digest('hex').substring(0, 16)}`;
    const createdAt = new Date().toISOString();

    // 1. Canonicalize Payload (RFC 8785 subset)
    const canonicalPayloadJson = this.canonicalizeJson(params.payload);
    const payload_sha256 = createHash('sha256').update(canonicalPayloadJson).digest('hex');

    // 2. Chained Hash Computation — the same formula as §03 `evidence_records.chain_hash`.
    const chainInput = `${params.previous_evidence_hash}|${payload_sha256}|${params.effect_key}|${params.step_index}`;
    const chainHash = createHash('sha256').update(chainInput).digest('hex');

    // 3. HMAC Signature for Non-repudiation.
    //    The secret is mandatory: a fallback literal would let anyone with the source forge an
    //    audit chain, so a missing secret fails the write instead of weakening the signature.
    if (!this.hmacSecret) {
      throw new OrchestratorError('AUDIT_SECRET_MISSING', 'AUDIT_HMAC_SECRET is required to sign evidence records (NFR-002).');
    }
    const signature = createHmac('sha256', this.hmacSecret).update(chainHash).digest('hex');

    // 4. Persist to the canonical immutable chain (§03 DOMAIN 5 `evidence_records`).
    const insertQuery = `
      INSERT INTO evidence_records (
        evidence_id, tenant_id, run_id, correlation_id, step_index,
        effect_key, previous_evidence_hash, payload_sha256, chain_hash, signature,
        raw_payload, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING evidence_id;
    `;
    await this.pgPool.query(insertQuery, [
      evidence_id,
      params.tenant_id,
      params.run_id,
      params.correlation_id,
      params.step_index,
      params.effect_key,
      params.previous_evidence_hash,
      payload_sha256,
      chainHash,
      signature,
      canonicalPayloadJson,
      createdAt,
    ]);

    return {
      evidence_id,
      run_id: params.run_id,
      tenant_id: params.tenant_id,
      correlation_id: params.correlation_id,
      step_index: params.step_index,
      effect_key: params.effect_key,
      previous_evidence_hash: params.previous_evidence_hash,
      payload_sha256,
      chain_hash: chainHash,
      signature,
      created_at: createdAt,
    };
  }

  /**
   * Canonical 18-field Agent Run writer (SRS §17). `step_index` is part of the primary key
   * (`tenant_id, run_id, skill, step_index`), so omitting it would collapse a multi-step plan
   * into one row per skill; `execution_status` uses the canonical vocabulary
   * (`pending | executing | success | failed | denied | aborted`).
   */
  public async logAgentRun(runLog: AgentRunLogRecord): Promise<void> {
    const query = `
      INSERT INTO agent_run_logs (
        run_id, tenant_id, agent_id, customer_or_entity_id, trigger,
        context, skill, step_index, tool, decision, authority,
        approval, action, execution_status, evidence, outcome,
        latency_ms, cost, error, started_at, completed_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21
      );
    `;
    await this.pgPool.query(query, [
      runLog.run_id,
      runLog.tenant_id,
      runLog.agent_id,
      runLog.customer_or_entity_id,
      runLog.trigger,
      JSON.stringify(runLog.context),
      runLog.skill,
      runLog.step_index,
      runLog.tool,
      JSON.stringify(runLog.decision),
      runLog.authority,
      runLog.approval ? JSON.stringify(runLog.approval) : null,
      JSON.stringify(runLog.action),
      runLog.execution_status,
      JSON.stringify(runLog.evidence),
      runLog.outcome ? JSON.stringify(runLog.outcome) : null,
      runLog.latency_ms,
      JSON.stringify(runLog.cost),
      runLog.error ? JSON.stringify(runLog.error) : null,
      runLog.started_at,
      runLog.completed_at,
    ]);
  }

  /**
   * Registers the asynchronous outcome watcher (§03 `pending_outcome_attributions`). The row is
   * tenant-scoped and unique per `(tenant_id, effect_key)`, so a retry or replay is a no-op
   * instead of creating a second watcher for the same effect.
   */
  public async initializeOutcomeWatch(params: {
    tenant_id: string;
    run_id: string;
    effect_key: string;
    skill_id: string;
  }): Promise<void> {
    const query = `
      INSERT INTO pending_outcome_attributions (tenant_id, run_id, effect_key, skill_id, status, created_at)
      VALUES ($1, $2, $3, $4, 'OBSERVING', CURRENT_TIMESTAMP)
      ON CONFLICT (tenant_id, effect_key) DO NOTHING;
    `;
    await this.pgPool.query(query, [params.tenant_id, params.run_id, params.effect_key, params.skill_id]);
  }

  private canonicalizeJson(obj: unknown): string {
    if (obj === null || typeof obj !== 'object') {
      return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
      return `[${obj.map((item) => this.canonicalizeJson(item)).join(',')}]`;
    }
    const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
    const pairs = sortedKeys.map((key) => `${JSON.stringify(key)}:${this.canonicalizeJson((obj as any)[key])}`);
    return `{${pairs.join(',')}}`;
  }
}
```

### 6.2. Persistence Contract

This evidence/outcome logger writes to exactly three canonical objects, all declared once in **§03 §1 DOMAIN 5**; they are not re-declared here, because a second DDL copy is precisely how the writer and the database drift apart. (The orchestrator's separate `IAuditTrail` binding appends the chained compliance ledger `audit_records`, §08 §4.1 — a fourth destination this logger never touches, so exactly one writer owns each object.)

| Object | Written by | Key / chain contract |
|---|---|---|
| `evidence_records` | `createImmutableRecord()` | `evidence_id` (PK), `tenant_id UUID`, `run_id`, `correlation_id`, `step_index`, `effect_key`, `previous_evidence_hash` (predecessor's `chain_hash`; `'0'×64` at genesis), `payload_sha256`, `chain_hash`, `signature` (HMAC-SHA256 over `chain_hash`), `raw_payload` (RFC 8785 canonical JSON), `UNIQUE (tenant_id, chain_hash)`. Append-only: the `trg_immutable_evidence_records` trigger rejects UPDATE/DELETE. |
| `agent_run_logs` | `logAgentRun()` | PK `(tenant_id, run_id, skill, step_index)`; the 18 SRS §17 fields plus `step_index`, `created_at`; `execution_status ∈ pending / executing / success / failed / denied / aborted` (the six-value append-only vocabulary; a timeout-UNKNOWN attempt is `failed` with `error.outcome = 'UNKNOWN'`). Append-only (`trg_immutable_agent_run_logs`). |
| `pending_outcome_attributions` | `initializeOutcomeWatch()` | `tenant_id UUID NOT NULL`, `UNIQUE (tenant_id, effect_key)`, `status ∈ OBSERVING / ATTRIBUTED / UNATTRIBUTED / EXPIRED`, `expires_at` bound to the 72-hour idempotency window. Mutable runtime state, RLS-covered. |

Approvals are **not** written here: the pause/claim transaction of §4.2 is the only writer of the canonical `approvals` row, and SCR-003 reads the `approval_queue` view over it. `immutable_evidence_records`, `evidence_log` and a second `approval_queue` table do not exist in this schema.

---

## 7. Acceptance Criteria & Test Verification Matrix

| Test Identifier | Target Requirement | Test Scenario | Expected Assertion |
|---|---|---|---|
| `TC-ORC-001` | 11-Step Lifecycle | Ingest standard `product.inquiry` signal. | Completes steps 1 through 11; emits a chained `evidence_records` row and one `agent_run_logs` row per step. |
| `TC-ORC-002` | Epistemic Guard (FR-C360-003) | Inject Agent output attempting to set `customer.is_fraud = true` as FACT. | Engine throws `SECURITY_VIOLATION`; Fact Store and SoR mirrors unchanged. |
| `TC-ORC-003` | Floor Price Guard (BR-001..003) | Draft 80 TWD against an owner-approved 100 TWD floor; separately omit provenance. | `ERR_FLOOR_PRICE_VIOLATION` / `P_FLOOR_UNAVAILABLE`; zero dispatch even after human approval; SoR price unchanged. |
| `TC-ORC-004` | Approval Pause (SCR-003) | Trigger broadcast campaign skill (`AUTH-4`). | Task transitions to `awaiting_human`; exactly one `approvals` row is PENDING, visible through the `approval_queue` view; the audit trail records `execution_status = 'pending'` (no effect claimed), and the step's single `agent_run_logs` row is appended only when the decision resolves the step. |
| `TC-ORC-005` | Human Takeover (SCR-005) | Ingest human operator `takeover` event on an active session. | Bot execution halts immediately; task transitions to `stopped`; no further step is drafted or dispatched. |
| `TC-ORC-006` | Double Execution Prevention (BR-006) | Two workers execute the same plan step with identical `effect_key`. | The durable reservation (`effect_reservations` PK) admits one attempt; the second receives `IN_FLIGHT`/`REPLAY` and never reaches the adapter. |
| `TC-ORC-007` | Tamper-Evidence Audit (NFR-002) | Attempt SQL UPDATE/DELETE on `evidence_records`, `agent_run_logs` and `audit_records`. | Trigger raises the immutability exception; modification blocked; the chain hash still verifies. |
| `TC-ORC-008` | AUTH-5 Hard Deny (SRS §12) | Skill declares `AUTH-5`, and separately an `AUTH-1` agent requests an `AUTH-3` skill. | Both return `DENIED` with `execution_status = 'denied'`; nothing is queued in SCR-003 and no adapter call is made. AUTH-5 is never compared numerically and never approvable. |
| `TC-ORC-009` | Single-Use Approval (SCR-003) | Approve an `AUTH-4` action twice (double click / replayed callback / stale console). | First claim updates 1 row and resumes the task; the second claim updates 0 rows and raises `APPROVAL_NOT_CLAIMABLE`; only one external effect exists. |
| `TC-ORC-010` | Deterministic `effect_key` (BR-005) | Kill the worker mid-run and replay the same inbound signal (same `signal_id`) as a new run. | The recomputed `effect_key` is byte-identical because `run_id` is not an input; the second run returns the cached receipt instead of re-sending the message. |
| `TC-ORC-011` | Timeout UNKNOWN & Recovery (NFR-004) | Abort the provider connection after the request was sent. | `audit_records` records `execution_status = 'failed'` with `error.outcome = 'UNKNOWN'` (never `success`, never a false no-op), and the `effect_reservations` row stays `RESERVED`; recovery reconciles by `effect_key` and either completes the step (settling the reservation and appending the step's single `agent_run_logs` row) or escalates at `expires_at`. No blind re-dispatch. |
| `TC-ORC-012` | Per-Step Takeover + Return-to-Agent (SCR-005) | Take over after step 1 of a 3-step plan, then return the conversation to the agent. | Step 2 is never dispatched; task is `stopped`; `human.resume` releases the takeover lock and restores `conversations.state = 'open'`; the next signal starts a fresh run with correct context. |
| `TC-ORC-013` | Anonymous Session Isolation (NFR-006) | Two anonymous visitors of one tenant interact concurrently. | Distinct `session_id` ⇒ distinct `tenant:{tid}:wm:{sid}` buckets, `customer = null` for both, and zero cross-session context in either prompt. |
| `TC-ORC-014` | Verified Identity for Customer Data | A caller supplies another customer's phone/email or a `verification_status = 'vip'` hint to read order history. | Identity resolves to `UNRESOLVED`/`CHANNEL_IDENTIFIER_EXACT` only from trusted sources; the order-lookup skill refuses without a verified identity of the order owner (§05 skill 17). No FACT is released from the payload assertion. |
| `TC-ORC-015` | Derived RFM Separation (FR-C360-003) | Read `customer_360_profiles` and attempt to persist the derived RFM value back to `customers`. | The projection exposes `rfm_segment_hypothesis` only; the SoR-mirror write is rejected (§03 §1.2) and a durable derived attribute can only be stored as an `evidences` row with `taxonomy_type = 'HYPOTHESIS'`. |

## 8. Contract-Complete Stage, Control-Flow, and Recovery Rules `[SRS-MUST][SRS §12, §17, §19 / NFR-003, NFR-004, NFR-007, NFR-008]`

This section is the owner contract for the eleven stages. The snippets and tables are `[NOT-RUNTIME-EVIDENCE]` until a future worker executes them against real durable state.

| Stage | Input → output | Durable state / side effect | Authority/evidence/retry rule |
|---|---|---|---|
| `SIGNAL` | external envelope → `SignalEnvelope` | immutable event and correlation ID | schema/tenant validation; reject malformed/replay conflict |
| `CONTEXT` | signal + tenant/session → `HydratedContext` | context-read trace | verified identity before private lookup; read retry only |
| `HYPOTHESIS` | context → tagged `HypothesisRecord` | hypothesis/evidence record | never FACT; model timeout is non-terminal until policy deadline |
| `DECISION` | hypothesis + policy → `RoutingDecision` | decision reason/verdict | registry/authority/policy checks; deny is terminal |
| `PLAN` | routing + context → `ExecutionPlan` | versioned task plan | no agent peer calls; validate dependencies and timeout |
| `ACTION` | plan step → `ActionDraft` | payload digest/effect key reservation intent | provenance-bearing floor required for price action; no dispatch yet |
| `APPROVAL` | action + verdict → `ApprovalGateResult` | PENDING approval or terminal deny | AUTH-0..3 may auto route; AUTH-4 pauses; AUTH-5 hard denies |
| `EXECUTION` | approved action → `ExecutionReceipt` | reservation and provider attempt | dispatch after reservation; UNKNOWN reconciles, never blind retries |
| `EVIDENCE` | receipt + decision → `EvidenceRecord` | append-only digest/hash chain | record provider receipt or truthful failure |
| `OUTCOME` | evidence + downstream events → `OutcomeAttribution` | attributed outcome watcher | source/effect match and late-event handling |
| `LEARNING` | outcome → versioned learning update | restricted Learning Memory write | no raw conversation/HYPOTHESIS promotion to FACT/knowledge |

Central control flow is mandatory: one orchestrator owns routing; agents do not call agents. The orchestrator asks at most one clarification question before routing/handoff, checks module enablement, resolves customer identity before private lookup, checks consent before outreach, and checks human takeover before every stage and retry. Missing context, disabled module, unknown identity, missing consent, unavailable floor provenance, or missing authority fails closed.

### 8.1 Authority verdict and approval binding `[SRS §12 / BR-007, BR-008]`

Agents carry only `AUTH-0..AUTH-3` grants. After tenant/agent binding, validate the grant, deny `AUTH-5`, route `AUTH-4`, reject any unknown requirement, and compare rank only for `AUTH-0..AUTH-3`. Every independent policy/consent/identity/floor check must pass before queue creation. The one-time approval binds `(tenant_id, run_id, effect_key, payload_digest)` and never upgrades a clearance. Resume rechecks current policy; the approval satisfies only its own AUTH-4 pause. Audit distinguishes grant, requirement, verdict, approval state, and execution status.

### 8.2 Pricing guardrail conflict `[OWNER-DECISION-REQUIRED][SRS §13, §19 / BR-001..003, NFR-008]`

No price-bearing dispatch is allowed without an owner-approved, provenance-bearing floor decision. Below-floor proposals are terminal refusals; approval cannot waive this. The ERP/policy-supplied mirror and platform-derived floor from owner-approved inputs remain competing proposals. Local arithmetic in `02` §4.1, `08` §3.1 and `09` is candidate-only until the Solution Architect and Business/Finance lock ownership, formula/mode, rounding, currency, staleness and provenance (`README.md` §8.1). `validateAction` resolves trusted metadata; `verifyFloorPrice` compares only validated values and cannot establish provenance by itself.

### 8.3 Durable task lifecycle and reconciliation `[SRS §12, §17 / NFR-003, NFR-004]`

Stored task states are `queued`, `running`, `waiting`, `awaiting_human`, `completed`, `stopped`, and `failed` (`03` DOMAIN 5). `UNKNOWN` is an unconfirmed effect outcome represented by `waiting`, `error.outcome = 'UNKNOWN'`, and an open reservation; it is neither a task state nor an audit execution status. Optimistic `task_version` and fenced leases reject stale workers. Approval claim and task transition are atomic. Stop/revocation checks run before each dispatch. Recovery loads committed checkpoints and never infers success from an in-memory response.

### 8.4 Stage-entry and recovery invariants `[BLUEPRINT][SRS §9, §12, §17, §19]`

`current_step` is the plan's skill-step cursor, not the ordinal of the eleven-stage lifecycle. The checkpoint stores stage identity/output and digest in `state_payload` together with the plan, pending action and evidence cursor. Each transition advances `task_version` while preserving `correlation_id`. A fenced worker alone may update the checkpoint or admit dispatch; a stale write affects zero rows. Recovery uses the last committed output rather than regenerating a plan or model response.

The stage boundary is pre-side-effect through `APPROVAL`: tenant and subject binding, schema validation, skill/agent authorization, business rules, consent, floor provenance, takeover state, and approval digest are evaluated before `IEffectGuard.reserve()`. `EXECUTION` is the only stage allowed to invoke an external mutating adapter, and only after a durable reservation succeeds. `EVIDENCE` cannot be skipped after a provider attempt; if its append fails, the run cannot claim success and enters reconciliation/operator review. `OUTCOME` accepts only a source event or SoR receipt linked to the effect; `LEARNING` writes a versioned, retention-approved projection and never overwrites source facts.

Recovery decisions are explicit: `SUCCEEDED` reservation advances the cursor without dispatch; provider-confirmed `FAILED` absence permits one same-key re-dispatch; `RESERVED`/indeterminate remains `waiting` and is reconciled; an expired unresolved reservation becomes an operator-visible `awaiting_human` exception. A retry is therefore a new attempt record with the same effect identity, never a new effect identity. These are target invariants and `[NOT-RUNTIME-EVIDENCE]` until a future durable worker and provider boundary execute them.

## 9. Dependency Interface Catalog `[BLUEPRINT][SRS §12, §17, §19]`

| Interface | Input/output | Required errors and boundary |
|---|---|---|
| `IContextAggregator` | `SignalEnvelope` → `HydratedContext` | tenant/identity missing, source unavailable; no inferred FACT |
| `IAgentRuntime` | context/route → hypothesis/draft | schema/timeout; cannot dispatch tools directly |
| `IPolicyEngine` | draft/context → authority/business verdict | AUTH-4 route, AUTH-5 deny, policy unavailable fail closed |
| `IStatefulWorkflowEngine` | plan/event → durable task state | optimistic version, lease lost, restart recovery |
| `IEvidenceLogger` | stage/receipt → immutable evidence | digest/chain failure blocks completion |
| `IAuditTrail` | verdict/transition → audit record | append failure blocks claimed success |
| `IAdapterDispatcher` | approved action → provider receipt | timeout/indeterminate/invalid receipt; no fabricated result |
| `IEffectGuard` | `(tenant_id,effect_key,payload_digest)` → reservation/replay | conflict/in-flight/unknown |
| `IIdentityResolver` | session/verified factors → identity verdict | unresolved or mismatch refuses private lookup |
| `ISessionControl` | conversation → takeover/lease state | human hold suppresses agent send |
| `DurableLeaseManager` | task → fenced lease | expired/stale worker cannot write |

## 10. Evidence, Outcome, and Verification Contract `[SRS §17, §19 / NFR-002, NFR-005]`

Trace propagation carries `tenant_id`, `run_id`, `correlation_id`, and `effect_key` through all stages. Evidence stores canonical JSON digest, predecessor hash, provider receipt or truthful failure, and source references. Audit and evidence are separate: audit records the governance decision; evidence records the immutable payload/result. Outcome attribution requires a source event/SoR reference and never fabricates revenue, delivery, or learning. Learning writes are versioned and restricted to validated outcome classes.

Future scenarios MUST cover: a complete eleven-stage run; missing context; unknown identity; missing consent; AUTH-4 pause/resume; AUTH-5 deny; provider timeout with reconciliation; duplicate retry; takeover suppression; absent floor provenance; and HYPOTHESIS separation. No scenario is runtime evidence until executed and attached to a gate bundle.
