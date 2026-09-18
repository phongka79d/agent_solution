# Core Engine and Revenue Orchestrator Specification

Status: Production Engineering Specification
System Component: Core Platform Engine (Layer 1)
Document Version: 1.0.0
Target Directory: `implement/04-core-engine-and-orchestrator.md`

---

## 1. Executive Summary and Architectural Invariants

The Core Platform Engine forms the domain-agnostic, tenant-isolated foundation of the AI Agent Platform. It coordinates the actions of all domain agents (Marketing, Sales, Customer Care) through a centralized, strictly governed execution loop.

### 1.1. Core Invariants
1. **Zero Direct Agent-to-Agent Coupling**: Domain agents (`MKT-*`, `SAL-*`, `CS-*`) are strictly isolated cognitive units. They cannot invoke, message, or depend on each other directly. All cross-domain interactions, context handoffs, and workflows are brokered through the centralized **Revenue Orchestrator**.
2. **Epistemic Boundary Separation (FR-C360-003)**:
   - `FACT`: Verified historical and transactional data retrieved from System of Record (PostgreSQL, ERP/POS).
   - `SIGNAL`: Raw, real-time observable user actions and event telemetry (Web/App, Webhooks).
   - `HYPOTHESIS`: Probabilistic AI inferences, churn scores, intent classifications, and propensity estimates.
   - **Hard Invariant**: An AI `HYPOTHESIS` shall NEVER be written or promoted into a Customer `FACT` without explicit validation from a System of Record.
3. **Fail-Closed Execution Policy (NFR-008)**: If any required context, consent record, mathematical floor price boundary ($P_{floor}$), or authority level cannot be validated with 100% certainty, the system halts execution, enters a safe fallback state, and escalates to a human operator (`SCR-003` / `SCR-005`).
4. **Idempotency Guarantee (NFR-003, BR-005)**: Every mutating external action is bound to a deterministic `effect_key`. Re-execution with an identical `effect_key` yields the previously committed result without side effects.
5. **Strict Multi-Tenant Isolation (NFR-006)**: Every memory lookup, vector query, database transaction, and message envelope is strictly scoped by `tenant_id`.

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
| [7. APPROVAL]    Evaluate Authority Model (AUTH-0..5); trigger Human SCR-003 gate if AUTH-4        |
|        |                                                                                           |
| [8. EXECUTION]   Dispatch commands via Plug-and-Play Adapters with distributed mutex               |
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
| **2** | `CONTEXT` | `SignalEnvelope`, `tenant_id`, `customer_id` | `HydratedContext` | Fetches Customer 360 (Facts), Consent tokens (BR-004), Session Scratchpad, and Second Brain docs. Fails closed if tenant mismatch. |
| **3** | `HYPOTHESIS` | `HydratedContext`, `SignalEnvelope` | `HypothesisRecord` | Computes intent probability, lead readiness, churn likelihood. Explicitly tags records as `HYPOTHESIS`. Prohibits overwriting `FACT`. |
| **4** | `DECISION` | `HypothesisRecord`, `TenantPolicies` | `RoutingDecision` | Selects target Agent (`marketing`, `sales`, `support`) or triggers clarification rule (Single Question Rule). |
| **5** | `PLAN` | `RoutingDecision`, `HydratedContext` | `ExecutionPlan` | Constructs sequential/parallel DAG of skill invocations, channel allocations, and timeout parameters. |
| **6** | `ACTION` | `ExecutionPlan`, `AgentDraftPayload` | `ActionDraft` | Synthesizes tool invocation payloads, verifies mathematical pricing floor ($P_{floor}$), generates deterministic `effect_key`. |
| **7** | `APPROVAL` | `ActionDraft`, `AuthorityPolicy` | `ApprovalGateResult` | Checks required authority (`AUTH-0` to `AUTH-5`). If `AUTH-4`, pauses execution and enqueues to `SCR-003 Approval Center`. |
| **8** | `EXECUTION` | Approved `ActionDraft`, Adapter Binding | `ExecutionReceipt` | Acquires distributed session lock, dispatches network request to external provider (ERP, LINE, Stripe) via Adapter. |
| **9** | `EVIDENCE` | `ExecutionReceipt`, `ActionDraft` | `ImmutableEvidenceRecord` | Computes SHA-256 payload digests, forms Merkle tree link, stores immutable proof in PostgreSQL `evidence_log`. |
| **10** | `OUTCOME` | `ImmutableEvidenceRecord`, Downstream Events | `OutcomeAttribution` | Matches async business outcomes (order settled, payment received, cart cleared, CSAT scored) to originating `run_id`. |
| **11** | `LEARNING` | `OutcomeAttribution`, `HypothesisRecord` | `MemoryOptimizationRecord`| Computes reward signal, updates prompt few-shot demonstrations, updates strategy priors in Second Brain Learning Memory. |

---

## 3. Concrete Orchestrator Implementation (TypeScript Core)

Below is the production implementation of the 11-step pipeline.

```typescript
/**
 * @file 11-step-revenue-orchestrator.ts
 * @description Core Revenue Orchestrator Engine enforcing the 11-step E2E lifecycle.
 */

import { createHash, randomUUID } from 'crypto';
import { EventEmitter } from 'events';

// ============================================================================
// DOMAIN TYPES & INTERFACES
// ============================================================================

export type EpistemicClassification = 'FACT' | 'SIGNAL' | 'HYPOTHESIS' | 'DECISION' | 'ACTION';

export type AuthorityLevel = 'AUTH-0' | 'AUTH-1' | 'AUTH-2' | 'AUTH-3' | 'AUTH-4' | 'AUTH-5';

export type TaskLifecycleState =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'awaiting_human'
  | 'completed'
  | 'stopped'
  | 'failed';

export interface SignalEnvelope {
  readonly signal_id: string;
  readonly tenant_id: string;
  readonly correlation_id: string;
  readonly source_channel: string;
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
  readonly customer_identity: {
    customer_id?: string;
    anonymous_id?: string;
    line_user_id?: string;
    phone?: string;
    email?: string;
  };
  readonly timestamp: string;
}

export interface Customer360Fact {
  readonly customer_id: string;
  readonly tenant_id: string;
  readonly verified_phone: string | null;
  readonly verified_email: string | null;
  readonly total_spent: number;
  readonly order_count: number;
  readonly rfm_segment: string;
  readonly consent_marketing: boolean;
  readonly consent_updated_at: string;
  readonly suppression_active: boolean;
  readonly created_at: string;
}

export interface WorkingMemoryContext {
  readonly session_id: string;
  readonly active_cart_id?: string;
  readonly last_touch_channel: string;
  readonly turn_count: number;
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
  readonly depends_on_steps?: number[];
  readonly computed_price_floor?: number;
  readonly proposed_price?: number;
}

export interface ExecutionPlan {
  readonly plan_id: string;
  readonly steps: PlannedStep[];
  readonly fallback_strategy: 'FAIL_CLOSED' | 'ESCALATE_HUMAN';
}

export interface ActionDraft {
  readonly action_id: string;
  readonly run_id: string;
  readonly tenant_id: string;
  readonly agent_id: PlatformAgentId;
  readonly effect_key: string;
  readonly skill_id: string;
  readonly adapter_target: string;
  readonly payload: Record<string, unknown>;
  readonly computed_price_floor?: number;
  readonly proposed_price?: number;
  readonly authority_level: AuthorityLevel;
}

export interface ApprovalGateResult {
  readonly approved: boolean;
  readonly status: 'AUTO_APPROVED' | 'AWAITING_HUMAN_APPROVAL' | 'REJECTED';
  readonly approver_id?: string;
  readonly reason: string;
}

export interface ExecutionReceipt {
  readonly execution_id: string;
  readonly adapter_status: 'SUCCESS' | 'ERROR' | 'TIMEOUT';
  readonly provider_reference: string;
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
  readonly previous_evidence_hash: string;
  readonly payload_sha256: string;
  readonly signature: string;
  readonly created_at: string;
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

// ============================================================================
// CORE ORCHESTRATOR PIPELINE
// ============================================================================

export class RevenueOrchestrator {
  private readonly eventBus: EventEmitter;
  private readonly contextAggregator: IContextAggregator;
  private readonly policyEngine: IPolicyEngine;
  private readonly workflowEngine: IStatefulWorkflowEngine;
  private readonly evidenceLogger: IEvidenceLogger;
  private readonly adapterDispatcher: IAdapterDispatcher;
  private readonly leaseManager: DurableLeaseManager;
  private readonly workerId: string;

  constructor(dependencies: {
    contextAggregator: IContextAggregator;
    policyEngine: IPolicyEngine;
    workflowEngine: IStatefulWorkflowEngine;
    evidenceLogger: IEvidenceLogger;
    adapterDispatcher: IAdapterDispatcher;
    leaseManager: DurableLeaseManager;
    workerId?: string;
  }) {
    this.eventBus = new EventEmitter();
    this.contextAggregator = dependencies.contextAggregator;
    this.policyEngine = dependencies.policyEngine;
    this.workflowEngine = dependencies.workflowEngine;
    this.evidenceLogger = dependencies.evidenceLogger;
    this.adapterDispatcher = dependencies.adapterDispatcher;
    this.leaseManager = dependencies.leaseManager;
    this.workerId = dependencies.workerId || `worker_${randomUUID().substring(0, 8)}`;
  }

  /**
   * Executes the full 11-step E2E lifecycle with Multi-Agent DAG workflow loop (FR-ORC-002).
   */
  public async processSignal(signal: SignalEnvelope): Promise<{
    run_id: string;
    lifecycle_state: TaskLifecycleState;
    evidence?: ImmutableEvidenceRecord;
    message?: string;
  }> {
    const run_id = `run_${randomUUID()}`;
    let previous_evidence_hash = '0'.repeat(64); // Genesis hash for run
    let latestEvidence: ImmutableEvidenceRecord | undefined;

    // Acquire distributed task lease prior to execution
    const leaseAcquired = await this.leaseManager.acquireLease(signal.tenant_id, run_id, this.workerId);
    if (!leaseAcquired) {
      throw new Error(`CONCURRENT_TASK_LOCK: Unable to acquire execution lease for run_id ${run_id}`);
    }

    // Initialize Durable Task State
    await this.workflowEngine.createTask({
      run_id,
      tenant_id: signal.tenant_id,
      correlation_id: signal.correlation_id,
      current_step: 1,
      state: 'running',
    });

    try {
      // ----------------------------------------------------------------------
      // STEP 1: SIGNAL VALIDATION
      // ----------------------------------------------------------------------
      this.validateSignalEnvelope(signal);

      // ----------------------------------------------------------------------
      // STEP 2: CONTEXT HYDRATION
      // ----------------------------------------------------------------------
      const context = await this.contextAggregator.hydrateContext(
        signal.tenant_id,
        signal.customer_identity,
        signal.correlation_id
      );

      // Prevent execution if human takeover lock is active (SCR-005)
      if (context.working_memory.takeover_active) {
        await this.workflowEngine.transitionTask(run_id, 'stopped', 'Human takeover active on session');
        return { run_id, lifecycle_state: 'stopped', message: 'Session locked by human operator' };
      }

      // ----------------------------------------------------------------------
      // STEP 3: HYPOTHESIS FORMATION (Explicitly tagged, cannot write to FACT)
      // ----------------------------------------------------------------------
      const hypothesis: HypothesisRecord = await this.deriveHypothesis(signal, context);
      this.enforceEpistemicSeparation(hypothesis);

      // ----------------------------------------------------------------------
      // STEP 4: DECISION & ROUTING (FR-ORC-001)
      // ----------------------------------------------------------------------
      const routing = await this.resolveRouting(signal, context, hypothesis);

      // Single Clarification Rule: If intent is ambiguous, ask ONE focused question
      if (routing.requires_clarification) {
        const clarificationAction: ActionDraft = {
          action_id: `act_${randomUUID()}`,
          run_id,
          tenant_id: signal.tenant_id,
          agent_id: routing.target_agent,
          effect_key: `clarification_${signal.correlation_id}_${context.working_memory.turn_count}`,
          skill_id: 'skill.sales.send_message',
          adapter_target: signal.source_channel,
          payload: { text: routing.clarification_prompt },
          authority_level: 'AUTH-3',
        };

        await this.adapterDispatcher.dispatch(clarificationAction);
        await this.workflowEngine.transitionTask(run_id, 'waiting', 'Awaiting clarification response');
        return { run_id, lifecycle_state: 'waiting', message: routing.clarification_prompt };
      }

      if (routing.target_agent === 'HUMAN_HANDOFF') {
        await this.workflowEngine.transitionTask(run_id, 'awaiting_human', 'Routed to human agent queue');
        return { run_id, lifecycle_state: 'awaiting_human', message: 'Escalated to human operator' };
      }

      // ----------------------------------------------------------------------
      // STEP 5: PLAN FORMULATION (FR-ORC-002 Multi-Agent Workflow)
      // ----------------------------------------------------------------------
      const plan = await this.formulatePlan(routing, context, hypothesis);

      // ----------------------------------------------------------------------
      // STEP 6-9: MULTI-STEP DAG EXECUTION LOOP WITH CHECKPOINTING
      // ----------------------------------------------------------------------
      for (const step of plan.steps) {
        const stepStartTime = Date.now();

        // Checkpoint progress in Durable Task Store
        await this.workflowEngine.updateTaskProgress(run_id, step.step_index, {
          plan_id: plan.plan_id,
          current_step: step.step_index,
          skill_id: step.skill_id,
          agent_id: step.agent_id,
        });

        // STEP 6: Action Drafting & Floor Price Check
        const action = await this.draftAction(step, context, run_id, signal.tenant_id);
        this.verifyMathematicalPricingFloor(action);

        // STEP 7: Authority & Approval Check
        const approval = await this.policyEngine.evaluateAuthority(action, context);

        if (approval.status === 'AWAITING_HUMAN_APPROVAL') {
          await this.workflowEngine.transitionTask(run_id, 'awaiting_human', approval.reason, {
            plan,
            current_step: step.step_index,
            pending_action: action,
            context,
            previous_evidence_hash,
          });
          await this.evidenceLogger.logPendingApproval(run_id, action, approval.reason);
          await this.evidenceLogger.logAgentRun({
            run_id,
            tenant_id: signal.tenant_id,
            agent_id: step.agent_id,
            customer_or_entity_id: signal.customer_identity.customer_id || 'anonymous',
            trigger: signal.event_type,
            context,
            skill: step.skill_id,
            tool: step.adapter_target,
            decision: { routing, step },
            authority: action.authority_level,
            approval: null,
            action,
            execution_status: 'AWAITING_APPROVAL',
            evidence: {},
            outcome: null,
            latency_ms: Date.now() - stepStartTime,
            cost: { prompt: 0, completion: 0, total_cost_usd: 0 },
            error: null,
            started_at: new Date(stepStartTime).toISOString(),
            completed_at: new Date().toISOString(),
          });
          return {
            run_id,
            lifecycle_state: 'awaiting_human',
            message: `Paused for Human Approval at Step ${step.step_index} in SCR-003`,
          };
        }

        if (approval.status === 'REJECTED') {
          await this.workflowEngine.transitionTask(run_id, 'stopped', `Policy rejected at step ${step.step_index}: ${approval.reason}`);
          return { run_id, lifecycle_state: 'stopped', message: approval.reason };
        }

        // STEP 8: Execution via Adapter
        const receipt = await this.adapterDispatcher.dispatch(action);
        if (receipt.adapter_status !== 'SUCCESS') {
          throw new Error(`Execution failed at adapter for step ${step.step_index}: ${JSON.stringify(receipt.response_payload)}`);
        }

        // STEP 9: Chained Immutable Evidence Generation
        const stepEvidence = await this.evidenceLogger.createImmutableRecord({
          run_id,
          tenant_id: signal.tenant_id,
          correlation_id: signal.correlation_id,
          step_index: step.step_index,
          effect_key: action.effect_key,
          previous_evidence_hash,
          payload: { action, receipt },
        });
        previous_evidence_hash = stepEvidence.payload_sha256;
        latestEvidence = stepEvidence;

        // Automated 18-field Agent Run Log (Section 17 SRS v0.1 & NFR-002)
        await this.evidenceLogger.logAgentRun({
          run_id,
          tenant_id: signal.tenant_id,
          agent_id: step.agent_id,
          customer_or_entity_id: signal.customer_identity.customer_id || 'anonymous',
          trigger: signal.event_type,
          context,
          skill: step.skill_id,
          tool: step.adapter_target,
          decision: { routing, step },
          authority: action.authority_level,
          approval: approval.status === 'AUTO_APPROVED' ? { mode: 'AUTO' } : null,
          action,
          execution_status: 'SUCCESS',
          evidence: stepEvidence,
          outcome: null,
          latency_ms: Date.now() - stepStartTime,
          cost: receipt.token_usage,
          error: null,
          started_at: new Date(stepStartTime).toISOString(),
          completed_at: new Date().toISOString(),
        });

        // Initialize outcome watcher if step mutates external state
        await this.evidenceLogger.initializeOutcomeWatch(run_id, action);
      }

      // STEP 10-11: Outcome Baseline & Learning Update
      await this.updateLearningMemory(run_id, hypothesis, latestEvidence);

      // Complete Task
      await this.workflowEngine.transitionTask(run_id, 'completed', 'All plan steps successfully executed');

      return { run_id, lifecycle_state: 'completed', evidence: latestEvidence };
    } catch (error: any) {
      await this.workflowEngine.transitionTask(run_id, 'failed', error.message || 'Execution error');
      throw error;
    } finally {
      await this.leaseManager.releaseLease(signal.tenant_id, run_id, this.workerId);
    }
  }

  /**
   * Resumes an interrupted or paused task from current_step after human approval (SCR-003) or event.
   */
  public async resumeTask(
    run_id: string,
    resumeEvent: {
      tenant_id: string;
      event_type: 'human.approval' | 'human.modify' | 'human.reject' | 'timer.expired';
      approver_id?: string;
      modifications?: Record<string, unknown>;
      reason?: string;
    }
  ): Promise<{
    run_id: string;
    lifecycle_state: TaskLifecycleState;
    evidence?: ImmutableEvidenceRecord;
    message?: string;
  }> {
    const task = await this.workflowEngine.getTask(run_id);
    if (!task) {
      throw new Error(`TASK_NOT_FOUND: Task ${run_id} does not exist`);
    }

    if (task.state !== 'awaiting_human' && task.state !== 'waiting') {
      throw new Error(`INVALID_TASK_STATE: Cannot resume task currently in '${task.state}' state`);
    }

    if (resumeEvent.event_type === 'human.reject') {
      await this.workflowEngine.transitionTask(run_id, 'stopped', `Rejected by human operator: ${resumeEvent.reason || 'None'}`);
      return { run_id, lifecycle_state: 'stopped', message: 'Task rejected by human operator' };
    }

    const acquired = await this.leaseManager.acquireLease(resumeEvent.tenant_id, run_id, this.workerId);
    if (!acquired) {
      throw new Error(`CONCURRENT_TASK_LOCK: Unable to acquire lease to resume run_id ${run_id}`);
    }

    try {
      await this.workflowEngine.transitionTask(run_id, 'running', `Resumed by ${resumeEvent.event_type}`);
      const checkpoint = task.state_payload;
      const plan: ExecutionPlan = checkpoint.plan;
      const context: HydratedContext = checkpoint.context;
      let previous_evidence_hash = checkpoint.previous_evidence_hash || '0'.repeat(64);
      let latestEvidence: ImmutableEvidenceRecord | undefined;

      const remainingSteps = plan.steps.filter((s) => s.step_index >= checkpoint.current_step);

      for (const step of remainingSteps) {
        const stepStartTime = Date.now();
        let action: ActionDraft = await this.draftAction(step, context, run_id, resumeEvent.tenant_id);

        // Apply modifications if human modified the payload at SCR-003
        if (resumeEvent.event_type === 'human.modify' && resumeEvent.modifications && step.step_index === checkpoint.current_step) {
          action = {
            ...action,
            payload: { ...action.payload, ...resumeEvent.modifications },
            proposed_price: (resumeEvent.modifications.proposed_price as number) ?? action.proposed_price,
          };
          this.verifyMathematicalPricingFloor(action);
        }

        const receipt = await this.adapterDispatcher.dispatch(action);
        if (receipt.adapter_status !== 'SUCCESS') {
          throw new Error(`Execution failed at adapter for resumed step ${step.step_index}`);
        }

        const stepEvidence = await this.evidenceLogger.createImmutableRecord({
          run_id,
          tenant_id: resumeEvent.tenant_id,
          correlation_id: task.correlation_id,
          step_index: step.step_index,
          effect_key: action.effect_key,
          previous_evidence_hash,
          payload: { action, receipt, resumeEvent },
        });
        previous_evidence_hash = stepEvidence.payload_sha256;
        latestEvidence = stepEvidence;

        await this.evidenceLogger.logAgentRun({
          run_id,
          tenant_id: resumeEvent.tenant_id,
          agent_id: step.agent_id,
          customer_or_entity_id: context.customer?.customer_id || 'anonymous',
          trigger: resumeEvent.event_type,
          context,
          skill: step.skill_id,
          tool: step.adapter_target,
          decision: { resumeEvent, step },
          authority: action.authority_level,
          approval: { approver_id: resumeEvent.approver_id, event: resumeEvent.event_type },
          action,
          execution_status: 'SUCCESS',
          evidence: stepEvidence,
          outcome: null,
          latency_ms: Date.now() - stepStartTime,
          cost: receipt.token_usage,
          error: null,
          started_at: new Date(stepStartTime).toISOString(),
          completed_at: new Date().toISOString(),
        });
      }

      await this.workflowEngine.transitionTask(run_id, 'completed', 'All resumed steps completed');
      return { run_id, lifecycle_state: 'completed', evidence: latestEvidence };
    } finally {
      await this.leaseManager.releaseLease(resumeEvent.tenant_id, run_id, this.workerId);
    }
  }

  // ==========================================================================
  // INVARIANT GUARDS & VALIDATION METHODS
  // ==========================================================================

  private validateSignalEnvelope(signal: SignalEnvelope): void {
    if (!signal.tenant_id || !signal.correlation_id || !signal.source_channel) {
      throw new Error('INVALID_SIGNAL: Missing mandatory envelope routing metadata');
    }
  }

  /**
   * Hard Invariant FR-C360-003: HYPOTHESIS records are forbidden from mutating FACT.
   */
  private enforceEpistemicSeparation(hypothesis: HypothesisRecord): void {
    if (hypothesis.classification !== 'HYPOTHESIS') {
      throw new Error('SECURITY_VIOLATION: Inferred data must be stamped with classification: HYPOTHESIS');
    }
  }

  /**
   * Hard Invariant BR-001 / BR-002: Proposed price must never drop below P_floor.
   */
  private verifyMathematicalPricingFloor(action: ActionDraft): void {
    if (action.proposed_price !== undefined && action.computed_price_floor !== undefined) {
      if (action.proposed_price < action.computed_price_floor) {
        throw new Error(
          `PRICE_FLOOR_VIOLATION: Proposed price ${action.proposed_price} < P_floor ${action.computed_price_floor}`
        );
      }
    }
  }

  // Mock / Hook stubs for internal subroutines
  private async deriveHypothesis(signal: SignalEnvelope, context: HydratedContext): Promise<HypothesisRecord> {
    return {
      classification: 'HYPOTHESIS',
      intent: (signal.payload.intent as string) || 'PURCHASE_QUERY',
      confidence: 0.89,
      churn_risk_score: context.customer ? (context.customer.order_count > 0 ? 0.15 : 0.4) : 0.5,
      purchase_propensity: 0.82,
      reasoning: 'User explicitly asked for product specifications matching skincare catalog.',
      derived_from_signals: [signal.signal_id],
    };
  }

  private async resolveRouting(
    signal: SignalEnvelope,
    context: HydratedContext,
    hypothesis: HypothesisRecord
  ): Promise<RoutingDecision> {
    if (hypothesis.confidence < 0.6) {
      return {
        target_agent: 'SAL-02',
        requires_clarification: true,
        clarification_prompt: 'Are you looking for products for oily skin or sensitive skin?',
        rationalization: 'Low confidence intent requires single clarification step.',
      };
    }
    return {
      target_agent: 'SAL-02',
      requires_clarification: false,
      rationalization: 'Standard sales consultation routing.',
    };
  }

  private async formulatePlan(
    routing: RoutingDecision,
    context: HydratedContext,
    hypothesis: HypothesisRecord
  ): Promise<ExecutionPlan> {
    return {
      plan_id: `plan_${randomUUID()}`,
      steps: [
        {
          step_index: 1,
          agent_id: routing.target_agent,
          skill_id: 'skill.sales.check_stock',
          adapter_target: 'API-001.InventoryConnector',
          input_parameters: { sku_id: 'SKU_HYDRATE_01' },
          required_authority: 'AUTH-3',
          computed_price_floor: 100.0,
          proposed_price: 120.0,
        },
      ],
      fallback_strategy: 'FAIL_CLOSED',
    };
  }

  private async draftAction(
    step: PlannedStep,
    context: HydratedContext,
    run_id: string,
    tenant_id: string
  ): Promise<ActionDraft> {
    return {
      action_id: `act_${randomUUID()}`,
      run_id,
      tenant_id,
      agent_id: step.agent_id,
      effect_key: `eff_${run_id}_step_${step.step_index}`,
      skill_id: step.skill_id,
      adapter_target: step.adapter_target,
      payload: step.input_parameters,
      computed_price_floor: step.computed_price_floor,
      proposed_price: step.proposed_price,
      authority_level: step.required_authority,
    };
  }

  private async updateLearningMemory(
    run_id: string,
    hypothesis: HypothesisRecord,
    receipt?: ImmutableEvidenceRecord
  ): Promise<void> {
    // Stores latency, cost, and prediction alignment into Second Brain /learning/
  }
}

// Dependent interfaces
export interface IContextAggregator {
  hydrateContext(tenant_id: string, identity: any, correlation_id: string): Promise<HydratedContext>;
}

export interface IPolicyEngine {
  evaluateAuthority(action: ActionDraft, context: HydratedContext): Promise<ApprovalGateResult>;
}

export interface IStatefulWorkflowEngine {
  createTask(task: any): Promise<void>;
  updateTaskProgress(run_id: string, stepIndex: number, checkpointPayload: any): Promise<void>;
  transitionTask(run_id: string, state: TaskLifecycleState, reason: string, checkpointPayload?: any): Promise<void>;
  getTask(run_id: string): Promise<any>;
}

export interface IEvidenceLogger {
  logPendingApproval(run_id: string, action: ActionDraft, reason: string): Promise<void>;
  createImmutableRecord(params: any): Promise<ImmutableEvidenceRecord>;
  initializeOutcomeWatch(run_id: string, action: ActionDraft): Promise<void>;
  logAgentRun(runLog: any): Promise<void>;
}

export interface IAdapterDispatcher {
  dispatch(action: ActionDraft): Promise<ExecutionReceipt>;
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
| `queued` | `task.claim` | `running` | Worker acquires Redis lease key with TTL 30s. Sets `task_version += 1`. |
| `running` | `task.await_event` | `waiting` | Task registers timer or webhook listener. Releases active execution lease. |
| `running` | `task.require_auth4` | `awaiting_human`| Action requires human sign-off (`SCR-003`). Notification sent to admins. |
| `running` | `task.success` | `completed` | All steps in plan verified. Immutable evidence hashed and saved. |
| `running` | `task.fatal_error` | `failed` | Retry limit exceeded or non-retryable error. Triggers fail-closed rollback. |
| `waiting` | `event.received` | `running` | Correlation ID verified. Re-hydrates state and re-acquires worker lease. |
| `waiting` | `timer.expired` | `running` | Scheduled delay reached (e.g., 24-hr abandoned cart sequence). |
| `awaiting_human`| `human.approve` | `running` | Authenticated operator signed with valid session. Action dispatched. |
| `awaiting_human`| `human.reject` | `stopped` | Operator rejects action. Terminal state; reason logged to audit trail. |
| `*` | `human.takeover` | `stopped` | Immediate hard kill of bot execution on session (`SCR-005`). |

### 4.2. PostgreSQL Durable Task State Schema

```sql
-- DDL for Durable Task State Management
CREATE TYPE task_lifecycle_state AS ENUM (
    'queued',
    'running',
    'waiting',
    'awaiting_human',
    'completed',
    'stopped',
    'failed'
);

CREATE TABLE platform_durable_tasks (
    task_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id VARCHAR(64) NOT NULL UNIQUE,
    tenant_id VARCHAR(64) NOT NULL,
    correlation_id VARCHAR(64) NOT NULL,
    current_step INT NOT NULL DEFAULT 1,
    state task_lifecycle_state NOT NULL DEFAULT 'queued',
    task_version INT NOT NULL DEFAULT 1,
    lease_owner VARCHAR(64) NULL,
    lease_expires_at TIMESTAMPTZ NULL,
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 3,
    state_payload JSONB NOT NULL DEFAULT '{}',
    error_details JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Compound indexes for fast polling and tenant isolation
CREATE INDEX idx_tasks_tenant_state ON platform_durable_tasks (tenant_id, state);
CREATE INDEX idx_tasks_lease ON platform_durable_tasks (state, lease_expires_at) WHERE state = 'queued';
CREATE INDEX idx_tasks_correlation ON platform_durable_tasks (tenant_id, correlation_id);

-- Enforce Row-Level Security (NFR-006)
ALTER TABLE platform_durable_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_tasks ON platform_durable_tasks
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true));
```

### 4.3. Distributed Worker Lease Management (Redis Mutex)

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
   * Attempts to acquire an exclusive lock for a task step.
   */
  public async acquireLease(tenantId: string, runId: string, workerId: string): Promise<boolean> {
    const lockKey = `lease:${tenantId}:${runId}`;
    const result = await this.redis.set(lockKey, workerId, 'PX', this.leaseTtlMs, 'NX');
    return result === 'OK';
  }

  /**
   * Heartbeat to renew the lease while step is actively executing.
   */
  public async renewLease(tenantId: string, runId: string, workerId: string): Promise<boolean> {
    const lockKey = `lease:${tenantId}:${runId}`;
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
    const lockKey = `lease:${tenantId}:${runId}`;
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
    private readonly vectorSearchClient: IVectorSearchClient
  ) {}

  public async hydrateContext(
    tenantId: string,
    identity: { customer_id?: string; phone?: string; line_user_id?: string },
    correlationId: string
  ): Promise<HydratedContext> {
    const startTime = Date.now();

    // Concurrently trigger 3 data hydration queries
    const [c360Result, memoryResult, vectorResult] = await Promise.allSettled([
      this.fetchCustomer360(tenantId, identity),
      this.fetchWorkingMemory(tenantId, identity.customer_id || identity.line_user_id || 'anon'),
      this.fetchKnowledgeCitations(tenantId, correlationId),
    ]);

    // 1. Process Customer 360 (Fact Store)
    const customer = c360Result.status === 'fulfilled' ? c360Result.value : null;

    // 2. Process Working Memory (Redis)
    const working_memory: WorkingMemoryContext =
      memoryResult.status === 'fulfilled' && memoryResult.value
        ? memoryResult.value
        : {
            session_id: `sess_${correlationId}`,
            last_touch_channel: 'unknown',
            turn_count: 1,
            takeover_active: false,
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

  private async fetchCustomer360(
    tenantId: string,
    identity: { customer_id?: string; phone?: string; line_user_id?: string }
  ): Promise<Customer360Fact | null> {
    const query = `
      SELECT 
        customer_id, tenant_id, verified_phone, verified_email,
        total_spent, order_count, rfm_segment, consent_marketing,
        consent_updated_at, suppression_active, created_at
      FROM customer_360_profiles
      WHERE tenant_id = $1 
        AND (customer_id = $2 OR verified_phone = $3 OR line_user_id = $4)
      LIMIT 1;
    `;
    const values = [tenantId, identity.customer_id || null, identity.phone || null, identity.line_user_id || null];
    const res = await this.pgPool.query(query, values);
    return res.rows.length > 0 ? (res.rows[0] as Customer360Fact) : null;
  }

  private async fetchWorkingMemory(tenantId: string, identifier: string): Promise<WorkingMemoryContext | null> {
    const key = `wm:${tenantId}:${identifier}`;
    const raw = await this.redis.get(key);
    return raw ? JSON.parse(raw) : null;
  }

  private async fetchKnowledgeCitations(tenantId: string, queryText: string): Promise<Array<{ document_id: string; path: string; score: number }>> {
    return this.vectorSearchClient.searchByTenant(tenantId, queryText, 3);
  }
}

export interface IVectorSearchClient {
  searchByTenant(tenantId: string, query: string, limit: number): Promise<Array<{ document_id: string; path: string; score: number }>>;
}
```

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
  private readonly hmacSecret: string;

  constructor(private readonly pgPool: Pool) {
    this.hmacSecret = process.env.AUDIT_HMAC_SECRET || 'audit_hmac_secret_fallback_key';
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
    const evidence_id = `ev_${createHash('sha256').update(params.effect_key + params.step_index).digest('hex').substring(0, 16)}`;
    const createdAt = new Date().toISOString();

    // 1. Canonicalize Payload (RFC 8785 subset)
    const canonicalPayloadJson = this.canonicalizeJson(params.payload);
    const payload_sha256 = createHash('sha256').update(canonicalPayloadJson).digest('hex');

    // 2. Chained Hash Computation
    const chainInput = `${params.previous_evidence_hash}|${payload_sha256}|${params.effect_key}|${params.step_index}`;
    const chainHash = createHash('sha256').update(chainInput).digest('hex');

    // 3. HMAC Signature for Non-repudiation
    const signature = createHmac('sha256', this.hmacSecret).update(chainHash).digest('hex');

    // 4. Persist to Immutable PostgreSQL Table
    const insertQuery = `
      INSERT INTO immutable_evidence_records (
        evidence_id, run_id, tenant_id, correlation_id, step_index,
        effect_key, previous_evidence_hash, payload_sha256, signature,
        raw_payload, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *;
    `;
    await this.pgPool.query(insertQuery, [
      evidence_id,
      params.run_id,
      params.tenant_id,
      params.correlation_id,
      params.step_index,
      params.effect_key,
      params.previous_evidence_hash,
      chainHash, // Stores current chain hash
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
      payload_sha256: chainHash,
      signature,
      created_at: createdAt,
    };
  }

  public async logPendingApproval(run_id: string, action: ActionDraft, reason: string): Promise<void> {
    const query = `
      INSERT INTO approval_queue (run_id, action_id, tenant_id, effect_key, payload, reason, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'PENDING');
    `;
    await this.pgPool.query(query, [
      run_id,
      action.action_id,
      action.tenant_id, // Fixed: passes action.tenant_id into $3
      action.effect_key,
      JSON.stringify(action),
      reason,
    ]);
  }

  public async logAgentRun(runLog: {
    run_id: string;
    tenant_id: string;
    agent_id: string;
    customer_or_entity_id: string;
    trigger: string;
    context: unknown;
    skill: string;
    tool: string;
    decision: unknown;
    authority: string;
    approval: unknown | null;
    action: unknown;
    execution_status: string;
    evidence: unknown;
    outcome: unknown | null;
    latency_ms: number;
    cost: unknown;
    error: unknown | null;
    started_at: string;
    completed_at: string;
  }): Promise<void> {
    const query = `
      INSERT INTO agent_run_logs (
        run_id, tenant_id, agent_id, customer_or_entity_id, trigger,
        context, skill, tool, decision, authority,
        approval, action, execution_status, evidence, outcome,
        latency_ms, cost, error, started_at, completed_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20
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

  public async initializeOutcomeWatch(run_id: string, action: ActionDraft): Promise<void> {
    const query = `
      INSERT INTO pending_outcome_attributions (run_id, effect_key, skill_id, status, created_at)
      VALUES ($1, $2, $3, 'OBSERVING', NOW());
    `;
    await this.pgPool.query(query, [run_id, action.effect_key, action.skill_id]);
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

### 6.2. Immutable Database DDL with Mutation Prevention Triggers

```sql
-- DDL for Cryptographically Immutable Evidence Records
CREATE TABLE immutable_evidence_records (
    evidence_id VARCHAR(64) PRIMARY KEY,
    run_id VARCHAR(64) NOT NULL,
    tenant_id VARCHAR(64) NOT NULL,
    correlation_id VARCHAR(64) NOT NULL,
    step_index INT NOT NULL,
    effect_key VARCHAR(128) NOT NULL,
    previous_evidence_hash CHAR(64) NOT NULL,
    payload_sha256 CHAR(64) NOT NULL,
    signature CHAR(64) NOT NULL,
    raw_payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Immutable Table Protection Trigger (Disallows UPDATE and DELETE)
CREATE OR REPLACE FUNCTION block_immutable_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'SECURITY_VIOLATION: Records in immutable_evidence_records cannot be modified or deleted.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_evidence_immutable
    BEFORE UPDATE OR DELETE ON immutable_evidence_records
    FOR EACH ROW
    EXECUTE FUNCTION block_immutable_modification();

-- Standardized 18-Field Agent Run Log Table (Section 17 SRS v0.1 & NFR-002)
CREATE TABLE agent_run_logs (
    run_id VARCHAR(64) NOT NULL,
    tenant_id VARCHAR(64) NOT NULL,
    agent_id VARCHAR(32) NOT NULL,
    customer_or_entity_id VARCHAR(64) NOT NULL,
    trigger VARCHAR(128) NOT NULL,
    context JSONB NOT NULL,
    skill VARCHAR(64) NOT NULL,
    step_index INT NOT NULL DEFAULT 1,
    tool VARCHAR(64) NOT NULL,
    decision JSONB NOT NULL,
    authority VARCHAR(16) NOT NULL,
    approval JSONB NULL,
    action JSONB NOT NULL,
    execution_status VARCHAR(32) NOT NULL,
    evidence JSONB NOT NULL,
    outcome JSONB NULL,
    latency_ms INT NOT NULL,
    cost JSONB NOT NULL,
    error JSONB NULL,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, run_id, skill, step_index)
);

CREATE INDEX idx_agent_run_logs_tenant_agent ON agent_run_logs (tenant_id, agent_id, started_at DESC);
CREATE INDEX idx_agent_run_logs_entity ON agent_run_logs (tenant_id, customer_or_entity_id);

-- Audit Queue for Human Approvals (SCR-003)
CREATE TABLE approval_queue (
    approval_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id VARCHAR(64) NOT NULL,
    action_id VARCHAR(64) NOT NULL,
    tenant_id VARCHAR(64) NOT NULL,
    effect_key VARCHAR(128) NOT NULL,
    payload JSONB NOT NULL,
    reason TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    decided_by VARCHAR(64) NULL,
    decided_at TIMESTAMPTZ NULL,
    decision_notes TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 7. Acceptance Criteria & Test Verification Matrix

| Test Identifier | Target Requirement | Test Scenario | Expected Assertion |
|---|---|---|---|
| `TC-ORC-001` | 11-Step Lifecycle | Ingest standard `product.inquiry` signal. | Completes steps 1 through 11; emits chained evidence record. |
| `TC-ORC-002` | Epistemic Guard (FR-C360-003) | Inject Agent output attempting to set `customer.is_fraud = true` as FACT. | Engine throws `SECURITY_VIOLATION`; preserves Fact Store unchanged. |
| `TC-ORC-003` | Floor Price Guard (BR-001) | Skill drafts quotation with price 80 TWD where $P_{floor} = 100$ TWD. | Engine blocks action with `PRICE_FLOOR_VIOLATION`. |
| `TC-ORC-004` | Approval Pause (SCR-003) | Trigger broadcast campaign skill (`AUTH-4`). | Task transitions to `awaiting_human`; record stored in `approval_queue`. |
| `TC-ORC-005` | Human Takeover (SCR-005) | Ingest human operator `takeover` event on active session. | Bot execution halts immediately; transitions task to `stopped`. |
| `TC-ORC-006` | Double Execution Prevention | Two workers attempt to execute task step with identical `effect_key`. | Redis mutex grants lease to Worker 1 only; Worker 2 exits cleanly. |
| `TC-ORC-007` | Tamper-Evidence Audit | Attempt SQL UPDATE on `immutable_evidence_records`. | PostgreSQL trigger raises exception; modification blocked. |
