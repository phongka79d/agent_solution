/**
 * @file Orchestrator lifecycle and guard cases (implement/04 §7, §8).
 *
 * The recovery/reconciliation half of the original suite lives in
 * `revenue-orchestrator-recovery.test.ts`; together the two files hold every case of the
 * pre-split file exactly once.
 */

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
  type IAuditTrail,
  type IEvidenceLogger,
  type IPolicyEngine,
  type PlannedStep,
  type HandoffIntent,
  type ICrossDomainHandoffBroker,
  type PlatformAgentId,
  type ActionDraft,
  type RoutingDecision,
  type SignalEnvelope,
  type DurableLeaseManager,
  type IStatefulWorkflowEngine,
} from '../contracts/index.js';
import { computeEffectKey } from '../effects/effect-key.js';
import { MemoryEffectGuard } from '../effects/memory-effect-guard.js';
import { MemoryEvidenceLogger } from '../evidence/evidence-logger.js';
import { AutonomyService, MemoryAutonomyStore, type AutonomyAdmissionPort } from '../autonomy/index.js';
import { assertValidTransition } from '../lifecycle/stages.js';
import { evaluateAuthorityVerdict } from '../policy/authority.js';
import { PolicyEnforcementPoint, type PolicyRegistrySkill } from '../policy/index.js';
import { MemoryLeaseManager } from '../workflow/memory-lease.js';
import { MemoryWorkflowEngine } from '../workflow/memory-workflow-engine.js';
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
  /** The next journey leg this run's plan declares, when the case exercises the handoff path. */
  readonly handoff_intent?: HandoffIntent;
  /** The brokered handoff binding; absent means this deployment brokers nothing. */
  readonly crossDomainHandoff?: ICrossDomainHandoffBroker;
  /** The verified Customer 360 subject of the run, when the case needs one to exist. */
  readonly customer?: HydratedContext['customer'];
  readonly agents?: PlatformAgentId[];
  readonly hypothesisRecord?: HypothesisRecord;
  readonly dispatch?: (
    action?: ActionDraft,
    options?: { timeout_ms?: number; signal?: AbortSignal; request_fingerprint?: string },
  ) => Promise<ExecutionReceipt>;
  readonly policyEngine?: IPolicyEngine;
  readonly effectGuard?: MemoryEffectGuard;
  /** Live SCR-005 lock state, so a case can hold the lock and release it mid-flight. */
  readonly isTakenOver?: () => Promise<boolean>;
  /** Evidence writer override (a failing audit/evidence store is a governance case, not a bug). */
  readonly evidenceLogger?: IEvidenceLogger;
  /** Audit sink override for assertions about the exact payload sent to persistence. */
  readonly auditTrail?: IAuditTrail;
  /** Durable engine override, so the claimed-queue reattempt path can be driven with a spy. */
  readonly workflowEngine?: IStatefulWorkflowEngine;
  /** Lease manager override, so a case can assert the attempt's release. */
  readonly leaseManager?: DurableLeaseManager;
  readonly assertExecutionLease?: (tenant_id: string, run_id: string) => Promise<void>;
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
  const hydrate = vi.fn(async () => (
    options.customer === undefined ? context() : { ...context(), customer: options.customer }
  ));
  const deriveHypothesis = vi.fn(async () => options.hypothesisRecord ?? hypothesis());
  const resolveRouting = vi.fn(async (): Promise<RoutingDecision> => ({
    target_agent: options.agents?.[0] ?? 'SAL-01',
    requires_clarification: false,
    rationalization: 'orchestrator routed',
  }));
  const formulatePlan = vi.fn(async () => {
    const base = options.steps !== undefined
      ? plan(options.steps)
      : plan((options.agents ?? ['SAL-01']).map((agent_id, index) => step({ step_index: index + 1, agent_id })));
    return options.handoff_intent === undefined
      ? base
      : { ...base, handoff_intent: options.handoff_intent };
  });
  const dispatch = vi.fn(options.dispatch ?? (async (_action?: ActionDraft) => receipt()));
  const reconcile = options.reconcile !== undefined ? vi.fn(options.reconcile) : undefined;
  const orchestrator = new RevenueOrchestrator({
    ...(options.crossDomainHandoff === undefined
      ? {}
      : { crossDomainHandoff: options.crossDomainHandoff }),
    contextAggregator: { hydrateContext: hydrate },
    agentRuntime: { deriveHypothesis, resolveRouting, formulatePlan },
    policyEngine: options.policyEngine ?? {
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
    auditTrail: options.auditTrail ?? { append: async () => undefined },
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
    ...(options.assertExecutionLease === undefined ? {} : { assertExecutionLease: options.assertExecutionLease }),
    workerId: 'worker-test',
  });
  return { orchestrator, effectGuard, workflow, memoryWorkflow, evidenceLogger, hydrate, deriveHypothesis, resolveRouting, formulatePlan, dispatch, reconcile };
}

function controlledStockPolicy(autonomy: AutonomyAdmissionPort): IPolicyEngine {
  const stock: PolicyRegistrySkill = {
    skill_id: 'skill.sales.check_stock',
    required_authority: 'AUTH-0',
    allowed_agents: ['SAL-01'],
    mutating: false,
    price_bearing: false,
    idempotent: true,
    epistemic_class: 'FACT',
    write_target: 'HYPOTHESIS',
    requires_consent: false,
    requires_verified_identity: false,
    timeout_ms: 5_000,
    policy_version: 'v1',
  };
  const pep = new PolicyEnforcementPoint({
    registry: {
      getSkill: (skill_id) => skill_id === stock.skill_id ? stock : undefined,
      getAgent: (agent_id) => agent_id === 'SAL-01'
        ? { agent_id, assigned_authority: 'AUTH-3' }
        : undefined,
    },
    approvals: { createOrReadPending: async () => ({ approval_id: 'approval-stock' }) },
    audit: { append: async () => undefined },
    auditSecret: 'test-stock-audit-secret',
    autonomy,
  });
  return {
    validateAction: async (action) => action,
    evaluateAuthority: async (action, hydrated) => {
      const decision = await pep.enforce({
        tenant_id: hydrated.tenant_id,
        agent_id: action.agent_id,
        run_id: action.run_id,
        request_id: action.request_id,
        correlation_id: hydrated.correlation_id,
        session_id: hydrated.working_memory.session_id,
        takeover_active: hydrated.working_memory.takeover_active,
      }, {
        skill_id: action.skill_id,
        tool_name: action.adapter_target,
        required_authority: action.required_authority,
        payload: action.payload,
      });
      return {
        verdict: decision.verdict,
        reason: decision.reason,
        ...(decision.autonomyWorkflow === undefined
          ? {}
          : { autonomyWorkflow: decision.autonomyWorkflow }),
      };
    },
  };
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

  it('redacts context email and phone before either audit writer receives the record', async () => {
    const email = 'private.customer@example.test';
    const phone = '+1 415 555 0199';
    const append = vi.fn(async (_record: Parameters<IAuditTrail['append']>[0]) => undefined);
    const auditTrail: IAuditTrail = { append };
    const customer: NonNullable<HydratedContext['customer']> = {
      customer_id: 'customer-123',
      tenant_id: TENANT,
      verified_phone: phone,
      verified_email: email,
      total_spent: 128,
      order_count: 2,
      rfm_segment_hypothesis: 'ACTIVE',
      consent_marketing: false,
      consent_updated_at: null,
      suppression_active: false,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const { orchestrator, evidenceLogger } = harness({
      customer,
      auditTrail,
      steps: [step({ audit_spec: { mask_pii_fields: ['customer_id'] } })],
    });
    const logAgentRun = vi.spyOn(evidenceLogger, 'logAgentRun');

    const result = await orchestrator.processSignal(signal());
    const auditRecord = append.mock.calls[0]?.[0];
    const runLog = logAgentRun.mock.calls[0]?.[0];

    expect(auditRecord).toBeDefined();
    expect(runLog).toBeDefined();
    expect((auditRecord?.context as HydratedContext).customer?.customer_id).toBe('[REDACTED]');
    expect((runLog?.context as HydratedContext).customer?.customer_id).toBe('[REDACTED]');
    expect(JSON.stringify([auditRecord, runLog])).not.toContain(email);
    expect(JSON.stringify([auditRecord, runLog])).not.toContain(phone);
    expect(result.lifecycle_state).toBe('completed');
  });

  it('reuses one full pending-action fingerprint for reservation and dispatch', async () => {
    const { orchestrator, effectGuard, dispatch } = harness({
      steps: [step({ skill_id: 'skill.care.escalate_to_human' })],
    });
    const fingerprint = vi.spyOn(effectGuard, 'computeRequestFingerprint');
    const reserve = vi.spyOn(effectGuard, 'reserve');

    await orchestrator.processSignal(signal());

    const dispatchedAction = dispatch.mock.calls[0]?.[0];
    const expectedFingerprint = fingerprint.mock.results[0]?.value;
    expect(fingerprint).toHaveBeenCalledTimes(1);
    expect(fingerprint).toHaveBeenCalledWith(dispatchedAction?.payload);
    expect(reserve.mock.calls[0]?.[0].request_fingerprint).toBe(expectedFingerprint);
    expect(dispatch.mock.calls[0]?.[1]?.request_fingerprint).toBe(expectedFingerprint);
  });
  it('does not leak the previous run journal into a sequential run', async () => {
    const { orchestrator } = harness();

    await orchestrator.processSignal(signal());
    const firstRunStages = [...orchestrator.visitedStages];

    await orchestrator.processSignal(signal());

    expect([...orchestrator.visitedStages]).toEqual(firstRunStages);
    expect(orchestrator.visitedStages.filter((stage) => stage === 'LEARNING')).toHaveLength(1);
  });
  it('does not retain a queued-run lease gate across sequential runs', async () => {
    const assertExecutionLease = vi.fn(async () => undefined);
    const queuedWorkflow = {
      getTask: vi.fn(async () => ({
        task_version: 1,
        state: 'running' as const,
        correlation_id: 'corr-1',
        state_payload: { signal: signal() },
        lease_owner: 'worker-test',
        lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
      })),
      createTask: vi.fn(async () => undefined),
      updateTaskProgress: vi.fn(async () => undefined),
      transitionTask: vi.fn(async () => undefined),
      recordFailure: vi.fn(async () => ({ requeued: true })),
    } as unknown as IStatefulWorkflowEngine;
    const { orchestrator } = harness({
      workflowEngine: queuedWorkflow,
      assertExecutionLease,
    });

    await orchestrator.processQueuedSignal('run-queued', signal(), { worker_id: 'worker-test' });
    expect(assertExecutionLease).toHaveBeenCalled();

    assertExecutionLease.mockClear();
    await orchestrator.processSignal(signal({ signal_id: 'signal-next' }));
    expect(assertExecutionLease).toHaveBeenCalledTimes(1);
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

  for (const condition of ['store unavailable', 'tenant paused', 'evidence drift'] as const) {
    it(`parks the low-risk stock draft with zero dispatch when autonomy has ${condition}`, async () => {
      const service = new AutonomyService(new MemoryAutonomyStore());
      const promoted = await service.promote({
        tenant_id: TENANT,
        skill_id: 'skill.sales.check_stock',
        policy_version: 'v1',
        required_authority: 'AUTH-0',
        evidence_window_ref: 'window-stock',
        evidence_ref: 'evidence-stock',
        audit_ref: 'audit-stock',
        authority_violations: 0,
        duplicate_effects: 0,
        audit_complete: true,
        evidence_complete: true,
        approver_id: 'operator-stock',
      });
      expect(promoted.accepted).toBe(true);
      if (condition === 'tenant paused') {
        await service.pauseTenant({ tenant_id: TENANT, actor: 'operator-stock' });
      } else if (condition === 'evidence drift') {
        await service.admit({
          tenant_id: TENANT,
          skill_id: 'skill.sales.check_stock',
          policy_version: 'v1',
          evidence_complete: false,
        });
      }
      const autonomy: AutonomyAdmissionPort = condition === 'store unavailable'
        ? { admit: async () => { throw new Error('autonomy store unavailable'); } }
        : service;
      const { orchestrator, workflow, dispatch } = harness({
        steps: [step({
          skill_id: 'skill.sales.check_stock',
          required_authority: 'AUTH-0',
          mutating: false,
          input_parameters: { sku_id: 'SKU-1' },
        })],
        policyEngine: controlledStockPolicy(autonomy),
      });

      const result = await orchestrator.processSignal(signal());
      expect(result.lifecycle_state).toBe('waiting');
      expect(result.message).toContain('PARKED_DRAFT');
      const parked = await workflow.getTask(TENANT, result.run_id);
      expect(parked?.state).toBe('waiting');
      expect(parked?.state_payload).toMatchObject({
        pending_action: { skill_id: 'skill.sales.check_stock', mutating: false },
      });
      expect(dispatch).not.toHaveBeenCalled();
      expect(orchestrator.visitedStages).not.toContain('EXECUTION');
    });
  }

  it('keeps AUTH-4 at approval and AUTH-5 prohibited even with promoted autonomy', async () => {
    const service = new AutonomyService(new MemoryAutonomyStore());
    const promoted = await service.promote({
      tenant_id: TENANT,
      skill_id: 'skill.sales.check_stock',
      policy_version: 'v1',
      required_authority: 'AUTH-0',
      evidence_window_ref: 'window-stock',
      evidence_ref: 'evidence-stock',
      audit_ref: 'audit-stock',
      authority_violations: 0,
      duplicate_effects: 0,
      audit_complete: true,
      evidence_complete: true,
      approver_id: 'operator-stock',
    });
    expect(promoted.accepted).toBe(true);
    for (const [required_authority, expectedState] of [
      ['AUTH-4', 'awaiting_human'],
      ['AUTH-5', 'stopped'],
    ] as const) {
      const { orchestrator, workflow, dispatch } = harness({
        steps: [step({
          skill_id: 'skill.sales.check_stock',
          required_authority,
          mutating: false,
          input_parameters: { sku_id: 'SKU-1' },
        })],
        policyEngine: controlledStockPolicy(service),
      });
      const result = await orchestrator.processSignal(signal());
      expect(result.lifecycle_state).toBe(expectedState);
      expect((await workflow.getTask(TENANT, result.run_id))?.state).toBe(expectedState);
      expect(dispatch).not.toHaveBeenCalled();
      expect(orchestrator.visitedStages).not.toContain('EXECUTION');
    }
  });

  it('executes a cross-agent plan only through the orchestrator', async () => {
    const { orchestrator, dispatch, deriveHypothesis, resolveRouting, formulatePlan } = harness({
      agents: ['MKT-01', 'SAL-01'],
    });

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
    const failure = vi.mocked(workflow.recordFailure).mock.calls[0]?.[0];
    if (failure === undefined) throw new Error('recordFailure input was not captured');
    expect(failure.tenant_id).toBe(TENANT);
    expect(failure.run_id).toBe(run_id);
    expect(failure.error_class).toBe('RETRYABLE');
    expect(failure.error_details.code).toBe('PROVIDER_UNAVAILABLE');
    expect(failure.error_details.message).toContain('provider is down');
    expect(leaseManager.releaseLease).toHaveBeenCalledWith(TENANT, run_id, 'worker-test');
  });

  it('records a deterministic handoff reservation refusal as FATAL with its code', async () => {
    const { orchestrator, run_id, workflow } = reattemptHarness({
      step: step({ skill_id: 'skill.care.escalate_to_human', mutating: true }),
      dispatch: async () => {
        throw new OrchestratorError(
          'HANDOFF_EFFECT_RESERVATION_INVALID',
          'reservation does not match the pending handoff action',
        );
      },
    });

    await expect(
      orchestrator.processQueuedSignal(run_id, signal(), { worker_id: 'worker-test' }),
    ).rejects.toMatchObject({ code: 'HANDOFF_EFFECT_RESERVATION_INVALID' });

    const failure = vi.mocked(workflow.recordFailure).mock.calls[0]?.[0];
    if (failure === undefined) throw new Error('recordFailure input was not captured');
    expect(failure.error_class).toBe('FATAL');
    expect(failure.error_details.code).toBe('HANDOFF_EFFECT_RESERVATION_INVALID');
  });
});
