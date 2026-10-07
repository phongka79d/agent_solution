/**
 * @file The guarded run engine (implement/04 §3.3, §8): one orchestrator owns routing and the
 * eleven-stage lifecycle.
 *
 * `processSignal` and `resumeTask` drive the SAME guarded step engine, so a first pass, a retry and
 * a resumed run re-apply the identical guard order — draft, floor, authority, reservation,
 * dispatch, evidence — and a claimed AUTH-4 approval satisfies only its own pause, never a
 * clearance. Agents never call agents: this class holds no peer-invoke method, and a routing
 * decision crosses between agents only through `assertOrchestratorBrokered()`.
 *
 * Stage journaling (§8.4): a stage is entered only when the run actually reaches it. A step that
 * pauses at APPROVAL (AUTH-4), is denied (AUTH-5 or insufficient rank), parks before dispatch or
 * has an in-flight reservation never records EXECUTION. The execution-stage record is persisted
 * immediately before an admitted adapter attempt, and a plan that produced no evidence never
 * records OUTCOME or LEARNING.
 *
 * Adaptations from the blueprint snippet, per the locked contract: dependency types come from
 * `contracts/ports.ts` (including the fenced `leaseManager` port); `getTask()` narrows
 * `state_payload` to `DurableTaskCheckpoint | null`; the stage journal is threaded through both
 * entry points and exposed as `visitedStages`; the blueprint's private `EventEmitter` field is
 * dropped because it had no emitter and `noUnusedLocals` rejects an assigned-but-never-read
 * private member.
 */

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';

import {
  GENESIS_HASH,
  OrchestratorError,
  assertHandoffSourceDomain,
  type ActionDraft,
  type AgentRunLogRecord,
  type AuthorityLevel,
  type CrossDomainHandoffDraft,
  type DurableTaskCheckpoint,
  type ExecutionPlan,
  type ExecutionReceipt,
  type ExecutionStatus,
  type FinalResponse,
  type HandoffAdmission,
  type HydratedContext,
  type HypothesisRecord,
  type ImmutableEvidenceRecord,
  type OrchestratorRunResult,
  type PlannedStep,
  type RetryClass,
  type RoutingDecision,
  type SignalEnvelope,
  type VerifiedStepReceipt,
} from '../contracts/index.js';
import type {
  DurableLeaseManager,
  IAdapterDispatcher,
  IAgentRuntime,
  IAuditTrail,
  IContextAggregator,
  ICrossDomainHandoffBroker,
  IEffectGuard,
  IEvidenceLogger,
  IPlanInputResolver,
  IPolicyEngine,
  IResponseFinalizer,
  IRunResponseStore,
  IRunStageRecorder,
  ISessionControl,
  IStatefulWorkflowEngine,
} from '../contracts/index.js';
import { canonicalizeJson, sha256CanonicalJson } from '../durability/canonical-json.js';
import { StageJournal, type LifecycleStage } from '../lifecycle/stages.js';
import { assertOrchestratorBrokered } from './agent-boundary.js';
import {
  classifyFailure,
  enforceEpistemicSeparation,
  floorMirrors,
  isPlainJsonObject,
  nextStepCursor,
  outcomeFields,
  readCompleteResumeCheckpoint,
  serializeError,
  validatePlanInputBindings,
  validateSignalEnvelope,
  verifyFloorPrice,
  type StepLoopOutcome,
} from './checkpoint-guards.js';
import {
  acquireEffectSlot,
  dispatchWithDeadline,
  reconcileProviderEffect,
  type ReconciledEffect,
} from './effect-reconciliation.js';
import { buildHandoffDraft } from './handoff-coordinator.js';

/** Mutable chain cursor shared across plan steps (previous_evidence_hash threading, §3.1). */
interface EvidenceChain {
  previous: string;
}

/** OTel remains optional at runtime: without an SDK this returns a non-recording span. */
const STAGE_TRACER = trace.getTracer('agentos.orchestrator');

export class RevenueOrchestrator {
  private readonly defaultWorkerId = `worker_${randomUUID().substring(0, 8)}`;
  private journal: StageJournal = new StageJournal();
  private readonly stageContext = new AsyncLocalStorage<StageJournal>();

  constructor(
    private readonly dependencies: {
      contextAggregator: IContextAggregator;
      agentRuntime: IAgentRuntime;
      policyEngine: IPolicyEngine;
      workflowEngine: IStatefulWorkflowEngine;
      evidenceLogger: IEvidenceLogger;
      /**
       * Optional durable stage trace. The in-memory journal remains the synchronous transition
       * guard; this binding receives only stages actually entered by the current attempt.
       */
      runStageRecorder?: IRunStageRecorder;
      /** Required for plans with input_bindings; omitted plans retain the existing path. */
      planInputResolver?: IPlanInputResolver;
      auditTrail: IAuditTrail;
      adapterDispatcher: IAdapterDispatcher;
      effectGuard: IEffectGuard;
      sessionControl: ISessionControl;
      leaseManager: DurableLeaseManager;
      /**
       * The ONLY brokered route between domains (plans/customer-lifecycle.md §3). Optional: a
       * deployment that runs a single domain binds no broker, and a plan that declares a handoff
       * without one refuses rather than completing a journey leg it cannot continue.
       */
      crossDomainHandoff?: ICrossDomainHandoffBroker;
      /**
       * Optional conversational response boundary. When a finalizer is bound, a response store
       * is required and persistence completes before the durable task is marked completed.
       */
      responseFinalizer?: IResponseFinalizer;
      responseStore?: IRunResponseStore;
      workerId?: string;
      /** The authoritative worker lease is rechecked immediately before external dispatch. */
      assertExecutionLease?: (tenant_id: string, run_id: string) => Promise<void>;
    }
  ) {}

  private get workerId(): string {
    return this.dependencies.workerId ?? this.defaultWorkerId;
  }

  /**
   * Enters one stage through the synchronous guard and, when configured, records the same entry
   * durably before the caller can perform a side effect. Recovery reconstruction deliberately
   * bypasses this helper and only mutates the in-memory journal.
   */
  private async enterStage(params: {
    tenant_id: string;
    run_id: string;
    attempt_ordinal: number;
    step_index: number;
    stage: LifecycleStage;
    detail?: unknown;
    evidence_refs?: unknown;
  }): Promise<void> {
    (this.stageContext.getStore() ?? this.journal).enter(params.stage);
    const recorder = this.dependencies.runStageRecorder;
    if (recorder !== undefined) {
      const entered_at = new Date().toISOString();
      await recorder.append({
        tenant_id: params.tenant_id,
        run_id: params.run_id,
        attempt_ordinal: params.attempt_ordinal,
        step_index: params.step_index,
        stage: params.stage,
        entered_at,
        ...(params.detail === undefined ? {} : { detail: params.detail }),
        ...(params.evidence_refs === undefined ? {} : { evidence_refs: params.evidence_refs }),
      });
    }
  }

  private startStageSpan(params: {
    tenant_id: string;
    run_id: string;
    stage: LifecycleStage;
  }): Span {
    return STAGE_TRACER.startSpan(`orchestrator.stage.${params.stage}`, {
      attributes: {
        tenant_id: params.tenant_id,
        run_id: params.run_id,
        stage: params.stage,
      },
    });
  }

  private async runStageSpan<T>(span: Span, operation: () => Promise<T>): Promise<T> {
    try {
      const result = await operation();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      const exception = error instanceof Error ? error : new Error(String(error));
      span.recordException(exception);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  }

  private async traceStage<T>(
    params: {
      tenant_id: string;
      run_id: string;
      attempt_ordinal: number;
      step_index: number;
      stage: LifecycleStage;
      detail?: unknown;
      evidence_refs?: unknown;
    },
    operation: () => Promise<T>,
  ): Promise<T> {
    const span = this.startStageSpan(params);
    try {
      await this.enterStage(params);
    } catch (error) {
      const exception = error instanceof Error ? error : new Error(String(error));
      span.recordException(exception);
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      throw error;
    }
    return this.runStageSpan(span, operation);
  }

  /**
   * Stages actually entered by the most recent run attempt, in entry order (§8.4). A stage is
   * recorded only when the run reaches its guarded boundary; `EXECUTION` means the reservation
   * admitted a provider attempt or replayed a stored receipt, never that a run merely paused or
   * was denied.
   */
  public get visitedStages(): readonly LifecycleStage[] {
    return this.journal.visited;
  }

  /**
   * Executes the full 11-step E2E lifecycle (FR-ORC-002 multi-step DAG included).
   */
  public async processSignal(signal: SignalEnvelope): Promise<OrchestratorRunResult> {
    // A rejected envelope is not a run: the journal is reset before validation and SIGNAL is only
    // entered once the envelope passed it.
    const journal = new StageJournal();
    this.journal = journal;
    this.stageContext.enterWith(journal);

    // STEP 1: SIGNAL VALIDATION — fail closed before any durable write.
    validateSignalEnvelope(signal);

    const request_id = signal.signal_id; // immutable inbound identity (idempotency anchor)
    const run_id = `run_${randomUUID()}`;
    const chain: EvidenceChain = { previous: GENESIS_HASH };

    const leaseAcquired = await this.dependencies.leaseManager.acquireLease(signal.tenant_id, run_id, this.workerId);
    if (!leaseAcquired) {
      throw new OrchestratorError('CONCURRENT_TASK_LOCK', `Unable to acquire execution lease for ${run_id}`);
    }

    let attempt_ordinal = 1;
    try {
      // SIGNAL is the only stage whose durable task does not exist before validation. Create the
      // row first, then enter/record SIGNAL, so a recorder can always bind the event to its run.
      await this.dependencies.workflowEngine.createTask({
        run_id,
        tenant_id: signal.tenant_id,
        correlation_id: signal.correlation_id,
        current_step: 1,
        state: 'running',
      });
      attempt_ordinal = await this.dependencies.runStageRecorder?.nextAttemptOrdinal(signal.tenant_id, run_id) ?? 1;
      await this.traceStage({
        tenant_id: signal.tenant_id,
        run_id,
        attempt_ordinal,
        step_index: 0,
        stage: 'SIGNAL',
      }, async () => undefined);
    } catch (error) {
      await this.dependencies.leaseManager.releaseLease(signal.tenant_id, run_id, this.workerId);
      throw error;
    }

    return this.runGuardedPipeline({
      signal,
      run_id,
      request_id,
      chain,
      workerId: this.workerId,
      attempt_ordinal,
      assertExecutionLease: false,
    });
  }

  /**
   * Executes the full 11-step E2E lifecycle against an existing queued or claimed durable task.
   *
   * Verifies the DB claimed task's lease ownership and signal equality, transitions queued tasks
   * to running, and executes the exact same guarded pipeline without creating a second task.
   */
  public async processQueuedSignal(
    run_id: string,
    signal: SignalEnvelope,
    options?: { worker_id?: string }
  ): Promise<OrchestratorRunResult> {
    const journal = new StageJournal();
    this.journal = journal;
    this.stageContext.enterWith(journal);
    const effectiveWorkerId = options?.worker_id ?? this.workerId;
    // STEP 1: SIGNAL VALIDATION — fail closed before any durable action.
    validateSignalEnvelope(signal);
    const task = await this.dependencies.workflowEngine.getTask(signal.tenant_id, run_id);
    if (!task) {
      throw new OrchestratorError('TASK_NOT_FOUND', `Task ${run_id} does not exist`);
    }

    if (task.state !== 'running' && task.state !== 'queued') {
      throw new OrchestratorError('INVALID_TASK_STATE', `Cannot process queued task currently in '${task.state}'`);
    }

    // Fencing guard: verify lease ownership against the claimed DB row
    if (!task.lease_owner || task.lease_owner !== effectiveWorkerId) {
      throw new OrchestratorError(
        'CONCURRENT_TASK_LOCK',
        `Worker '${effectiveWorkerId}' does not hold active lease for task ${run_id} (held by: '${task.lease_owner ?? 'none'}')`
      );
    }

    const expiresAtMs = task.lease_expires_at ? Date.parse(task.lease_expires_at) : Number.NaN;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new OrchestratorError('TASK_LEASE_EXPIRED', `Execution lease for task ${run_id} is absent or expired`);
    }

    // Verify correlation and signal equality
    if (task.correlation_id !== signal.correlation_id) {
      throw new OrchestratorError(
        'SIGNAL_MISMATCH',
        `Signal correlation_id '${signal.correlation_id}' does not match task correlation_id '${task.correlation_id}'`
      );
    }

    const payload = task.state_payload;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload) || !('signal' in payload)) {
      throw new OrchestratorError('CHECKPOINT_INCOMPLETE', 'Queued task has no persisted signal.');
    }
    const storedSignal = payload.signal;
    if (canonicalizeJson(storedSignal) !== canonicalizeJson(signal)) {
      throw new OrchestratorError('SIGNAL_MISMATCH', `Provided signal does not match stored queued signal for task ${run_id}`);
    }
    const attempt_ordinal = await this.dependencies.runStageRecorder?.nextAttemptOrdinal(signal.tenant_id, run_id)
      ?? (task.retry_count ?? 0) + 1;
    if (('plan' in payload || 'pending_action' in payload) && task.state === 'queued') {
      await this.dependencies.workflowEngine.transitionTask(
        signal.tenant_id,
        run_id,
        'running',
        'Worker claimed queued recovery task',
        undefined,
        { expected_task_version: task.task_version, lease_owner: effectiveWorkerId },
      );
    }

    if ('plan' in payload || 'pending_action' in payload) {
      const checkpoint = payload as unknown as DurableTaskCheckpoint;

      // A reattempt of a persisted plan runs inside the SAME durable-recovery envelope as a first
      // pass: a checkpoint that cannot be resumed, and a step that fails again, are both outcomes of
      // this attempt — they must be parked or booked (§4.4) and spend the retry budget, never leave
      // the run re-queueable with nothing recorded. Only refusals about *who* may run the task (the
      // claim, the lease, the correlation) stay outside the envelope, because they are not the
      // run's own failure and must not consume its budget.
      return await this.withDurableRecovery(
        { tenant_id: signal.tenant_id, run_id, workerId: effectiveWorkerId, checkpoint },
        async () => {
          if (!checkpoint.plan || !checkpoint.context || !checkpoint.request_id
            || checkpoint.request_id !== signal.signal_id || !Number.isInteger(checkpoint.current_step)
            || checkpoint.current_step < 1 || !checkpoint.previous_evidence_hash) {
            throw new OrchestratorError('CHECKPOINT_INCOMPLETE', 'Claimed task has no complete persisted plan cursor.');
          }
          validatePlanInputBindings(checkpoint.plan);
          const persistedAction = checkpoint.pending_action;
          const persistedApprovalId = persistedAction?.approval_id;
          const persistedApprovalDigest = persistedAction?.approval_payload_digest;
          // A MODIFIED AUTH-4 action is the only read-only checkpoint that may be dispatched
          // automatically after the claim transaction committed. The approval id and the digest
          // are persisted with the revised action, so recovery cannot re-draft revision zero or
          // dispatch bytes other than the ones the operator released.
          const authorizedReadOnlyAction =
            persistedAction !== null
            && persistedAction.action_revision > 0
            && persistedAction.required_authority === 'AUTH-4'
            && typeof persistedApprovalId === 'string'
            && persistedApprovalId.length > 0
            && typeof persistedApprovalDigest === 'string'
            && persistedApprovalDigest.length > 0
            && !persistedAction.mutating
              ? persistedAction
              : null;
          if (checkpoint.pending_action?.mutating && checkpoint.pending_action.step_index === checkpoint.current_step) {
            throw new OrchestratorError('CHECKPOINT_REQUIRES_RECONCILIATION', 'A restarted mutating step requires reconciliation by its effect key.');
          }
          this.replayCommittedStages(checkpoint);
          if (checkpoint.current_step > checkpoint.plan.steps.length) {
            const lastStep = checkpoint.plan.steps.at(-1);
            const recovered = lastStep === undefined
              ? null
              : await this.findVerifiedStepReceipt({
                  tenant_id: signal.tenant_id,
                  run_id,
                  request_id: checkpoint.request_id,
                  step_index: lastStep.step_index,
                  plan: checkpoint.plan,
                });
            if (recovered !== null) {
              await this.traceStage({
                tenant_id: signal.tenant_id,
                run_id,
                attempt_ordinal,
                step_index: recovered.evidence.step_index,
                stage: 'OUTCOME',
              }, async () => undefined);
              await this.updateLearningMemory(
                signal.tenant_id,
                run_id,
                undefined,
                recovered.evidence,
                attempt_ordinal,
              );
            }
            const handoff = await this.brokerPlanHandoff({
              tenant_id: signal.tenant_id,
              run_id,
              correlation_id: signal.correlation_id,
              plan: checkpoint.plan,
              context: checkpoint.context,
              request_id: checkpoint.request_id,
              previous_evidence_hash: checkpoint.previous_evidence_hash,
            });
            if (handoff.kind === 'PARKED') {
              return handoff.result;
            }
            const response = await this.persistFinalResponse({
              tenant_id: signal.tenant_id,
              run_id,
              request_id: checkpoint.request_id,
              context: checkpoint.context,
              plan: checkpoint.plan,
            });
            await this.dependencies.workflowEngine.transitionTask(signal.tenant_id, run_id, 'completed', 'Recovered evidenced plan verified');
            return {
              run_id,
              lifecycle_state: 'completed',
              ...(recovered === null ? {} : { evidence: recovered.evidence }),
              ...(response === undefined ? {} : { response }),
              ...(handoff.kind === 'ADMITTED' ? { handoff: handoff.admission } : {}),
            };
          }
          const outcome = await this.executeSteps({
            signal, tenant_id: signal.tenant_id, run_id, correlation_id: signal.correlation_id,
            request_id: checkpoint.request_id, plan: checkpoint.plan, context: checkpoint.context,
            chain: { previous: checkpoint.previous_evidence_hash }, from_step: checkpoint.current_step,
            approved_action: authorizedReadOnlyAction,
            approval_ref: authorizedReadOnlyAction === null
              ? null
              : {
                  approval_id: authorizedReadOnlyAction.approval_id ?? null,
                  decision: 'MODIFIED',
                  operator_id: null,
                },
            attempt_ordinal,
            assertExecutionLease: true,
          });
          if (outcome.evidence !== undefined) {
            await this.traceStage({
              tenant_id: signal.tenant_id,
              run_id,
              attempt_ordinal,
              step_index: outcome.evidence.step_index,
              stage: 'OUTCOME',
            }, async () => undefined);
            await this.updateLearningMemory(
              signal.tenant_id,
              run_id,
              undefined,
              outcome.evidence,
              attempt_ordinal,
            );
          }
          if (outcome.lifecycle_state === 'completed') {
            const handoff = await this.brokerPlanHandoff({
              tenant_id: signal.tenant_id,
              run_id,
              correlation_id: signal.correlation_id,
              plan: checkpoint.plan,
              context: checkpoint.context,
              request_id: checkpoint.request_id,
              previous_evidence_hash: outcome.evidence?.chain_hash ?? checkpoint.previous_evidence_hash,
            });
            if (handoff.kind === 'PARKED') {
              return handoff.result;
            }
            const response = await this.persistFinalResponse({
              tenant_id: signal.tenant_id,
              run_id,
              request_id: checkpoint.request_id,
              context: checkpoint.context,
              plan: checkpoint.plan,
            });
            await this.dependencies.workflowEngine.transitionTask(signal.tenant_id, run_id, 'completed', 'Recovered plan steps verified');
            return {
              run_id,
              lifecycle_state: 'completed',
              ...outcomeFields(outcome),
              ...(response === undefined ? {} : { response }),
              ...(handoff.kind === 'ADMITTED' ? { handoff: handoff.admission } : {}),
            };
          }
          return { run_id, lifecycle_state: outcome.lifecycle_state, ...outcomeFields(outcome) };
        },
      );
    }

    // The reattempt branch replays SIGNAL from the checkpoint, so the first-pass path enters it
    // here: exactly one SIGNAL entry on either path, and no illegal repeat on a re-driven task.
    await this.traceStage({
      tenant_id: signal.tenant_id,
      run_id,
      attempt_ordinal,
      step_index: 0,
      stage: 'SIGNAL',
    }, async () => undefined);

    // Transition queued task to running if not already running
    if (task.state === 'queued') {
      await this.dependencies.workflowEngine.transitionTask(
        signal.tenant_id,
        run_id,
        'running',
        'Worker claimed queued task',
        undefined,
        { expected_task_version: task.task_version, lease_owner: effectiveWorkerId }
      );
    }

    const request_id = signal.signal_id;
    const chain: EvidenceChain = { previous: GENESIS_HASH };

    return this.runGuardedPipeline({
      signal,
      run_id,
      request_id,
      chain,
      workerId: effectiveWorkerId,
      attempt_ordinal,
      assertExecutionLease: true,
    });
  }

  /**
   * Executes the common guarded pipeline for processSignal and processQueuedSignal.
   */
  private async runGuardedPipeline(params: {
    signal: SignalEnvelope;
    run_id: string;
    request_id: string;
    chain: EvidenceChain;
    workerId: string;
    attempt_ordinal: number;
    assertExecutionLease: boolean;
  }): Promise<OrchestratorRunResult> {
    const { signal, run_id, request_id, chain, workerId, attempt_ordinal, assertExecutionLease } = params;

    return await this.withDurableRecovery(
      { tenant_id: signal.tenant_id, run_id, workerId },
      async () => {
        // STEP 2: CONTEXT HYDRATION (trusted identity resolution + session-scoped memory)
        const context = await this.traceStage({
          tenant_id: signal.tenant_id,
          run_id,
          attempt_ordinal,
          step_index: 0,
          stage: 'CONTEXT',
        }, async () => this.dependencies.contextAggregator.hydrateContext(
          signal.tenant_id,
          signal.subject,
          signal.correlation_id
        ));
        const sessionId = context.working_memory.session_id;

        if (await this.dependencies.sessionControl.isTakenOver(signal.tenant_id, sessionId)) {
          await this.dependencies.workflowEngine.transitionTask(signal.tenant_id, run_id, 'stopped', 'HUMAN_TAKEOVER at step [2. CONTEXT] (SCR-005)');
          return {
            run_id,
            lifecycle_state: 'stopped',
            ...outcomeFields({ message: 'Session locked by human operator' }),
          };
        }

        // STEP 3: HYPOTHESIS FORMATION (explicitly HYPOTHESIS-class, cannot write to FACT)
        const hypothesis = await this.traceStage({
          tenant_id: signal.tenant_id,
          run_id,
          attempt_ordinal,
          step_index: 0,
          stage: 'HYPOTHESIS',
        }, async () => {
          const derived = await this.dependencies.agentRuntime.deriveHypothesis(signal, context);
          enforceEpistemicSeparation(derived);
          return derived;
        });
        // STEP 4: DECISION & ROUTING (FR-ORC-001)
        const routing = await this.traceStage({
          tenant_id: signal.tenant_id,
          run_id,
          attempt_ordinal,
          step_index: 0,
          stage: 'DECISION',
        }, async () => assertOrchestratorBrokered(
          await this.dependencies.agentRuntime.resolveRouting(signal, context, hypothesis),
        ));


        // STEP 5: PLAN FORMULATION. The Single Clarification Rule produces a one-step plan, so a
        // clarification message passes the SAME authority, reservation and evidence guards as any
        // other outbound action (it is a real external mutation).
        const plan = await this.traceStage({
          tenant_id: signal.tenant_id,
          run_id,
          attempt_ordinal,
          step_index: 0,
          stage: 'PLAN',
        }, async () => {
          const formulated = routing.requires_clarification
            ? this.buildClarificationPlan(routing, signal, context)
            : await this.dependencies.agentRuntime.formulatePlan(routing, context, hypothesis);
          validatePlanInputBindings(formulated);
          return formulated;
        });
        // Persist the decided plan before its first side effect. A restarted worker must replay this
        // checkpoint rather than rederive a potentially different plan under the same request id.
        await this.dependencies.workflowEngine.updateTaskProgress(signal.tenant_id, run_id, 1, {
          signal, plan, current_step: 1, pending_action: null, context,
          previous_evidence_hash: chain.previous, request_id,
        });

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
          attempt_ordinal,
          assertExecutionLease,
        });
        if (outcome.lifecycle_state !== 'completed') {
          return {
            run_id,
            lifecycle_state: outcome.lifecycle_state,
            ...outcomeFields(outcome),
          };
        }

        // STEPS 10-11: OUTCOME BASELINE & LEARNING UPDATE. Only a run that produced step evidence has
        // an outcome to attribute; a plan that produced none (an empty plan, or a resume past the last
        // step) completes without claiming either stage rather than recording a stage it never reached.
        if (outcome.evidence !== undefined) {
          await this.traceStage({
            tenant_id: signal.tenant_id,
            run_id,
            attempt_ordinal,
            step_index: outcome.evidence.step_index,
            stage: 'OUTCOME',
          }, async () => undefined);
          await this.updateLearningMemory(signal.tenant_id, run_id, hypothesis, outcome.evidence, attempt_ordinal);
        }

        // STEP 10.5: the brokered handoff, before the run is settled. A plan that declared a next
        // leg either hands off, parks on an unresolved admission, or refuses — it never completes
        // as though the journey had no successor (§8, plans/customer-lifecycle.md §3).
        const handoff = await this.brokerPlanHandoff({
          tenant_id: signal.tenant_id,
          run_id,
          correlation_id: signal.correlation_id,
          plan,
          context,
          request_id,
          previous_evidence_hash: outcome.evidence?.chain_hash ?? chain.previous,
        });
        if (handoff.kind === 'PARKED') {
          return handoff.result;
        }

        const response = await this.persistFinalResponse({
          tenant_id: signal.tenant_id,
          run_id,
          request_id,
          context,
          plan,
        });
        await this.dependencies.workflowEngine.transitionTask(signal.tenant_id, run_id, 'completed', 'All plan steps verified');

        return {
          run_id,
          lifecycle_state: 'completed',
          ...outcomeFields(outcome),
          ...(response === undefined ? {} : { response }),
          ...(handoff.kind === 'ADMITTED' ? { handoff: handoff.admission } : {}),
        };
      },
    );
  }

  /**
   * The one durable-recovery envelope around an execution attempt (§4.4).
   *
   * A classified failure is booked exactly once (`UNKNOWN` parks the task for reconciliation by
   * `effect_key` rather than being persisted as an error class), and the attempt's lease is released
   * in every case — including the early returns for a stopped, escalated or recovered run. Both
   * entry paths run inside it: a first pass through `runGuardedPipeline`, and a reattempt of a
   * persisted plan inside `processQueuedSignal`, so a repeat failure spends the retry budget instead
   * of re-queueing itself forever without accounting.
   */
  private async withDurableRecovery(
    params: { tenant_id: string; run_id: string; workerId: string; checkpoint?: unknown },
    attempt: () => Promise<OrchestratorRunResult>,
  ): Promise<OrchestratorRunResult> {
    const { tenant_id, run_id, workerId } = params;

    try {
      return await attempt();
    } catch (error) {
      const failure_class = classifyFailure(error);
      // A restarted mutating step is the same reconciliation state as an indeterminate provider
      // outcome: its effect may have landed under an unsettled reservation, so it is parked for
      // resolution by `effect_key` instead of being failed or re-dispatched (§4.4).
      const requires_reconciliation = failure_class === 'UNKNOWN'
        || (error instanceof OrchestratorError && error.code === 'CHECKPOINT_REQUIRES_RECONCILIATION');
      if (requires_reconciliation) {
        // `waiting` is stored with a REPLACED `state_payload`, and the repository refuses a park
        // whose checkpoint is incomplete (§4.2): the validated checkpoint of the reattempt is passed
        // through verbatim, which is also the blob the scheduler would resume from.
        if (params.checkpoint === undefined) {
          await this.dependencies.workflowEngine.recordFailure({
            tenant_id,
            run_id,
            error_class: 'FATAL',
            error_details: serializeError(error),
          });
          throw error;
        }
        await this.dependencies.workflowEngine.transitionTask(
          tenant_id,
          run_id,
          'waiting',
          'EFFECT_UNKNOWN: provider outcome indeterminate; reconciliation scheduled (§4.4)',
          params.checkpoint,
        );
        return {
          run_id,
          lifecycle_state: 'waiting',
          ...outcomeFields({ message: 'Provider outcome is UNKNOWN; reconciling by effect_key before any retry' }),
        };
      }
      // RETRYABLE (re-queued under max_retries) or FATAL (terminal): hand the classified failure
      // to the durable scheduler.
      await this.dependencies.workflowEngine.recordFailure({
        tenant_id,
        run_id,
        error_class: failure_class,
        error_details: serializeError(error),
      });
      throw error;
    } finally {
      await this.dependencies.leaseManager.releaseLease(tenant_id, run_id, workerId);
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
    reconciled_action?: ActionDraft | null;
    reconciled_effect?: ReconciledEffect | null;
    attempt_ordinal: number;
    assertExecutionLease: boolean;
  }): Promise<StepLoopOutcome> {
    const { tenant_id, run_id, correlation_id, request_id, plan, context, chain, attempt_ordinal } = params;
    const sessionId = context.working_memory.session_id;
    let reconciledEffect = params.reconciled_effect ?? null;
    let reconciledAction = params.reconciled_action ?? null;
    // A first pass carries the inbound event; a resume carries the decision that released it.
    const trigger = params.signal ? params.signal.event_type : 'task.resume';
    let latestEvidence: ImmutableEvidenceRecord | undefined;
    if (params.from_step > plan.steps.length && plan.steps.length > 0) {
      const lastStep = plan.steps.at(-1);
      if (lastStep !== undefined) {
        const recovered = await this.findVerifiedStepReceipt({
          tenant_id,
          run_id,
          request_id,
          step_index: lastStep.step_index,
          plan,
        });
        latestEvidence = recovered?.evidence;
      }
    }

    for (const step of plan.steps) {
      if (step.step_index < params.from_step) {
        continue; // already executed and chained before the pause
      }
      const stepStartTime = Date.now();
      const stepStartedAt = new Date(stepStartTime).toISOString();

      // SCR-005 guard, per step (hence per retry and per resume): a takeover landing mid-run stops
      if (params.assertExecutionLease === true) {
        await this.dependencies.assertExecutionLease?.(tenant_id, run_id);
      }
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
        return { lifecycle_state: 'stopped', ...outcomeFields({ message: reason }) };
      }

      const isReceiptSource = plan.steps.some((candidate) =>
        Object.values(candidate.input_bindings ?? {}).some(
          (binding) => binding.source_step_index === step.step_index,
        )
      );
      if (isReceiptSource) {
        const recovered = await this.findVerifiedStepReceipt({
          tenant_id, run_id, request_id, step_index: step.step_index, plan,
        });
        if (recovered !== null) {
          if (recovered.evidence.previous_evidence_hash !== chain.previous) {
            throw new OrchestratorError(
              'INPUT_BINDING_RECEIPT_INVALID',
              `Recovered evidence for step ${step.step_index} is not linked to the current plan chain.`,
            );
          }
          chain.previous = recovered.evidence.chain_hash;
          latestEvidence = recovered.evidence;
          this.journal.enter('ACTION');
          this.journal.enter('APPROVAL');
          this.journal.enter('EXECUTION');
          this.journal.enter('EVIDENCE');
          await this.dependencies.workflowEngine.updateTaskProgress(tenant_id, run_id, step.step_index + 1, {
            ...(params.signal === null ? {} : { signal: params.signal }),
            plan,
            current_step: step.step_index + 1,
            pending_action: null,
            context,
            previous_evidence_hash: chain.previous,
            request_id,
          });
          continue;
        }
      }

      await this.dependencies.workflowEngine.updateTaskProgress(tenant_id, run_id, step.step_index, {
        plan_id: plan.plan_id,
        current_step: step.step_index,
        skill_id: step.skill_id,
        agent_id: step.agent_id,
      });

      // STEPS 6-7: ACTION DRAFTING (deterministic effect_key + authoritative floor).
      // The stage is entered before the draft: the step loop returns to ACTION from EVIDENCE for
      // every step after the first (§8.4), and a step that never drafts never records it.
      const released = params.approved_action !== null
        && params.approved_action.step_index === step.step_index;
      const reconciled = reconciledAction !== null
        && reconciledAction.step_index === step.step_index;

      const action: ActionDraft = await this.traceStage({
        tenant_id,
        run_id,
        attempt_ordinal,
        step_index: step.step_index,
        stage: 'ACTION',
      }, async () => {
        if (reconciledEffect !== null && !reconciled) {
          throw new OrchestratorError(
            'RECONCILIATION_BINDING_REQUIRED',
            'Provider reconciliation proof requires the persisted pending action for the resumed step.',
          );
        }

        const resolvedInputs = released || reconciled
          ? undefined
          : await this.resolveStepInputs({
              tenant_id, run_id, request_id, step, plan, context,
            });
        const drafted: ActionDraft = released
          ? (params.approved_action as ActionDraft)
          : reconciled
            ? (reconciledAction as ActionDraft)
            : await this.draftAction(step, context, run_id, tenant_id, request_id, 0, resolvedInputs);
        verifyFloorPrice(drafted);
        // Save the exact draft before dispatch. A restarted effect-bearing run cannot re-draft and
        // re-send until its reservation and provider outcome have been reconciled by this key.
        await this.dependencies.workflowEngine.updateTaskProgress(tenant_id, run_id, step.step_index, {
          ...(params.signal === null ? {} : { signal: params.signal }),
          plan, current_step: step.step_index, pending_action: drafted, context,
          previous_evidence_hash: chain.previous, request_id,
        });
        return drafted;
      });

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
      if (reconciled) {
        if (
          reconciledAction === null
          || action.action_id !== reconciledAction.action_id
          || action.effect_key !== reconciledAction.effect_key
        ) {
          throw new OrchestratorError(
            'RECONCILIATION_BINDING_REQUIRED',
            'A reconciled step must preserve the persisted pending action identity.',
          );
        }
        if (
          reconciledEffect !== null
          && (
            reconciledEffect.effect_key !== action.effect_key
            || reconciledEffect.action_id !== action.action_id
          )
        ) {
          throw new OrchestratorError(
            'RECONCILIATION_BINDING_REQUIRED',
            'Provider reconciliation proof is bound to a different action or effect key than the resumed action.',
          );
        }
      }
      const authorization = await this.traceStage({
        tenant_id,
        run_id,
        attempt_ordinal,
        step_index: step.step_index,
        stage: 'APPROVAL',
      }, async () => this.dependencies.policyEngine.evaluateAuthority(action, context));

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
        // AUTH-5 and every other denial stop here: the run never enters EXECUTION and no adapter is
        // reachable from this path.
        return { lifecycle_state: 'stopped', ...outcomeFields({ message: authorization.reason }) };
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
        // AUTH-4 return: the run pauses at APPROVAL. It has not dispatched and must not record
        // EXECUTION — the released action re-enters the guarded loop on resume.
        return {
          lifecycle_state: 'awaiting_human',
          ...outcomeFields({ message: `Paused for Human Approval at step ${step.step_index} in SCR-003 (approval ${paused.approval_id})` }),
        };
      }

      // What authorized this step: the human decision that released it, or the autonomous verdict.
      const approvalRecord = this.approvalField(released ? params.approval_ref : null);

      // STEP 8: RESERVATION THEN DISPATCH. `acquireEffectSlot()` reserves the deterministic
      // `effect_key` durably before every mutating dispatch; a read-only action is dispatched
      // unreserved because it has no external effect to deduplicate.
      const slot = await acquireEffectSlot(this.dependencies, action, run_id, reconciledEffect);
      if (reconciledEffect !== null) {
        reconciledEffect = null;
      }
      if (reconciledAction !== null) {
        reconciledAction = null;
      }
      if (slot.kind === 'WAIT') {
        await this.parkTask({
          tenant_id, run_id, reason: slot.reason, plan, current_step: step.step_index,
          pending_action: action, context, previous_evidence_hash: chain.previous, request_id,
        });
        // The reservation is unsettled, so no dispatch happened and EXECUTION stays unrecorded.
        return { lifecycle_state: 'waiting', ...outcomeFields({ message: slot.reason }) };
      }

      // A REPLAY is not a dispatch: the effect already landed under this exact key, so the stored
      // receipt of the durable reservation is reused verbatim and the provider is never called
      // again (BR-006). The engine does not synthesize an adapter response it did not receive;
      // `providerReceipt` is whatever the reservation stored (possibly `null`).
      const replayed = slot.kind === 'REPLAY';
      let providerReceipt: unknown = replayed ? slot.receipt : null;
      let dispatchedReceipt: ExecutionReceipt | null = null;

      if (!replayed) {
        const autonomyWorkflow = (authorization as typeof authorization & {
          autonomyWorkflow?: 'UNCHANGED' | 'AUTO_EXECUTE' | 'PARKED_DRAFT';
        }).autonomyWorkflow;
        if (autonomyWorkflow === 'PARKED_DRAFT') {
          const reason = 'PARKED_DRAFT: controlled-autonomy admission withheld external dispatch.';
          await this.parkTask({
            tenant_id, run_id, reason, plan, current_step: step.step_index,
            pending_action: action, context, previous_evidence_hash: chain.previous, request_id,
          });
          return { lifecycle_state: 'waiting', ...outcomeFields({ message: reason }) };
        }
        // EXECUTION is entered and persisted before the adapter call. A recorder failure therefore
        // prevents the external side effect instead of leaving an untraced dispatch.
        await this.enterStage({
          tenant_id,
          run_id,
          attempt_ordinal,
          step_index: step.step_index,
          stage: 'EXECUTION',
        });
        const executionSpan = this.startStageSpan({
          tenant_id,
          run_id,
          stage: 'EXECUTION',
        });
        try {
          dispatchedReceipt = await this.runStageSpan(
            executionSpan,
            async () => dispatchWithDeadline(this.dependencies, action, step),
          );
          providerReceipt = dispatchedReceipt;
        } catch (error) {
          const classified = classifyFailure(error);
          // `UNKNOWN` is reserved for a step with an external effect (§3.2.4): a read-only step
          // reserved nothing, so an unconfirmed outcome is a transient provider failure that is
          // re-queued under its declared retry policy instead of parking the task for a
          // reconciliation it has no effect to reconcile.
          const failure_class: RetryClass = step.mutating || classified !== 'UNKNOWN' ? classified : 'RETRYABLE';
          const dispatchFailure = step.mutating || classified !== 'UNKNOWN'
            ? error
            : new OrchestratorError(
                'PROVIDER_UNAVAILABLE',
                `Read-only step ${step.step_index} returned no verifiable outcome: ${JSON.stringify(serializeError(error))}`
              );
          await this.logRun({
            tenant_id, run_id, correlation_id, trigger, step, context,
            startedAt: stepStartedAt, startTime: stepStartTime,
            execution_status: 'failed',
            authority: action.required_authority,
            approval: approvalRecord,
            action,
            evidence: { recorded: false, reason: 'DISPATCH_FAILED' },
            error: { ...serializeError(dispatchFailure), outcome: failure_class === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED' },
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
            return {
              lifecycle_state: 'waiting',
              ...outcomeFields({ message: 'Provider outcome is UNKNOWN; reconciling by effect_key before any retry' }),
            };
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
              ...outcomeFields({ message: `Adapter returned ${dispatchedReceipt.adapter_status} for step ${step.step_index}; effect outcome UNKNOWN and will be reconciled` }),
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

        if (action.skill_id === 'skill.care.escalate_to_human') {
          // The HandoffBus commits the queue row, parked task, takeover state and receipt together.
          // Do not settle that reservation or advance the checkpoint a second time here.
          return {
            lifecycle_state: 'awaiting_human',
            ...outcomeFields({ message: 'Escalated to human operator' }),
          };
        }

        if (step.mutating) {
          await this.dependencies.effectGuard.resolve({
            tenant_id: action.tenant_id,
            effect_key: action.effect_key,
            status: 'SUCCEEDED',
            receipt: dispatchedReceipt,
          });
        }
      } else {
        // A replayed receipt is an actual execution-stage observation without another adapter call.
        await this.traceStage({
          tenant_id,
          run_id,
          attempt_ordinal,
          step_index: step.step_index,
          stage: 'EXECUTION',
        }, async () => undefined);
      }

      // STEP 9: CHAINED IMMUTABLE EVIDENCE. The stage record precedes the durable evidence append,
      // preserving a trace even when evidence persistence itself fails closed.
      const evidenceStage = {
        tenant_id,
        run_id,
        attempt_ordinal,
        step_index: step.step_index,
        stage: 'EVIDENCE' as const,
      };
      await this.enterStage(evidenceStage);
      const evidenceSpan = this.startStageSpan(evidenceStage);

      // From here a mutating step may ALREADY have applied its external effect: it dispatched just
      // now, or it replayed the stored receipt of an effect that landed. An evidence or audit write
      // that fails at this point — the chained record, the run-log/audit row, or the outcome watch
      // that settles the effect — is therefore a reconciliation obligation, not a terminal failure
      // (implement/08 §4.3, §7): the attempt identity and the reservation are preserved, no success
      // is claimed, no blind retry follows, and the task is parked under the SAME `effect_key`. A
      // read-only step has no external effect, so its write failure keeps the existing behaviour.
      const effectMayHaveLanded = step.mutating && (replayed || dispatchedReceipt !== null);
      try {
        const stepEvidence = await this.runStageSpan(
          evidenceSpan,
          async () => this.dependencies.evidenceLogger.createImmutableRecord({
            run_id,
            tenant_id,
            correlation_id,
            step_index: step.step_index,
            effect_key: action.effect_key,
            previous_evidence_hash: chain.previous,
            payload: { action, receipt: providerReceipt, replayed },
          }),
        );
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
        await this.dependencies.workflowEngine.updateTaskProgress(tenant_id, run_id, step.step_index + 1, {
          ...(params.signal === null ? {} : { signal: params.signal }),
          plan, current_step: step.step_index + 1, pending_action: null, context,
          previous_evidence_hash: chain.previous, request_id,
        });
      } catch (error) {
        // A read-only step dispatched nothing effect-bearing, so there is nothing to reconcile and
        // the failure keeps its existing classification.
        if (!effectMayHaveLanded) {
          throw error;
        }
        const reconcileReason = `EVIDENCE_RECONCILE_REQUIRED: ${String(serializeError(error).code)} after a possible effect on ${action.effect_key}; the evidence/audit trail is incomplete and must be reconciled by effect_key before any retry (§08 §4.3, §7).`;
        await this.parkTask({
          tenant_id, run_id, reason: reconcileReason, plan, current_step: step.step_index,
          pending_action: action, context, previous_evidence_hash: chain.previous, request_id,
        });
        return {
          lifecycle_state: 'waiting',
          ...outcomeFields({
            message: `Step ${step.step_index} effect ${action.effect_key} may already have landed but its evidence/audit trail is incomplete; no success is claimed and the run must be reconciled by effect_key.`,
          }),
        };
      }
    }

    return { lifecycle_state: 'completed', ...outcomeFields({ evidence: latestEvidence }) };
  }

  /**
   * Resumes a paused task after a human decision or a schedule/reconciliation event.
   * The approval row is claimed and the task re-activated in one transaction, so an approval can
   * never be consumed twice and can never resume a task it was not bound to.
   */
  public async resumeTask(
    run_id: string,
    resumeEvent: {
      tenant_id: string;
      event_type: 'human.approval' | 'human.modify' | 'human.reject' | 'human.pause' | 'human.cancel' | 'human.reconcile' | 'timer.expired' | 'reconcile.completed' | 'human.handoff.evidence';
      approval_id?: string;
      expected_payload_sha256?: string;
      operator_id?: string;
      reconciliation_resolution?: 'PROVIDER_CONFIRMED_SUCCEEDED' | 'PROVIDER_CONFIRMED_ABSENT' | 'ESCALATE_MANUALLY';
      reconciliation_receipt?: unknown;
      modifications?: Record<string, unknown>;
      evidence_payload?: Record<string, unknown>;
      step_index?: number;
      effect_key?: string;
      reason?: string;
    }
  ): Promise<OrchestratorRunResult> {
    const journal = new StageJournal();
    this.journal = journal;
    this.stageContext.enterWith(journal);
    let task = await this.dependencies.workflowEngine.getTask(resumeEvent.tenant_id, run_id);
    if (!task) {
      throw new OrchestratorError('TASK_NOT_FOUND', 'Task ' + run_id + ' does not exist');
    }
    if (task.state !== 'awaiting_human' && task.state !== 'waiting') {
      throw new OrchestratorError('INVALID_TASK_STATE', 'Cannot resume task currently in ' + task.state);
    }

    let attempt_ordinal = (task.retry_count ?? 0) + 1;

    let checkpoint = readCompleteResumeCheckpoint(task.state_payload, run_id);
    const isReconciliationResolution = resumeEvent.event_type === 'human.reconcile';
    const isHumanApprovalDecision = resumeEvent.event_type === 'human.approval'
      || resumeEvent.event_type === 'human.modify'
      || resumeEvent.event_type === 'human.reject'
      || resumeEvent.event_type === 'human.pause'
      || resumeEvent.event_type === 'human.cancel';
    const isAutomaticResume = resumeEvent.event_type === 'timer.expired'
      || resumeEvent.event_type === 'reconcile.completed';
    const isHandoffEvidence = resumeEvent.event_type === 'human.handoff.evidence';
    if ((isHumanApprovalDecision && task.state !== 'awaiting_human')
      || (isHandoffEvidence && task.state !== 'awaiting_human')
      || (isReconciliationResolution && task.state !== 'waiting')
      || (isAutomaticResume && task.state !== 'waiting')) {
      throw new OrchestratorError('INVALID_TASK_STATE', 'Resume event does not match the durable waiting state.');
    }

    // The lease is taken BEFORE an approval is claimed: an approval authorizes exactly one
    // execution, so it must never be consumed by a worker that cannot actually run the task.
    const hasDurableFence = Object.prototype.hasOwnProperty.call(task, 'lease_owner')
      || Object.prototype.hasOwnProperty.call(task, 'lease_expires_at');
    const clearResumeEvent = async (reason: string): Promise<void> => {
      const resumeCheckpoint: DurableTaskCheckpoint = {
        plan: checkpoint.plan,
        current_step: checkpoint.current_step,
        pending_action: checkpoint.pending_action,
        context: checkpoint.context,
        previous_evidence_hash: checkpoint.previous_evidence_hash,
        request_id: checkpoint.request_id,
      };
      const stored = task?.state_payload;
      const storedSignal = stored !== null && typeof stored === 'object' && !Array.isArray(stored) && 'signal' in stored
        ? stored.signal
        : undefined;
      const guard = hasDurableFence
        ? { expected_task_version: task!.task_version, lease_owner: this.workerId }
        : undefined;
      await this.dependencies.workflowEngine.transitionTask(
        resumeEvent.tenant_id,
        run_id,
        'waiting',
        reason,
        storedSignal === undefined ? resumeCheckpoint : { ...resumeCheckpoint, signal: storedSignal },
        guard,
      );
    };
    const leaseAcquired = await this.dependencies.leaseManager.acquireLease(resumeEvent.tenant_id, run_id, this.workerId);
    if (!leaseAcquired) {
      throw new OrchestratorError('CONCURRENT_TASK_LOCK', 'Unable to acquire lease to resume ' + run_id);
    }

    let executionResumed = false;
    try {
      const fencedTask = await this.dependencies.workflowEngine.getTask(resumeEvent.tenant_id, run_id);
      if (!fencedTask) {
        throw new OrchestratorError('TASK_NOT_FOUND', 'Task ' + run_id + ' disappeared while acquiring its lease');
      }
      if ((isHumanApprovalDecision && fencedTask.state !== 'awaiting_human')
        || (isHandoffEvidence && fencedTask.state !== 'awaiting_human')
        || (isReconciliationResolution && fencedTask.state !== 'waiting')
        || (isAutomaticResume && fencedTask.state !== 'waiting')) {
        throw new OrchestratorError('CONCURRENT_TASK_LOCK', 'The waiting task changed while its resume lease was acquired.');
      }
      if (hasDurableFence) {
        if (
          fencedTask.lease_owner !== this.workerId
          || fencedTask.lease_expires_at === null
          || fencedTask.lease_expires_at === undefined
          || Date.parse(fencedTask.lease_expires_at) <= Date.now()
        ) {
          throw new OrchestratorError('CONCURRENT_TASK_LOCK', 'The resume worker does not hold a live durable lease.');
        }
        const fencedPayload = isPlainJsonObject(fencedTask.state_payload) ? fencedTask.state_payload : null;
        const storedResumeEvent = fencedPayload?.['resume_event'];
        if (
          !isPlainJsonObject(storedResumeEvent)
          || canonicalizeJson(storedResumeEvent) !== canonicalizeJson(resumeEvent)
        ) {
          throw new OrchestratorError(
            'RESUME_EVENT_CONFLICT',
            'The resume event changed after the worker acquired the durable lease.',
          );
        }
      }
      task = fencedTask;
      attempt_ordinal = await this.dependencies.runStageRecorder?.nextAttemptOrdinal(resumeEvent.tenant_id, run_id)
        ?? (task.retry_count ?? 0) + 1;
      checkpoint = readCompleteResumeCheckpoint(task.state_payload, run_id);
      this.replayCommittedStages(checkpoint);
      const pendingAction: ActionDraft | null = checkpoint.pending_action ?? null;

      let releasedAction: ActionDraft | null = null;
      let approvalRef: {
        approval_id: string | null;
        decision: 'APPROVED' | 'MODIFIED' | null;
        operator_id: string | null;
      } | null = null;
      let reconciledEffect: ReconciledEffect | null = null;
      let reconciledAction: ActionDraft | null = null;

      if (isHandoffEvidence) {
        const evidencePayload = isPlainJsonObject(resumeEvent.evidence_payload)
          ? resumeEvent.evidence_payload
          : null;
        const action = evidencePayload && isPlainJsonObject(evidencePayload['action'])
          ? evidencePayload['action'] as unknown as ActionDraft
          : pendingAction;
        const rawEffectKey = evidencePayload?.['effect_key'] ?? resumeEvent.effect_key;
        const effectKey = typeof rawEffectKey === 'string' ? rawEffectKey : action?.effect_key;
        const stepIndex = typeof resumeEvent.step_index === 'number' ? resumeEvent.step_index : checkpoint.current_step;
        const step = checkpoint.plan.steps.find((candidate) => candidate.step_index === stepIndex)
          ?? checkpoint.plan.steps[checkpoint.current_step - 1];
        if (!evidencePayload || !action || !step || !effectKey) {
          throw new OrchestratorError('HANDOFF_EVIDENCE_REPAIR_INVALID', 'Handoff evidence repair lacks its persisted action, step or effect identity.');
        }

        const findEvidence = this.dependencies.evidenceLogger.findImmutableRecord;
        if (!findEvidence) {
          throw new OrchestratorError('HANDOFF_EVIDENCE_REPAIR_UNBOUND', 'Durable handoff evidence repair requires a read-by-effect evidence binding.');
        }
        const existingEvidence = await findEvidence({
          tenant_id: resumeEvent.tenant_id,
          run_id,
          effect_key: effectKey,
          step_index: stepIndex,
        });
        const stepEvidence = existingEvidence ?? await this.dependencies.evidenceLogger.createImmutableRecord({
          run_id,
          tenant_id: resumeEvent.tenant_id,
          correlation_id: task.correlation_id,
          step_index: stepIndex,
          effect_key: effectKey,
          previous_evidence_hash: checkpoint.previous_evidence_hash,
          payload: evidencePayload,
        });
        try {
          const receiptRecord = isPlainJsonObject(evidencePayload['receipt']) ? evidencePayload['receipt'] : null;
          const tokenUsage = isPlainJsonObject(receiptRecord?.['token_usage'])
            ? receiptRecord['token_usage'] as unknown as ExecutionReceipt['token_usage']
            : undefined;
          await this.logRun({
            tenant_id: resumeEvent.tenant_id,
            run_id,
            correlation_id: task.correlation_id,
            trigger: 'signal',
            step,
            context: checkpoint.context,
            startedAt: new Date().toISOString(),
            startTime: Date.now(),
            execution_status: 'success',
            authority: action.required_authority,
            approval: null,
            action,
            evidence: stepEvidence,
            error: null,
            cost: tokenUsage,
            disposition: 'terminal',
          });
        } catch (logError) {
          const message = logError instanceof Error ? logError.message : String(logError);
          const code = logError instanceof OrchestratorError ? logError.code : undefined;
          const duplicate = code === 'EVIDENCE_APPEND_ONLY_VIOLATION'
            || code === 'AGENT_RUN_LOG_APPENDED'
            || code === 'AUDIT_RECORD_APPENDED'
            || message.startsWith('AGENT_RUN_LOG_APPENDED:')
            || message.startsWith('AUDIT_RECORD_APPENDED:')
            || message.includes('already exists')
            || message.includes('duplicate key')
            || message.includes('UNIQUE constraint');
          if (!duplicate) throw logError;
        }

        await this.dependencies.workflowEngine.clearHandoffEvidence({
          tenant_id: resumeEvent.tenant_id,
          run_id,
          expected_task_version: task.task_version,
          lease_owner: this.workerId,
          expected_resume_event: resumeEvent as unknown as Record<string, unknown>,
        });
        return {
          run_id,
          lifecycle_state: 'awaiting_human',
          ...outcomeFields({ message: 'Handoff evidence recorded; task remains awaiting_human', evidence: stepEvidence }),
        };
      }
      if (isReconciliationResolution) {
        if (!resumeEvent.operator_id || !pendingAction || !pendingAction.mutating) {
          throw new OrchestratorError(
            'RECONCILIATION_BINDING_REQUIRED',
            'Manual reconciliation requires an authenticated operator and a pending mutating action.',
          );
        }
        if (resumeEvent.reconciliation_resolution === 'ESCALATE_MANUALLY') {
          await clearResumeEvent('Manual reconciliation escalation recorded; no dispatch was authorized.');
          return {
            run_id,
            lifecycle_state: 'waiting',
            ...outcomeFields({ message: 'Provider outcome remains unresolved; no dispatch was authorized.' }),
          };
        }
        reconciledEffect = await reconcileProviderEffect(this.dependencies, pendingAction);
        reconciledAction = pendingAction;
        const resumeCheckpoint: DurableTaskCheckpoint = {
          plan: checkpoint.plan,
          current_step: checkpoint.current_step,
          pending_action: checkpoint.pending_action,
          context: checkpoint.context,
          previous_evidence_hash: checkpoint.previous_evidence_hash,
          request_id: checkpoint.request_id,
        };
        // The operator event requests a provider check; it is not proof and its receipt is never
        // persisted. Consume it by one fenced transition to running with the resume checkpoint,
        // so a crash or write interruption cannot leave an unclaimable waiting row.
        await this.dependencies.workflowEngine.transitionTask(
          resumeEvent.tenant_id,
          run_id,
          'running',
          'Provider reconciliation proof authorized guarded resume',
          resumeCheckpoint,
          hasDurableFence
            ? { expected_task_version: task.task_version, lease_owner: this.workerId }
            : undefined,
        );
        const refreshed = await this.dependencies.workflowEngine.getTask(resumeEvent.tenant_id, run_id);
        if (!refreshed) {
          throw new OrchestratorError('TASK_NOT_FOUND', 'The task disappeared after provider reconciliation proof.');
        }
        task = refreshed;
        checkpoint = readCompleteResumeCheckpoint(task.state_payload, run_id);
        reconciledAction = checkpoint.pending_action ?? pendingAction;
        executionResumed = true;
      }

      if (isHumanApprovalDecision) {
        const approvalId = resumeEvent.approval_id;
        const operatorId = resumeEvent.operator_id;
        const expectedPayloadSha256 = resumeEvent.expected_payload_sha256;
        if (!approvalId || !pendingAction || !operatorId || !expectedPayloadSha256) {
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
        const authorizedAction = decision === 'APPROVED' || decision === 'MODIFIED'
          ? {
              ...candidate,
              approval_id: approvalId,
              approval_payload_digest: decision === 'MODIFIED'
                ? sha256CanonicalJson(candidate.payload)
                : expectedPayloadSha256,
            }
          : null;
        if (decision === 'APPROVED' || decision === 'MODIFIED') {
          verifyFloorPrice(candidate);
          const eligibility = await this.dependencies.policyEngine.evaluateAuthority(candidate, checkpoint.context);
          if (eligibility.verdict === 'DENIED') {
            throw new OrchestratorError('AUTHORITY_DENIED', eligibility.reason);
          }
          if (
            await this.dependencies.sessionControl.isTakenOver(
              resumeEvent.tenant_id,
              checkpoint.context.working_memory.session_id,
            )
          ) {
            throw new OrchestratorError(
              'HUMAN_TAKEOVER',
              'An operator holds the SCR-005 session lock; the approval stays PENDING and no dispatch may follow.',
            );
          }
        }
        const taskPayload = isPlainJsonObject(task.state_payload) ? task.state_payload : null;
        const expectedResumeEvent = taskPayload?.['resume_event'];
        const claimFence = hasDurableFence && isPlainJsonObject(expectedResumeEvent)
          ? {
              expected_task_version: task.task_version,
              lease_owner: this.workerId,
              expected_resume_event: expectedResumeEvent,
            }
          : {};
        const claimed = await this.dependencies.workflowEngine.claimApprovalAndResume({
          tenant_id: resumeEvent.tenant_id,
          run_id,
          approval_id: approvalId,
          effect_key: pendingAction.effect_key,
          expected_payload_sha256: expectedPayloadSha256,
          authorized_action: authorizedAction,
          decision,
          operator_id: operatorId,
          review_comment: resumeEvent.reason ?? null,
          ...claimFence,
        });
        if (!claimed.claimed) {
          throw new OrchestratorError('APPROVAL_NOT_CLAIMABLE', 'Approval is stale, decided, or bound to a different action.');
        }
        if (decision === 'PAUSE') {
          return {
            run_id,
            lifecycle_state: 'awaiting_human',
            ...outcomeFields({ message: 'Approval remains pending under an explicit human pause' }),
          };
        }
        if (decision === 'REJECTED' || decision === 'CANCELLED') {
          return {
            run_id,
            lifecycle_state: 'stopped',
            ...outcomeFields({ message: 'Task ' + decision.toLowerCase() + ' by human operator' }),
          };
        }
        executionResumed = true;
        releasedAction = authorizedAction;
        approvalRef = { approval_id: approvalId, decision, operator_id: operatorId };
      }

      if (isAutomaticResume && !executionResumed) {
        await clearResumeEvent('Consumed automatic reconciliation resume event.');
        const refreshed = await this.dependencies.workflowEngine.getTask(resumeEvent.tenant_id, run_id);
        if (!refreshed) {
          throw new OrchestratorError('TASK_NOT_FOUND', 'The task disappeared before automatic reconciliation resume.');
        }
        task = refreshed;
        checkpoint = readCompleteResumeCheckpoint(task.state_payload, run_id);
        await this.dependencies.workflowEngine.transitionTask(
          resumeEvent.tenant_id,
          run_id,
          'running',
          'Resumed by ' + resumeEvent.event_type,
          undefined,
          hasDurableFence
            ? { expected_task_version: task.task_version, lease_owner: this.workerId }
            : undefined,
        );
        executionResumed = true;
      }

      const outcome = await this.executeSteps({
        signal: null,
        tenant_id: resumeEvent.tenant_id,
        run_id,
        correlation_id: task.correlation_id,
        request_id: checkpoint.request_id,
        plan: checkpoint.plan,
        context: checkpoint.context,
        chain: { previous: checkpoint.previous_evidence_hash },
        from_step: checkpoint.current_step,
        approved_action: releasedAction,
        approval_ref: approvalRef,
        reconciled_action: reconciledAction,
        reconciled_effect: reconciledEffect,
        attempt_ordinal,
        assertExecutionLease: true,
      });
      if (outcome.lifecycle_state !== 'completed') {
        return {
          run_id,
          lifecycle_state: outcome.lifecycle_state,
          ...outcomeFields(outcome),
        };
      }

      if (outcome.evidence !== undefined) {
        await this.traceStage({
          tenant_id: resumeEvent.tenant_id,
          run_id,
          attempt_ordinal,
          step_index: outcome.evidence.step_index,
          stage: 'OUTCOME',
        }, async () => undefined);
        await this.updateLearningMemory(
          resumeEvent.tenant_id,
          run_id,
          undefined,
          outcome.evidence,
          attempt_ordinal,
        );
      }

      const resumedHandoff = await this.brokerPlanHandoff({
        tenant_id: resumeEvent.tenant_id,
        run_id,
        correlation_id: task.correlation_id,
        plan: checkpoint.plan,
        context: checkpoint.context,
        request_id: checkpoint.request_id,
        previous_evidence_hash: outcome.evidence?.chain_hash
          ?? checkpoint.previous_evidence_hash,
      });
      if (resumedHandoff.kind === 'PARKED') {
        return resumedHandoff.result;
      }

      const response = await this.persistFinalResponse({
        tenant_id: resumeEvent.tenant_id,
        run_id,
        request_id: checkpoint.request_id,
        context: checkpoint.context,
        plan: checkpoint.plan,
      });
      await this.dependencies.workflowEngine.transitionTask(resumeEvent.tenant_id, run_id, 'completed', 'All resumed steps verified');
      return {
        run_id,
        lifecycle_state: 'completed',
        ...outcomeFields(outcome),
        ...(response === undefined ? {} : { response }),
        ...(resumedHandoff.kind === 'ADMITTED' ? { handoff: resumedHandoff.admission } : {}),
      };
    } catch (error) {
      if (!executionResumed) {
        // A provider proof failure leaves the resume event queued so a later worker can retry the
        // authoritative GET; only an explicit manual escalation consumes the event.
        throw error;
      }
      const failure_class = classifyFailure(error);
      if (failure_class === 'UNKNOWN') {
        await this.parkTask({
          tenant_id: resumeEvent.tenant_id,
          run_id,
          reason: 'EFFECT_UNKNOWN: provider outcome indeterminate; reconciliation scheduled (§4.4)',
          plan: checkpoint.plan,
          current_step: checkpoint.current_step,
          pending_action: checkpoint.pending_action,
          context: checkpoint.context,
          previous_evidence_hash: checkpoint.previous_evidence_hash,
          request_id: checkpoint.request_id,
        });
        return {
          run_id,
          lifecycle_state: 'waiting',
          ...outcomeFields({ message: 'Provider outcome is UNKNOWN; reconciling by effect_key before any retry' }),
        };
      }
      await this.dependencies.workflowEngine.recordFailure({
        tenant_id: resumeEvent.tenant_id,
        run_id,
        error_class: failure_class,
        error_details: serializeError(error),
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

  /**
   * Finalizes and durably stores the response before the task's terminal transition. A configured
   * finalizer without a store is an invalid trust boundary and fails closed. Existing deployments
   * without a finalizer retain the historical completion behavior.
   */
  private async persistFinalResponse(params: {
    tenant_id: string;
    run_id: string;
    request_id: string;
    context: HydratedContext;
    plan: ExecutionPlan;
  }): Promise<FinalResponse | undefined> {
    const finalizer = this.dependencies.responseFinalizer;
    if (finalizer === undefined) return undefined;

    const store = this.dependencies.responseStore;
    if (store === undefined) {
      throw new OrchestratorError(
        'RESPONSE_STORE_UNBOUND',
        'A response finalizer requires a tenant-scoped run response store.',
      );
    }

    // Only a run admitted for a conversation owes a customer-visible answer. A scheduled or
    // brokered run (no conversation_id) keeps its historical completion path: it stores no
    // response and is never forced to invent grounded text for a caller that does not exist.
    if (params.context.working_memory.conversation_id === undefined) {
      return await store.read({ tenant_id: params.tenant_id, run_id: params.run_id }) ?? undefined;
    }

    const existing = await store.read({ tenant_id: params.tenant_id, run_id: params.run_id });
    const response = existing ?? await finalizer.finalize({
      tenant_id: params.tenant_id,
      run_id: params.run_id,
      ...(params.context.working_memory.conversation_id === undefined ? {} : { conversation_id: params.context.working_memory.conversation_id }),
      domain: this.responseDomain(params.plan),
      context: params.context,
      successful_receipts: await this.collectSuccessfulReceipts({
        tenant_id: params.tenant_id,
        run_id: params.run_id,
        request_id: params.request_id,
        plan: params.plan,
      }),
    });
    const verifiedResponse = this.validateFinalResponse(response);
    const senderId = params.plan.steps[params.plan.steps.length - 1]?.agent_id;
    if (senderId === undefined) {
      throw new OrchestratorError(
        'RESPONSE_SENDER_UNBOUND',
        'A persisted run response requires a trusted sender agent from the completed plan.',
      );
    }
    await store.save({
      tenant_id: params.tenant_id,
      run_id: params.run_id,
      ...(params.context.working_memory.conversation_id === undefined ? {} : { conversation_id: params.context.working_memory.conversation_id }),
      sender_id: senderId,
      response: verifiedResponse,
    });
    return verifiedResponse;
  }

  /**
   * Reads every planned step from the immutable evidence boundary. A response may never be built
   * from the mutable checkpoint or from a receipt supplied by the caller.
   */
  private async collectSuccessfulReceipts(params: {
    tenant_id: string;
    run_id: string;
    request_id: string;
    plan: ExecutionPlan;
  }): Promise<readonly VerifiedStepReceipt[]> {
    if (params.plan.steps.length === 0) {
      throw new OrchestratorError(
        'RESPONSE_EVIDENCE_MISSING',
        'A completed response requires at least one successful immutable step receipt.',
      );
    }

    const receipts: VerifiedStepReceipt[] = [];
    for (const step of [...params.plan.steps].sort((left, right) => left.step_index - right.step_index)) {
      const verified = await this.findVerifiedStepReceipt({
        tenant_id: params.tenant_id,
        run_id: params.run_id,
        request_id: params.request_id,
        step_index: step.step_index,
        plan: params.plan,
      });
      if (verified === null) {
        throw new OrchestratorError(
          'RESPONSE_EVIDENCE_INVALID',
          `Step ${step.step_index} lacks a successful immutable receipt bound to this run.`,
        );
      }
      receipts.push(verified);
    }
    return receipts;
  }

  private responseDomain(plan: ExecutionPlan): string {
    const agentId = plan.steps[0]?.agent_id;
    if (agentId?.startsWith('SAL-')) return 'sales';
    if (agentId?.startsWith('CS-')) return 'support';
    if (agentId?.startsWith('MKT-')) return 'marketing';
    return 'unknown';
  }

  private validateFinalResponse(value: FinalResponse): FinalResponse {
    if (
      !isPlainJsonObject(value)
      || typeof value.answer !== 'string'
      || value.answer.trim().length === 0
      || !Array.isArray(value.sources)
    ) {
      throw new OrchestratorError(
        'RESPONSE_INVALID',
        'A final response must contain a non-empty answer and an array of source citations.',
      );
    }
    for (const source of value.sources) {
      if (
        !isPlainJsonObject(source)
        || typeof source.source_record_id !== 'string'
        || source.source_record_id.trim().length === 0
        || typeof source.source_version !== 'string'
        || source.source_version.trim().length === 0
        || typeof source.source_file !== 'string'
        || source.source_file.trim().length === 0
      ) {
        throw new OrchestratorError(
          'RESPONSE_INVALID',
          'Every final-response citation must identify a record, version and source file.',
        );
      }
    }
    return value;
  }

  // ==========================================================================
  // INVARIANT GUARDS & SHARED SUBROUTINES
  // ==========================================================================

  /**
   * Replays the stage history a resuming process did not witness.
   *
   * The journal is per attempt and starts empty, but `assertValidTransition` admits no first entry
   * other than SIGNAL, and a resume must not re-run the derivation stages it is resuming past. The
   * durable checkpoint is the evidence for what came before: a task parked mid-plan can only be
   * mid-plan because the run reached PLAN, and a cursor past step `k` can only have advanced
   * through the full guarded cycle (ACTION → APPROVAL → EXECUTION → EVIDENCE) of every step below
   * it. Replaying exactly that committed prefix keeps the journal legal and truthful, so the
   * resumed step enters ACTION from EVIDENCE (the documented loop edge) and every entry after it
   * is guarded as usual.
   */
  private replayCommittedStages(checkpoint: DurableTaskCheckpoint): void {
    const journal = this.stageContext.getStore() ?? this.journal;
    for (const stage of ['SIGNAL', 'CONTEXT', 'HYPOTHESIS', 'DECISION', 'PLAN'] as const) {
      journal.enter(stage);
    }
    for (let step = 1; step < checkpoint.current_step; step += 1) {
      for (const stage of ['ACTION', 'APPROVAL', 'EXECUTION', 'EVIDENCE'] as const) {
        journal.enter(stage);
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
    const current = await this.dependencies.workflowEngine.getTask(params.tenant_id, params.run_id);
    const queued = current?.state_payload;
    const queuedSignal = queued !== null && typeof queued === 'object' && !Array.isArray(queued) && 'signal' in queued
      ? queued.signal
      : undefined;
    await this.dependencies.workflowEngine.transitionTask(params.tenant_id, params.run_id, 'waiting', params.reason, {
      ...(queuedSignal === undefined ? {} : { signal: queuedSignal }),
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

  private async resolveStepInputs(params: {
    tenant_id: string;
    run_id: string;
    request_id: string;
    step: PlannedStep;
    plan: ExecutionPlan;
    context: HydratedContext;
  }): Promise<Record<string, unknown> | undefined> {
    const bindings = params.step.input_bindings;
    if (bindings === undefined || Object.keys(bindings).length === 0) return undefined;
    const resolver = this.dependencies.planInputResolver;
    if (resolver === undefined) {
      throw new OrchestratorError(
        'INPUT_BINDING_RESOLVER_UNBOUND',
        `Step ${params.step.step_index} has receipt bindings but no plan input resolver is bound.`,
      );
    }

    const previous_receipts: Record<string, ExecutionReceipt> = {};
    for (const binding of Object.values(bindings)) {
      const sourceKey = String(binding.source_step_index);
      if (previous_receipts[sourceKey] !== undefined) continue;
      const verified = await this.findVerifiedStepReceipt({
        tenant_id: params.tenant_id,
        run_id: params.run_id,
        request_id: params.request_id,
        step_index: binding.source_step_index,
        plan: params.plan,
      });
      if (verified === null) {
        throw new OrchestratorError(
          'INPUT_BINDING_RECEIPT_MISSING',
          `Step ${params.step.step_index} requires a successful immutable receipt from step ${binding.source_step_index}.`,
        );
      }
      previous_receipts[sourceKey] = verified.receipt;
    }

    const resolved = await resolver.resolve({
      tenant_id: params.tenant_id,
      run_id: params.run_id,
      step: params.step,
      previous_receipts,
      context: params.context,
    });
    if (!isPlainJsonObject(resolved)) {
      throw new OrchestratorError('INPUT_BINDING_RESOLUTION_INVALID', 'A plan input resolver must return a JSON object.');
    }

    const destinations = Object.keys(bindings).sort();
    const resolvedKeys = Object.keys(resolved).sort();
    if (destinations.length !== resolvedKeys.length || destinations.some((key, index) => key !== resolvedKeys[index])) {
      throw new OrchestratorError(
        'INPUT_BINDING_RESOLUTION_INVALID',
        `Step ${params.step.step_index} resolver output must contain exactly the declared binding destinations.`,
      );
    }

    for (const [destination, binding] of Object.entries(bindings)) {
      const receipt = previous_receipts[String(binding.source_step_index)];
      if (receipt === undefined) {
        throw new OrchestratorError(
          'INPUT_BINDING_RECEIPT_MISSING',
          `Step ${params.step.step_index} has no verified source receipt for step ${binding.source_step_index}.`,
        );
      }
      const expected = this.readReceiptResponsePath(
        receipt,
        binding.response_path,
        params.step.step_index,
        destination,
      );
      let expectedCanonical: string;
      let resolvedCanonical: string;
      try {
        expectedCanonical = canonicalizeJson(expected);
        resolvedCanonical = canonicalizeJson(resolved[destination]);
      } catch {
        throw new OrchestratorError(
          'INPUT_BINDING_RESOLUTION_INVALID',
          `Step ${params.step.step_index}.${destination} resolved to a non-JSON value.`,
        );
      }
      if (expectedCanonical !== resolvedCanonical) {
        throw new OrchestratorError(
          'INPUT_BINDING_RESOLUTION_INVALID',
          `Step ${params.step.step_index}.${destination} did not preserve its verified receipt value.`,
        );
      }
    }
    return { ...resolved };
  }

  private async findVerifiedStepReceipt(params: {
    tenant_id: string;
    run_id: string;
    request_id: string;
    step_index: number;
    plan: ExecutionPlan;
  }): Promise<VerifiedStepReceipt | null> {
    const sourceStep = params.plan.steps.find((candidate) => candidate.step_index === params.step_index);
    if (sourceStep === undefined) {
      throw new OrchestratorError('INPUT_BINDING_SOURCE_INVALID', `Receipt source step ${params.step_index} is not in the plan.`);
    }
    const findByEffect = this.dependencies.evidenceLogger.findImmutableRecord;
    const findByStep = this.dependencies.evidenceLogger.findImmutableRecordByStep;
    if (findByEffect === undefined && findByStep === undefined) {
      throw new OrchestratorError(
        'INPUT_BINDING_EVIDENCE_UNBOUND',
        'Receipt bindings require a durable immutable-evidence read binding.',
      );
    }

    let evidence: ImmutableEvidenceRecord | null = null;
    if (findByEffect !== undefined) {
      const expectedEffectKey = this.dependencies.effectGuard.computeEffectKey({
        tenant_id: params.tenant_id,
        skill_id: sourceStep.skill_id,
        step_index: sourceStep.step_index,
        action_revision: 0,
        request_id: params.request_id,
      });
      evidence = await findByEffect.call(this.dependencies.evidenceLogger, {
        tenant_id: params.tenant_id,
        run_id: params.run_id,
        effect_key: expectedEffectKey,
        step_index: sourceStep.step_index,
      });
    }
    if (evidence === null && findByStep !== undefined) {
      evidence = await findByStep.call(this.dependencies.evidenceLogger, {
        tenant_id: params.tenant_id,
        run_id: params.run_id,
        step_index: sourceStep.step_index,
      });
    }
    if (evidence === null) return null;
    if (
      evidence.tenant_id !== params.tenant_id
      || evidence.run_id !== params.run_id
      || evidence.step_index !== sourceStep.step_index
      || evidence.effect_key.trim().length === 0
      || evidence.receipt === undefined
    ) {
      throw new OrchestratorError(
        'INPUT_BINDING_RECEIPT_INVALID',
        `Immutable receipt for step ${sourceStep.step_index} is not bound to this tenant, run or effect.`,
      );
    }
    if (
      evidence.receipt.adapter_status !== 'SUCCESS'
      || !isPlainJsonObject(evidence.receipt.response_payload)
    ) {
      throw new OrchestratorError(
        'INPUT_BINDING_RECEIPT_INVALID',
        `Step ${sourceStep.step_index} has no successful receipt with a JSON response payload.`,
      );
    }
    return { evidence, receipt: evidence.receipt };
  }

  private readReceiptResponsePath(
    receipt: VerifiedStepReceipt['receipt'],
    responsePath: string,
    stepIndex: number,
    destination: string,
  ): unknown {
    let value: unknown = receipt.response_payload;
    for (const segment of responsePath.split('.')) {
      if (Array.isArray(value) && /^(?:0|[1-9][0-9]?)$/.test(segment) && Number(segment) < value.length) {
        value = value[Number(segment)];
      } else if (isPlainJsonObject(value) && Object.prototype.hasOwnProperty.call(value, segment)) {
        value = value[segment];
      } else {
        throw new OrchestratorError(
          'INPUT_BINDING_RESPONSE_PATH_MISSING',
          `Step ${stepIndex}.${destination} references missing response path '${responsePath}'.`,
        );
      }
    }
    return value;
  }

  /**
   * Drafts the action for one step. `action_id` is a real UUID because `agentos.actions.id` is
   * `UUID`, and `effect_key` comes from `IEffectGuard` — never from `run_id`, a timestamp or a
   * random UUID (§3.2.3). `validateAction` is the only source of trusted price/floor metadata, so
   * the draft is handed to it before any guard reads it.
   */
  private async draftAction(
    step: PlannedStep,
    context: HydratedContext,
    run_id: string,
    tenant_id: string,
    request_id: string,
    action_revision: number,
    resolvedInputs?: Record<string, unknown>,
  ): Promise<ActionDraft> {
    const inputParameters = { ...step.input_parameters, ...resolvedInputs };
    const effect_key = this.dependencies.effectGuard.computeEffectKey({
      tenant_id, skill_id: step.skill_id, step_index: step.step_index, action_revision, request_id,
    });
    return this.dependencies.policyEngine.validateAction({
      action_id: randomUUID(), run_id, tenant_id, request_id, action_revision,
      agent_id: step.agent_id, skill_id: step.skill_id, adapter_target: step.adapter_target,
      step_index: step.step_index, mutating: step.mutating, price_bearing: step.price_bearing,
      effect_key,
      required_authority: step.required_authority,
      payload: step.mutating
        ? { ...inputParameters, tenant_id, effect_key }
        : { ...inputParameters, tenant_id },
      ...floorMirrors(step),
    }, context);
  }


  private buildClarificationPlan(
    routing: RoutingDecision,
    signal: SignalEnvelope,
    context: HydratedContext
  ): ExecutionPlan {
    const rawResponseChannel = context.working_memory?.last_touch_channel;
    const responseChannel = typeof rawResponseChannel === 'string' ? rawResponseChannel.trim() : '';
    const rawResponseSkill = context.working_memory?.response_skill_id;
    const responseSkill = typeof rawResponseSkill === 'string' ? rawResponseSkill.trim() : '';
    const rawResponseAdapterTarget = context.working_memory?.response_adapter_target;
    const responseAdapterTarget = typeof rawResponseAdapterTarget === 'string'
      ? rawResponseAdapterTarget.trim()
      : '';
    if (
      responseChannel.length === 0
      || responseSkill.length === 0
      || responseAdapterTarget.length === 0
    ) {
      throw new OrchestratorError(
        'RESPONSE_SENDER_UNBOUND',
        'A clarification response requires a trusted response channel, skill and adapter target bound in run context.',
      );
    }

    return {
      plan_id: `plan_${randomUUID()}`,
      steps: [
        {
          step_index: 1,
          agent_id: routing.target_agent,
          skill_id: responseSkill,
          adapter_target: responseAdapterTarget,
          input_parameters: {
            tenant_id: signal.tenant_id,
            recipient_id: signal.subject.channel_identifier ?? context.working_memory.session_id,
            channel: responseChannel,
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
  /**
   * STEP 10.5 of the run lifecycle: the brokered handoff (implement/04 §8, plans/customer-lifecycle.md §3).
   *
   * The handoff package and evidence references are projected by the sibling coordinator from
   * server-derived plan/context data; admission and durable parking remain owned by this façade.
   */
  private async brokerPlanHandoff(params: {
    tenant_id: string;
    run_id: string;
    correlation_id: string;
    plan: ExecutionPlan;
    context: HydratedContext;
    /** The immutable inbound identity of this run; never synthesized from the run id (§3.2.3). */
    request_id: string;
    previous_evidence_hash: string;
  }): Promise<
    | { readonly kind: 'NONE' }
    | { readonly kind: 'ADMITTED'; readonly admission: HandoffAdmission }
    | { readonly kind: 'PARKED'; readonly result: OrchestratorRunResult }
  > {
    const intent = params.plan.handoff_intent;
    if (intent === undefined) {
      return { kind: 'NONE' };
    }

    assertHandoffSourceDomain(
      intent.source_domain,
      params.plan.steps.map((step) => step.agent_id),
    );

    const draft: CrossDomainHandoffDraft = buildHandoffDraft({
      tenant_id: params.tenant_id,
      run_id: params.run_id,
      correlation_id: params.correlation_id,
      plan: params.plan,
      context: params.context,
    });

    const broker = this.dependencies.crossDomainHandoff;
    if (broker === undefined) {
      throw new OrchestratorError(
        'HANDOFF_BROKER_UNBOUND',
        'This plan declares a handoff but no cross-domain broker is bound; a journey leg is never '
          + 'reported complete without its successor (implement/09 §1.1 Gate P4).',
      );
    }

    try {
      return { kind: 'ADMITTED', admission: await broker.admit(draft) };
    } catch (error) {
      if (error instanceof OrchestratorError && error.code.startsWith('HANDOFF_')
        && error.code !== 'HANDOFF_ADMISSION_UNRESOLVED') {
        // A guard refusal is a property of the plan, not of this attempt: parking it would replay
        // the same refusal forever. Fail closed and let the durable recovery envelope book it.
        throw error;
      }

      await this.parkTask({
        tenant_id: params.tenant_id,
        run_id: params.run_id,
        reason: 'HANDOFF_ADMISSION_UNRESOLVED: the durable handoff could not be admitted; the same '
          + 'idempotency key is retried before the journey leg is reported complete (§4.4).',
        plan: params.plan,
        // The cursor is the NEXT step ordinal, not the array length.
        current_step: nextStepCursor(params.plan),
        pending_action: null,
        context: params.context,
        previous_evidence_hash: params.previous_evidence_hash,
        request_id: params.request_id,
      });

      return {
        kind: 'PARKED',
        result: {
          run_id: params.run_id,
          lifecycle_state: 'waiting',
          ...outcomeFields({
            message: 'Handoff admission unresolved; the run parks and retries the same handoff key',
          }),
        },
      };
    }
  }


  /**
   * STEP 11: LEARNING — and nothing else.
   *
   * The Learning Memory projection (§07 `/learning/`) is written by the Learning pipeline, which
   * owns prediction alignment, latency and cost for the completed run and is always tenant-scoped
   * (NFR-006). The orchestrator schedules that write by entering the stage and hands the pipeline
   * its inputs; it never fabricates a learning or FACT record inline, and never promotes the
   * HYPOTHESIS-class record it received — which is why nothing here echoes those inputs into a
   * store of its own.
   */
  private async updateLearningMemory(
    tenant_id: string,
    run_id: string,
    _hypothesis: HypothesisRecord | undefined,
    receipt: ImmutableEvidenceRecord | undefined,
    attempt_ordinal: number,
  ): Promise<void> {
    await this.traceStage({
      tenant_id,
      run_id,
      attempt_ordinal,
      step_index: receipt?.step_index ?? 0,
      stage: 'LEARNING',
    }, async () => undefined);
  }

}