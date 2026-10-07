import { describe, expect, it, vi } from 'vitest';
import {
  computeRequestFingerprint,
  MemoryEffectGuard,
  type ActionDraft,
  type ApprovalGateResult,
  type ExecutionPlan,
  type HydratedContext,
  type IAgentRuntime,
  type IAuditTrail,
  type IContextAggregator,
  type IEvidenceLogger,
  type IPolicyEngine,
  type IStatefulWorkflowEngine,
  type SignalEnvelope,
  type TaskLifecycleState,
} from '@agentos/core-engine';
import type { DurableLeaseManager } from '@agentos/core-engine/contracts';
import { createMarketingOrchestratorFactory } from './factory.js';
import type { MarketingSkillOptions } from './skills/index.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const CUSTOMER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_CUSTOMER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECRET = 'stack-a-guards-test-secret';
const NOW = new Date('2026-09-29T00:00:00.000Z');

type Task = {
  state: TaskLifecycleState;
  task_version: number;
  correlation_id: string;
  state_payload: unknown;
  retry_count: number;
};

class WorkflowDouble implements IStatefulWorkflowEngine {
  readonly tasks = new Map<string, Task>();
  readonly pauseForApproval = vi.fn(async (params: Parameters<IStatefulWorkflowEngine['pauseForApproval']>[0]) => {
    const task = this.tasks.get(params.run_id);
    if (task === undefined) throw new Error('task missing');
    task.state = 'awaiting_human';
    task.state_payload = params.checkpoint;
    task.task_version++;
    return { approval_id: 'approval-stack-a' };
  });
  readonly claimApprovalAndResume = vi.fn(async (_params: Parameters<IStatefulWorkflowEngine['claimApprovalAndResume']>[0]) => ({ claimed: true }));

  async createTask(input: Parameters<IStatefulWorkflowEngine['createTask']>[0]): Promise<void> {
    this.tasks.set(input.run_id, {
      state: input.state,
      task_version: 1,
      correlation_id: input.correlation_id,
      state_payload: input.state_payload ?? null,
      retry_count: 0,
    });
  }

  async updateTaskProgress(tenant_id: string, run_id: string, _step: number, payload: unknown): Promise<void> {
    void tenant_id;
    const task = this.tasks.get(run_id);
    if (task === undefined) throw new Error('task missing');
    task.state_payload = payload;
    task.task_version++;
  }

  async transitionTask(_tenant: string, run_id: string, state: Task['state'], _reason: string, payload?: unknown): Promise<void> {
    const task = this.tasks.get(run_id);
    if (task === undefined) throw new Error('task missing');
    task.state = state;
    if (payload !== undefined) task.state_payload = payload;
    task.task_version++;
  }

  async getTask(_tenant: string, run_id: string): Promise<Task | null> {
    return this.tasks.get(run_id) ?? null;
  }

  async recordFailure(): Promise<{ requeued: boolean }> {
    return { requeued: false };
  }

  async queueHandoffEvidence(): Promise<{ queued: boolean }> {
    return { queued: false };
  }

  async clearHandoffEvidence(): Promise<{ cleared: boolean }> {
    return { cleared: false };
  }
}

function context(tenant_id = TENANT): HydratedContext {
  return {
    tenant_id,
    correlation_id: 'corr-stack-a',
    customer: {
      customer_id: CUSTOMER,
      tenant_id,
      verified_phone: null,
      verified_email: null,
      total_spent: 0,
      order_count: 0,
      rfm_segment_hypothesis: 'HIBERNATING',
      consent_marketing: true,
      consent_updated_at: null,
      suppression_active: false,
      created_at: NOW.toISOString(),
    },
    working_memory: {
      session_id: 'session-stack-a',
      last_touch_channel: 'MARKETING_CAMPAIGN',
      turn_count: 0,
      takeover_active: false,
    },
    knowledge_citations: [],
    hydrated_at: NOW.toISOString(),
  };
}

function signal(signal_id = 'signal-stack-a'): SignalEnvelope {
  return {
    signal_id,
    tenant_id: TENANT,
    correlation_id: 'corr-stack-a',
    source_channel: 'MARKETING_CAMPAIGN',
    event_type: 'campaign.requested',
    timestamp: NOW.toISOString(),
    subject: { session_id: 'session-stack-a', channel_type: 'MARKETING_CAMPAIGN' },
    payload: { module: 'marketing', skill_id: 'skill.mkt.dispatch_campaign' },
  } as SignalEnvelope;
}

type StackASkill = 'analyze' | 'segment' | 'check_consent' | 'generate' | 'brand' | 'dispatch' | 'attribution';

function campaignPlan(
  required_authority: 'AUTH-1' | 'AUTH-2' | 'AUTH-3' | 'AUTH-4' | 'AUTH-5' = 'AUTH-4',
  inputOverrides: Record<string, unknown> = {},
  skill: StackASkill = 'dispatch',
): ExecutionPlan {
  const input_parameters = skill === 'analyze'
    ? { market_region: 'TW', category_id: 'tea-beverages', observation_window_days: 30, ...inputOverrides }
    : skill === 'segment'
      ? { rfm_criteria: 'HIBERNATING', min_days_inactive: 30, max_segment_size: 10, ...inputOverrides }
      : skill === 'check_consent'
        ? { customer_id: OTHER_CUSTOMER, channel: 'EMAIL', ...inputOverrides }
        : skill === 'generate'
          ? { campaign_theme: 'Seasonal collection', channel: 'SMS_TEXT', locale: 'en-US', ...inputOverrides }
          : skill === 'brand'
            ? { draft_text: 'Clean copy', channel: 'SMS_TEXT', ...inputOverrides }
            : skill === 'attribution'
              ? { campaign_id: 'campaign-stack-a', attribution_model: 'LAST_TOUCH', ...inputOverrides }
              : {
                  campaign_id: 'campaign-stack-a',
                  segment_id: 'segment-stack-a',
                  channel: 'EMAIL',
                  approved_content_id: 'content-stack-a',
                  ...inputOverrides,
                };
  const skill_id = skill === 'analyze' ? 'skill.mkt.analyze_market_signal'
    : skill === 'segment' ? 'skill.mkt.segment_audience'
      : skill === 'check_consent' ? 'skill.mkt.check_consent'
        : skill === 'generate' ? 'skill.mkt.generate_content'
          : skill === 'brand' ? 'skill.mkt.audit_brand_compliance'
            : skill === 'attribution' ? 'skill.mkt.evaluate_attribution'
              : 'skill.mkt.dispatch_campaign';
  const agent_id = skill === 'analyze' ? 'MKT-01'
    : skill === 'segment' ? 'MKT-02'
      : skill === 'generate' ? 'MKT-03'
        : skill === 'brand' ? 'MKT-04'
          : skill === 'check_consent' ? 'MKT-02'
            : skill === 'attribution' ? 'MKT-06' : 'MKT-05';
  const adapter_target = skill === 'analyze' ? 'API-002.EventIngestion'
    : skill === 'segment' ? 'PostgreSQL.Customer360Store'
      : skill === 'check_consent' ? 'API-002.ConsentStore'
        : skill === 'generate' ? 'Core.LLMContentEngine'
          : skill === 'brand' ? 'SecondBrain.BrandGuard'
            : skill === 'attribution' ? 'PostgreSQL.AnalyticsStore'
              : 'API-003.CommunicationConnector';
  const mutating = skill === 'dispatch';
  return {
    plan_id: 'plan-stack-a',
    steps: [{
      step_index: 1,
      agent_id,
      skill_id,
      adapter_target,
      input_parameters,
      required_authority,
      mutating,
      price_bearing: false,
      idempotent: !mutating,
      timeout_ms: 5000,
    }],
    fallback_strategy: 'FAIL_CLOSED',
  };
}

function agentRuntime(
  required_authority: 'AUTH-1' | 'AUTH-2' | 'AUTH-3' | 'AUTH-4' | 'AUTH-5' = 'AUTH-4',
  inputOverrides: Record<string, unknown> = {},
  skill: StackASkill = 'dispatch',
): IAgentRuntime {
  return {
    deriveHypothesis: async () => ({
      classification: 'HYPOTHESIS',
      intent: 'marketing:dispatch',
      confidence: 1,
      churn_risk_score: 0,
      purchase_propensity: 0,
      reasoning: 'test',
      derived_from_signals: ['signal-stack-a'],
    }),
    resolveRouting: async () => ({ target_agent: skill === 'check_consent' ? 'MKT-02' : skill === 'generate' ? 'MKT-03' : skill === 'brand' ? 'MKT-04' : skill === 'attribution' ? 'MKT-06' : 'MKT-01', requires_clarification: false, rationalization: 'test' }),
    formulatePlan: async () => campaignPlan(required_authority, inputOverrides, skill),
  };
}

function evidenceLogger(): IEvidenceLogger {
  let serial = 0;
  return {
    createImmutableRecord: async (input) => ({
      evidence_id: `evidence-stack-a-${++serial}`,
      run_id: input.run_id,
      tenant_id: input.tenant_id,
      correlation_id: input.correlation_id,
      step_index: input.step_index,
      effect_key: input.effect_key,
      previous_evidence_hash: input.previous_evidence_hash,
      payload_sha256: 'a'.repeat(64),
      chain_hash: `b${String(serial).padStart(63, '0')}`,
      signature: 'c'.repeat(64),
      created_at: NOW.toISOString(),
      ...(typeof input.payload.receipt === 'object' && input.payload.receipt !== null
        ? { receipt: input.payload.receipt as never }
        : {}),
    }),
    initializeOutcomeWatch: async () => undefined,
    logAgentRun: async () => undefined,
  };
}

function makeHarness(options: {
  readonly policy?: IPolicyEngine;
  readonly grant?: 'AUTH-3' | null;
  readonly resolveAudience?: (input: { tenant_id: string; segment_id: string; channel: string }) => Promise<readonly string[]>;
  readonly consent?: (input: { tenant_id: string; customer_id: string; channel: string }) => Promise<{ allowed: boolean }>;
  readonly dispatch?: (input: { recipients?: readonly string[] }) => Promise<Record<string, unknown>>;
  readonly requiredAuthority?: 'AUTH-1' | 'AUTH-2' | 'AUTH-3' | 'AUTH-4' | 'AUTH-5';
  readonly inputOverrides?: Record<string, unknown>;
  readonly contextTenant?: string;
  readonly skill?: StackASkill;
  readonly reconcile?: MarketingSkillOptions['reconcile'];
  readonly validateAuthoritative?: (
    payload: Readonly<Record<string, unknown>>,
    context: HydratedContext,
  ) => Promise<{ computed_price_floor: number; floor_source: string; proposed_price?: number }>;
} = {}) {
  const workflow = new WorkflowDouble();
  const dispatch = vi.fn(options.dispatch ?? (async ({ recipients }) => ({
    dispatch_id: 'dispatch-stack-a',
    recipient_count: recipients?.length ?? 0,
    status: 'ENQUEUED',
    dispatched_at: NOW.toISOString(),
  })));
  const resolveAudience = vi.fn(options.resolveAudience ?? (async () => [CUSTOMER]));
  const consent = vi.fn(options.consent ?? (async () => ({ allowed: true })));
  const consentPort = {
    checkConsent: async (input: { tenant_id: string; customer_id: string; channel: string }) => ({
      ...input,
      ...(await consent(input)),
      consent_timestamp: NOW.toISOString(),
      suppression_reason: null,
    }),
  };
  const communication = {
    resolveAudience,
    consent: consentPort,
    dispatchCampaign: async (input: { recipients?: readonly string[] }) => dispatch(input),
  } as unknown as NonNullable<MarketingSkillOptions['communication']>;
  const skillOptions = {
    communication,
    consent: consentPort,
    signal_reads: {
      readSignals: async () => ({
        signals: [{ signal_id: 'market-signal-1', keyword: 'tea', search_volume_growth: 2, price_pressure_index: 1 }],
        trend_velocity: 'STABLE',
        analyzed_at: NOW.toISOString(),
      }),
    },
    customer360: {
      segmentAudience: async () => ({
        segment_id: 'segment-stack-a',
        matched_customer_count: 1,
        customer_ids: [CUSTOMER],
        generated_at: NOW.toISOString(),
      }),
    },
    content_engine: {
      generateContent: async () => ({
        draft_id: 'draft-stack-a',
        headline: 'Headline',
        body_content: 'Body',
        cta_text: 'Shop',
        channel_payload: { channel_type: 'SMS_TEXT' },
      }),
    },
    brand_guard: {
      auditBrandCompliance: async () => ({ compliant: true, violations: [], confidence_score: 1 }),
    },
    analytics: {
      evaluateAttribution: async () => ({
        campaign_id: 'campaign-stack-a',
        attributed_revenue: 0,
        attributed_orders: 0,
        roas: 0,
        calculated_at: NOW.toISOString(),
      }),
    },
  } as unknown as Partial<MarketingSkillOptions>;
  const effectGuard = new MemoryEffectGuard({ now: () => NOW });
  const leaseManager: DurableLeaseManager = {
    acquireLease: async () => true,
    releaseLease: async () => undefined,
  };
  const auditTrail: IAuditTrail = { append: async () => undefined };
  const contextAggregator: IContextAggregator = {
    hydrateContext: async (tenant_id) => context(options.contextTenant ?? tenant_id),
  };
  const factory = createMarketingOrchestratorFactory({
    auditSecret: SECRET,
    workflowEngine: workflow,
    evidenceLogger: evidenceLogger(),
    auditTrail,
    sessionControl: { isTakenOver: async () => false, returnToAgent: async () => undefined },
    leaseManager,
    effectGuard,
    contextAggregator,
    agentRuntime: agentRuntime(options.requiredAuthority, options.inputOverrides, options.skill),
    resolve_grant: async () => options.grant === null ? null : options.grant ?? 'AUTH-3',
    resolve_correlation_id: async () => 'corr-stack-a',
    skillOptions: {
      ...skillOptions,
      ...(options.reconcile === undefined ? {} : { reconcile: options.reconcile }),
    },
    ...(options.policy === undefined ? {} : { policyEngine: options.policy }),
    ...(options.validateAuthoritative === undefined ? {} : { validateAuthoritative: options.validateAuthoritative }),
  });
  return { factory, workflow, dispatch, resolveAudience, consent, effectGuard };
}

function autoPolicy(digest: 'valid' | 'invalid' = 'valid'): IPolicyEngine {
  return {
    validateAction: async (action: ActionDraft) => {
      const payload = { ...(action.payload as Record<string, unknown>) };
      delete payload.effect_key;
      return {
        ...action,
        approval_id: 'approval-stack-a',
        approval_payload_digest: digest === 'valid' ? computeRequestFingerprint(payload) : '0'.repeat(64),
      };
    },
    evaluateAuthority: async (): Promise<ApprovalGateResult> => ({ verdict: 'AUTO_APPROVED', reason: 'test approval' }),
  };
}
function pauseThenAutoPolicy(): IPolicyEngine {
  let evaluations = 0;
  return {
    validateAction: async (action: ActionDraft) => action,
    evaluateAuthority: async (): Promise<ApprovalGateResult> => {
      evaluations++;
      return evaluations === 1
        ? { verdict: 'AWAITING_HUMAN_APPROVAL', reason: 'test approval required' }
        : { verdict: 'AUTO_APPROVED', reason: 'claimed approval' };
    },
  };
}


describe('Stack A Marketing guard port', () => {
  it('keeps AUTH-4 mandatory and makes zero provider calls before release', async () => {
    const harness = makeHarness();
    const orchestrator = await harness.factory(TENANT);
    const result = await orchestrator!.processSignal(signal());

    expect(result.lifecycle_state).toBe('awaiting_human');
    expect(harness.workflow.pauseForApproval).toHaveBeenCalledTimes(1);
    expect(harness.dispatch).not.toHaveBeenCalled();
    expect(orchestrator!.visitedStages).toEqual(['SIGNAL', 'CONTEXT', 'HYPOTHESIS', 'DECISION', 'PLAN', 'ACTION', 'APPROVAL']);
  });

  it('rejects a resumed dispatch when the reviewed digest no longer covers the action payload', async () => {
    const harness = makeHarness({ policy: pauseThenAutoPolicy() });
    const orchestrator = await harness.factory(TENANT);
    const paused = await orchestrator!.processSignal(signal('signal-digest-mismatch'));

    expect(paused.lifecycle_state).toBe('awaiting_human');
    const resumed = await orchestrator!.resumeTask(paused.run_id, {
      tenant_id: TENANT,
      event_type: 'human.approval',
      approval_id: 'approval-stack-a',
      expected_payload_sha256: '0'.repeat(64),
      operator_id: 'operator-stack-a',
    });

    expect(resumed.lifecycle_state).toBe('waiting');
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it('filters recipients through dispatch-time consent before the API-003 call', async () => {
    const harness = makeHarness({
      policy: autoPolicy(),
      resolveAudience: async () => [CUSTOMER, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
      consent: async ({ customer_id }) => ({ allowed: customer_id === CUSTOMER }),
    });
    const orchestrator = await harness.factory(TENANT);
    const result = await orchestrator!.processSignal(signal('signal-consent-filter'));

    expect(result.lifecycle_state).toBe('completed');
    expect(harness.consent).toHaveBeenCalledTimes(2);
    expect(harness.dispatch).toHaveBeenCalledWith(expect.objectContaining({ recipients: [CUSTOMER] }));
  });

  it('refuses AUTH-5 before queueing or provider dispatch', async () => {
    const harness = makeHarness({ requiredAuthority: 'AUTH-5' });
    const orchestrator = await harness.factory(TENANT);
    const result = await orchestrator!.processSignal(signal('signal-auth5'));

    expect(result.lifecycle_state).toBe('stopped');
    expect(harness.workflow.pauseForApproval).not.toHaveBeenCalled();
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it('replays a duplicate effect without a second connector dispatch', async () => {
    const harness = makeHarness({ policy: autoPolicy() });
    const orchestrator = await harness.factory(TENANT);
    const request = signal('signal-idempotent');

    expect((await orchestrator!.processSignal(request)).lifecycle_state).toBe('completed');
    expect((await orchestrator!.processSignal(request)).lifecycle_state).toBe('completed');
    expect(harness.dispatch).toHaveBeenCalledTimes(1);
  });

  it('parks a provider-reported failure as UNKNOWN instead of fabricating success', async () => {
    const harness = makeHarness({
      policy: autoPolicy(),
      dispatch: async () => ({
        dispatch_id: 'dispatch-failed-stack-a',
        recipient_count: 1,
        status: 'FAILED',
        dispatched_at: NOW.toISOString(),
      }),
    });
    const orchestrator = await harness.factory(TENANT);
    const result = await orchestrator!.processSignal(signal('signal-receipt-failure'));

    expect(result.lifecycle_state).toBe('waiting');
    expect(harness.dispatch).toHaveBeenCalledTimes(1);
    expect(result.message).toContain('UNKNOWN');
  });

  it('keeps tenant context bound to the server-resolved tenant', async () => {
    const harness = makeHarness({ policy: autoPolicy() });
    const orchestrator = await harness.factory(TENANT);
    const internals = orchestrator as unknown as { dependencies: { contextAggregator: IContextAggregator } };
    const hydrated = await internals.dependencies.contextAggregator.hydrateContext(TENANT, { session_id: 'session-stack-a', channel_type: 'MARKETING_CAMPAIGN' }, 'corr-stack-a');

    expect(hydrated.tenant_id).toBe(TENANT);
    expect(hydrated.customer?.tenant_id).toBe(TENANT);
  });
  it('fails closed when the consent filter denies every resolved recipient', async () => {
    const harness = makeHarness({
      policy: autoPolicy(),
      consent: async () => ({ allowed: false }),
    });
    const orchestrator = await harness.factory(TENANT);
    const result = await orchestrator!.processSignal(signal('signal-consent-all-denied'));

    expect(result.lifecycle_state).toBe('waiting');
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it('refuses a price-bearing action without authoritative provenance before approval', async () => {
    const harness = makeHarness({ inputOverrides: { proposed_price: 900 } });
    const orchestrator = await harness.factory(TENANT);

    await expect(orchestrator!.processSignal(signal('signal-price-provenance'))).rejects.toMatchObject({
      code: 'PRICE_PROVENANCE_REQUIRED',
    });
    expect(harness.workflow.pauseForApproval).not.toHaveBeenCalled();
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it('rejects a context bound to a different tenant before any provider call', async () => {
    const harness = makeHarness({ contextTenant: OTHER_TENANT });
    const orchestrator = await harness.factory(TENANT);

    await expect(orchestrator!.processSignal(signal('signal-tenant-mismatch'))).rejects.toMatchObject({
      code: 'CROSS_TENANT_ASSERTION',
    });
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it('does not retry an unsettled provider failure when reconciliation is indeterminate', async () => {
    const harness = makeHarness({
      policy: autoPolicy(),
      dispatch: async () => ({
        dispatch_id: 'dispatch-timeout-stack-a',
        recipient_count: 1,
        status: 'FAILED',
        dispatched_at: NOW.toISOString(),
      }),
    });
    const orchestrator = await harness.factory(TENANT);
    const parked = await orchestrator!.processSignal(signal('signal-reconcile-indeterminate'));

    expect(parked.lifecycle_state).toBe('waiting');
    await expect(orchestrator!.resumeTask(parked.run_id, {
      tenant_id: TENANT,
      event_type: 'human.reconcile',
      operator_id: 'operator-stack-a',
      reconciliation_resolution: 'PROVIDER_CONFIRMED_SUCCEEDED',
    })).rejects.toMatchObject({ code: 'RECONCILIATION_PROVIDER_PROOF_REQUIRED' });
    expect(harness.dispatch).toHaveBeenCalledTimes(1);
  });

  it('rejects a cross-customer consent claim before the consent port', async () => {
    const harness = makeHarness({
      skill: 'check_consent',
      requiredAuthority: 'AUTH-1',
      inputOverrides: { customer_id: OTHER_CUSTOMER },
    });
    const orchestrator = await harness.factory(TENANT);

    await expect(orchestrator!.processSignal(signal('signal-cross-customer'))).rejects.toMatchObject({
      code: 'CROSS_CUSTOMER_ASSERTION',
    });
    expect(harness.consent).not.toHaveBeenCalled();
  });

  it('rejects a below-floor price after authoritative source validation', async () => {
    const harness = makeHarness({
      inputOverrides: { proposed_price: 700, price_source: 'erp://price/v1' },
      validateAuthoritative: async () => ({
        proposed_price: 700,
        computed_price_floor: 800,
        floor_source: 'erp://floor/v1',
      }),
    });
    const orchestrator = await harness.factory(TENANT);

    await expect(orchestrator!.processSignal(signal('signal-floor-price'))).rejects.toMatchObject({
      code: 'ERR_FLOOR_PRICE_VIOLATION',
    });
    expect(harness.workflow.pauseForApproval).not.toHaveBeenCalled();
  });

  it('denies dispatch when the current authority grant is unavailable', async () => {
    const harness = makeHarness({ grant: null });
    const orchestrator = await harness.factory(TENANT);
    const result = await orchestrator!.processSignal(signal('signal-grant-missing'));

    expect(result.lifecycle_state).toBe('stopped');
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it('fails closed on an empty canonical audience', async () => {
    const harness = makeHarness({
      policy: autoPolicy(),
      resolveAudience: async () => [],
    });
    const orchestrator = await harness.factory(TENANT);
    const result = await orchestrator!.processSignal(signal('signal-audience-empty'));

    expect(result.lifecycle_state).toBe('waiting');
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it('parks malformed provider receipt output instead of treating it as success', async () => {
    const harness = makeHarness({
      policy: autoPolicy(),
      dispatch: async () => ({
        dispatch_id: '',
        recipient_count: 1,
        status: 'ENQUEUED',
        dispatched_at: NOW.toISOString(),
      }),
    });
    const orchestrator = await harness.factory(TENANT);
    const result = await orchestrator!.processSignal(signal('signal-receipt-missing-id'));

    expect(result.lifecycle_state).toBe('waiting');
    expect(harness.dispatch).toHaveBeenCalledTimes(1);
  });

  it('rejects reconciliation success without a confirmed execution receipt', async () => {
    const harness = makeHarness({
      policy: autoPolicy(),
      dispatch: async () => ({
        dispatch_id: 'dispatch-needs-reconcile',
        recipient_count: 1,
        status: 'FAILED',
        dispatched_at: NOW.toISOString(),
      }),
      reconcile: async () => ({
        outcome: 'SUCCEEDED' as const,
        receipt: {
          execution_id: '',
          adapter_status: 'SUCCESS' as const,
          provider_reference: null,
          response_payload: {},
          latency_ms: 0,
          token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
        },
      }),
    });
    const orchestrator = await harness.factory(TENANT);
    const parked = await orchestrator!.processSignal(signal('signal-reconcile-bad-receipt'));

    await expect(orchestrator!.resumeTask(parked.run_id, {
      tenant_id: TENANT,
      event_type: 'human.reconcile',
      operator_id: 'operator-stack-a',
      reconciliation_resolution: 'PROVIDER_CONFIRMED_SUCCEEDED',
    })).rejects.toMatchObject({ code: 'RECONCILIATION_PROVIDER_PROOF_REQUIRED' });
    expect(harness.dispatch).toHaveBeenCalledTimes(1);
  });

  it('routes MKT-01 through MKT-04 canonical skills through the factory orchestrator', async () => {
    const routes: readonly {
      readonly skill: Exclude<StackASkill, 'dispatch' | 'attribution'>;
      readonly authority: 'AUTH-1' | 'AUTH-2' | 'AUTH-3';
    }[] = [
      { skill: 'analyze', authority: 'AUTH-1' },
      { skill: 'segment', authority: 'AUTH-1' },
      { skill: 'check_consent', authority: 'AUTH-3' },
      { skill: 'generate', authority: 'AUTH-2' },
      { skill: 'brand', authority: 'AUTH-1' },
    ];

    for (const route of routes) {
      const harness = makeHarness({
        policy: autoPolicy(),
        skill: route.skill,
        requiredAuthority: route.authority,
      });
      const orchestrator = await harness.factory(TENANT);
      const result = await orchestrator!.processSignal(signal(`signal-${route.skill}`));
      expect(result.lifecycle_state, route.skill).toBe('completed');
    }
  });

  it('refuses MKT-06 without an evidence-bound attribution contract', async () => {
    const harness = makeHarness({
      skill: 'attribution',
      requiredAuthority: 'AUTH-1',
    });
    const orchestrator = await harness.factory(TENANT);

    await expect(orchestrator!.processSignal(signal('signal-attribution-unbound'))).rejects.toMatchObject({
      code: 'MKT06_EVIDENCE_BINDING_REQUIRED',
    });
  });

});
