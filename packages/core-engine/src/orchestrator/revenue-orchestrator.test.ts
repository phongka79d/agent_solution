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
}

function harness(options: HarnessOptions = {}) {
  const effectGuard = options.effectGuard ?? new MemoryEffectGuard();
  const workflow = new MemoryWorkflowEngine();
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
        return { verdict: verdict.verdict, reason: verdict.reason };
      },
    },
    workflowEngine: workflow,
    evidenceLogger: new MemoryEvidenceLogger('test-hmac-secret'),
    auditTrail: { append: async () => undefined },
    adapterDispatcher: { dispatch },
    effectGuard,
    sessionControl: {
      isTakenOver: async () => false,
      returnToAgent: async () => undefined,
    },
    leaseManager: new MemoryLeaseManager(),
    workerId: 'worker-test',
  });
  return { orchestrator, effectGuard, workflow, hydrate, deriveHypothesis, resolveRouting, formulatePlan, dispatch };
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
});
