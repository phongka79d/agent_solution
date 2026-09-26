import { computeEffectKey, computeRequestFingerprint } from '@agentos/core-engine';
import type { ActionDraft, AssignableAuthority } from '@agentos/core-engine/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { MarketingAudienceResolver } from './types.js';
import {
  MARKETING_DISPATCH_INTEGRATION,
  MARKETING_DISPATCH_INTEGRATION_STATUS,
  createMarketingSkillServices,
  type InputMktDispatchCampaign,
  type OutputMktDispatchCampaign,
  type InputMktEvaluateAttribution,
  type MarketingAnalyticsPort,
  type MarketingBrandGuardPort,
  type MarketingCommunicationPort,
  type MarketingConsentPort,
  type MarketingContentEnginePort,
  type MarketingCustomer360Port,
  type MarketingSignalReadPort,
  type MarketingSkillOptions,
} from './index.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const RUN_ID = 'run-marketing-test-1';
const CORRELATION_ID = 'corr-marketing-test-1';
const REQUEST_ID = 'req-marketing-test-1';

function createMockSignalReads(): MarketingSignalReadPort {
  return {
    readSignals: vi.fn(async (_input: unknown, _context: unknown) => ({
      signals: [
        {
          signal_id: 'sig-1',
          keyword: 'organic tea',
          search_volume_growth: 1.45,
          price_pressure_index: 0.8,
        },
      ],
      trend_velocity: 'STABLE' as const,
      analyzed_at: '2026-09-26T12:00:00.000Z',
      source_uri: 'research://skills/signals',
      source_version: 'v2026-09-26',
    })),
  };
}

function createMockCustomer360(): MarketingCustomer360Port {
  return {
    segmentAudience: vi.fn(async () => ({
      segment_id: 'seg-test-1',
      matched_customer_count: 2,
      customer_ids: ['cust-1', 'cust-2'],
      generated_at: '2026-09-26T12:00:00.000Z',
    })),
  };
}

function createMockConsent(): MarketingConsentPort {
  return {
    checkConsent: vi.fn(async () => ({
      allowed: true,
      consent_timestamp: '2026-09-26T12:00:00.000Z',
      suppression_reason: null,
    })),
  };
}

function createMockContentEngine(): MarketingContentEnginePort {
  return {
    generateContent: vi.fn(async (input: { channel: string }) => ({
      draft_id: 'draft-test-1',
      headline: 'Fresh Tea Offers',
      body_content: 'Discover our seasonal tea selections.',
      cta_text: 'Explore Now',
      channel_payload: {
        channel_type: input.channel,
      },
    })),
  };
}

function createMockBrandGuard(): MarketingBrandGuardPort {
  return {
    auditBrandCompliance: vi.fn(async () => ({
      compliant: true,
      violations: [],
      confidence_score: 0.98,
    })),
  };
}

function createMockCommunication(
  overrides: Partial<MarketingCommunicationPort> = {},
): MarketingCommunicationPort {
  return {
    resolveAudience: vi.fn(async () => ['cust-1', 'cust-2']),
    dispatchCampaign: vi.fn(async () => ({
      dispatch_id: 'disp-test-999',
      recipient_count: 50,
      status: 'ENQUEUED' as const,
      dispatched_at: '2026-09-26T12:00:00.000Z',
    })),
    ...overrides,
  };
}

function createMockAnalytics(): MarketingAnalyticsPort {
  return {
    evaluateAttribution: vi.fn(async (input: InputMktEvaluateAttribution) => ({
      campaign_id: input.campaign_id,
      attributed_revenue: 5400,
      attributed_orders: 45,
      roas: 4.2,
      cac: 24.5,
      calculated_at: '2026-09-26T12:00:00.000Z',
    })),
  };
}

function createServices(
  overrides: Partial<MarketingSkillOptions> = {},
  grant: AssignableAuthority | null = 'AUTH-3',
) {
  return createMarketingSkillServices({
    signal_reads: createMockSignalReads(),
    customer360: createMockCustomer360(),
    consent: createMockConsent(),
    content_engine: createMockContentEngine(),
    brand_guard: createMockBrandGuard(),
    communication: createMockCommunication(),
    analytics: createMockAnalytics(),
    resolve_correlation_id: vi.fn(async () => CORRELATION_ID),
    resolve_grant: vi.fn(async () => grant),
    ...overrides,
  });
}

describe('Marketing Skill Services and Dispatcher', () => {
  describe('1. Row Registration', () => {
    it('registers all 7 canonical Marketing rows with expected properties', () => {
      const services = createServices();

      const expectedSkillIds = [
        'skill.mkt.analyze_market_signal',
        'skill.mkt.segment_audience',
        'skill.mkt.check_consent',
        'skill.mkt.generate_content',
        'skill.mkt.audit_brand_compliance',
        'skill.mkt.dispatch_campaign',
        'skill.mkt.evaluate_attribution',
      ];

      for (const skillId of expectedSkillIds) {
        const row = services.registry.resolve(skillId);
        expect(row).toBeDefined();
        expect(row.skill_id).toBe(skillId);
        expect(row.enabled).toBe(true);
        expect(row.purpose.length).toBeGreaterThan(0);
        expect(row.allowed_agents.length).toBeGreaterThan(0);
        expect(row.tool_binding.length).toBeGreaterThan(0);
        expect(row.guarded_dependency.length).toBeGreaterThan(0);
        expect(row.timeout_ms).toBeGreaterThan(0);
      }
    });

    it('enforces explicit skill enablement from options', async () => {
      const services = createServices({
        skill_enablement: {
          enabled_skill_ids: ['skill.mkt.analyze_market_signal'],
        },
      });

      const enabledRow = services.registry.resolve('skill.mkt.analyze_market_signal');
      expect(enabledRow.enabled).toBe(true);

      const disabledRow = services.registry.resolve('skill.mkt.segment_audience');
      expect(disabledRow.enabled).toBe(false);

      const effect_key = computeEffectKey({
        tenant_id: TENANT_ID,
        skill_id: 'skill.mkt.segment_audience',
        step_index: 0,
        action_revision: 0,
        request_id: REQUEST_ID,
      });

      const action: ActionDraft = {
        action_id: '00000000-0000-0000-0000-000000000001',
        run_id: RUN_ID,
        tenant_id: TENANT_ID,
        agent_id: 'MKT-02' as const,
        skill_id: 'skill.mkt.segment_audience',
        adapter_target: 'PostgreSQL.Customer360Store',
        step_index: 0,
        action_revision: 0,
        request_id: REQUEST_ID,
        effect_key,
        mutating: false,
        price_bearing: false,
        required_authority: 'AUTH-1',
        payload: {
          tenant_id: TENANT_ID,
          rfm_criteria: 'CHAMPIONS',
          min_days_inactive: 30,
        },
      };

      await expect(services.dispatcher.dispatch(action)).rejects.toMatchObject({
        code: 'SKILL_DISABLED',
      });
    });
  });

  describe('2. AUTH-5 and Authority Refusals', () => {
    it('refuses an unauthorized caller agent before evaluating clearance', async () => {
      const services = createServices({}, 'AUTH-3');

      const effect_key = computeEffectKey({
        tenant_id: TENANT_ID,
        skill_id: 'skill.mkt.analyze_market_signal',
        step_index: 0,
        action_revision: 0,
        request_id: REQUEST_ID,
      });

      // MKT-06 is only allowed on evaluate_attribution, not analyze_market_signal
      const action: ActionDraft = {
        action_id: '00000000-0000-0000-0000-000000000002',
        run_id: RUN_ID,
        tenant_id: TENANT_ID,
        agent_id: 'MKT-06' as const,
        skill_id: 'skill.mkt.analyze_market_signal',
        adapter_target: 'API-002.EventIngestion',
        step_index: 0,
        action_revision: 0,
        request_id: REQUEST_ID,
        effect_key,
        mutating: false,
        price_bearing: false,
        required_authority: 'AUTH-1',
        payload: {
          tenant_id: TENANT_ID,
          market_region: 'TW',
          category_id: 'cat-tea',
          observation_window_days: 14,
        },
      };

      await expect(services.dispatcher.dispatch(action)).rejects.toMatchObject({
        code: 'UNAUTHORIZED_AGENT',
      });
    });

    it('refuses when granted authority is insufficient for the skill requirement', async () => {
      // check_consent requires AUTH-3; caller has AUTH-1
      const services = createServices({}, 'AUTH-1');

      const effect_key = computeEffectKey({
        tenant_id: TENANT_ID,
        skill_id: 'skill.mkt.check_consent',
        step_index: 0,
        action_revision: 0,
        request_id: REQUEST_ID,
      });

      const action: ActionDraft = {
        action_id: '00000000-0000-0000-0000-000000000003',
        run_id: RUN_ID,
        tenant_id: TENANT_ID,
        agent_id: 'MKT-02' as const,
        skill_id: 'skill.mkt.check_consent',
        adapter_target: 'API-002.ConsentStore',
        step_index: 0,
        action_revision: 0,
        request_id: REQUEST_ID,
        effect_key,
        mutating: false,
        price_bearing: false,
        required_authority: 'AUTH-3',
        payload: {
          tenant_id: TENANT_ID,
          customer_id: 'cust-100',
          channel: 'LINE',
        },
      };

      await expect(services.dispatcher.dispatch(action)).rejects.toMatchObject({
        code: 'INSUFFICIENT_AUTHORITY',
      });
    });

    it('rejects registration of an action requiring AUTH-5 as prohibited', () => {
      const services = createServices({}, 'AUTH-3');
      const dispatchSkill = services.registry.resolve('skill.mkt.dispatch_campaign');

      expect(() =>
        services.registry.register({
          ...dispatchSkill,
          skill_id: 'skill.mkt.prohibited_op',
          required_authority: 'AUTH-5',
        }),
      ).toThrow(/PROHIBITED_AUTHORITY_REQUIREMENT/);
    });

    it('refuses when granted authority is not an assignable clearance', async () => {
      const services = createServices({}, null);

      const effect_key = computeEffectKey({
        tenant_id: TENANT_ID,
        skill_id: 'skill.mkt.analyze_market_signal',
        step_index: 0,
        action_revision: 0,
        request_id: REQUEST_ID,
      });

      const action: ActionDraft = {
        action_id: '00000000-0000-0000-0000-000000000005',
        run_id: RUN_ID,
        tenant_id: TENANT_ID,
        agent_id: 'MKT-01' as const,
        skill_id: 'skill.mkt.analyze_market_signal',
        adapter_target: 'API-002.EventIngestion',
        step_index: 0,
        action_revision: 0,
        request_id: REQUEST_ID,
        effect_key,
        mutating: false,
        price_bearing: false,
        required_authority: 'AUTH-1',
        payload: {
          tenant_id: TENANT_ID,
          market_region: 'TW',
          category_id: 'cat-tea',
          observation_window_days: 14,
        },
      };

      await expect(services.dispatcher.dispatch(action)).rejects.toMatchObject({
        code: 'CLEARANCE_REQUIRED',
      });
    });
  });

  describe('3. Approval Digest Forwarding for AUTH-4', () => {
    const campaignPayload = {
      tenant_id: TENANT_ID,
      campaign_id: 'camp-summer-2026',
      segment_id: 'seg-test-1',
      channel: 'SMS' as const,
      approved_content_id: 'content-approved-99',
    };

    it('refuses AUTH-4 dispatch when approval_id is absent', async () => {
      const services = createServices({}, 'AUTH-3');

      const effect_key = computeEffectKey({
        tenant_id: TENANT_ID,
        skill_id: 'skill.mkt.dispatch_campaign',
        step_index: 0,
        action_revision: 0,
        request_id: REQUEST_ID,
      });

      const action: ActionDraft = {
        action_id: '00000000-0000-0000-0000-000000000006',
        run_id: RUN_ID,
        tenant_id: TENANT_ID,
        agent_id: 'MKT-05' as const,
        skill_id: 'skill.mkt.dispatch_campaign',
        adapter_target: 'API-003.CommunicationConnector',
        step_index: 0,
        action_revision: 0,
        request_id: REQUEST_ID,
        effect_key,
        mutating: true,
        price_bearing: false,
        required_authority: 'AUTH-4',
        payload: campaignPayload,
      };

      await expect(services.dispatcher.dispatch(action)).rejects.toMatchObject({
        code: 'APPROVAL_REQUIRED',
      });
    });

    it('refuses AUTH-4 dispatch when approval_payload_digest mismatches the normalized input', async () => {
      const services = createServices({}, 'AUTH-3');

      const effect_key = computeEffectKey({
        tenant_id: TENANT_ID,
        skill_id: 'skill.mkt.dispatch_campaign',
        step_index: 0,
        action_revision: 0,
        request_id: REQUEST_ID,
      });

      const action: ActionDraft = {
        action_id: '00000000-0000-0000-0000-000000000007',
        run_id: RUN_ID,
        tenant_id: TENANT_ID,
        agent_id: 'MKT-05' as const,
        skill_id: 'skill.mkt.dispatch_campaign',
        adapter_target: 'API-003.CommunicationConnector',
        step_index: 0,
        action_revision: 0,
        request_id: REQUEST_ID,
        effect_key,
        mutating: true,
        price_bearing: false,
        required_authority: 'AUTH-4',
        approval_id: 'appr-valid-1',
        approval_payload_digest: 'digest-tampered-or-mismatched',
        payload: campaignPayload,
      };

      await expect(services.dispatcher.dispatch(action)).rejects.toMatchObject({
        code: 'APPROVAL_PAYLOAD_MISMATCH',
      });
    });

    it('forwards approval_id and approval_payload_digest unchanged on matching AUTH-4 dispatch', async () => {
      const communication = createMockCommunication();
      const services = createServices({ communication }, 'AUTH-3');

      const effect_key = computeEffectKey({
        tenant_id: TENANT_ID,
        skill_id: 'skill.mkt.dispatch_campaign',
        step_index: 0,
        action_revision: 0,
        request_id: REQUEST_ID,
      });

      // Compute exact canonical RFC 8785 + SHA-256 fingerprint for the normalized payload
      const skill = services.registry.resolve('skill.mkt.dispatch_campaign');
      const normalizedPayload = skill.validateInput(campaignPayload) as Record<string, unknown>;
      const canonicalDigest = computeRequestFingerprint(normalizedPayload);

      const action: ActionDraft = {
        action_id: '00000000-0000-0000-0000-000000000008',
        run_id: RUN_ID,
        tenant_id: TENANT_ID,
        agent_id: 'MKT-05' as const,
        skill_id: 'skill.mkt.dispatch_campaign',
        adapter_target: 'API-003.CommunicationConnector',
        step_index: 0,
        action_revision: 0,
        request_id: REQUEST_ID,
        effect_key,
        mutating: true,
        price_bearing: false,
        required_authority: 'AUTH-4',
        approval_id: 'appr-valid-1',
        approval_payload_digest: canonicalDigest,
        payload: campaignPayload,
      };

      const receipt = await services.dispatcher.dispatch(action);

      expect(receipt.adapter_status).toBe('SUCCESS');
      expect(receipt.provider_reference).toBe('disp-test-999');
      expect(receipt.response_payload).toMatchObject({
        dispatch_id: 'disp-test-999',
        recipient_count: 50,
        status: 'ENQUEUED',
      });

      // Verify that the tool invocation received the approval_id and approval_payload_digest unchanged
      expect(communication.dispatchCampaign).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(communication.dispatchCampaign).mock.calls[0]!;
      const forwardedContext = callArgs[1]!;
      expect(forwardedContext.approval_id).toBe('appr-valid-1');
      expect(forwardedContext.approval_payload_digest).toBe(canonicalDigest);
      expect(callArgs[0]).toEqual(expect.objectContaining({ recipients: ['cust-1', 'cust-2'] }));
    });
  });

  describe('4. Unbound-Provider Refusal', () => {
    it('lists all 7 unbound capabilities when no ports are configured', () => {
      const services = createMarketingSkillServices({
        resolve_correlation_id: vi.fn(async () => CORRELATION_ID),
        resolve_grant: vi.fn(async () => 'AUTH-3'),
      });

      expect(services.unbound).toHaveLength(7);
      expect(services.unbound).toContain(
        'API-002.EventIngestion: no signal read connector is bound',
      );
      expect(services.unbound).toContain(
        'PostgreSQL.Customer360Store: no Customer360 store is bound',
      );
      expect(services.unbound).toContain(
        'API-002.ConsentStore: no consent store connector is bound',
      );
      expect(services.unbound).toContain(
        'Core.LLMContentEngine: no content generation engine is bound',
      );
      expect(services.unbound).toContain(
        'SecondBrain.BrandGuard: no BrandGuard compliance engine is bound',
      );
      expect(services.unbound).toContain(
        'API-003.CommunicationConnector: no API-003 communication connector is bound',
      );
      expect(services.unbound).toContain(
        'PostgreSQL.AnalyticsStore: no downstream analytics/order evidence store is bound',
      );
    });

    it('fails closed on tool_port.invoke for every unbound skill with UNBOUND_PROVIDER', async () => {
      const services = createMarketingSkillServices({
        resolve_correlation_id: vi.fn(async () => CORRELATION_ID),
        resolve_grant: vi.fn(async () => 'AUTH-3'),
      });

      const dummyContext = {
        run_id: RUN_ID,
        tenant_id: TENANT_ID,
        caller_agent: 'MKT-01',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3' as const,
        effect_key: 'effect-dummy',
      };

      const testInvocations = [
        {
          skill_id: 'skill.mkt.analyze_market_signal',
          tool_binding: 'API-002.EventIngestion',
          input: {
            tenant_id: TENANT_ID,
            market_region: 'TW',
            category_id: 'cat',
            observation_window_days: 10,
          },
        },
        {
          skill_id: 'skill.mkt.segment_audience',
          tool_binding: 'PostgreSQL.Customer360Store',
          input: {
            tenant_id: TENANT_ID,
            rfm_criteria: 'LOYAL',
            min_days_inactive: 10,
          },
        },
        {
          skill_id: 'skill.mkt.check_consent',
          tool_binding: 'API-002.ConsentStore',
          input: {
            tenant_id: TENANT_ID,
            customer_id: 'cust-1',
            channel: 'LINE',
          },
        },
        {
          skill_id: 'skill.mkt.generate_content',
          tool_binding: 'Core.LLMContentEngine',
          input: {
            tenant_id: TENANT_ID,
            campaign_theme: 'theme',
            channel: 'SMS_TEXT',
            locale: 'zh-TW',
          },
        },
        {
          skill_id: 'skill.mkt.audit_brand_compliance',
          tool_binding: 'SecondBrain.BrandGuard',
          input: {
            tenant_id: TENANT_ID,
            draft_text: 'draft',
            channel: 'SMS',
          },
        },
        {
          skill_id: 'skill.mkt.dispatch_campaign',
          tool_binding: 'API-003.CommunicationConnector',
          input: {
            tenant_id: TENANT_ID,
            campaign_id: 'camp',
            segment_id: 'seg',
            channel: 'SMS',
            approved_content_id: 'app',
          },
        },
        {
          skill_id: 'skill.mkt.evaluate_attribution',
          tool_binding: 'PostgreSQL.AnalyticsStore',
          input: {
            tenant_id: TENANT_ID,
            campaign_id: 'camp',
            attribution_model: 'LAST_TOUCH',
          },
        },
      ];

      for (const inv of testInvocations) {
        await expect(
          services.tool_port.invoke({
            skill_id: inv.skill_id,
            tool_binding: inv.tool_binding,
            input: inv.input,
            context: dummyContext,
          }),
        ).rejects.toMatchObject({
          code: 'UNBOUND_PROVIDER',
        });
      }
    });

    it('rejects unknown skill or tool binding with UNKNOWN_CAPABILITY', async () => {
      const services = createServices();

      await expect(
        services.tool_port.invoke({
          skill_id: 'skill.mkt.unknown_skill',
          tool_binding: 'Unknown.Binding',
          input: {},
          context: {
            run_id: RUN_ID,
            tenant_id: TENANT_ID,
            caller_agent: 'MKT-01',
            correlation_id: CORRELATION_ID,
            granted_authority: 'AUTH-3',
            effect_key: 'effect-dummy',
          },
        }),
      ).rejects.toMatchObject({
        code: 'UNKNOWN_CAPABILITY',
      });
    });
  });

  describe('5. Dispatcher Receipt and Reconcile Mapping', () => {
    it('maps successful dispatch onto canonical ExecutionReceipt shape', async () => {
      const services = createServices({}, 'AUTH-3');

      const effect_key = computeEffectKey({
        tenant_id: TENANT_ID,
        skill_id: 'skill.mkt.analyze_market_signal',
        step_index: 0,
        action_revision: 0,
        request_id: REQUEST_ID,
      });

      const action: ActionDraft = {
        action_id: '00000000-0000-0000-0000-000000000009',
        run_id: RUN_ID,
        tenant_id: TENANT_ID,
        agent_id: 'MKT-01' as const,
        skill_id: 'skill.mkt.analyze_market_signal',
        adapter_target: 'API-002.EventIngestion',
        step_index: 0,
        action_revision: 0,
        request_id: REQUEST_ID,
        effect_key,
        mutating: false,
        price_bearing: false,
        required_authority: 'AUTH-1',
        payload: {
          tenant_id: TENANT_ID,
          market_region: 'TW',
          category_id: 'tea-beverages',
          observation_window_days: 30,
        },
      };

      const receipt = await services.dispatcher.dispatch(action);

      expect(receipt).toBeDefined();
      expect(receipt.execution_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(receipt.adapter_status).toBe('SUCCESS');
      expect(receipt.response_payload).toMatchObject({
        trend_velocity: 'STABLE',
        signals: expect.arrayContaining([
          expect.objectContaining({ keyword: 'organic tea' }),
        ]),
      });
      expect(receipt.latency_ms).toBeGreaterThanOrEqual(0);
      expect(receipt.token_usage).toEqual({
        prompt: 0,
        completion: 0,
        total_cost_usd: 0,
      });
    });

    it('delegates reconcile to injected handler when provided', async () => {
      const mockReconcile = vi.fn(async () => ({
        outcome: 'SUCCEEDED' as const,
        receipt: {
          execution_id: 'exec-reconciled-1',
          adapter_status: 'SUCCESS' as const,
          provider_reference: 'ref-rec-1',
          response_payload: { reconciled: true },
          latency_ms: 5,
          token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
        },
      }));

      const services = createServices({ reconcile: mockReconcile }, 'AUTH-3');

      const result = await services.dispatcher.reconcile!({
        tenant_id: TENANT_ID,
        effect_key: 'effect-test-key-1',
        skill_id: 'skill.mkt.dispatch_campaign',
      });

      expect(mockReconcile).toHaveBeenCalledWith({
        tenant_id: TENANT_ID,
        effect_key: 'effect-test-key-1',
        skill_id: 'skill.mkt.dispatch_campaign',
      });
      expect(result.outcome).toBe('SUCCEEDED');
      expect(result.receipt).toBeDefined();
    });

    it('defaults reconcile to INDETERMINATE when no handler is provided', async () => {
      const services = createServices({}, 'AUTH-3');

      const result = await services.dispatcher.reconcile!({
        tenant_id: TENANT_ID,
        effect_key: 'effect-test-key-2',
      });

      expect(result).toEqual({ outcome: 'INDETERMINATE' });
    });

    it('marks dispatch integration status as PENDING_P2_SHARED_ROUTING', () => {
      const services = createServices();
      expect(services.dispatch_integration).toBe('PENDING_P2_SHARED_ROUTING');
      expect(MARKETING_DISPATCH_INTEGRATION).toBe('PENDING_P2_SHARED_ROUTING');
      expect(MARKETING_DISPATCH_INTEGRATION_STATUS).toBe('PENDING_P2_SHARED_ROUTING');
    });
  });

  describe('6. Canonical Server-Side Audience Resolution (skill.mkt.dispatch_campaign)', () => {
    const validDispatchInput = {
      tenant_id: TENANT_ID,
      campaign_id: 'camp-summer-2026',
      segment_id: 'seg-test-1',
      channel: 'SMS' as const,
      approved_content_id: 'draft-brand-approved-1',
    };

    const dummyContext = {
      run_id: RUN_ID,
      tenant_id: TENANT_ID,
      caller_agent: 'MKT-05',
      correlation_id: CORRELATION_ID,
      granted_authority: 'AUTH-3' as const,
      effect_key: 'effect-dummy',
    };

    it('fails closed on canonical unbound path when communication connector is missing with UNBOUND_PROVIDER', async () => {
      const services = createMarketingSkillServices({
        resolve_correlation_id: vi.fn(async () => CORRELATION_ID),
        resolve_grant: vi.fn(async () => 'AUTH-3'),
      });

      await expect(
        services.tool_port.invoke({
          skill_id: 'skill.mkt.dispatch_campaign',
          tool_binding: 'API-003.CommunicationConnector',
          input: validDispatchInput,
          context: dummyContext,
        }),
      ).rejects.toMatchObject({
        code: 'UNBOUND_PROVIDER',
      });
    });

    it('fails closed with AUDIENCE_RESOLVER_REQUIRED when communication connector is bound but has no audience resolver configured', async () => {
      const communication: MarketingCommunicationPort = {
        dispatchCampaign: vi.fn(async () => ({
          dispatch_id: 'disp-test',
          recipient_count: 10,
          status: 'ENQUEUED' as const,
          dispatched_at: '2026-09-26T12:00:00.000Z',
        })),
      };
      const services = createServices({ communication });

      await expect(
        services.tool_port.invoke({
          skill_id: 'skill.mkt.dispatch_campaign',
          tool_binding: 'API-003.CommunicationConnector',
          input: validDispatchInput,
          context: dummyContext,
        }),
      ).rejects.toMatchObject({
        code: 'AUDIENCE_RESOLVER_REQUIRED',
      });
      expect(communication.dispatchCampaign).not.toHaveBeenCalled();
    });

    it('fails closed with AUDIENCE_REQUIRED when server-side audience resolver returns empty array', async () => {
      const communication: MarketingCommunicationPort = {
        resolveAudience: vi.fn(async () => []),
        dispatchCampaign: vi.fn(async () => ({
          dispatch_id: 'disp-test',
          recipient_count: 0,
          status: 'ENQUEUED' as const,
          dispatched_at: '2026-09-26T12:00:00.000Z',
        })),
      };
      const services = createServices({ communication });

      await expect(
        services.tool_port.invoke({
          skill_id: 'skill.mkt.dispatch_campaign',
          tool_binding: 'API-003.CommunicationConnector',
          input: validDispatchInput,
          context: dummyContext,
        }),
      ).rejects.toMatchObject({
        code: 'AUDIENCE_REQUIRED',
      });
      expect(communication.resolveAudience).toHaveBeenCalledTimes(1);
      expect(communication.dispatchCampaign).not.toHaveBeenCalled();
    });

    it('fails closed with AUDIENCE_REQUIRED when consent recheck denies all resolved recipients', async () => {
      const communication: MarketingCommunicationPort = {
        resolveAudience: vi.fn(async () => ['cust-denied-1']),
        dispatchCampaign: vi.fn(async () => ({
          dispatch_id: 'disp-test',
          recipient_count: 0,
          status: 'ENQUEUED' as const,
          dispatched_at: '2026-09-26T12:00:00.000Z',
        })),
      };
      const consent: MarketingConsentPort = {
        checkConsent: vi.fn(async () => ({
          allowed: false,
          consent_timestamp: null,
          suppression_reason: 'SUPPRESSED',
        })),
      };
      const services = createServices({ communication, consent });

      await expect(
        services.tool_port.invoke({
          skill_id: 'skill.mkt.dispatch_campaign',
          tool_binding: 'API-003.CommunicationConnector',
          input: validDispatchInput,
          context: dummyContext,
        }),
      ).rejects.toMatchObject({
        code: 'AUDIENCE_REQUIRED',
      });
      expect(communication.dispatchCampaign).not.toHaveBeenCalled();
    });

    it('resolves segment to recipients server-side, checks consent, and passes only consented recipients onward', async () => {
      const resolveAudience: MarketingAudienceResolver = vi.fn(async () => ['cust-opted-in', 'cust-opted-out']);
      const dispatchCampaign = vi.fn(async (_input: InputMktDispatchCampaign) => ({
        dispatch_id: 'disp-resolved-1',
        recipient_count: 1,
        status: 'ENQUEUED' as const,
        dispatched_at: '2026-09-26T12:00:00.000Z',
      }));
      const consent: MarketingConsentPort = {
        checkConsent: vi.fn(async (checkInput) => ({
          allowed: checkInput.customer_id === 'cust-opted-in',
          consent_timestamp: '2026-09-26T12:00:00.000Z',
          suppression_reason: checkInput.customer_id === 'cust-opted-in' ? null : 'OPTOUT',
        })),
      };
      const communication: MarketingCommunicationPort = {
        resolveAudience,
        dispatchCampaign,
      };
      const services = createServices({ communication, consent });

      const result = await services.tool_port.invoke<InputMktDispatchCampaign, OutputMktDispatchCampaign>({
        skill_id: 'skill.mkt.dispatch_campaign',
        tool_binding: 'API-003.CommunicationConnector',
        input: validDispatchInput,
        context: dummyContext,
      });

      expect(resolveAudience).toHaveBeenCalledWith(
        {
          tenant_id: TENANT_ID,
          segment_id: validDispatchInput.segment_id,
          channel: validDispatchInput.channel,
        },
        dummyContext,
      );
      expect(consent.checkConsent).toHaveBeenCalledTimes(2);
      expect(dispatchCampaign).toHaveBeenCalledTimes(1);
      const passedCall = dispatchCampaign.mock.calls[0]!;
      expect(passedCall).toBeDefined();
      expect(passedCall[0]).toEqual(expect.objectContaining({ recipients: ['cust-opted-in'] }));
      expect(result.dispatch_id).toBe('disp-resolved-1');
    });

    it('resolves audience when resolver is configured via options.audience_resolver', async () => {
      const audience_resolver: MarketingAudienceResolver = vi.fn(async () => ['cust-opted']);
      const dispatchCampaign = vi.fn(async (_input: InputMktDispatchCampaign) => ({
        dispatch_id: 'disp-opt-1',
        recipient_count: 1,
        status: 'ENQUEUED' as const,
        dispatched_at: '2026-09-26T12:00:00.000Z',
      }));
      const services = createServices({
        communication: { dispatchCampaign },
        audience_resolver,
      });

      await services.tool_port.invoke({
        skill_id: 'skill.mkt.dispatch_campaign',
        tool_binding: 'API-003.CommunicationConnector',
        input: validDispatchInput,
        context: dummyContext,
      });

      expect(audience_resolver).toHaveBeenCalledTimes(1);
      expect(dispatchCampaign).toHaveBeenCalledWith(
        expect.objectContaining({ recipients: ['cust-opted'] }),
        expect.anything(),
      );
    });

    it('fails closed with CONSENT_PORT_REQUIRED before communication when server-side consent port is missing', async () => {
      const resolveAudience: MarketingAudienceResolver = vi.fn(async () => ['cust-1', 'cust-2']);
      const dispatchCampaign = vi.fn(async (_input: InputMktDispatchCampaign) => ({
        dispatch_id: 'disp-test',
        recipient_count: 2,
        status: 'ENQUEUED' as const,
        dispatched_at: '2026-09-26T12:00:00.000Z',
      }));
      const communication: MarketingCommunicationPort = {
        resolveAudience,
        dispatchCampaign,
      };
      const services = createServices({ communication, consent: null });

      await expect(
        services.tool_port.invoke({
          skill_id: 'skill.mkt.dispatch_campaign',
          tool_binding: 'API-003.CommunicationConnector',
          input: validDispatchInput,
          context: dummyContext,
        }),
      ).rejects.toMatchObject({
        code: 'CONSENT_PORT_REQUIRED',
      });
      expect(resolveAudience).toHaveBeenCalledTimes(1);
      expect(dispatchCampaign).not.toHaveBeenCalled();
    });

    it('fails closed with CONSENT_PORT_REQUIRED via dispatcher when server-side consent port is missing', async () => {
      const resolveAudience: MarketingAudienceResolver = vi.fn(async () => ['cust-1', 'cust-2']);
      const dispatchCampaign = vi.fn(async (_input: InputMktDispatchCampaign) => ({
        dispatch_id: 'disp-test',
        recipient_count: 2,
        status: 'ENQUEUED' as const,
        dispatched_at: '2026-09-26T12:00:00.000Z',
      }));
      const communication: MarketingCommunicationPort = {
        resolveAudience,
        dispatchCampaign,
      };
      const services = createServices({ communication, consent: null }, 'AUTH-3');

      const effect_key = computeEffectKey({
        tenant_id: TENANT_ID,
        skill_id: 'skill.mkt.dispatch_campaign',
        step_index: 0,
        action_revision: 0,
        request_id: REQUEST_ID,
      });

      const skill = services.registry.resolve('skill.mkt.dispatch_campaign');
      const normalizedPayload = skill.validateInput(validDispatchInput);
      const canonicalDigest = computeRequestFingerprint(normalizedPayload as Record<string, unknown>);

      const action: ActionDraft = {
        action_id: '00000000-0000-0000-0000-000000000099',
        run_id: RUN_ID,
        tenant_id: TENANT_ID,
        agent_id: 'MKT-05',
        skill_id: 'skill.mkt.dispatch_campaign',
        adapter_target: 'API-003.CommunicationConnector',
        step_index: 0,
        action_revision: 0,
        request_id: REQUEST_ID,
        effect_key,
        mutating: true,
        price_bearing: false,
        required_authority: 'AUTH-4',
        approval_id: 'appr-valid-1',
        approval_payload_digest: canonicalDigest,
        payload: validDispatchInput,
      };

      await expect(services.dispatcher.dispatch(action)).rejects.toMatchObject({
        code: 'SKILL_EXECUTION_FAILED',
      });
      expect(dispatchCampaign).not.toHaveBeenCalled();
    });

    it('allows dispatch when audience resolver returns explicit verified-consent result without separate consent port', async () => {
      const resolveAudience: MarketingAudienceResolver = vi.fn(async () => ({
        recipients: ['cust-verified-1', 'cust-verified-2'],
        consent_verified: true as const,
      }));
      const dispatchCampaign = vi.fn(async (_input: InputMktDispatchCampaign) => ({
        dispatch_id: 'disp-verified-1',
        recipient_count: 2,
        status: 'ENQUEUED' as const,
        dispatched_at: '2026-09-26T12:00:00.000Z',
      }));
      const communication: MarketingCommunicationPort = {
        resolveAudience,
        dispatchCampaign,
      };
      const services = createServices({ communication, consent: null });

      const result = await services.tool_port.invoke<
        InputMktDispatchCampaign,
        OutputMktDispatchCampaign
      >({
        skill_id: 'skill.mkt.dispatch_campaign',
        tool_binding: 'API-003.CommunicationConnector',
        input: validDispatchInput,
        context: dummyContext,
      });

      expect(resolveAudience).toHaveBeenCalledTimes(1);
      expect(dispatchCampaign).toHaveBeenCalledTimes(1);
      expect(dispatchCampaign).toHaveBeenCalledWith(
        expect.objectContaining({
          recipients: ['cust-verified-1', 'cust-verified-2'],
        }),
        dummyContext,
      );
      expect(result.dispatch_id).toBe('disp-verified-1');
    });

    it('fails closed with CONSENT_PORT_REQUIRED when audience resolver returns unverified audience and consent port is missing', async () => {
      const resolveAudience: MarketingAudienceResolver = vi.fn(async () => ({
        recipients: ['cust-unverified-1'],
        consent_verified: false as const,
      }));
      const dispatchCampaign = vi.fn(async (_input: InputMktDispatchCampaign) => ({
        dispatch_id: 'disp-test',
        recipient_count: 1,
        status: 'ENQUEUED' as const,
        dispatched_at: '2026-09-26T12:00:00.000Z',
      }));
      const communication: MarketingCommunicationPort = {
        resolveAudience,
        dispatchCampaign,
      };
      const services = createServices({ communication, consent: null });

      await expect(
        services.tool_port.invoke({
          skill_id: 'skill.mkt.dispatch_campaign',
          tool_binding: 'API-003.CommunicationConnector',
          input: validDispatchInput,
          context: dummyContext,
        }),
      ).rejects.toMatchObject({
        code: 'CONSENT_PORT_REQUIRED',
      });
      expect(dispatchCampaign).not.toHaveBeenCalled();
    });

    it('fails closed with AUDIENCE_REQUIRED when explicit verified-consent audience returns empty recipients', async () => {
      const resolveAudience: MarketingAudienceResolver = vi.fn(async () => ({
        recipients: [],
        consent_verified: true as const,
      }));
      const dispatchCampaign = vi.fn(async (_input: InputMktDispatchCampaign) => ({
        dispatch_id: 'disp-test',
        recipient_count: 0,
        status: 'ENQUEUED' as const,
        dispatched_at: '2026-09-26T12:00:00.000Z',
      }));
      const communication: MarketingCommunicationPort = {
        resolveAudience,
        dispatchCampaign,
      };
      const services = createServices({ communication, consent: null });

      await expect(
        services.tool_port.invoke({
          skill_id: 'skill.mkt.dispatch_campaign',
          tool_binding: 'API-003.CommunicationConnector',
          input: validDispatchInput,
          context: dummyContext,
        }),
      ).rejects.toMatchObject({
        code: 'AUDIENCE_REQUIRED',
      });
      expect(dispatchCampaign).not.toHaveBeenCalled();
    });

    it('allows consent port configured on communication connector or via consent_port alias', async () => {
      const resolveAudience: MarketingAudienceResolver = vi.fn(async () => ['cust-1']);
      const dispatchCampaign = vi.fn(async (_input: InputMktDispatchCampaign) => ({
        dispatch_id: 'disp-alias-1',
        recipient_count: 1,
        status: 'ENQUEUED' as const,
        dispatched_at: '2026-09-26T12:00:00.000Z',
      }));
      const consent: MarketingConsentPort = {
        checkConsent: vi.fn(async () => ({
          allowed: true,
          consent_timestamp: '2026-09-26T12:00:00.000Z',
          suppression_reason: null,
        })),
      };
      const communication: MarketingCommunicationPort = {
        resolveAudience,
        dispatchCampaign,
        consent,
      };
      const services = createServices({ communication, consent: null });

      const result = await services.tool_port.invoke<
        InputMktDispatchCampaign,
        OutputMktDispatchCampaign
      >({
        skill_id: 'skill.mkt.dispatch_campaign',
        tool_binding: 'API-003.CommunicationConnector',
        input: validDispatchInput,
        context: dummyContext,
      });

      expect(consent.checkConsent).toHaveBeenCalledTimes(1);
      expect(dispatchCampaign).toHaveBeenCalledTimes(1);
      expect(result.dispatch_id).toBe('disp-alias-1');
    });

    it('normalizes undeclared recipients out of canonical row input', () => {
      const services = createServices();
      const skill = services.registry.resolve('skill.mkt.dispatch_campaign');
      const normalized = skill.validateInput({
        ...validDispatchInput,
        recipients: ['cust-bypass'],
      });

      expect(normalized).not.toHaveProperty('recipients');
    });
  });
});
