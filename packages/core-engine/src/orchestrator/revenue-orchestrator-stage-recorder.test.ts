import { describe, expect, it } from 'vitest';


import {
  type ActionDraft,
  type ExecutionPlan,
  type ExecutionReceipt,
  type HydratedContext,
  type HypothesisRecord,
  type IRunStageRecorder,
  type PlannedStep,
  type RoutingDecision,
  type SignalEnvelope,
} from '../contracts/index.js';
import { MemoryEffectGuard } from '../effects/memory-effect-guard.js';
import { type LifecycleStage } from '../lifecycle/stages.js';
import { MemoryEvidenceLogger } from '../evidence/evidence-logger.js';
import { MemoryLeaseManager } from '../workflow/memory-lease.js';
import { MemoryWorkflowEngine } from '../workflow/memory-workflow-engine.js';
import { RevenueOrchestrator } from './revenue-orchestrator.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SESSION = 'stage-recorder-session';

function signal(): SignalEnvelope {
  return {
    signal_id: 'stage-recorder-signal',
    tenant_id: TENANT,
    correlation_id: 'stage-recorder-correlation',
    source_channel: 'web',
    event_type: 'product.inquiry',
    payload: { text: 'show me products' },
    subject: { session_id: SESSION, channel_type: 'web' },
    timestamp: '2026-09-28T00:00:00.000Z',
  };
}

function context(): HydratedContext {
  return {
    correlation_id: 'stage-recorder-correlation',
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

function hypothesis(): HypothesisRecord {
  return {
    classification: 'HYPOTHESIS',
    intent: 'product.inquiry',
    confidence: 0.8,
    churn_risk_score: 0,
    purchase_propensity: 0,
    reasoning: 'stage recorder test hypothesis',
    derived_from_signals: ['stage-recorder-signal'],
  };
}

function plannedStep(step_index: number, required_authority: PlannedStep['required_authority'] = 'AUTH-1'): PlannedStep {
  return {
    step_index,
    agent_id: 'SAL-01',
    skill_id: `skill.stage_recorder.${step_index}`,
    adapter_target: 'web',
    input_parameters: { text: `step-${step_index}` },
    required_authority,
    mutating: true,
    price_bearing: false,
    idempotent: true,
    timeout_ms: 1_000,
  };
}

function receipt(step_index: number): ExecutionReceipt {
  return {
    execution_id: `execution-${step_index}`,
    adapter_status: 'SUCCESS',
    provider_reference: `provider-${step_index}`,
    response_payload: { step_index },
    latency_ms: 1,
    token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
  };
}

function createOrchestrator(params: {
  readonly steps: PlannedStep[];
  readonly recorder: IRunStageRecorder;
  readonly timeline: string[];
  readonly dispatch?: (action: ActionDraft) => Promise<ExecutionReceipt>;
  readonly approval?: 'AUTO_APPROVED' | 'AWAITING_HUMAN_APPROVAL';
}): RevenueOrchestrator {
  const workflowEngine = new MemoryWorkflowEngine();
  const effectGuard = new MemoryEffectGuard();
  const evidenceLogger = new MemoryEvidenceLogger('stage-recorder-test-secret');
  const approval = params.approval ?? 'AUTO_APPROVED';
  return new RevenueOrchestrator({
    contextAggregator: { hydrateContext: async () => context() },
    agentRuntime: {
      deriveHypothesis: async () => hypothesis(),
      resolveRouting: async (): Promise<RoutingDecision> => ({
        target_agent: 'SAL-01',
        requires_clarification: false,
        rationalization: 'stage recorder test route',
      }),
      formulatePlan: async (): Promise<ExecutionPlan> => ({
        plan_id: 'stage-recorder-plan',
        steps: params.steps,
        fallback_strategy: 'FAIL_CLOSED',
      }),
    },
    policyEngine: {
      validateAction: async (action) => action,
      evaluateAuthority: async () => ({ verdict: approval, reason: `stage recorder ${approval}` }),
    },
    workflowEngine,
    evidenceLogger,
    runStageRecorder: params.recorder,
    auditTrail: { append: async () => undefined },
    adapterDispatcher: {
      dispatch: async (action) => {
        params.timeline.push(`dispatch:${action.step_index}`);
        return params.dispatch === undefined ? receipt(action.step_index) : params.dispatch(action);
      },
    },
    effectGuard,
    sessionControl: {
      isTakenOver: async () => false,
      returnToAgent: async () => undefined,
    },
    leaseManager: new MemoryLeaseManager(),
    workerId: 'stage-recorder-worker',
  });
}

describe('RevenueOrchestrator durable stage recorder', () => {
  it('records a two-step lifecycle with pre-plan index zero and dispatch after EXECUTION append', async () => {
    const timeline: string[] = [];
    const events: Array<{
      stage: LifecycleStage;
      step_index: number;
      attempt_ordinal: number;
    }> = [];
    const recorder: IRunStageRecorder = {
      nextAttemptOrdinal: async () => 1,
      append: async (input) => {
        timeline.push(`stage:${input.stage}:${input.step_index}`);
        events.push({ stage: input.stage, step_index: input.step_index, attempt_ordinal: input.attempt_ordinal });
      },
    };
    const orchestrator = createOrchestrator({
      steps: [plannedStep(1), plannedStep(2)],
      recorder,
      timeline,
    });

    const result = await orchestrator.processSignal(signal());

    expect(result.lifecycle_state).toBe('completed');
    expect(events.map(({ stage }) => stage)).toEqual([
      'SIGNAL', 'CONTEXT', 'HYPOTHESIS', 'DECISION', 'PLAN',
      'ACTION', 'APPROVAL', 'EXECUTION', 'EVIDENCE',
      'ACTION', 'APPROVAL', 'EXECUTION', 'EVIDENCE', 'OUTCOME', 'LEARNING',
    ]);
    expect(events.map(({ step_index }) => step_index)).toEqual([
      0, 0, 0, 0, 0,
      1, 1, 1, 1,
      2, 2, 2, 2, 2, 2,
    ]);
    expect(events.every(({ attempt_ordinal }) => attempt_ordinal === 1)).toBe(true);
    expect(timeline.indexOf('stage:EXECUTION:1')).toBeLessThan(timeline.indexOf('dispatch:1'));
    expect(timeline.indexOf('stage:EXECUTION:2')).toBeLessThan(timeline.indexOf('dispatch:2'));
  });

  it('records APPROVAL but never EXECUTION when a step pauses for human approval', async () => {
    const timeline: string[] = [];
    const events: Array<{ stage: LifecycleStage; step_index: number }> = [];
    const orchestrator = createOrchestrator({
      steps: [plannedStep(1, 'AUTH-4')],
      approval: 'AWAITING_HUMAN_APPROVAL',
      timeline,
      recorder: {
        nextAttemptOrdinal: async () => 1,
        append: async ({ stage, step_index }) => {
          events.push({ stage, step_index });
          timeline.push(`stage:${stage}:${step_index}`);
        },
      },
    });

    const result = await orchestrator.processSignal(signal());

    expect(result.lifecycle_state).toBe('awaiting_human');
    expect(events.at(-1)).toEqual({ stage: 'APPROVAL', step_index: 1 });
    expect(events.some(({ stage }) => stage === 'EXECUTION')).toBe(false);
    expect(timeline.some((entry) => entry.startsWith('dispatch:'))).toBe(false);
  });

  it('fails closed on a recorder error before dispatch', async () => {
    const timeline: string[] = [];
    const orchestrator = createOrchestrator({
      steps: [plannedStep(1)],
      timeline,
      recorder: {
        nextAttemptOrdinal: async () => 1,
        append: async ({ stage }) => {
          timeline.push(`stage:${stage}`);
          if (stage === 'EXECUTION') throw new Error('stage recorder unavailable');
        },
      },
    });

    await expect(orchestrator.processSignal(signal())).rejects.toThrow('stage recorder unavailable');
    expect(timeline.some((entry) => entry.startsWith('dispatch:'))).toBe(false);
  });
});
