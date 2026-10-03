import { describe, expect, it, vi } from 'vitest';
import type {
  ActionDraft,
  HydratedContext,
  DurableLeaseManager,
  IAdapterDispatcher,
  IAgentRuntime,
  IAuditTrail,
  IContextAggregator,
  IEffectGuard,
  IEvidenceLogger,
  IPolicyEngine,
  ISessionControl,
  IStatefulWorkflowEngine,
  SignalEnvelope,
} from '@agentos/core-engine/contracts';
import type * as Database from '@agentos/database';
import type { DurableWorkflowRepository } from '@agentos/database';
import type { SkillGate } from '@agentos/skills';

const getProfile = vi.hoisted(() => vi.fn());

vi.mock('@agentos/database', async (importOriginal) => ({
  ...(await importOriginal<typeof Database>()),
  getProfile,
}));

import { createMarketingOrchestratorFactory } from './factory.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const CUSTOMER = '33333333-3333-4333-8333-333333333333';
const AUDIT_SECRET = 'marketing-test-audit-secret-32-characters';

const profile = (tenant_id = TENANT) => ({
  customer_id: CUSTOMER,
  tenant_id,
  verified_phone: '+886900000000',
  verified_email: 'customer@example.test',
  total_spent: '125.50',
  order_count: 3,
  rfm_segment_hypothesis: 'LOYAL',
  consent_marketing: true,
  consent_updated_at: new Date('2026-01-01T00:00:00.000Z'),
  suppression_active: false,
  line_user_id: 'line-customer-1',
  created_at: new Date('2025-01-01T00:00:00.000Z'),
});

const subject = {
  session_id: 'session-marketing-test',
  channel_type: 'WEB_CHAT',
  verified_customer_id: CUSTOMER,
};

const signal = (): SignalEnvelope => ({
  signal_id: 'signal-marketing-test',
  tenant_id: TENANT,
  correlation_id: 'correlation-marketing-test',
  source_channel: 'WEB_CHAT',
  event_type: 'campaign.requested',
  payload: {
    skill_id: 'skill.mkt.analyze_market_signal',
    input: {},
  },
  subject,
  timestamp: '2026-01-01T00:00:00.000Z',
});

interface OrchestratorInternals {
  readonly dependencies: {
    readonly contextAggregator: IContextAggregator;
    readonly agentRuntime: IAgentRuntime;
    readonly policyEngine: IPolicyEngine;
    readonly assertExecutionLease?: unknown;
  };
}

const makeFactory = (
  crossDomainHandoff = false,
  audiencePolicy?: { getApprovedAudienceLimit: (tenant_id: string) => Promise<number | undefined> },
  gate?: SkillGate,
) => createMarketingOrchestratorFactory({
  auditSecret: AUDIT_SECRET,
  audit: null,
  workflowRepository: {} as DurableWorkflowRepository,
  adapters: {
    workflowEngine: {} as IStatefulWorkflowEngine,
    evidenceLogger: {} as IEvidenceLogger,
    auditTrail: {} as IAuditTrail,
    sessionControl: {} as ISessionControl,
    leaseManager: {} as DurableLeaseManager,
  },
  adapterDispatcher: {} as IAdapterDispatcher,
  effectGuard: {} as IEffectGuard,
  policyEngine: {} as IPolicyEngine,
  ...(audiencePolicy === undefined ? {} : { audiencePolicy }),
  ...(gate === undefined ? {} : { gate }),
  ...(crossDomainHandoff
    ? { crossDomainHandoff: { admit: vi.fn() } }
    : {}),
});

const internals = (orchestrator: unknown): OrchestratorInternals => orchestrator as OrchestratorInternals;

describe('Marketing policy factory composition', () => {
  it('retains the audit secret and autonomy port without promoting AUTH-4 campaign dispatch', async () => {

    const auditTrail: IAuditTrail = { append: vi.fn(async () => undefined) };
    const admit = vi.fn(async () => ({ workflow: 'PARKED_DRAFT' as const, reason: 'not promoted' }));
    const assertExecutionLease = vi.fn(async () => undefined);
    const factory = createMarketingOrchestratorFactory({
      auditSecret: AUDIT_SECRET,
      autonomy: { admit },
      resolve_grant: async () => 'AUTH-3',
      assertExecutionLease,
      adapters: {
        workflowEngine: {} as IStatefulWorkflowEngine,
        evidenceLogger: {} as IEvidenceLogger,
        auditTrail,
        sessionControl: {} as ISessionControl,
        leaseManager: {} as DurableLeaseManager,
      },
      adapterDispatcher: {} as IAdapterDispatcher,
      effectGuard: {} as IEffectGuard,
    });
    const orchestrator = await factory(TENANT);
    expect(internals(orchestrator).dependencies.assertExecutionLease).toBe(assertExecutionLease);
    const policyEngine = internals(orchestrator).dependencies.policyEngine;
    const context: HydratedContext = {
      tenant_id: TENANT,
      correlation_id: 'correlation-marketing-test',
      customer: null,
      working_memory: {
        session_id: subject.session_id,
        last_touch_channel: 'WEB_CHAT',
        turn_count: 1,
        takeover_active: false,
      },
      knowledge_citations: [],
      hydrated_at: '2026-01-01T00:00:00.000Z',
    };
    const action: ActionDraft = {
      action_id: '33333333-3333-4333-8333-333333333333',
      run_id: 'run-marketing',
      tenant_id: TENANT,
      agent_id: 'MKT-05',
      skill_id: 'skill.mkt.dispatch_campaign',
      adapter_target: 'API-003.CommunicationConnector',
      step_index: 0,
      mutating: true,
      price_bearing: false,
      request_id: 'request-marketing',
      action_revision: 0,
      effect_key: 'effect-marketing',
      required_authority: 'AUTH-4',
      payload: { tenant_id: TENANT, effect_key: 'effect-marketing' },
    };

    const approval = await policyEngine.evaluateAuthority(action, context);
    expect(approval.verdict).toBe('AWAITING_HUMAN_APPROVAL');
    expect(approval.autonomyWorkflow).toBeUndefined();
    expect(auditTrail.append).toHaveBeenCalledTimes(1);

    // segment_audience is an INTERNAL row: the derived policy treats it as mutating, so it carries
    // its server-derived effect key; it is still draft-gated by autonomy rather than AUTH-4.
    const draftGated = await policyEngine.evaluateAuthority({
      ...action,
      agent_id: 'MKT-02',
      skill_id: 'skill.mkt.segment_audience',
      adapter_target: 'PostgreSQL.Customer360Store',
      mutating: true,
      required_authority: 'AUTH-1',
      payload: { tenant_id: TENANT, effect_key: 'effect-marketing' },
    }, context);
    expect(draftGated.verdict, draftGated.reason).toBe('AUTO_APPROVED');
    expect(draftGated.autonomyWorkflow).toBe('PARKED_DRAFT');
    expect(admit).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: TENANT,
      skill_id: 'skill.mkt.segment_audience',
    }));
  });
  it('records a structured blocker when the audit secret is unavailable', async () => {
    const blockers: string[] = [];
    const factory = createMarketingOrchestratorFactory({
      auditSecret: '',
      env: { AUDIT_HMAC_SECRET: '' },
      blockers,
    });

    await expect(factory(TENANT)).resolves.toBeNull();
    expect(blockers).toEqual([
      expect.stringContaining('MARKETING_AUDIT_SECRET_REQUIRED'),
    ]);
  });

});

describe('default Marketing context aggregation', () => {
  it('hydrates a matching customer profile through the default factory aggregator', async () => {
    getProfile.mockResolvedValueOnce(profile());

    const orchestrator = await makeFactory()(TENANT);
    const context = await internals(orchestrator).dependencies.contextAggregator.hydrateContext(
      TENANT,
      subject,
      'correlation-marketing-test',
    );

    expect(getProfile).toHaveBeenCalledWith(TENANT, CUSTOMER);
    expect(context.customer).toEqual({
      customer_id: CUSTOMER,
      tenant_id: TENANT,
      verified_phone: '+886900000000',
      verified_email: 'customer@example.test',
      total_spent: 125.5,
      order_count: 3,
      rfm_segment_hypothesis: 'LOYAL',
      consent_marketing: true,
      consent_updated_at: '2026-01-01T00:00:00.000Z',
      suppression_active: false,
      created_at: '2025-01-01T00:00:00.000Z',
    });
  });

  it('fails closed when the authoritative profile is missing', async () => {
    getProfile.mockResolvedValueOnce(null);

    const orchestrator = await makeFactory()(TENANT);
    const context = await internals(orchestrator).dependencies.contextAggregator.hydrateContext(
      TENANT,
      subject,
      'correlation-missing-profile',
    );

    expect(context.customer).toBeNull();
  });

  it('fails closed when the profile tenant does not match the requested tenant', async () => {
    getProfile.mockResolvedValueOnce(profile(OTHER_TENANT));

    const orchestrator = await makeFactory()(TENANT);
    const context = await internals(orchestrator).dependencies.contextAggregator.hydrateContext(
      TENANT,
      subject,
      'correlation-foreign-profile',
    );

    expect(context.customer).toBeNull();
  });

  it('does not look up a malformed verified customer id', async () => {
    getProfile.mockClear();

    const orchestrator = await makeFactory()(TENANT);
    const context = await internals(orchestrator).dependencies.contextAggregator.hydrateContext(
      TENANT,
      { ...subject, verified_customer_id: 'not-a-uuid' },
      'correlation-malformed-customer',
    );

    expect(getProfile).not.toHaveBeenCalled();
    expect(context.customer).toBeNull();
  });

  it('produces a journey entry intent after default hydration when a handoff broker is bound', async () => {
    getProfile.mockResolvedValueOnce(profile());

    const orchestrator = await makeFactory(true)(TENANT);
    const { contextAggregator, agentRuntime } = internals(orchestrator).dependencies;
    const context = await contextAggregator.hydrateContext(TENANT, subject, 'correlation-journey-entry');
    const inbound = signal();
    const hypothesis = await agentRuntime.deriveHypothesis(inbound, context);
    const routing = await agentRuntime.resolveRouting(inbound, context, hypothesis);
    const plan = await agentRuntime.formulatePlan(routing, context, hypothesis);

    expect(plan.handoff_intent).toEqual({
      source_domain: 'marketing',
      target_domain: 'sales',
      target_agent: 'SAL-02',
      reason: 'Marketing leg completed for a verified customer; Sales consultation is the next leg',
    });
  });

  it('returns a typed skill-unavailable refusal for an unavailable Marketing step', async () => {
    getProfile.mockResolvedValueOnce(profile());
    const checks: [string, string][] = [];
    const gate: SkillGate = {
      available: async (tenant_id, skill_id) => {
        checks.push([tenant_id, skill_id]);
        return { available: false, reason: 'AGENT_INACTIVE' };
      },
    };
    const orchestrator = await makeFactory(false, undefined, gate)(TENANT);
    const { contextAggregator, agentRuntime } = internals(orchestrator).dependencies;
    const context = await contextAggregator.hydrateContext(TENANT, subject, 'correlation-unavailable-skill');
    const inbound = signal();
    const hypothesis = await agentRuntime.deriveHypothesis(inbound, context);
    const routing = await agentRuntime.resolveRouting(inbound, context, hypothesis);
    const plan = await agentRuntime.formulatePlan(routing, context, hypothesis);

    expect(checks).toEqual([[TENANT, 'skill.mkt.analyze_market_signal']]);
    expect(plan.domain).toBe('marketing');
    expect(plan.steps).toEqual([]);
    expect(plan.terminal_response).toMatchObject({
      response_kind: 'REFUSAL',
      reason_code: 'AGENT_INACTIVE',
    });
  });

  it('plans an operator campaign as segment → content → brand → AUTH-4 dispatch with no per-customer step', async () => {
    const availabilityChecks: string[] = [];
    const gate: SkillGate = {
      async available(_tenant_id, skill_id) {
        availabilityChecks.push(skill_id);
        if (skill_id === 'skill.mkt.dispatch_campaign') {
          return { available: false, reason: 'CONNECTOR_UNBOUND' };
        }
        return { available: true, reason: 'OK' };
      },
    };
    const orchestrator = await makeFactory(false, undefined, gate)(TENANT);
    const { contextAggregator, agentRuntime } = internals(orchestrator).dependencies;
    // The subject the gateway stamps for an operator command: the operator session, under the
    // Marketing contract's own channel — never the browser WEB_CHAT turn the file defaults to.
    const campaignSubject = {
      session_id: 'demo-tenant-operator',
      channel_type: 'MARKETING_CAMPAIGN',
      channel_identifier: 'demo-tenant-operator',
    };
    const context = await contextAggregator.hydrateContext(TENANT, campaignSubject, 'correlation-campaign-plan');

    // The shape the gateway stamps for an operator campaign draft: the normalized envelope under
    // `input`, `module: 'marketing'`, and the Marketing contract's own source channel.
    const campaign: SignalEnvelope = {
      signal_id: 'signal-campaign-plan',
      tenant_id: TENANT,
      correlation_id: 'correlation-campaign-plan',
      source_channel: 'MARKETING_CAMPAIGN',
      event_type: 'campaign.requested',
      subject: campaignSubject,
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: {
        module: 'marketing',
        skill_id: 'skill.mkt.generate_content',
        input: {
          objective: 'winback',
          segment_id: 'inactive_90d',
          instruction: 'Reactivate the 90-day inactive segment.',
          content_constraints: { channel: 'EMAIL_HTML', locale: 'vi-VN' },
        },
      },
    };

    const hypothesis = await agentRuntime.deriveHypothesis(campaign, context);
    const routing = await agentRuntime.resolveRouting(campaign, context, hypothesis);
    const plan = await agentRuntime.formulatePlan(routing, context, hypothesis);
    expect(availabilityChecks).toContain('skill.mkt.dispatch_campaign');

    // Contiguous steps, and the approval gate is on the dispatch step itself: the plan parks in
    // SCR-003 as AUTH-4 before any provider call.
    expect(plan.steps.map((step) => step.step_index)).toEqual([1, 2, 3, 4]);
    expect(plan.domain).toBe('marketing');
    const content = plan.steps[1]!;
    expect(content.input_parameters).toMatchObject({
      campaign_theme: 'Reactivate the 90-day inactive segment.',
      channel: 'EMAIL_HTML',
      locale: 'vi-VN',
    });
    expect(content.timeout_ms).toBe(18000);
    const audit = plan.steps[2]!;
    expect(audit.input_bindings).toEqual({
      draft_text: { source_step_index: 2, response_path: 'brand_audit_text' },
    });
    const dispatch = plan.steps[3]!;
    expect(dispatch.skill_id).toBe('skill.mkt.dispatch_campaign');
    expect(dispatch.required_authority).toBe('AUTH-4');
    expect(dispatch.mutating).toBe(true);
    expect(dispatch.depends_on_steps).toEqual([1, 2, 3]);
    expect(dispatch.input_bindings).toEqual({
      segment_id: { source_step_index: 1, response_path: 'segment_id' },
      approved_content_id: { source_step_index: 2, response_path: 'draft_id' },
    });

    // No pre-approval per-customer consent step: a segment identifier is not a customer identity,
    // and no step may assert one. Consent is re-read per recipient by the dispatch tool itself.
    expect(plan.steps.some((step) => step.skill_id === 'skill.mkt.check_consent')).toBe(false);
    for (const step of plan.steps) {
      expect(Object.keys(step.input_bindings ?? {})).not.toContain('customer_id');
      expect(Object.keys(step.input_parameters)).not.toContain('customer_id');
    }
  });
  it('refuses an operator audience request above the owner-approved policy cap', async () => {
    const policy = {
      getApprovedAudienceLimit: vi.fn(async () => 25),
    };
    const orchestrator = await makeFactory(false, policy)(TENANT);
    const { contextAggregator, agentRuntime } = internals(orchestrator).dependencies;
    const campaignSubject = {
      session_id: 'demo-tenant-operator-cap',
      channel_type: 'MARKETING_CAMPAIGN',
      channel_identifier: 'demo-tenant-operator-cap',
    };
    const context = await contextAggregator.hydrateContext(TENANT, campaignSubject, 'correlation-campaign-cap');
    const campaign: SignalEnvelope = {
      signal_id: 'signal-campaign-cap',
      tenant_id: TENANT,
      correlation_id: 'correlation-campaign-cap',
      source_channel: 'MARKETING_CAMPAIGN',
      event_type: 'campaign.requested',
      subject: campaignSubject,
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: {
        module: 'marketing',
        input: {
          objective: 'reactivation',
          segment_id: 'inactive_90d',
          max_segment_size: 26,
          content_constraints: { channel: 'EMAIL_HTML', locale: 'en-US' },
        },
      },
    };
    const hypothesis = await agentRuntime.deriveHypothesis(campaign, context);
    const routing = await agentRuntime.resolveRouting(campaign, context, hypothesis);

    await expect(agentRuntime.formulatePlan(routing, context, hypothesis)).rejects.toMatchObject({
      code: 'AUDIENCE_LIMIT_EXCEEDED',
    });
    expect(policy.getApprovedAudienceLimit).toHaveBeenCalledWith(TENANT);
  });
  it('restores the signal from checkpoint context in a fresh Marketing runtime', async () => {
    const first = await makeFactory()(TENANT);
    const recovered = await makeFactory()(TENANT);
    expect(first).not.toBeNull();
    expect(recovered).not.toBeNull();

    const initialInternals = internals(first);
    const recoveredRuntime = internals(recovered).dependencies.agentRuntime;
    const context = await initialInternals.dependencies.contextAggregator.hydrateContext(
      TENANT,
      subject,
      'correlation-signal-checkpoint',
    );
    const sourceSignal: SignalEnvelope = {
      ...signal(),
      signal_id: 'signal-from-checkpoint',
      payload: {
        skill_id: 'skill.mkt.analyze_market_signal',
        input: { checkpoint_marker: 'survives-restart' },
      },
    };
    const hypothesis = await initialInternals.dependencies.agentRuntime.deriveHypothesis(sourceSignal, context);
    const persistedContext = structuredClone(context);
    const routing = {
      target_agent: 'MKT-01' as const,
      requires_clarification: false,
      rationalization: 'test',
    };

    const plan = await recoveredRuntime.formulatePlan(routing, persistedContext, hypothesis);

    expect(plan.steps[0]?.input_parameters).toMatchObject({
      tenant_id: TENANT,
      checkpoint_marker: 'survives-restart',
    });
    expect(persistedContext.run_state?.marketing?.source_signal?.signal_id).toBe(sourceSignal.signal_id);
  });
});
