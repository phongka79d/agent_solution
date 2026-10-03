import { describe, expect, it } from 'vitest';

import type {
  ActionDraft,
  AgentRunLogRecord,
  ExecutionPlan,
  ExecutionReceipt,
  HydratedContext,
  HypothesisRecord,
  IAuditTrail,
  IRunStageRecorder,
  PlannedStep,
  RoutingDecision,
  SignalEnvelope,
} from '../contracts/index.js';
import { MemoryEffectGuard } from '../effects/memory-effect-guard.js';
import type { LifecycleStage } from '../lifecycle/stages.js';
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
    payload: {
      text: 'Jamie Example asked about products',
      phone: '+1 555 010 1234',
      email: 'jamie@example.test',
      address: '12 Example Street',
      free_text: 'Customer private message',
    },
    subject: { session_id: SESSION, channel_type: 'web' },
    timestamp: '2026-09-28T00:00:00.000Z',
  };
}

function context(): HydratedContext & Record<string, unknown> {
  const working_memory = Object.assign(
    {
      session_id: SESSION,
      last_touch_channel: 'web',
      turn_count: 1,
      takeover_active: false,
    },
    {
      phone: '+1 555 010 1234',
      email: 'jamie@example.test',
      address: '12 Example Street',
      free_text: 'Private memory text',
    },
  );
  return {
    correlation_id: 'stage-recorder-correlation',
    tenant_id: TENANT,
    customer: {
      customer_id: 'customer-stage-recorder',
      tenant_id: TENANT,
      verified_phone: '+1 555 010 1234',
      verified_email: 'jamie@example.test',
      total_spent: 0,
      order_count: 0,
      rfm_segment_hypothesis: 'new',
      consent_marketing: false,
      consent_updated_at: null,
      suppression_active: false,
      created_at: '2026-09-28T00:00:00.000Z',
    },
    working_memory,
    knowledge_citations: [],
    hydrated_at: '2026-09-28T00:00:00.000Z',
    data_class: 'DEMO',
    phone: '+1 555 010 1234',
    email: 'jamie@example.test',
    address: '12 Example Street',
    free_text: 'Private hydrated context',
  };
}

function hypothesis(): HypothesisRecord & Record<string, unknown> {
  return {
    classification: 'HYPOTHESIS',
    intent: 'product.inquiry',
    confidence: 0.8,
    churn_risk_score: 0,
    purchase_propensity: 0,
    reasoning: 'Private free text for stage-recorder test',
    derived_from_signals: ['stage-recorder-signal'],
    provider_call_index: 2,
    phone: '+1 555 010 1234',
    email: 'jamie@example.test',
    address: '12 Example Street',
    free_text: 'Private hypothesis explanation',
  };
}

function plannedStep(
  step_index: number,
  required_authority: PlannedStep['required_authority'] = 'AUTH-1',
  skill_id = `skill.stage_recorder.${step_index}`,
): PlannedStep {
  return {
    step_index,
    agent_id: 'SAL-01',
    skill_id,
    adapter_target: 'web',
    input_parameters: {
      text: `step-${step_index}`,
      phone: '+1 555 010 1234',
      email: 'jamie@example.test',
      address: '12 Example Street',
      free_text: 'Private skill input',
    },
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
    response_payload: {
      step_index,
      phone: '+1 555 010 1234',
      email: 'jamie@example.test',
      address: '12 Example Street',
      free_text: 'Private provider response',
    },
    latency_ms: 1,
    token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
  };
}

function createOrchestrator(params: {
  readonly steps: PlannedStep[];
  readonly recorder: IRunStageRecorder;
  readonly timeline: string[];
  readonly dispatch?: (action: ActionDraft) => Promise<ExecutionReceipt>;
  readonly auditTrail?: IAuditTrail;
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
      evaluateAuthority: async () => ({
        verdict: approval,
        reason: `Approval reason with private value jamie@example.test`,
      }),
    },
    workflowEngine,
    evidenceLogger,
    runStageRecorder: params.recorder,
    auditTrail: params.auditTrail ?? { append: async () => undefined },
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
      evidence_refs?: unknown;
      detail?: unknown;
    }> = [];
    const results: Array<Parameters<IRunStageRecorder['complete']>[0]> = [];
    const recorder: IRunStageRecorder = {
      nextAttemptOrdinal: async () => 1,
      append: async (input) => {
        timeline.push(`stage:${input.stage}:${input.step_index}`);
        events.push({
          stage: input.stage,
          step_index: input.step_index,
          attempt_ordinal: input.attempt_ordinal,
          ...(input.evidence_refs === undefined ? {} : { evidence_refs: input.evidence_refs }),
          ...(input.detail === undefined ? {} : { detail: input.detail }),
        });
      },
      complete: async (result) => {
        results.push(result);
      },
    };
    const orchestrator = createOrchestrator({
      steps: [plannedStep(1, 'AUTH-1', 'skill.sales.search_product'), plannedStep(2)],
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
    expect(results.map(({ stage, step_index }) => `${stage}:${step_index}`))
      .toEqual(events.map(({ stage, step_index }) => `${stage}:${step_index}`));
    expect(results.every(({ status, started_at, completed_at, duration_ms }) => (
      status === 'completed'
      && Date.parse(completed_at) >= Date.parse(started_at)
      && duration_ms >= 0
    ))).toBe(true);
    expect(results.map(({ summary_key }) => summary_key)).toEqual([
      'run.stage.signal.received',
      'run.stage.context.hydrated',
      'run.stage.hypothesis.derived',
      'run.stage.decision.routed',
      'run.skill.sales.search_product.plan',
      'run.skill.sales.search_product.action',
      'run.skill.sales.search_product.approval',
      'run.skill.sales.search_product.execution',
      'run.skill.sales.search_product.evidence',
      'run.stage.action.drafted',
      'run.stage.approval.evaluated',
      'run.stage.execution.observed',
      'run.stage.evidence.recorded',
      'run.stage.outcome.available',
      'run.stage.learning.updated',
    ]);
    expect(results.find(({ stage }) => stage === 'SIGNAL')?.detail).toEqual({
      event_type: 'product.inquiry',
      channel: 'web',
      domain: 'orchestration',
    });
    expect(results.find(({ stage }) => stage === 'CONTEXT')?.detail).toEqual({
      customer_verified: true,
      data_class: 'DEMO',
      takeover_active: false,
    });
    expect(results.find(({ stage }) => stage === 'HYPOTHESIS')?.detail).toEqual({
      intent: 'product.inquiry',
      confidence: 0.8,
      provider_call_index: 2,
    });
    expect(results.find(({ stage }) => stage === 'DECISION')?.detail).toEqual({
      target_agent: 'SAL-01',
      requires_clarification: false,
      routing_reason_key: 'routing.decision.complete',
    });
    expect(results.find(({ stage }) => stage === 'PLAN')?.detail).toEqual({
      steps: [
        { agent: 'SAL-01', skill: 'skill.sales.search_product', authority: 'AUTH-1', mutating: true },
        { agent: 'SAL-01', skill: 'skill.stage_recorder.2', authority: 'AUTH-1', mutating: true },
      ],
    });
    expect(results.find(({ stage }) => stage === 'ACTION')?.detail).toEqual({
      agent: 'SAL-01',
      skill: 'skill.sales.search_product',
    });
    expect(results.find(({ stage }) => stage === 'APPROVAL')?.detail).toEqual({
      approval_id: null,
      attempts: 1,
      skill_id: 'skill.sales.search_product',
      effect_key_status: 'NOT_RESERVED',
      verdict: 'AUTO_APPROVED',
      reason_key: 'authority.approved',
    });
    expect(results.find(({ stage }) => stage === 'EXECUTION')?.detail).toEqual({
      approval_id: null,
      attempts: 1,
      skill_id: 'skill.sales.search_product',
      effect_key_status: 'RESERVED',
      adapter_status: 'SUCCESS',
      latency_ms: 1,
    });
    expect(results.find(({ stage }) => stage === 'EVIDENCE')?.detail).toEqual({
      agent: 'SAL-01',
      skill: 'skill.sales.search_product',
      evidence_id: expect.stringMatching(/^ev_[a-f0-9]{16}$/),
    });
    expect(results.find(({ stage }) => stage === 'OUTCOME')?.detail).toEqual({
      outcome_kind: null,
      outcome_watch_id: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(results.find(({ stage }) => stage === 'LEARNING')?.detail).toEqual({
      outcome_kind: null,
      outcome_watch_id: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const serializedDetails = JSON.stringify([
      ...results.map(({ detail }) => detail),
      ...results.map(({ summary_key }) => summary_key),
      ...events.map(({ detail }) => detail),
    ]);
    for (const field of [
      'phone',
      'email',
      'address',
      'free_text',
      'verified_phone',
      'verified_email',
      'text',
      'message',
      'content',
      'reason',
      'payload',
      'raw_payload',
      'reasoning',
      'customer_id',
      'verified_customer_id',
      'customer',
      'customer_name',
      'display_name',
      'tenant_id',
      'session_id',
      'working_memory',
      'correlation_id',
      'signal_id',
      'subject',
    ]) {
      expect(serializedDetails).not.toContain(`"${field}"`);
    }
    for (const privateValue of [
      'Jamie Example',
      '+1 555 010 1234',
      'jamie@example.test',
      '12 Example Street',
      'Private skill input',
      'Private provider response',
      'Private hypothesis explanation',
    ]) {
      expect(serializedDetails).not.toContain(privateValue);
    }
    expect(results.filter(({ stage }) => ['ACTION', 'APPROVAL', 'EXECUTION', 'EVIDENCE', 'OUTCOME', 'LEARNING'].includes(stage))
      .every(({ skill_id }) => skill_id === 'skill.sales.search_product' || skill_id === 'skill.stage_recorder.2'))
      .toBe(true);
    const evidenceResults = results.filter(({ stage }) => stage === 'EVIDENCE');
    expect(evidenceResults).toHaveLength(2);
    for (const evidenceResult of evidenceResults) {
      const detail = evidenceResult.detail as { evidence_id?: string };
      expect(detail.evidence_id).toMatch(/^ev_[a-f0-9]{16}$/);
      expect(evidenceResult.evidence_refs).toEqual([{ evidence_id: detail.evidence_id }]);
    }
    const finalEvidenceId = (evidenceResults.at(-1)?.detail as { evidence_id?: string } | undefined)?.evidence_id;
    expect(events.find(({ stage }) => stage === 'OUTCOME')?.evidence_refs)
      .toEqual([{ evidence_id: finalEvidenceId }]);
    expect(results.find(({ stage }) => stage === 'OUTCOME')?.evidence_refs)
      .toEqual([{ evidence_id: finalEvidenceId }]);
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
        complete: async () => undefined,
      },
    });

    const result = await orchestrator.processSignal(signal());

    expect(result.lifecycle_state).toBe('awaiting_human');
    expect(events.at(-1)).toEqual({ stage: 'APPROVAL', step_index: 1 });
    expect(events.some(({ stage }) => stage === 'EXECUTION')).toBe(false);
    expect(timeline.some((entry) => entry.startsWith('dispatch:'))).toBe(false);
  });

  it.each<{ approval: 'AUTO_APPROVED' | 'AWAITING_HUMAN_APPROVAL' }>([
    { approval: 'AUTO_APPROVED' },
    { approval: 'AWAITING_HUMAN_APPROVAL' },
  ])(
    'writes real step audit coverage for a $approval draft-gated run without stage audit_ref claims',
    async ({ approval }) => {
      const audits: AgentRunLogRecord[] = [];
      const results: Array<Parameters<IRunStageRecorder['complete']>[0]> = [];
      const orchestrator = createOrchestrator({
        steps: [plannedStep(1, 'AUTH-4', 'skill.mkt.generate_content')],
        approval,
        timeline: [],
        auditTrail: {
          append: async (record) => {
            audits.push(record);
          },
        },
        recorder: {
          nextAttemptOrdinal: async () => 1,
          append: async () => undefined,
          complete: async (result) => {
            results.push(result);
          },
        },
      });

      const result = await orchestrator.processSignal(signal());

      expect(result.lifecycle_state).toBe(approval === 'AUTO_APPROVED' ? 'completed' : 'awaiting_human');
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        tenant_id: TENANT,
        run_id: result.run_id,
        skill: 'skill.mkt.generate_content',
        step_index: 1,
        execution_status: approval === 'AUTO_APPROVED' ? 'success' : 'pending',
        action: { step_index: 1 },
      });
      const skillStages = results.filter(({ skill_id }) => skill_id === 'skill.mkt.generate_content');
      expect(skillStages.find(({ stage }) => stage === 'PLAN')?.step_index).toBe(0);
      expect(skillStages.some(({ step_index }) => step_index === 1)).toBe(true);
      for (const stage of skillStages) {
        expect(stage.detail).not.toHaveProperty('audit_ref');
        expect(audits.some((audit) => (
          audit.tenant_id === stage.tenant_id
          && audit.run_id === stage.run_id
          && audit.skill === stage.skill_id
          && (stage.step_index === 0 || audit.step_index === stage.step_index)
        ))).toBe(true);
      }
    },
  );

  it('does not claim audit coverage when the step audit append fails after dispatch', async () => {
    const results: Array<Parameters<IRunStageRecorder['complete']>[0]> = [];
    let appendAttempts = 0;
    const orchestrator = createOrchestrator({
      steps: [plannedStep(1, 'AUTH-4', 'skill.mkt.generate_content')],
      timeline: [],
      auditTrail: {
        append: async () => {
          appendAttempts += 1;
          throw new Error('audit ledger unavailable');
        },
      },
      recorder: {
        nextAttemptOrdinal: async () => 1,
        append: async () => undefined,
        complete: async (result) => {
          results.push(result);
        },
      },
    });

    const result = await orchestrator.processSignal(signal());

    expect(result.lifecycle_state).toBe('waiting');
    expect(appendAttempts).toBe(1);
    expect(results.find(({ stage }) => stage === 'EVIDENCE')?.status).toBe('failed');
    for (const stage of results) {
      expect(stage.detail).not.toHaveProperty('audit_ref');
    }
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
        complete: async () => undefined,
      },
    });

    await expect(orchestrator.processSignal(signal())).rejects.toThrow('stage recorder unavailable');
    expect(timeline.some((entry) => entry.startsWith('dispatch:'))).toBe(false);
  });
});
