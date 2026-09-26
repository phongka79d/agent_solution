/**
 * @file Dependency interface catalog (implement/04 §3.2.3, §3.3). These are runtime bindings
 * supplied by the platform; the orchestrator depends on the contract, never on an implementation.
 * It fails closed when a binding is absent and never fabricates a port result (no hard-coded
 * scores, Routings, receipts or outcomes).
 *
 * Declarations only — the durable/in-memory implementations live outside this directory and are
 * bound at the composition root.
 */

import type {
  CrossDomainHandoffDraft,
  HandoffAdmission,
} from './cross-domain-handoff.js';
import type {
  ActionDraft,
  AgentRunLogRecord,
  ApprovalGateResult,
  DurableTaskGuard,
  DurableTaskSnapshot,
  ExecutionPlan,
  ExecutionReceipt,
  HydratedContext,
  HypothesisRecord,
  ImmutableEvidenceRecord,
  IStatefulWorkflowEngine,
  ResolvedSubject,
  RoutingDecision,
  SignalEnvelope,
  SignalSubject,
} from './types.js';

export type {
  DurableTaskGuard,
  DurableTaskSnapshot,
  IStatefulWorkflowEngine,
};

// ============================================================================
// Effect deduplication (§3.2.3)
// ============================================================================

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
   * and never for a read-only action, which has no external effect to deduplicate.
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
   * An indeterminate outcome is deliberately NOT a settlement — the row is left RESERVED, which is
   * the only canonical way to express "the effect may or may not have landed".
   */
  resolve(input: {
    tenant_id: string;
    effect_key: string;
    status: 'SUCCEEDED' | 'FAILED';
    receipt?: unknown;
  }): Promise<void>;
  /**
   * Provider-side reconciliation of an unsettled effect (§4.4): the stored receipt is returned
   * verbatim for a confirmed `SUCCEEDED` effect, so a replay never has to synthesize an adapter
   * response for a call that this process did not make. Never a blind re-dispatch.
   */
  reconcile(input: {
    tenant_id: string;
    effect_key: string;
    skill_id: string;
  }): Promise<{ outcome: 'SUCCEEDED' | 'FAILED' | 'INDETERMINATE'; receipt?: unknown }>;
  reopenForRetry?(input: {
    tenant_id: string;
    effect_key: string;
  }): Promise<boolean>;
}

export type ReservationOutcome =
  | { readonly kind: 'RESERVED' }                            // first delivery: safe to dispatch
  | { readonly kind: 'REPLAY'; readonly receipt: unknown }    // same key + payload, already SUCCEEDED: return the stored receipt, no call
  | { readonly kind: 'IN_FLIGHT' }                            // identical key, RESERVED and unexpired
  | { readonly kind: 'RECONCILE_REQUIRED' }                   // expired RESERVED row, or a prior FAILED attempt
  | { readonly kind: 'CONFLICT' };                            // same key, different canonical payload

// ============================================================================
// Dependency interfaces (runtime bindings; not implemented in this blueprint)
// ============================================================================

export interface IContextAggregator {
  hydrateContext(tenant_id: string, subject: SignalSubject, correlation_id: string): Promise<HydratedContext>;
}

/**
 * Cognitive layer binding (MKT/SAL/CS agents + LLM). The orchestrator owns routing and plan
 * execution; this port exposes only the three derivation steps of the lifecycle. There is
 * deliberately no agent-to-agent invoke/message/call method here: agents never call agents, and a
 * `RoutingDecision` crosses the boundary only through `assertOrchestratorBrokered()`.
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
  findImmutableRecord?(params: { tenant_id: string; run_id: string; effect_key: string; step_index: number }): Promise<ImmutableEvidenceRecord | null>;
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
  /**
   * Queries the provider by effect_key / action_id to reconcile an unproven effect outcome (§4.4).
   */
  reconcile?(input: {
    readonly tenant_id: string;
    readonly effect_key: string;
    readonly action_id?: string;
    readonly adapter_target?: string;
    readonly skill_id?: string;
  }): Promise<{
    readonly outcome: 'SUCCEEDED' | 'FAILED' | 'INDETERMINATE';
    readonly receipt?: ExecutionReceipt | unknown;
  }>;
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

/**
 * Fenced execution lease per `(tenant_id, run_id)` (§4.4). A worker that cannot acquire the lease
 * for a run must not touch its durable task or admit dispatch: the lease is what makes stale or
 * concurrent workers write zero rows. The contract is deliberately transport-free — the Redis
 * implementation is one binding, never the correctness authority.
 */
export interface DurableLeaseManager {
  acquireLease(tenant_id: string, run_id: string, worker_id: string): Promise<boolean>;
  releaseLease(tenant_id: string, run_id: string, worker_id: string): Promise<void>;
}

/**
 * The ONLY brokered route between domains (implement/04 §1.1, plans/customer-lifecycle.md §3).
 *
 * A run that finished a leg of the customer journey asks the orchestrator to hand off; the
 * orchestrator builds the package, and this binding admits the target domain's durable run. An
 * agent never calls, messages or addresses another agent, and this port never executes a skill:
 * it admits a run, and the target domain's own runtime plans and executes it under the same PEP,
 * effect guard, evidence and audit boundaries as any other run.
 *
 * Fail closed. A broker that cannot decide must raise rather than report an admission: a handoff
 * that did not happen is never reported as one, and a replayed admission is reported as
 * `admitted: false` with the run the ledger already holds.
 *
 * The broker owns the durable identity of the hop: it reads the ledger, completes the package from
 * the draft, asserts `assertHandoffAdmissible` against the durable facts it read, and only then
 * admits. A draft is a request; the ledger decides what exists.
 */
export interface ICrossDomainHandoffBroker {
  admit(draft: CrossDomainHandoffDraft): Promise<HandoffAdmission>;
}
