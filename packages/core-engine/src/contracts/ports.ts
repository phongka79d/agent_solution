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
import type { LifecycleStage } from '../lifecycle/stages.js';

import type {
  ActionDraft,
  AgentRunLogRecord,
  ApprovalGateResult,
  DurableTaskGuard,
  DurableTaskSnapshot,
  ExecutionPlan,
  ExecutionReceipt,
  FinalResponse,
  HydratedContext,
  HypothesisRecord,
  ImmutableEvidenceRecord,
  IStatefulWorkflowEngine,
  PlannedStep,
  PreviousStepReceipts,
  ResolvedSubject,
  ResponseFinalizationInput,
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
//
// The durable contract in `types.ts` is the single source of truth. Keep this
// barrel path as a compatibility re-export for adapter/test bindings.
export type { IEffectGuard, ReservationOutcome } from './types.js';
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

/**
 * Builds a customer-facing response from server-trusted context and successful immutable receipts.
 * The input deliberately contains no caller-authored message or raw provider output.
 */
export interface IResponseFinalizer {
  finalize(input: ResponseFinalizationInput): Promise<FinalResponse>;
}

/**
 * Tenant-scoped durable response persistence. `save` MUST be idempotent for `(tenant_id, run_id)`
 * and MUST reject a replay that supplies content different from the immutable stored response.
 */
export interface IRunResponseStore {
  read(input: {
    tenant_id: string;
    run_id: string;
  }): Promise<FinalResponse | null>;
  save(input: {
    tenant_id: string;
    run_id: string;
    conversation_id?: string;
    sender_id: string;
    response: FinalResponse;
  }): Promise<void>;
}

/**
 * Durable append-only lifecycle stage trace. The orchestrator performs the synchronous
 * `StageJournal` transition guard first, then awaits this port before any external side effect.
 * Implementations should make `(tenant_id, run_id, attempt_ordinal, step_index, stage)` idempotent
 * for recovery/replay.
 */
export interface IRunStageRecorder {
  nextAttemptOrdinal(tenant_id: string, run_id: string): Promise<number>;
  append(input: {
    tenant_id: string;
    run_id: string;
    attempt_ordinal: number;
    step_index: number;
    stage: LifecycleStage;
    entered_at: string;
    detail?: unknown;
    evidence_refs?: unknown;
  }): Promise<void>;
}


/**
 * Resolves server-authored receipt bindings for one downstream step. `previous_receipts` is
 * assembled from immutable evidence by the orchestrator on every attempt; a resolver must not
 * obtain receipts from caller input, a provider body, or an in-memory-only cache.
 */
export interface IPlanInputResolver {
  resolve(input: {
    tenant_id: string;
    run_id: string;
    step: PlannedStep;
    previous_receipts: PreviousStepReceipts;
    context: HydratedContext;
  }): Promise<Record<string, unknown>>;
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
  /** Durable lookup used when a predecessor's action revision is not derivable from the plan. */
  findImmutableRecordByStep?(params: {
    tenant_id: string;
    run_id: string;
    step_index: number;
  }): Promise<ImmutableEvidenceRecord | null>;
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
   *
   * The signal is aborted by the guard when the registry deadline expires; implementations MUST
   * forward it to their in-flight provider request.
   */
  dispatch(action: ActionDraft, options?: { timeout_ms?: number; signal?: AbortSignal }): Promise<ExecutionReceipt>;
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
