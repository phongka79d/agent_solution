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
  type RoutingDecision,
  type SignalEnvelope,
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
  readonly dispatch?: () => Promise<ExecutionReceipt>;
  readonly effectGuard?: MemoryEffectGuard;
  /** Live SCR-005 lock state, so a case can hold the lock and release it mid-flight. */
  readonly isTakenOver?: () => Promise<boolean>;
  /** Evidence writer override (a failing audit/evidence store is a governance case, not a bug). */
  readonly evidenceLogger?: IEvidenceLogger;
}

function harness(options: HarnessOptions = {}) {
  const effectGuard = options.effectGuard ?? new MemoryEffectGuard();
  const workflow = new MemoryWorkflowEngine();
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
  const dispatch = vi.fn(options.dispatch ?? (async () => receipt()));
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
    adapterDispatcher: { dispatch },
    effectGuard,
    sessionControl: {
      isTakenOver: options.isTakenOver ?? (async () => false),
      returnToAgent: async () => undefined,
    },
    leaseManager: new MemoryLeaseManager(),
    workerId: 'worker-test',
  });
  return { orchestrator, effectGuard, workflow, evidenceLogger, hydrate, deriveHypothesis, resolveRouting, formulatePlan, dispatch };
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

  it('refuses an AUTH-4 release while an operator holds the SCR-005 lock and leaves the approval claimable', async () => {
    let takeover = false;
    const { orchestrator, dispatch, workflow } = harness({
      steps: [step({ required_authority: 'AUTH-4' satisfies AuthorityLevel })],
      isTakenOver: async () => takeover,
    });
    const claim = vi.spyOn(workflow, 'claimApprovalAndResume');

    const paused = await orchestrator.processSignal(signal());
    expect(paused.lifecycle_state).toBe('awaiting_human');
    const approval = workflow.listApprovals(TENANT, paused.run_id)[0];
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
    expect(workflow.listApprovals(TENANT, paused.run_id)[0]?.decision).toBe('PENDING');
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
    const { orchestrator, workflow } = harness({
      steps: [step({ required_authority: 'AUTH-4' satisfies AuthorityLevel })],
      isTakenOver: async () => takeover,
    });

    const paused = await orchestrator.processSignal(signal());
    const approval = workflow.listApprovals(TENANT, paused.run_id)[0];
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
    expect(workflow.listApprovals(TENANT, paused.run_id)[0]?.decision).toBe('REJECTED');
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
});
