import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span, TracerProvider } from '@opentelemetry/api';

import {
  type ActionDraft,
  type ExecutionPlan,
  type ExecutionReceipt,
  type HydratedContext,
  type HypothesisRecord,
  type PlannedStep,
  type RoutingDecision,
  type SignalEnvelope,
} from '../contracts/index.js';
import { MemoryEffectGuard } from '../effects/memory-effect-guard.js';
import { MemoryEvidenceLogger } from '../evidence/evidence-logger.js';
import { MemoryLeaseManager } from '../workflow/memory-lease.js';
import { MemoryWorkflowEngine } from '../workflow/memory-workflow-engine.js';
import { RevenueOrchestrator } from './revenue-orchestrator.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SESSION = 'stage-tracing-session';
const SIGNAL_ID = 'stage-tracing-signal';
const SUCCESSFUL_STAGES = [
  'SIGNAL', 'CONTEXT', 'HYPOTHESIS', 'DECISION', 'PLAN', 'ACTION',
  'APPROVAL', 'EXECUTION', 'EVIDENCE', 'OUTCOME', 'LEARNING',
] as const;

type RecordedSpan = {
  readonly name: string;
  readonly attributes: Record<string, unknown>;
  status?: SpanStatusCode;
  exception?: unknown;
  ended: boolean;
};

type SpanEvent = {
  readonly kind: 'start' | 'end';
  readonly name: string;
};

const recordedSpans: RecordedSpan[] = [];
const spanEvents: SpanEvent[] = [];

const fakeTracer = {
  startSpan(name: string, options?: unknown): Span {
    const attributes = (options as { attributes?: Record<string, unknown> } | undefined)?.attributes ?? {};
    const recorded: RecordedSpan = { name, attributes, ended: false };
    recordedSpans.push(recorded);
    spanEvents.push({ kind: 'start', name });
    return {
      setStatus: (status: { code: SpanStatusCode }) => {
        recorded.status = status.code;
      },
      recordException: (exception: unknown) => {
        recorded.exception = exception;
      },
      end: () => {
        recorded.ended = true;
        spanEvents.push({ kind: 'end', name });
      },
    } as unknown as Span;
  },
};

const fakeTracerProvider = {
  getTracer: () => fakeTracer,
} as unknown as TracerProvider;

function signal(): SignalEnvelope {
  return {
    signal_id: SIGNAL_ID,
    tenant_id: TENANT,
    correlation_id: 'stage-tracing-correlation',
    source_channel: 'web',
    event_type: 'product.inquiry',
    payload: { text: 'show me products' },
    subject: { session_id: SESSION, channel_type: 'web' },
    timestamp: '2026-09-28T00:00:00.000Z',
  };
}

function context(): HydratedContext {
  return {
    correlation_id: 'stage-tracing-correlation',
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
    reasoning: 'stage tracing test hypothesis',
    derived_from_signals: [SIGNAL_ID],
  };
}

function plannedStep(): PlannedStep {
  return {
    step_index: 1,
    agent_id: 'SAL-01',
    skill_id: 'skill.stage_tracing.dispatch',
    adapter_target: 'web',
    input_parameters: { text: 'step-1' },
    required_authority: 'AUTH-1',
    mutating: true,
    price_bearing: false,
    idempotent: true,
    timeout_ms: 1_000,
  };
}

function receipt(): ExecutionReceipt {
  return {
    execution_id: 'stage-tracing-execution',
    adapter_status: 'SUCCESS',
    provider_reference: 'stage-tracing-provider',
    response_payload: {},
    latency_ms: 1,
    token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
  };
}

function createOrchestrator(options: { readonly deriveHypothesis?: () => Promise<HypothesisRecord> } = {}): RevenueOrchestrator {
  const workflowEngine = new MemoryWorkflowEngine();
  return new RevenueOrchestrator({
    contextAggregator: { hydrateContext: async () => context() },
    agentRuntime: {
      deriveHypothesis: options.deriveHypothesis ?? (async () => hypothesis()),
      resolveRouting: async (): Promise<RoutingDecision> => ({
        target_agent: 'SAL-01',
        requires_clarification: false,
        rationalization: 'stage tracing test route',
      }),
      formulatePlan: async (): Promise<ExecutionPlan> => ({
        plan_id: 'stage-tracing-plan',
        steps: [plannedStep()],
        fallback_strategy: 'FAIL_CLOSED',
      }),
    },
    policyEngine: {
      validateAction: async (action: ActionDraft) => action,
      evaluateAuthority: async () => ({ verdict: 'AUTO_APPROVED' as const, reason: 'stage tracing test approval' }),
    },
    workflowEngine,
    evidenceLogger: new MemoryEvidenceLogger('stage-tracing-test-secret'),
    auditTrail: { append: async () => undefined },
    adapterDispatcher: { dispatch: async () => receipt() },
    effectGuard: new MemoryEffectGuard(),
    sessionControl: {
      isTakenOver: async () => false,
      returnToAgent: async () => undefined,
    },
    leaseManager: new MemoryLeaseManager(),
    workerId: 'stage-tracing-worker',
  });
}

describe('RevenueOrchestrator stage tracing', () => {
  beforeAll(() => {
    trace.setGlobalTracerProvider(fakeTracerProvider);
  });

  beforeEach(() => {
    recordedSpans.length = 0;
    spanEvents.length = 0;
  });

  it('starts and ends successful stage spans in pipeline order without payload attributes', async () => {
    const orchestrator = createOrchestrator();
    const result = await orchestrator.processSignal(signal());

    expect(result.lifecycle_state).toBe('completed');
    expect(recordedSpans.map((span) => span.name)).toEqual(
      SUCCESSFUL_STAGES.map((stage) => `orchestrator.stage.${stage}`),
    );
    expect(spanEvents).toEqual(SUCCESSFUL_STAGES.flatMap((stage) => [
      { kind: 'start', name: `orchestrator.stage.${stage}` },
      { kind: 'end', name: `orchestrator.stage.${stage}` },
    ]));

    for (const span of recordedSpans) {
      expect(span.status).toBe(SpanStatusCode.OK);
      expect(span.ended).toBe(true);
      expect(Object.keys(span.attributes).sort()).toEqual(['run_id', 'stage', 'tenant_id']);
      expect(span.attributes.tenant_id).toBe(TENANT);
      expect(span.attributes.run_id).toBe(result.run_id);
      expect(span.attributes.stage).toBe(span.name.replace('orchestrator.stage.', ''));
    }
  });

  it('records a throwing stage exception as ERROR and still ends its span', async () => {
    const failure = new Error('hypothesis provider failed');
    const orchestrator = createOrchestrator({ deriveHypothesis: async () => { throw failure; } });

    await expect(orchestrator.processSignal(signal())).rejects.toBe(failure);

    expect(recordedSpans.map((span) => span.name)).toEqual([
      'orchestrator.stage.SIGNAL',
      'orchestrator.stage.CONTEXT',
      'orchestrator.stage.HYPOTHESIS',
    ]);
    const hypothesisSpan = recordedSpans[2];
    expect(hypothesisSpan?.status).toBe(SpanStatusCode.ERROR);
    expect(hypothesisSpan?.exception).toBe(failure);
    expect(hypothesisSpan?.ended).toBe(true);
    expect(Object.keys(hypothesisSpan?.attributes ?? {}).sort()).toEqual(['run_id', 'stage', 'tenant_id']);
  });
});
