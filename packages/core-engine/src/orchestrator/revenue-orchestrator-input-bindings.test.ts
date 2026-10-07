/** Receipt-bound plan inputs: durable predecessor evidence, closed bindings and recovery. */
import { describe, expect, it, vi } from 'vitest';

import {
  GENESIS_HASH,
  type ActionDraft,
  type ExecutionPlan,
  type ExecutionReceipt,
  type HydratedContext,
  type IPlanInputResolver,
  type IStatefulWorkflowEngine,
  type PlannedStep,
  type RoutingDecision,
  type SignalEnvelope,
} from '../contracts/index.js';
import { MemoryEffectGuard } from '../effects/memory-effect-guard.js';
import { MemoryEvidenceLogger } from '../evidence/evidence-logger.js';
import { evaluateAuthorityVerdict } from '../policy/authority.js';
import { MemoryLeaseManager } from '../workflow/memory-lease.js';
import { MemoryWorkflowEngine } from '../workflow/memory-workflow-engine.js';
import { RevenueOrchestrator } from './revenue-orchestrator.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const SESSION = 'binding-session';
const SIGNAL_ID = 'binding-signal';

function signal(): SignalEnvelope {
  return {
    signal_id: SIGNAL_ID,
    tenant_id: TENANT,
    correlation_id: 'binding-correlation',
    source_channel: 'web',
    event_type: 'product.inquiry',
    payload: { text: 'find a product' },
    subject: { session_id: SESSION, channel_type: 'web' },
    timestamp: '2026-09-28T00:00:00.000Z',
  };
}

function context(): HydratedContext {
  return {
    correlation_id: 'binding-correlation',
    tenant_id: TENANT,
    customer: null,
    working_memory: {
      session_id: SESSION,
      last_touch_channel: 'web',
      turn_count: 1,
      takeover_active: false,
    },
    knowledge_citations: [],
    hydrated_at: '2026-09-28T00:00:00.000Z',
  };
}

function step(overrides: Partial<PlannedStep> = {}): PlannedStep {
  return {
    step_index: 1,
    agent_id: 'SAL-01',
    skill_id: 'skill.test.read',
    adapter_target: 'test',
    input_parameters: { text: 'hello' },
    required_authority: 'AUTH-1',
    mutating: false,
    price_bearing: false,
    idempotent: true,
    timeout_ms: 1_000,
    ...overrides,
  };
}

function receipt(response_payload: Record<string, unknown>): ExecutionReceipt {
  return {
    execution_id: 'execution-binding',
    adapter_status: 'SUCCESS',
    provider_reference: 'provider-binding',
    response_payload,
    latency_ms: 1,
    token_usage: { prompt: 1, completion: 1, total_cost_usd: 0 },
  };
}

function plan(steps: PlannedStep[]): ExecutionPlan {
  return { plan_id: 'binding-plan', steps, fallback_strategy: 'FAIL_CLOSED' };
}

function makeOrchestrator(options: {
  readonly steps: PlannedStep[];
  readonly evidenceLogger?: MemoryEvidenceLogger;
  readonly workflowEngine?: IStatefulWorkflowEngine;
  readonly resolver?: IPlanInputResolver;
  readonly dispatch?: (action: ActionDraft) => Promise<ExecutionReceipt>;
}) {
  const evidenceLogger = options.evidenceLogger ?? new MemoryEvidenceLogger('binding-secret');
  const effectGuard = new MemoryEffectGuard();
  const workflow = options.workflowEngine ?? new MemoryWorkflowEngine();
  const dispatch = vi.fn(options.dispatch ?? (async () => receipt({})));
  const agentRuntime = {
    deriveHypothesis: async () => ({
      classification: 'HYPOTHESIS' as const,
      intent: 'product.inquiry',
      confidence: 0.9,
      churn_risk_score: 0,
      purchase_propensity: 0,
      reasoning: 'test hypothesis',
      derived_from_signals: [SIGNAL_ID],
    }),
    resolveRouting: async (): Promise<RoutingDecision> => ({
      target_agent: 'SAL-01',
      requires_clarification: false,
      rationalization: 'test route',
    }),
    formulatePlan: async () => plan(options.steps),
  };
  const orchestrator = new RevenueOrchestrator({
    contextAggregator: { hydrateContext: async () => context() },
    agentRuntime,
    policyEngine: {
      validateAction: async (action) => action,
      evaluateAuthority: async (action) => ({
        ...evaluateAuthorityVerdict('AUTH-3', action.required_authority),
        reason: 'test authority',
      }),
    },
    workflowEngine: workflow,
    evidenceLogger,
    ...(options.resolver === undefined ? {} : { planInputResolver: options.resolver }),
    auditTrail: { append: async () => undefined },
    adapterDispatcher: { dispatch },
    effectGuard,
    sessionControl: { isTakenOver: async () => false, returnToAgent: async () => undefined },
    leaseManager: new MemoryLeaseManager(),
    workerId: 'worker-test',
  });
  return { orchestrator, dispatch, evidenceLogger, effectGuard, workflow };
}

function twoStepPlan(binding: PlannedStep['input_bindings']): PlannedStep[] {
  return [
    step({ step_index: 1 }),
    step({
      step_index: 2,
      skill_id: 'skill.test.downstream',
      input_parameters: { sku: 'caller-value' },
      depends_on_steps: [1],
      ...(binding === undefined ? {} : { input_bindings: binding }),
    }),
  ];
}

const skuResolver: IPlanInputResolver = {
  resolve: async ({ previous_receipts }) => ({
    sku: previous_receipts['1']?.response_payload['sku'],
  }),
};

describe('RevenueOrchestrator receipt-bound inputs', () => {
  it('passes a verified predecessor response field into the downstream action', async () => {
    const { orchestrator, dispatch } = makeOrchestrator({
      steps: twoStepPlan({ sku: { source_step_index: 1, response_path: 'sku' } }),
      resolver: skuResolver,
      dispatch: async (action) => action.step_index === 1
        ? receipt({ sku: 'NM-L01-BLK' })
        : receipt({ sent: true }),
    });

    const result = await orchestrator.processSignal(signal());

    expect(result.lifecycle_state).toBe('completed');
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect((dispatch.mock.calls[1]?.[0] as ActionDraft).payload['sku']).toBe('NM-L01-BLK');
  });

  it('rejects a binding with no declared dependency before any dispatch', async () => {
    const planSteps = twoStepPlan({ sku: { source_step_index: 1, response_path: 'sku' } });
    planSteps[1] = { ...planSteps[1]!, depends_on_steps: [] };
    const { orchestrator, dispatch } = makeOrchestrator({ steps: planSteps, resolver: skuResolver });

    await expect(orchestrator.processSignal(signal())).rejects.toMatchObject({ code: 'INPUT_BINDING_INVALID' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refuses a missing response path before dispatching the downstream step', async () => {
    const { orchestrator, dispatch } = makeOrchestrator({
      steps: twoStepPlan({ sku: { source_step_index: 1, response_path: 'missing' } }),
      resolver: skuResolver,
      dispatch: async (action) => action.step_index === 1
        ? receipt({ sku: 'NM-L01-BLK' })
        : receipt({ sent: true }),
    });

    await expect(orchestrator.processSignal(signal())).rejects.toMatchObject({ code: 'INPUT_BINDING_RESPONSE_PATH_MISSING' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('refuses evidence from another tenant before dispatch', async () => {
    const evidenceLogger = new MemoryEvidenceLogger('binding-secret');
    const wrongTenantEvidence = await evidenceLogger.createImmutableRecord({
      run_id: 'run-not-used',
      tenant_id: OTHER_TENANT,
      correlation_id: 'binding-correlation',
      step_index: 1,
      effect_key: 'wrong-effect',
      previous_evidence_hash: GENESIS_HASH,
      payload: { action: {}, receipt: receipt({ sku: 'NM-L01-BLK' }), replayed: false },
    });
    vi.spyOn(evidenceLogger, 'findImmutableRecord').mockResolvedValue(wrongTenantEvidence);

    const { orchestrator, dispatch } = makeOrchestrator({
      steps: twoStepPlan({ sku: { source_step_index: 1, response_path: 'sku' } }),
      evidenceLogger,
      resolver: skuResolver,
    });

    await expect(orchestrator.processSignal(signal())).rejects.toMatchObject({ code: 'INPUT_BINDING_RECEIPT_INVALID' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('replays a durable predecessor receipt after a crash without dispatching it again', async () => {
    const runId = 'run-binding-replay';
    const source = step({ step_index: 1 });
    const steps = twoStepPlan({ sku: { source_step_index: 1, response_path: 'sku' } });
    const evidenceLogger = new MemoryEvidenceLogger('binding-secret');
    const effectGuard = new MemoryEffectGuard();
    const sourceEffectKey = effectGuard.computeEffectKey({
      tenant_id: TENANT,
      skill_id: source.skill_id,
      step_index: 1,
      action_revision: 0,
      request_id: SIGNAL_ID,
    });
    await evidenceLogger.createImmutableRecord({
      run_id: runId,
      tenant_id: TENANT,
      correlation_id: 'binding-correlation',
      step_index: 1,
      effect_key: sourceEffectKey,
      previous_evidence_hash: GENESIS_HASH,
      payload: { action: {}, receipt: receipt({ sku: 'NM-L01-BLK' }), replayed: false },
    });
    const checkpoint = {
      signal: signal(),
      plan: plan(steps),
      current_step: 1,
      pending_action: null,
      context: context(),
      previous_evidence_hash: GENESIS_HASH,
      request_id: SIGNAL_ID,
    };
    const workflow = {
      getTask: vi.fn(async () => ({
        task_version: 2,
        state: 'running' as const,
        correlation_id: 'binding-correlation',
        state_payload: checkpoint,
        lease_owner: 'worker-test',
        lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
      })),
      updateTaskProgress: vi.fn(async () => undefined),
      transitionTask: vi.fn(async () => undefined),
      recordFailure: vi.fn(async () => ({ requeued: true })),
    } as unknown as IStatefulWorkflowEngine;
    const { orchestrator, dispatch } = makeOrchestrator({
      steps,
      evidenceLogger,
      workflowEngine: workflow,
      resolver: skuResolver,
      dispatch: async () => receipt({ sent: true }),
    });

    const result = await orchestrator.processQueuedSignal(runId, signal(), { worker_id: 'worker-test' });

    expect(result.lifecycle_state).toBe('completed');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0]?.[0] as ActionDraft).step_index).toBe(2);
  });
});
