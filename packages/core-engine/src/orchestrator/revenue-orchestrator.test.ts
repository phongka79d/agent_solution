/**
 * @file Orchestrator foundation cases (implement/04 §7, §8).
 *
 * These exercise the real authority verdict, effect-key, reservation, and stage journal.
 * Ports are in-memory bindings, not connectors.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  GENESIS_HASH,
  OrchestratorError,
  type AuthorityLevel,
  type ExecutionPlan,
  type ExecutionReceipt,
  type HydratedContext,
  type HypothesisRecord,
  type IEvidenceLogger,
  type PlannedStep,
  type PlatformAgentId,
  type ActionDraft,
  type RoutingDecision,
  type SignalEnvelope,
  type DurableLeaseManager,
  type IStatefulWorkflowEngine,
  type DurableTaskGuard,
} from '../contracts/index.js';
import { computeEffectKey } from '../effects/effect-key.js';
import { MemoryEffectGuard } from '../effects/memory-effect-guard.js';
import { MemoryEvidenceLogger } from '../evidence/evidence-logger.js';
import { assertValidTransition } from '../lifecycle/stages.js';
import { evaluateAuthorityVerdict } from '../policy/authority.js';
import { MemoryLeaseManager } from '../workflow/memory-lease.js';
import { MemoryWorkflowEngine } from '../workflow/memory-workflow-engine.js';
import { assertOrchestratorBrokered } from './agent-boundary.js';
import { RevenueOrchestrator } from './revenue-orchestrator.js';
import * as engine from '../index.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SESSION = 'sess-1';
const SIGNAL_ID = 'sig-inbound-1';

function signal(overrides: Partial<SignalEnvelope> = {}): SignalEnvelope {
  return {
    signal_id: SIGNAL_ID,
    tenant_id: TENANT,
    correlation_id: 'corr-1',
    source_channel: 'web',
    event_type: 'product.inquiry',
    payload: { sku: 'SKU-1' },
    subject: { session_id: SESSION, channel_type: 'web' },
    timestamp: '2026-09-22T00:00:00.000Z',
    ...overrides,
  };
}

function context(): HydratedContext {
  return {
    correlation_id: 'corr-1',
    tenant_id: TENANT,
    customer: null,
    working_memory: {
      session_id: SESSION,
      last_touch_channel: 'web',
      turn_count: 1,
      takeover_active: false,
    },
    knowledge_citations: [],
    hydrated_at: '2026-09-22T00:00:00.000Z',
  };
}

function hypothesis(): HypothesisRecord {
  return {
    classification: 'HYPOTHESIS',
    intent: 'product.inquiry',
    confidence: 0.5,
    churn_risk_score: 0,
    purchase_propensity: 0,
    reasoning: 'tagged hypothesis',
    derived_from_signals: [SIGNAL_ID],
  };
}

function step(overrides: Partial<PlannedStep> = {}): PlannedStep {
  return {
    step_index: 1,
    agent_id: 'SAL-01',
    skill_id: 'skill.test.dispatch',
    adapter_target: 'web',
    input_parameters: { text: 'hello' },
    required_authority: 'AUTH-1',
    mutating: true,
    price_bearing: false,
    idempotent: true,
    timeout_ms: 1000,
    ...overrides,
  };
}

function plan(steps: PlannedStep[]): ExecutionPlan {
  return { plan_id: 'plan-1', steps, fallback_strategy: 'FAIL_CLOSED' };
}

function receipt(): ExecutionReceipt {
  return {
    execution_id: 'exec-1',
    adapter_status: 'SUCCESS',
    provider_reference: 'ref-1',
    response_payload: {},
    latency_ms: 1,
    token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
  };
}

interface HarnessOptions {
  readonly steps?: PlannedStep[];
  readonly agents?: PlatformAgentId[];
  readonly hypothesisRecord?: HypothesisRecord;
  readonly dispatch?: (action?: ActionDraft) => Promise<ExecutionReceipt>;
  readonly effectGuard?: MemoryEffectGuard;
  /** Live SCR-005 lock state, so a case can hold the lock and release it mid-flight. */
  readonly isTakenOver?: () => Promise<boolean>;
  /** Evidence writer override (a failing audit/evidence store is a governance case, not a bug). */
  readonly evidenceLogger?: IEvidenceLogger;
  /** Durable engine override, so the claimed-queue reattempt path can be driven with a spy. */
  readonly workflowEngine?: IStatefulWorkflowEngine;
  /** Lease manager override, so a case can assert the attempt's release. */
  readonly leaseManager?: DurableLeaseManager;
  readonly reconcile?: (input: {
    readonly tenant_id: string;
    readonly effect_key: string;
    readonly action_id?: string;
    readonly adapter_target?: string;
    readonly skill_id?: string;
  }) => Promise<{
    readonly outcome: 'SUCCEEDED' | 'FAILED' | 'INDETERMINATE';
    readonly receipt?: ExecutionReceipt | unknown;
  }>;
}

function harness(options: HarnessOptions = {}) {
  const effectGuard = options.effectGuard ?? new MemoryEffectGuard();
  // The default engine is kept in its concrete type: cases that read the stored approval rows back
  // need the memory binding's own surface, while `workflow` stays the injected interface.
  const memoryWorkflow = options.workflowEngine instanceof MemoryWorkflowEngine
    ? options.workflowEngine
    : new MemoryWorkflowEngine();
  const workflow = options.workflowEngine ?? memoryWorkflow;
  const evidenceLogger = options.evidenceLogger ?? new MemoryEvidenceLogger('test-hmac-secret');
  const hydrate = vi.fn(async () => context());
  const deriveHypothesis = vi.fn(async () => options.hypothesisRecord ?? hypothesis());
  const resolveRouting = vi.fn(async (): Promise<RoutingDecision> => ({
    target_agent: options.agents?.[0] ?? 'SAL-01',
    requires_clarification: false,
    rationalization: 'orchestrator routed',
  }));
  const formulatePlan = vi.fn(async () => {
    if (options.steps !== undefined) {
      return plan(options.steps);
    }
    const agents = options.agents ?? ['SAL-01'];
    return plan(agents.map((agent_id, index) => step({ step_index: index + 1, agent_id })));
  });
  const dispatch = vi.fn(options.dispatch ?? (async (_action?: ActionDraft) => receipt()));
  const reconcile = options.reconcile !== undefined ? vi.fn(options.reconcile) : undefined;
  const orchestrator = new RevenueOrchestrator({
    contextAggregator: { hydrateContext: hydrate },
    agentRuntime: { deriveHypothesis, resolveRouting, formulatePlan },
    policyEngine: {
      validateAction: async (action) => action,
      evaluateAuthority: async (action) => {
        const verdict = evaluateAuthorityVerdict('AUTH-3', action.required_authority);
        const claimedApproval = action.approval_id;
        // A claimed approval covers this exact action and satisfies AUTH-4 only (ports.ts
        // `IPolicyEngine.evaluateAuthority`). The released action carries the `approval_id` the
        // orchestrator claimed, so the fake reports the AUTO_APPROVED verdict the real PEP returns
        // for a bound claim instead of re-routing the step to a second approval.
        if (verdict.verdict === 'AWAITING_HUMAN_APPROVAL' && claimedApproval !== undefined && claimedApproval.length > 0) {
          return {
            verdict: 'AUTO_APPROVED',
            approval_id: claimedApproval,
            reason: 'A claimed approval bound to this action satisfies the AUTH-4 pause.',
          };
        }
        return { verdict: verdict.verdict, reason: verdict.reason };
      },
    },
    workflowEngine: workflow,
    evidenceLogger,
    auditTrail: { append: async () => undefined },
    adapterDispatcher: {
      dispatch,
      ...(reconcile !== undefined ? { reconcile } : {}),
    },
    effectGuard,
    sessionControl: {
      isTakenOver: options.isTakenOver ?? (async () => false),
      returnToAgent: async () => undefined,
    },
    leaseManager: options.leaseManager ?? new MemoryLeaseManager(),
    workerId: 'worker-test',
  });
  return { orchestrator, effectGuard, workflow, memoryWorkflow, evidenceLogger, hydrate, deriveHypothesis, resolveRouting, formulatePlan, dispatch, reconcile };
}

function getDispatchedAction(dispatch: { mock: { calls: unknown[] } }, index: number): ActionDraft {
  const calls = dispatch.mock.calls as unknown[][];
  const call = calls[index];
  if (!call || call[0] === undefined) {
    throw new Error(`Expected dispatch call at index ${index}`);
  }
  return call[0] as ActionDraft;
}

describe('RevenueOrchestrator', () => {
  it('walks the eleven stages in order and chains evidence from genesis', async () => {
    const { orchestrator, dispatch } = harness();
    const result = await orchestrator.processSignal(signal());

    expect(result.lifecycle_state).toBe('completed');
    expect(orchestrator.visitedStages).toEqual([
      'SIGNAL', 'CONTEXT', 'HYPOTHESIS', 'DECISION', 'PLAN', 'ACTION',
      'APPROVAL', 'EXECUTION', 'EVIDENCE', 'OUTCOME', 'LEARNING',
    ]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.evidence?.previous_evidence_hash).toBe(GENESIS_HASH);
  });

  it('rejects an illegal stage skip and does not execute an AUTH-5 step', async () => {
    expect(() => assertValidTransition(null, 'PLAN')).toThrow(OrchestratorError);
    try {
      assertValidTransition(null, 'PLAN');
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestratorError);
      expect((error as OrchestratorError).code).toBe('INVALID_STAGE_TRANSITION');
    }

    const { orchestrator, dispatch, workflow } = harness({
      steps: [step({ required_authority: 'AUTH-5' })],
    });
    const result = await orchestrator.processSignal(signal());
    expect(result.lifecycle_state).toBe('stopped');
    expect(orchestrator.visitedStages).not.toContain('EXECUTION');
    expect(dispatch).not.toHaveBeenCalled();
    expect((await workflow.getTask(TENANT, result.run_id))?.state).not.toBe('awaiting_human');
  });

  it('routes AUTH-4 to approval and does not dispatch', async () => {
    const { orchestrator, dispatch, workflow } = harness({
      steps: [step({ required_authority: 'AUTH-4' satisfies AuthorityLevel })],
    });
    const result = await orchestrator.processSignal(signal());

    expect(result.lifecycle_state).toBe('awaiting_human');
    expect(dispatch).not.toHaveBeenCalled();
    expect(orchestrator.visitedStages).toContain('APPROVAL');
    expect(orchestrator.visitedStages).not.toContain('EXECUTION');
    expect((await workflow.getTask(TENANT, result.run_id))?.state).toBe('awaiting_human');
    expect(evaluateAuthorityVerdict('AUTH-3', 'AUTH-4').verdict).toBe('AWAITING_HUMAN_APPROVAL');
  });

  it('hard-denies AUTH-5 without queueing an approval', async () => {
    const { orchestrator, dispatch, workflow } = harness({
      steps: [step({ required_authority: 'AUTH-5' })],
    });
    const result = await orchestrator.processSignal(signal());

    expect(result.lifecycle_state).toBe('stopped');
    expect(dispatch).not.toHaveBeenCalled();
    expect((await workflow.getTask(TENANT, result.run_id))?.state).toBe('stopped');
    expect(evaluateAuthorityVerdict('AUTH-3', 'AUTH-5').verdict).toBe('DENIED');
  });

  it('executes a cross-agent plan only through the orchestrator', async () => {
    const { orchestrator, dispatch, deriveHypothesis, resolveRouting, formulatePlan } = harness({
      agents: ['MKT-01', 'SAL-01'],
    });
    const decision: RoutingDecision = {
      target_agent: 'MKT-01',
      requires_clarification: false,
      rationalization: 'brokered',
    };

    expect(assertOrchestratorBrokered(decision).target_agent).toBe('MKT-01');
    await orchestrator.processSignal(signal());

    expect(deriveHypothesis).toHaveBeenCalledTimes(1);
    expect(resolveRouting).toHaveBeenCalledTimes(1);
    expect(formulatePlan).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(engine).not.toHaveProperty('invokeAgent');
    expect(engine).not.toHaveProperty('callAgent');
    expect(engine).not.toHaveProperty('messageAgent');
    expect(engine).not.toHaveProperty('dispatchPeer');
  });

  it('derives the same effect key for a replayed inbound signal and does not dispatch twice', async () => {
    const effectGuard = new MemoryEffectGuard();
    const first = harness({ effectGuard });
    const second = harness({ effectGuard });
    const firstResult = await first.orchestrator.processSignal(signal());
    const secondResult = await second.orchestrator.processSignal(signal());
    const key = computeEffectKey({
      tenant_id: TENANT,
      skill_id: 'skill.test.dispatch',
      step_index: 1,
      action_revision: 0,
      request_id: SIGNAL_ID,
    });

    expect(firstResult.run_id).not.toBe(secondResult.run_id);
    expect(key).not.toContain(firstResult.run_id);
    expect(key).not.toContain(secondResult.run_id);
    expect(effectGuard.peek(TENANT, key)?.status).toBe('SUCCEEDED');
    expect(first.dispatch).toHaveBeenCalledTimes(1);
    expect(second.dispatch).not.toHaveBeenCalled();
  });

  it('fails closed on a missing session, a missing floor, and a non-hypothesis record', async () => {
    const missingSession = harness();
    const blankSubject = signal({ subject: { session_id: '', channel_type: 'web' } });
    await expect(missingSession.orchestrator.processSignal(blankSubject)).rejects.toMatchObject({
      code: 'INVALID_SESSION',
    });
    expect(missingSession.hydrate).not.toHaveBeenCalled();
    expect(missingSession.dispatch).not.toHaveBeenCalled();

    const missingFloor = harness({
      steps: [step({ price_bearing: true, proposed_price: 80 })],
    });
    await expect(missingFloor.orchestrator.processSignal(signal())).rejects.toMatchObject({
      code: 'P_FLOOR_UNAVAILABLE',
    });
    expect(missingFloor.dispatch).not.toHaveBeenCalled();

    const illegal = harness({
      hypothesisRecord: { ...hypothesis(), classification: 'FACT' } as unknown as HypothesisRecord,
    });
    await expect(illegal.orchestrator.processSignal(signal())).rejects.toMatchObject({
      code: 'SECURITY_VIOLATION',
    });
  });

  it('parks an unconfirmed mutating dispatch and does not retry it', async () => {
    const effectGuard = new MemoryEffectGuard();
    const first = harness({
      effectGuard,
      dispatch: async () => {
        throw new OrchestratorError('DISPATCH_TIMEOUT', 'deadline');
      },
    });
    const result = await first.orchestrator.processSignal(signal());
    const key = computeEffectKey({
      tenant_id: TENANT,
      skill_id: 'skill.test.dispatch',
      step_index: 1,
      action_revision: 0,
      request_id: SIGNAL_ID,
    });

    expect(result.lifecycle_state).toBe('waiting');
    expect(effectGuard.peek(TENANT, key)?.status).toBe('RESERVED');
    expect(first.dispatch).toHaveBeenCalledTimes(1);

    const second = harness({ effectGuard });
    const replay = await second.orchestrator.processSignal(signal());
    expect(replay.lifecycle_state).toBe('waiting');
    expect(second.dispatch).not.toHaveBeenCalled();
    expect(effectGuard.peek(TENANT, key)?.status).toBe('RESERVED');
  });

  /**
   * A durable task claimed by the worker, already past PLAN, so `processQueuedSignal` re-enters the
   * persisted plan instead of re-deciding it. The engine is a spy because this path is about what
   * the orchestrator writes back to it.
   */
  function reattemptHarness(options: {
    readonly step?: PlannedStep;
    readonly pendingAction?: ActionDraft | null;
    readonly dispatch?: () => Promise<ExecutionReceipt>;
  } = {}) {
    const run_id = 'run-requeued-1';
    const plannedStep = options.step ?? step({ skill_id: 'skill.test.read', mutating: false });
    const checkpoint = {
      signal: signal(),
      plan: plan([plannedStep]),
      context: context(),
      current_step: 1,
      pending_action: options.pendingAction ?? null,
      previous_evidence_hash: GENESIS_HASH,
      request_id: SIGNAL_ID,
    };
    const workflow = {
      getTask: vi.fn(async () => ({
        task_version: 4,
        state: 'running' as const,
        correlation_id: 'corr-1',
        state_payload: checkpoint,
        lease_owner: 'worker-test',
        lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
      })),
      updateTaskProgress: vi.fn(async () => undefined),
      transitionTask: vi.fn(async () => undefined),
      recordFailure: vi.fn(async () => ({ requeued: true })),
    } as unknown as IStatefulWorkflowEngine;
    const leaseManager: DurableLeaseManager = {
      acquireLease: vi.fn(async () => true),
      releaseLease: vi.fn(async () => undefined),
    };
    const { orchestrator } = harness({
      workflowEngine: workflow,
      leaseManager,
      dispatch: options.dispatch ?? (async () => receipt()),
      steps: [plannedStep],
    });

    return { orchestrator, run_id, workflow, leaseManager, checkpoint };
  }

  it('books the failure of a re-claimed run instead of returning it to the queue unrecorded', async () => {
    // §4.4: the reattempt of a persisted plan is an attempt like any other. Before this, a second
    // failure escaped with no error class and no retry consumed, so the run returned to `queued`
    // and was claimed again forever.
    const { orchestrator, run_id, workflow, leaseManager } = reattemptHarness({
      dispatch: async () => {
        throw new OrchestratorError('PROVIDER_UNAVAILABLE', 'provider is down');
      },
    });

    await expect(
      orchestrator.processQueuedSignal(run_id, signal(), { worker_id: 'worker-test' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });

    expect(workflow.recordFailure).toHaveBeenCalledTimes(1);
    const [failure] = vi.mocked(workflow.recordFailure).mock.calls[0] as [
      { tenant_id: string; run_id: string; error_class: string; error_details: { code: string; message: string } },
    ];
    expect(failure.tenant_id).toBe(TENANT);
    expect(failure.run_id).toBe(run_id);
    expect(failure.error_class).toBe('RETRYABLE');
    expect(failure.error_details.code).toBe('PROVIDER_UNAVAILABLE');
    expect(failure.error_details.message).toContain('provider is down');
    expect(leaseManager.releaseLease).toHaveBeenCalledWith(TENANT, run_id, 'worker-test');
  });

  it('parks a restarted mutating step on the checkpoint waiting requires', async () => {
    // §4.2 stores `waiting` with a REPLACED payload, so the park must carry the complete checkpoint:
    // the transport would refuse anything less, and the scheduler resumes from exactly these members.
    const pendingAction = {
      action_id: 'action-1',
      run_id: 'run-requeued-1',
      tenant_id: TENANT,
      agent_id: 'SAL-01' as PlatformAgentId,
      skill_id: 'skill.test.mutate',
      adapter_target: 'web',
      step_index: 1,
      mutating: true,
      price_bearing: false,
      request_id: SIGNAL_ID,
      action_revision: 0,
      effect_key: 'effect-key-1',
      required_authority: 'AUTH-1' as AuthorityLevel,
      payload: { text: 'hello' },
    };
    const { orchestrator, run_id, workflow, checkpoint } = reattemptHarness({
      step: step({ skill_id: 'skill.test.mutate', mutating: true }),
      pendingAction,
    });

    const result = await orchestrator.processQueuedSignal(run_id, signal(), {
      worker_id: 'worker-test',
    });

    expect(result.lifecycle_state).toBe('waiting');
    expect(workflow.transitionTask).toHaveBeenCalledWith(
      TENANT,
      run_id,
      'waiting',
      expect.stringContaining('reconciliation'),
      checkpoint,
    );
    expect(workflow.recordFailure).not.toHaveBeenCalled();
  });

  it('refuses an AUTH-4 release while an operator holds the SCR-005 lock and leaves the approval claimable', async () => {
    let takeover = false;
    const { orchestrator, dispatch, workflow, memoryWorkflow } = harness({
      steps: [step({ required_authority: 'AUTH-4' satisfies AuthorityLevel })],
      isTakenOver: async () => takeover,
    });
    const claim = vi.spyOn(workflow, 'claimApprovalAndResume');

    const paused = await orchestrator.processSignal(signal());
    expect(paused.lifecycle_state).toBe('awaiting_human');
    const approval = memoryWorkflow.listApprovals(TENANT, paused.run_id)[0];
    if (approval === undefined) throw new Error('the AUTH-4 pause must leave one PENDING approval row');
    expect(approval.decision).toBe('PENDING');

    // The lock lands while the task is parked. A release opens a dispatch, so the resume must
    // refuse BEFORE the single-use claim: the claim is irreversible and consuming it here would
    // burn the run's only resume authority for an action no operator may dispatch.
    takeover = true;
    await expect(orchestrator.resumeTask(paused.run_id, {
      tenant_id: TENANT,
      event_type: 'human.approval',
      approval_id: approval.approval_id,
      operator_id: 'operator-1',
      expected_payload_sha256: approval.payload_sha256,
    })).rejects.toMatchObject({ code: 'HUMAN_TAKEOVER' });

    expect(claim).not.toHaveBeenCalled();
    expect(memoryWorkflow.listApprovals(TENANT, paused.run_id)[0]?.decision).toBe('PENDING');
    expect((await workflow.getTask(TENANT, paused.run_id))?.state).toBe('awaiting_human');
    expect(dispatch).not.toHaveBeenCalled();

    // The operator returns the conversation: the same approval is still the run's resume authority.
    takeover = false;
    const resumed = await orchestrator.resumeTask(paused.run_id, {
      tenant_id: TENANT,
      event_type: 'human.approval',
      approval_id: approval.approval_id,
      operator_id: 'operator-1',
      expected_payload_sha256: approval.payload_sha256,
    });

    expect(claim).toHaveBeenCalledTimes(1);
    expect(resumed.lifecycle_state).toBe('completed');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('still lets a rejection resolve the run while an operator holds the lock', async () => {
    let takeover = false;
    const { orchestrator, memoryWorkflow } = harness({
      steps: [step({ required_authority: 'AUTH-4' satisfies AuthorityLevel })],
      isTakenOver: async () => takeover,
    });

    const paused = await orchestrator.processSignal(signal());
    const approval = memoryWorkflow.listApprovals(TENANT, paused.run_id)[0];
    if (approval === undefined) throw new Error('the AUTH-4 pause must leave one PENDING approval row');

    // A rejection opens no dispatch, so the lock must not freeze the operator out of resolving the
    // run: the decision is claimed and the task stops instead of staying parked forever.
    takeover = true;
    const rejected = await orchestrator.resumeTask(paused.run_id, {
      tenant_id: TENANT,
      event_type: 'human.reject',
      approval_id: approval.approval_id,
      operator_id: 'operator-1',
      expected_payload_sha256: approval.payload_sha256,
      reason: 'out of policy',
    });

    expect(rejected.lifecycle_state).toBe('stopped');
    expect(memoryWorkflow.listApprovals(TENANT, paused.run_id)[0]?.decision).toBe('REJECTED');
  });

  it('stops the next plan step when an operator takes over between steps', async () => {
    let takeover = false;
    const { orchestrator, dispatch, workflow } = harness({
      steps: [
        step({ step_index: 1, skill_id: 'skill.test.first' }),
        step({ step_index: 2, skill_id: 'skill.test.second' }),
      ],
      // The lock lands while the first effect is in flight, so only the second step sees it.
      dispatch: async () => {
        takeover = true;
        return receipt();
      },
      isTakenOver: async () => takeover,
    });

    const result = await orchestrator.processSignal(signal());

    expect(result.lifecycle_state).toBe('stopped');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await workflow.getTask(TENANT, result.run_id))?.state).toBe('stopped');
  });

  it('parks a dispatched mutating step when its evidence write fails, without claiming success or re-dispatching', async () => {
    const effectGuard = new MemoryEffectGuard();
    const backing = new MemoryEvidenceLogger('test-hmac-secret');
    let evidenceStoreDown = true;
    const evidenceLogger: IEvidenceLogger = {
      createImmutableRecord: async (params) => {
        if (evidenceStoreDown) {
          evidenceStoreDown = false;
          throw new Error('evidence store unavailable');
        }
        return backing.createImmutableRecord(params);
      },
      initializeOutcomeWatch: (params) => backing.initializeOutcomeWatch(params),
      logAgentRun: (runLog) => backing.logAgentRun(runLog),
    };
    const { orchestrator, dispatch, workflow } = harness({ effectGuard, evidenceLogger });
    const key = computeEffectKey({
      tenant_id: TENANT,
      skill_id: 'skill.test.dispatch',
      step_index: 1,
      action_revision: 0,
      request_id: SIGNAL_ID,
    });

    const result = await orchestrator.processSignal(signal());

    // The effect may already have landed, so the failure is a reconciliation obligation: no
    // success is claimed, nothing is re-dispatched, and the run is parked on the same effect_key.
    expect(result.lifecycle_state).toBe('waiting');
    expect(result.evidence).toBeUndefined();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(effectGuard.peek(TENANT, key)?.status).toBe('SUCCEEDED');
    expect((await workflow.getTask(TENANT, result.run_id))?.state).toBe('waiting');
    expect(backing.listEvidence(TENANT, result.run_id)).toHaveLength(0);
    expect(backing.listAgentRuns(TENANT, result.run_id)).toHaveLength(0);

    // Reconciled by effect_key: the reserved success replays its stored receipt and the adapter is
    // never called a second time.
    const reconciled = await orchestrator.resumeTask(result.run_id, {
      tenant_id: TENANT,
      event_type: 'timer.expired',
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(reconciled.lifecycle_state).toBe('completed');
    expect(backing.listEvidence(TENANT, result.run_id)).toHaveLength(1);
  });
  it('consumes manual escalation without leaving a reclaimable resume event', async () => {
    const { orchestrator, workflow } = harness({
      dispatch: async () => {
        throw new OrchestratorError('DISPATCH_TIMEOUT', 'deadline');
      },
    });

    const waiting = await orchestrator.processSignal(signal());
    const resumed = await orchestrator.resumeTask(waiting.run_id, {
      tenant_id: TENANT,
      event_type: 'human.reconcile',
      operator_id: 'operator-1',
      reconciliation_resolution: 'ESCALATE_MANUALLY',
      reason: 'provider outcome needs manual follow-up',
    });

    expect(resumed.lifecycle_state).toBe('waiting');
    const task = await workflow.getTask(TENANT, waiting.run_id);
    expect(task?.state).toBe('waiting');
    expect(task?.state_payload).not.toHaveProperty('resume_event');
  });
  it('rejects operator-only provider proof and retains the reconciliation event on unavailable proof', async () => {
    const { orchestrator, workflow, dispatch } = harness({
      dispatch: async () => {
        throw new OrchestratorError('DISPATCH_TIMEOUT', 'deadline');
      },
    });

    const waiting = await orchestrator.processSignal(signal());
    const resumeEvent = {
      tenant_id: TENANT,
      event_type: 'human.reconcile' as const,
      operator_id: 'operator-1',
      reconciliation_resolution: 'PROVIDER_CONFIRMED_ABSENT' as const,
      reconciliation_receipt: { receipt_id: 'operator-receipt-1' },
      reason: 'operator claimed absence without provider proof',
    };
    const taskBefore = await workflow.getTask(TENANT, waiting.run_id);
    await workflow.transitionTask(
      TENANT,
      waiting.run_id,
      'waiting',
      'queue reconciliation resume event',
      {
        ...(taskBefore?.state_payload as Record<string, unknown>),
        resume_event: resumeEvent,
      },
    );

    await expect(orchestrator.resumeTask(waiting.run_id, resumeEvent)).rejects.toMatchObject({
      code: 'RECONCILIATION_PROVIDER_UNAVAILABLE',
    });

    const task = await workflow.getTask(TENANT, waiting.run_id);
    expect(task?.state).toBe('waiting');
    expect(task?.state_payload).toHaveProperty('resume_event');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('rejects operator-only provider proof and retains the reconciliation event on indeterminate proof', async () => {
    const { orchestrator, workflow, dispatch, reconcile } = harness({
      dispatch: async () => {
        throw new OrchestratorError('DISPATCH_TIMEOUT', 'deadline');
      },
      reconcile: async () => ({ outcome: 'INDETERMINATE' }),
    });

    const waiting = await orchestrator.processSignal(signal());
    const resumeEvent = {
      tenant_id: TENANT,
      event_type: 'human.reconcile' as const,
      operator_id: 'operator-1',
      reconciliation_resolution: 'PROVIDER_CONFIRMED_SUCCEEDED' as const,
      reconciliation_receipt: { receipt_id: 'operator-receipt-1' },
      reason: 'operator claimed success but provider returned indeterminate',
    };
    const taskBefore = await workflow.getTask(TENANT, waiting.run_id);
    await workflow.transitionTask(
      TENANT,
      waiting.run_id,
      'waiting',
      'queue reconciliation resume event',
      {
        ...(taskBefore?.state_payload as Record<string, unknown>),
        resume_event: resumeEvent,
      },
    );

    await expect(orchestrator.resumeTask(waiting.run_id, resumeEvent)).rejects.toMatchObject({
      code: 'RECONCILIATION_PROVIDER_PROOF_REQUIRED',
    });

    expect(reconcile).toHaveBeenCalledTimes(1);
    const task = await workflow.getTask(TENANT, waiting.run_id);
    expect(task?.state).toBe('waiting');
    expect(task?.state_payload).toHaveProperty('resume_event');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('replays provider-confirmed success without second dispatch, ignoring operator receipts and clearing resume event', async () => {
    const effectGuard = new MemoryEffectGuard();
    const backing = new MemoryEvidenceLogger('test-hmac-secret');
    const providerReceipt: ExecutionReceipt = {
      execution_id: 'provider-proof-1',
      adapter_status: 'SUCCESS',
      provider_reference: 'prov-tx-999',
      response_payload: { verified: true },
      latency_ms: 42,
      token_usage: { prompt: 1, completion: 2, total_cost_usd: 0.0001 },
    };

    const { orchestrator, workflow, dispatch, reconcile } = harness({
      effectGuard,
      evidenceLogger: backing,
      dispatch: async () => {
        throw new OrchestratorError('DISPATCH_TIMEOUT', 'deadline');
      },
      reconcile: async () => ({
        outcome: 'SUCCEEDED',
        receipt: providerReceipt,
      }),
    });

    const waiting = await orchestrator.processSignal(signal());
    const key = computeEffectKey({
      tenant_id: TENANT,
      skill_id: 'skill.test.dispatch',
      step_index: 1,
      action_revision: 0,
      request_id: SIGNAL_ID,
    });

    expect(effectGuard.peek(TENANT, key)?.status).toBe('RESERVED');
    expect(dispatch).toHaveBeenCalledTimes(1);
    const initialAction = getDispatchedAction(dispatch, 0);
    expect(initialAction.effect_key).toBe(key);

    const resumeEvent = {
      tenant_id: TENANT,
      event_type: 'human.reconcile' as const,
      operator_id: 'operator-1',
      reconciliation_resolution: 'PROVIDER_CONFIRMED_ABSENT' as const,
      reconciliation_receipt: { receipt_id: 'bogus-operator-receipt' },
      reason: 'verifying provider proof precedence',
    };
    const taskBefore = await workflow.getTask(TENANT, waiting.run_id);
    await workflow.transitionTask(
      TENANT,
      waiting.run_id,
      'waiting',
      'queue reconciliation resume event',
      {
        ...(taskBefore?.state_payload as Record<string, unknown>),
        resume_event: resumeEvent,
      },
    );

    const result = await orchestrator.resumeTask(waiting.run_id, resumeEvent);

    expect(result.lifecycle_state).toBe('completed');
    expect(reconcile).toHaveBeenCalledWith({
      tenant_id: TENANT,
      effect_key: key,
      action_id: initialAction.action_id,
      adapter_target: 'web',
      skill_id: 'skill.test.dispatch',
    });
    expect(dispatch).toHaveBeenCalledTimes(1);

    const settled = effectGuard.peek(TENANT, key);
    expect(settled?.status).toBe('SUCCEEDED');
    expect(settled?.receipt).toEqual(providerReceipt);

    const task = await workflow.getTask(TENANT, waiting.run_id);
    expect(task?.state).toBe('completed');
    expect(task?.state_payload).not.toHaveProperty('resume_event');

    const evidenceList = backing.listEvidence(TENANT, waiting.run_id);
    expect(evidenceList).toHaveLength(1);
    const evidencePayload = JSON.parse(evidenceList[0]!.raw_payload) as {
      action: ActionDraft;
      receipt: unknown;
      replayed: boolean;
    };
    expect(evidencePayload.receipt).toEqual(providerReceipt);
    expect(evidencePayload.replayed).toBe(true);
    expect(evidencePayload.action.action_id).toBe(initialAction.action_id);
    expect(evidencePayload.action.effect_key).toBe(key);
    expect(evidencePayload.action.payload).toEqual(initialAction.payload);
  });

  it('settles FAILED, reopens same effect key and permits exactly one re-dispatch on provider-confirmed absence', async () => {
    const effectGuard = new MemoryEffectGuard();
    const backing = new MemoryEvidenceLogger('test-hmac-secret');
    let dispatchCount = 0;
    const secondDispatchReceipt: ExecutionReceipt = {
      execution_id: 'redispatch-exec-2',
      adapter_status: 'SUCCESS',
      provider_reference: 'prov-tx-second-try',
      response_payload: { status: 'created' },
      latency_ms: 15,
      token_usage: { prompt: 2, completion: 4, total_cost_usd: 0.0002 },
    };

    const { orchestrator, workflow, dispatch, reconcile } = harness({
      effectGuard,
      evidenceLogger: backing,
      dispatch: async () => {
        dispatchCount += 1;
        if (dispatchCount === 1) {
          throw new OrchestratorError('DISPATCH_TIMEOUT', 'initial dispatch timed out');
        }
        return secondDispatchReceipt;
      },
      reconcile: async () => ({
        outcome: 'FAILED',
      }),
    });

    const waiting = await orchestrator.processSignal(signal());
    const key = computeEffectKey({
      tenant_id: TENANT,
      skill_id: 'skill.test.dispatch',
      step_index: 1,
      action_revision: 0,
      request_id: SIGNAL_ID,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    const initialAction = getDispatchedAction(dispatch, 0);
    expect(initialAction.effect_key).toBe(key);
    const resumeEvent = {
      tenant_id: TENANT,
      event_type: 'human.reconcile' as const,
      operator_id: 'operator-1',
      reconciliation_resolution: 'PROVIDER_CONFIRMED_SUCCEEDED' as const,
      reconciliation_receipt: { receipt_id: 'bogus-operator-receipt' },
      reason: 'verifying provider absence triggers reopen and redispatch',
    };
    const taskBefore = await workflow.getTask(TENANT, waiting.run_id);
    await workflow.transitionTask(
      TENANT,
      waiting.run_id,
      'waiting',
      'queue reconciliation resume event',
      {
        ...(taskBefore?.state_payload as Record<string, unknown>),
        resume_event: resumeEvent,
      },
    );

    const result = await orchestrator.resumeTask(waiting.run_id, resumeEvent);

    expect(result.lifecycle_state).toBe('completed');
    expect(reconcile).toHaveBeenCalledWith({
      tenant_id: TENANT,
      effect_key: key,
      action_id: initialAction.action_id,
      adapter_target: 'web',
      skill_id: 'skill.test.dispatch',
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    const secondAction = getDispatchedAction(dispatch, 1);
    expect(secondAction.action_id).toBe(initialAction.action_id);
    expect(secondAction.effect_key).toBe(key);
    expect(secondAction.payload).toEqual(initialAction.payload);
    const settled = effectGuard.peek(TENANT, key);
    expect(settled?.status).toBe('SUCCEEDED');
    expect(settled?.receipt).toEqual(secondDispatchReceipt);

    const task = await workflow.getTask(TENANT, waiting.run_id);
    expect(task?.state).toBe('completed');
    expect(task?.state_payload).not.toHaveProperty('resume_event');

    const evidenceList = backing.listEvidence(TENANT, waiting.run_id);
    expect(evidenceList).toHaveLength(1);
    const evidencePayload = JSON.parse(evidenceList[0]!.raw_payload) as {
      action: ActionDraft;
      receipt: unknown;
      replayed: boolean;
    };
    expect(evidencePayload.receipt).toEqual(secondDispatchReceipt);
    expect(evidencePayload.replayed).toBe(false);
    expect(evidencePayload.action.action_id).toBe(initialAction.action_id);
    expect(evidencePayload.action.effect_key).toBe(key);
    expect(evidencePayload.action.payload).toEqual(initialAction.payload);
  });

  it('enforces task-version and lease fencing during provider-proof reconciliation', async () => {
    const plannedStep = step({ step_index: 1, mutating: true });
    const pendingAction: ActionDraft = {
      action_id: 'action-fenced-1',
      run_id: 'run-fenced-1',
      tenant_id: TENANT,
      agent_id: plannedStep.agent_id,
      skill_id: plannedStep.skill_id,
      adapter_target: plannedStep.adapter_target,
      step_index: 1,
      mutating: true,
      price_bearing: plannedStep.price_bearing,
      request_id: SIGNAL_ID,
      action_revision: 0,
      effect_key: computeEffectKey({
        tenant_id: TENANT,
        skill_id: plannedStep.skill_id,
        step_index: 1,
        action_revision: 0,
        request_id: SIGNAL_ID,
      }),
      payload: plannedStep.input_parameters,
      required_authority: plannedStep.required_authority,
    };
    const resumeEvent = {
      tenant_id: TENANT,
      event_type: 'human.reconcile' as const,
      operator_id: 'operator-1',
      reconciliation_resolution: 'PROVIDER_CONFIRMED_SUCCEEDED' as const,
    };
    const checkpoint = {
      signal: signal(),
      plan: plan([plannedStep]),
      context: context(),
      current_step: 1,
      pending_action: pendingAction,
      previous_evidence_hash: GENESIS_HASH,
      request_id: SIGNAL_ID,
      resume_event: resumeEvent,
    };
    let currentVersion = 10;
    const taskRecord = {
      task_version: currentVersion,
      state: 'waiting' as const,
      correlation_id: 'corr-1',
      state_payload: checkpoint,
      lease_owner: 'worker-test',
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const transitions: Array<{ state: string; guard?: DurableTaskGuard }> = [];
    const workflow = {
      getTask: vi.fn(async () => ({ ...taskRecord, task_version: currentVersion })),
      updateTaskProgress: vi.fn(async () => undefined),
      transitionTask: vi.fn(async (_t, _r, state, _reason, cp, guard) => {
        transitions.push({ state, guard });
        currentVersion += 1;
        taskRecord.task_version = currentVersion;
        if (cp !== undefined) {
          taskRecord.state_payload = cp as typeof checkpoint;
        }
      }),
      recordFailure: vi.fn(async () => ({ requeued: true })),
    } as unknown as IStatefulWorkflowEngine;
    const leaseManager: DurableLeaseManager = {
      acquireLease: vi.fn(async () => true),
      releaseLease: vi.fn(async () => undefined),
    };
    const effectGuard = new MemoryEffectGuard();
    await effectGuard.reserve({
      tenant_id: TENANT,
      run_id: 'run-fenced-1',
      request_id: SIGNAL_ID,
      effect_key: pendingAction.effect_key,
      request_fingerprint: effectGuard.computeRequestFingerprint(pendingAction.payload),
      skill_id: plannedStep.skill_id,
      step_index: 1,
      action_revision: 0,
    });
    const { orchestrator } = harness({
      workflowEngine: workflow,
      leaseManager,
      effectGuard,
      steps: [plannedStep],
      reconcile: async () => ({
        outcome: 'SUCCEEDED',
        receipt: receipt(),
      }),
    });

    const result = await orchestrator.resumeTask('run-fenced-1', resumeEvent);
    expect(result.lifecycle_state).toBe('completed');
    expect(transitions[0]).toEqual({
      state: 'running',
      guard: { expected_task_version: 10, lease_owner: 'worker-test' },
    });
    expect(transitions).toHaveLength(2);
    const finalTransition = transitions[1];
    expect(finalTransition).toBeDefined();
    if (!finalTransition) {
      throw new Error('Expected final transition');
    }
    expect(finalTransition.state).toBe('completed');
  });

  it('prevents unclaimable waiting row on provider-proof write interruption and replays safely on retry', async () => {
    const effectGuard = new MemoryEffectGuard();
    const backing = new MemoryEvidenceLogger('test-hmac-secret');
    const providerReceipt: ExecutionReceipt = {
      execution_id: 'provider-proof-replay-1',
      adapter_status: 'SUCCESS',
      provider_reference: 'prov-tx-replay-42',
      response_payload: { settled: true },
      latency_ms: 30,
      token_usage: { prompt: 2, completion: 2, total_cost_usd: 0.0001 },
    };

    const { orchestrator, workflow, dispatch } = harness({
      effectGuard,
      evidenceLogger: backing,
      dispatch: async () => {
        throw new OrchestratorError('DISPATCH_TIMEOUT', 'initial dispatch timed out');
      },
      reconcile: async () => ({
        outcome: 'SUCCEEDED',
        receipt: providerReceipt,
      }),
    });

    const waiting = await orchestrator.processSignal(signal());
    const key = computeEffectKey({
      tenant_id: TENANT,
      skill_id: 'skill.test.dispatch',
      step_index: 1,
      action_revision: 0,
      request_id: SIGNAL_ID,
    });

    expect(effectGuard.peek(TENANT, key)?.status).toBe('RESERVED');
    expect(dispatch).toHaveBeenCalledTimes(1);

    const resumeEvent = {
      tenant_id: TENANT,
      event_type: 'human.reconcile' as const,
      operator_id: 'operator-1',
      reconciliation_resolution: 'PROVIDER_CONFIRMED_SUCCEEDED' as const,
      reconciliation_receipt: { receipt_id: 'operator-receipt-1' },
      reason: 'verifying interruption replay does not leave unclaimable waiting row',
    };
    const taskBefore = await workflow.getTask(TENANT, waiting.run_id);
    await workflow.transitionTask(
      TENANT,
      waiting.run_id,
      'waiting',
      'queue reconciliation resume event',
      {
        ...(taskBefore?.state_payload as Record<string, unknown>),
        resume_event: resumeEvent,
      },
    );

    // Simulate a write interruption on the decisive transition to 'running'
    const originalTransition = workflow.transitionTask.bind(workflow);
    let failRunningTransition = true;
    vi.spyOn(workflow, 'transitionTask').mockImplementation(async (tenant_id, run_id, state, reason, cp?, guard?) => {
      if (failRunningTransition && state === 'running') {
        failRunningTransition = false;
        throw new OrchestratorError('WRITE_INTERRUPTED', 'Simulated network drop during transition to running');
      }
      return originalTransition(tenant_id, run_id, state, reason, cp, guard);
    });

    // 1. The interrupted attempt throws without advancing execution
    await expect(orchestrator.resumeTask(waiting.run_id, resumeEvent)).rejects.toMatchObject({
      code: 'WRITE_INTERRUPTED',
    });

    // 2. The task remains claimable in 'waiting' with resume_event intact (no unclaimable row created)
    const taskAfterInterruption = await workflow.getTask(TENANT, waiting.run_id);
    expect(taskAfterInterruption?.state).toBe('waiting');
    expect(taskAfterInterruption?.state_payload).toHaveProperty('resume_event');
    expect((taskAfterInterruption?.state_payload as Record<string, unknown>)['resume_event']).toEqual(resumeEvent);

    // 3. Retry after interruption: worker re-claims and resumes idempotently
    const retried = await orchestrator.resumeTask(waiting.run_id, resumeEvent);
    expect(retried.lifecycle_state).toBe('completed');

    // 4. Reservation settlement is preserved, no second dispatch occurred, and task is completed without event
    const settled = effectGuard.peek(TENANT, key);
    expect(settled?.status).toBe('SUCCEEDED');
    expect(settled?.receipt).toEqual(providerReceipt);
    expect(dispatch).toHaveBeenCalledTimes(1);

    const taskFinal = await workflow.getTask(TENANT, waiting.run_id);
    expect(taskFinal?.state).toBe('completed');
    expect(taskFinal?.state_payload).not.toHaveProperty('resume_event');

    const evidenceList = backing.listEvidence(TENANT, waiting.run_id);
    expect(evidenceList).toHaveLength(1);
    const evidencePayload = JSON.parse(evidenceList[0]!.raw_payload) as {
      replayed: boolean;
      receipt: unknown;
    };
    expect(evidencePayload.replayed).toBe(true);
    expect(evidencePayload.receipt).toEqual(providerReceipt);
  });
  it('handles post-enqueue evidence failure for skill.care.escalate_to_human without parking or second-settle, and replays safely with one EV_HUMAN_HANDOFF record', async () => {
    const effectGuard = new MemoryEffectGuard();
    const backing = new MemoryEvidenceLogger('test-hmac-secret');
    let evidenceStoreDown = true;
    const evidenceLogger: IEvidenceLogger = {
      findImmutableRecord: vi.fn(async (params) => backing.findImmutableRecord(params)),
      createImmutableRecord: vi.fn(async (params) => {
        if (evidenceStoreDown) {
          evidenceStoreDown = false;
          throw new Error('evidence store unavailable');
        }
        return backing.createImmutableRecord(params);
      }),
      initializeOutcomeWatch: vi.fn(async (params) => backing.initializeOutcomeWatch(params)),
      logAgentRun: vi.fn(async (runLog) => backing.logAgentRun(runLog)),
    };

    const handoffOutput = {
      handoff_id: 'handoff-uuid-1',
      queue_position: 1,
      status: 'ENQUEUED',
      escalated_at: '2026-09-22T00:00:00.000Z',
    };
    const handoffReceipt: ExecutionReceipt = {
      execution_id: 'handoff-uuid-1',
      adapter_status: 'SUCCESS',
      provider_reference: 'handoff-uuid-1',
      response_payload: handoffOutput,
      latency_ms: 10,
      token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
    };

    const careStep: PlannedStep = {
      step_index: 1,
      agent_id: 'CS-01',
      skill_id: 'skill.care.escalate_to_human',
      adapter_target: 'Orchestrator.HandoffBus',
      input_parameters: {
        tenant_id: TENANT,
        session_id: 'thread-care-1',
        conversation_id: 'conv-care-1',
        customer_id: 'cust-care-1',
        escalation_reason: 'billing dispute',
        summary_context: 'Customer requests human operator',
      },
      required_authority: 'AUTH-3',
      mutating: true,
      price_bearing: false,
      idempotent: true,
      timeout_ms: 1000,
    };

    const memoryWorkflow = new MemoryWorkflowEngine();
    const dispatch = vi.fn(async (actionDraft?: ActionDraft) => {
      // Simulate CareHandoffRepository.enqueue:
      // atomically parks task in awaiting_human with state_payload.resume_event='human.handoff.evidence',
      // clears lease, and settles reservation in the atomic transaction
      const task = await memoryWorkflow.getTask(TENANT, actionDraft!.run_id);
      if (task) {
        await memoryWorkflow.transitionTask(
          TENANT,
          actionDraft!.run_id,
          'awaiting_human',
          'Enqueued in CareHandoffRepository',
        );
        await memoryWorkflow.queueHandoffEvidence({
          tenant_id: TENANT,
          run_id: actionDraft!.run_id,
          step_index: careStep.step_index,
          effect_key: actionDraft!.effect_key,
          evidence_payload: {
            evidence_card: 'EV_HUMAN_HANDOFF',
            tenant_id: TENANT,
            run_id: actionDraft!.run_id,
            customer_id: 'cust-care-1',
            session_id: 'thread-care-1',
            conversation_id: 'conv-care-1',
            effect_key: actionDraft!.effect_key,
            receipt: handoffReceipt,
            handoff_receipt: handoffReceipt,
            action: actionDraft,
            replayed: false,
          },
        });
      }
      await effectGuard.resolve({
        tenant_id: TENANT,
        effect_key: actionDraft!.effect_key,
        status: 'SUCCEEDED',
        receipt: handoffReceipt,
      });
      return handoffReceipt;
    });

    const { orchestrator, workflow } = harness({
      steps: [careStep],
      agents: ['CS-01'],
      effectGuard,
      evidenceLogger,
      workflowEngine: memoryWorkflow,
      dispatch,
    });

    const transitionSpy = vi.spyOn(memoryWorkflow, 'transitionTask');
    let postEnqueueProgressCalls = 0;
    const originalUpdateProgress = memoryWorkflow.updateTaskProgress.bind(memoryWorkflow);
    const updateProgressSpy = vi.spyOn(memoryWorkflow, 'updateTaskProgress').mockImplementation(
      async (tenantId, runId, stepIndex, statePayload) => {
        if (dispatch.mock.calls.some((call) => call[0]?.run_id === runId)) {
          postEnqueueProgressCalls += 1;
        }
        return originalUpdateProgress(tenantId, runId, stepIndex, statePayload);
      }
    );
    const resolveSpy = vi.spyOn(effectGuard, 'resolve');

    const key = computeEffectKey({
      tenant_id: TENANT,
      skill_id: 'skill.care.escalate_to_human',
      step_index: 1,
      action_revision: 0,
      request_id: SIGNAL_ID,
    });

    // 1. Initial processSignal: CareHandoff enqueue atomically leaves awaiting_human with resume_event='human.handoff.evidence'
    const result = await orchestrator.processSignal(signal({
      subject: { session_id: 'thread-care-1', channel_type: 'web' },
    }));

    // Must return awaiting_human, NOT waiting, and must not dispatch evidence or advance progress
    expect(result.lifecycle_state).toBe('awaiting_human');
    expect(result.evidence).toBeUndefined();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(evidenceLogger.createImmutableRecord).not.toHaveBeenCalled();
    expect(evidenceLogger.logAgentRun).not.toHaveBeenCalled();

    // The task must remain in awaiting_human with persisted human.handoff.evidence repair event
    const taskState = await workflow.getTask(TENANT, result.run_id);
    expect(taskState?.state).toBe('awaiting_human');
    const persistedResumeEvent = (taskState?.state_payload as Record<string, unknown> | undefined)?.['resume_event'] as {
      tenant_id: string;
      run_id: string;
      event_type: 'human.handoff.evidence';
      evidence_payload: Record<string, unknown>;
      step_index: number;
      effect_key: string;
    } | undefined;
    expect(persistedResumeEvent).toBeDefined();
    expect(persistedResumeEvent?.event_type).toBe('human.handoff.evidence');
    expect(persistedResumeEvent?.tenant_id).toBe(TENANT);
    expect(persistedResumeEvent?.run_id).toBe(result.run_id);
    expect(persistedResumeEvent?.effect_key).toBe(key);
    expect(persistedResumeEvent?.step_index).toBe(careStep.step_index);
    const waitingTransitions = transitionSpy.mock.calls.filter((call) => call[2] === 'waiting');
    expect(waitingTransitions).toHaveLength(0);

    // Pre-dispatch checkpoint writes legitimately record task progress before dispatch
    const preDispatchCalls = updateProgressSpy.mock.calls.filter((call) => call[1] === result.run_id);
    expect(preDispatchCalls.length).toBeGreaterThan(0);
    for (const call of preDispatchCalls) {
      expect(call[2]).toBe(careStep.step_index);
    }
    const checkpointWritesWithAction = preDispatchCalls.filter(
      (call) => (call[3] as Record<string, unknown> | undefined)?.['pending_action'] !== undefined
    );
    expect(checkpointWritesWithAction.length).toBeGreaterThan(0);

    // Normal progress update (post-enqueue), second-settlement, and outcome watch must NOT have been called
    expect(postEnqueueProgressCalls).toBe(0);
    const advancingStepCalls = updateProgressSpy.mock.calls.filter((call) => call[2] > careStep.step_index);
    expect(advancingStepCalls).toHaveLength(0);
    // effectGuard.resolve was called once inside dispatch (simulating atomic enqueue), never second-settled by orchestrator
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(evidenceLogger.initializeOutcomeWatch).not.toHaveBeenCalled();
    expect(backing.listEvidence(TENANT, result.run_id)).toHaveLength(0);

    // 2. First resumeTask with the persisted repair event fails while evidence store is down and leaves the event queued
    await expect(orchestrator.resumeTask(result.run_id, persistedResumeEvent!)).rejects.toThrow(
      'evidence store unavailable',
    );
    expect(evidenceLogger.findImmutableRecord).toHaveBeenCalledWith({
      tenant_id: TENANT,
      run_id: result.run_id,
      effect_key: key,
      step_index: careStep.step_index,
    });
    expect(evidenceLogger.createImmutableRecord).toHaveBeenCalledTimes(1);

    const taskAfterFailedRepair = await workflow.getTask(TENANT, result.run_id);
    expect(taskAfterFailedRepair?.state).toBe('awaiting_human');
    expect(
      (taskAfterFailedRepair?.state_payload as Record<string, unknown> | undefined)?.['resume_event'],
    ).toEqual(persistedResumeEvent);
    expect(backing.listEvidence(TENANT, result.run_id)).toHaveLength(0);
    expect(backing.listAgentRuns(TENANT, result.run_id)).toHaveLength(0);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalledTimes(1);

    // 3. Second resumeTask with the same event uses evidence read/replay, appends one EV_HUMAN_HANDOFF and audit/run log,
    // clears only the repair event while keeping awaiting_human, and never second-settles/resends
    const replayResult = await orchestrator.resumeTask(result.run_id, persistedResumeEvent!);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(replayResult.lifecycle_state).toBe('awaiting_human');
    expect(replayResult.evidence).toBeDefined();
    expect(evidenceLogger.findImmutableRecord).toHaveBeenCalledTimes(2);

    // Exactly one immutable evidence record and one agent run log are appended
    const evidenceList = backing.listEvidence(TENANT, replayResult.run_id);
    expect(evidenceList).toHaveLength(1);
    const ev = evidenceList[0]!;
    expect(ev.tenant_id).toBe(TENANT);
    expect(ev.run_id).toBe(replayResult.run_id);
    expect(ev.effect_key).toBe(key);

    const payload = JSON.parse(ev.raw_payload);
    expect(payload).toMatchObject({
      evidence_card: 'EV_HUMAN_HANDOFF',
      customer_id: 'cust-care-1',
      session_id: 'thread-care-1',
      conversation_id: 'conv-care-1',
      effect_key: key,
      tenant_id: TENANT,
      run_id: replayResult.run_id,
      receipt: handoffReceipt,
      handoff_receipt: handoffReceipt,
    });

    const runLogs = backing.listAgentRuns(TENANT, replayResult.run_id);
    expect(runLogs).toHaveLength(1);
    expect(runLogs[0]?.execution_status).toBe('success');
    expect(runLogs[0]?.skill).toBe('skill.care.escalate_to_human');

    const taskAfterRepair = await workflow.getTask(TENANT, result.run_id);
    expect(taskAfterRepair?.state).toBe('awaiting_human');
    expect(
      (taskAfterRepair?.state_payload as Record<string, unknown> | undefined)?.['resume_event'],
    ).toBeUndefined();
    expect(
      (taskAfterRepair?.state_payload as Record<string, unknown> | undefined)?.['pending_action'],
    ).toBeDefined();

    const settled = effectGuard.peek(TENANT, key);
    expect(settled?.status).toBe('SUCCEEDED');
    expect(settled?.receipt).toEqual(handoffReceipt);

    // Post-enqueue progress, park, second-settle and outcome watch remain absent across repair
    expect(postEnqueueProgressCalls).toBe(0);
    expect(updateProgressSpy.mock.calls.filter((call) => call[2] > careStep.step_index)).toHaveLength(0);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(evidenceLogger.initializeOutcomeWatch).not.toHaveBeenCalled();
    // 4. Re-queue the same persisted repair after evidence exists; a duplicate log is accepted only by its canonical code.
    const taskForDuplicateRepair = await workflow.getTask(TENANT, result.run_id);
    await workflow.queueHandoffEvidence({
      tenant_id: TENANT,
      run_id: result.run_id,
      expected_task_version: taskForDuplicateRepair!.task_version,
      evidence_payload: persistedResumeEvent!.evidence_payload!,
      step_index: careStep.step_index,
      effect_key: key,
    });
    const queuedDuplicate = await workflow.getTask(TENANT, result.run_id);
    const duplicateEvent = (queuedDuplicate?.state_payload as Record<string, unknown>)?.['resume_event'] as typeof persistedResumeEvent;
    evidenceLogger.logAgentRun = vi.fn(async () => {
      throw new Error('AGENT_RUN_LOG_APPENDED: step already has its agent_run_logs row');
    });
    const duplicateRepair = await orchestrator.resumeTask(result.run_id, duplicateEvent!);
    expect(duplicateRepair.lifecycle_state).toBe('awaiting_human');
    expect((await workflow.getTask(TENANT, result.run_id))?.state_payload).not.toHaveProperty('resume_event');
    expect(backing.listEvidence(TENANT, result.run_id)).toHaveLength(1);
  });
});
