/**
 * @file Sales agent runtime: routing, identity and registry guards.
 *
 * Split from `agent-runtime.test.ts`; the sibling files hold the remaining groups exactly
 * once and every assertion body is unchanged.
 */

import { describe, expect, it } from 'vitest';
import { type Customer360Fact, type HydratedContext, type SignalEnvelope } from '@agentos/core-engine/contracts';
import { SalesAgentRuntime, type SkillRegistryPort, type SkillRegistryRowMetadata } from './agent-runtime.js';
import { SalesAdvisorExecutionState } from './advisor-adapters.js';

describe('SalesAgentRuntime', () => {
  const tenant_id = '00000000-0000-4000-8000-000000000001';


  const verifiedCustomer: Customer360Fact = {
    customer_id: 'cust-verified-77',
    tenant_id,
    verified_phone: '+15551234567',
    verified_email: 'buyer@example.com',
    total_spent: 1200,
    order_count: 8,
    rfm_segment_hypothesis: 'CHAMPION',
    consent_marketing: true,
    consent_updated_at: '2026-09-01T00:00:00Z',
    suppression_active: false,
    created_at: '2026-09-01T00:00:00Z',
  };


  const verifiedContext: HydratedContext = {
    correlation_id: 'corr-sales-1',
    tenant_id,
    customer: verifiedCustomer,
    working_memory: {
      session_id: 'sess-sales-1',
      last_touch_channel: 'web',
      turn_count: 1,
      takeover_active: false,
    },
    knowledge_citations: [],
    hydrated_at: '2026-09-01T00:00:00Z',
  };


  const unverifiedContext: HydratedContext = {
    ...verifiedContext,
    customer: null,
  };


  const canonicalSalesRegistry: Record<string, SkillRegistryRowMetadata> = {
    'skill.sales.search_product': {
      skill_id: 'skill.sales.search_product',
      effect_class: 'READ',
      guarded_dependency: 'API-001.CatalogConnector',
      required_authority: 'AUTH-0',
      timeout_ms: 1500,
      allowed_agents: ['SAL-01', 'SAL-02'],
      enabled: true,
    },
    'skill.sales.check_stock': {
      skill_id: 'skill.sales.check_stock',
      effect_class: 'READ',
      guarded_dependency: 'API-001.InventoryConnector',
      required_authority: 'AUTH-0',
      timeout_ms: 3000,
      allowed_agents: ['SAL-01', 'SAL-02', 'CS-01'],
      enabled: true,
    },
    'skill.sales.retrieve_customer': {
      skill_id: 'skill.sales.retrieve_customer',
      effect_class: 'READ',
      guarded_dependency: 'PostgreSQL.Customer360Store',
      required_authority: 'AUTH-0',
      timeout_ms: 1500,
      allowed_agents: ['SAL-01', 'SAL-02', 'SAL-03', 'SAL-04', 'SAL-05'],
      enabled: true,
    },
    'skill.sales.recommend_product': {
      skill_id: 'skill.sales.recommend_product',
      effect_class: 'READ',
      guarded_dependency: 'Core.RecommendationEngine',
      required_authority: 'AUTH-1',
      timeout_ms: 2000,
      allowed_agents: ['SAL-02', 'SAL-03'],
      enabled: true,
    },
    'skill.sales.check_price': {
      skill_id: 'skill.sales.check_price',
      effect_class: 'READ',
      guarded_dependency: 'API-001.PricingEngine',
      required_authority: 'AUTH-3',
      timeout_ms: 2000,
      allowed_agents: ['SAL-02', 'SAL-04'],
      enabled: false,
    },
    'skill.sales.create_cart': {
      skill_id: 'skill.sales.create_cart',
      effect_class: 'EFFECT',
      guarded_dependency: 'API-002.CommerceCartAPI',
      required_authority: 'AUTH-3',
      timeout_ms: 2000,
      allowed_agents: ['SAL-02', 'SAL-04', 'SAL-05'],
      enabled: false,
    },
    'skill.sales.create_order': {
      skill_id: 'skill.sales.create_order',
      effect_class: 'EFFECT',
      guarded_dependency: 'API-001.OrderConnector',
      required_authority: 'AUTH-3',
      timeout_ms: 4000,
      allowed_agents: ['SAL-02', 'SAL-04', 'SAL-05'],
      enabled: false,
    },
    'skill.sales.send_message': {
      skill_id: 'skill.sales.send_message',
      effect_class: 'EFFECT',
      guarded_dependency: 'API-003.CommunicationConnector',
      required_authority: 'AUTH-3',
      timeout_ms: 3000,
      allowed_agents: ['SAL-02', 'SAL-04', 'SAL-05'],
      enabled: false,
    },
  };


  const createRegistryPort = (overrides?: Partial<Record<string, SkillRegistryRowMetadata>>): SkillRegistryPort => ({
    get(id: string) {
      if (overrides && id in overrides) {
        return overrides[id] ?? null;
      }
      return canonicalSalesRegistry[id] ?? null;
    },
  });


  describe('Three Agents Routing Coverage', () => {
    it('classifies a marketing_to_sales handoff as a brokered Sales leg', async () => {
      const runtime = new SalesAgentRuntime({ registry: createRegistryPort() });
      const signal: SignalEnvelope = {
        signal_id: 'sig-marketing-sales-handoff',
        tenant_id,
        correlation_id: 'corr-sales-handoff',
        source_channel: 'ORCHESTRATOR_HANDOFF',
        event_type: 'handoff.marketing_to_sales',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-marketing-sales', channel_type: 'orchestrator' },
        payload: {
          module: 'sales',
          handoff: { source_domain: 'marketing', target_domain: 'sales' },
          handoff_reason: 'Marketing-qualified customer journey leg',
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      expect(hypothesis.classification).toBe('HYPOTHESIS');
      expect(hypothesis.intent).toBe('sales:sales');
      expect(hypothesis.confidence).toBe(1);

      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.target_agent).toBe('SAL-02');
      expect(routing.requires_clarification).toBe(false);

      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0]?.agent_id).toBe('SAL-02');
      expect(plan.steps[0]?.skill_id).toBe('skill.sales.recommend_product');
      expect(plan.handoff_intent).toBeUndefined();

      const boundRuntime = new SalesAgentRuntime({
        registry: createRegistryPort(),
        careOnboardingItinerary: { steps: ['owner-configured-welcome'] },
      });
      const boundHypothesis = await boundRuntime.deriveHypothesis(signal, verifiedContext);
      const boundRouting = await boundRuntime.resolveRouting(signal, verifiedContext, boundHypothesis);
      const boundPlan = await boundRuntime.formulatePlan(boundRouting, verifiedContext, boundHypothesis);
      expect(boundPlan.handoff_intent).toEqual({
        source_domain: 'sales',
        target_domain: 'care',
        target_agent: 'CS-01',
        reason: 'Marketing-qualified customer journey leg',
      });
    });

    it('routes customer lookup inquiry to SAL-01 (Lead Qualification)', async () => {
      const runtime = new SalesAgentRuntime({ registry: createRegistryPort() });
      const signal: SignalEnvelope = {
        signal_id: 'sig-cust-1',
        tenant_id,
        correlation_id: 'corr-sales-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-1', channel_type: 'web' },
        payload: { message: 'Can you show my customer account profile and purchase history?' },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      expect(hypothesis.intent).toBe('customer_lookup');

      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.target_agent).toBe('SAL-01');
      expect(routing.requires_clarification).toBe(false);
    });

    it('routes product search inquiry to SAL-02 (AI Sales Advisor)', async () => {
      const runtime = new SalesAgentRuntime({ registry: createRegistryPort() });
      const signal: SignalEnvelope = {
        signal_id: 'sig-search-1',
        tenant_id,
        correlation_id: 'corr-sales-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-1', channel_type: 'web' },
        payload: { message: 'Find lightweight running shoes size 10 in catalog' },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      expect(hypothesis.intent).toBe('product_search');

      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.target_agent).toBe('SAL-02');
      expect(routing.requires_clarification).toBe(false);
    });

    it('routes inventory check inquiry to SAL-02 (AI Sales Advisor)', async () => {
      const runtime = new SalesAgentRuntime({ registry: createRegistryPort() });
      const signal: SignalEnvelope = {
        signal_id: 'sig-inv-1',
        tenant_id,
        correlation_id: 'corr-sales-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-1', channel_type: 'web' },
        payload: { message: 'Check stock availability for SKU-RUN-456' },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      expect(hypothesis.intent).toBe('inventory');

      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.target_agent).toBe('SAL-02');
      expect(routing.requires_clarification).toBe(false);
    });

    it('routes disabled price query to SAL-02 and forces clarification without plan', async () => {
      const runtime = new SalesAgentRuntime({ registry: createRegistryPort() });
      const signal: SignalEnvelope = {
        signal_id: 'sig-price-1',
        tenant_id,
        correlation_id: 'corr-sales-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-1', channel_type: 'web' },
        payload: { message: 'What is the price and discount quote for SKU-RUN-456?' },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      expect(hypothesis.intent).toBe('disabled_price');

      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.target_agent).toBe('SAL-02');
      expect(routing.requires_clarification).toBe(true);
      expect(routing.clarification_prompt).toContain('disabled');

      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(plan.steps).toHaveLength(0);
      expect(plan.fallback_strategy).toBe('FAIL_CLOSED');
    });

    it('routes product recommendation inquiry to SAL-03 (Recommendation Agent)', async () => {
      const runtime = new SalesAgentRuntime({ registry: createRegistryPort() });
      const signal: SignalEnvelope = {
        signal_id: 'sig-rec-1',
        tenant_id,
        correlation_id: 'corr-sales-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-1', channel_type: 'web' },
        payload: {
          message: 'Can you recommend complementary accessories for my running shoes?',
          current_cart_skus: ['SKU-RUN-456'],
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      expect(hypothesis.intent).toBe('recommend');

      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.target_agent).toBe('SAL-03');
      expect(routing.requires_clarification).toBe(false);
    });
  });

  describe('Safe Plan Step Formulation', () => {
    it('formulates valid PlannedStep for customer lookup with context customer identity', async () => {
      const runtime = new SalesAgentRuntime({ registry: createRegistryPort() });
      const signal: SignalEnvelope = {
        signal_id: 'sig-cust-2',
        tenant_id,
        correlation_id: 'corr-sales-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-1', channel_type: 'web' },
        payload: {
          message: 'Retrieve my customer profile',
          customer_id: 'untrusted-spoofed-customer-id',
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);

      expect(plan.steps).toHaveLength(1);
      const step = plan.steps[0]!;
      expect(step.agent_id).toBe('SAL-01');
      expect(step.skill_id).toBe('skill.sales.retrieve_customer');
      expect(step.adapter_target).toBe('PostgreSQL.Customer360Store');
      expect(step.mutating).toBe(false);
      expect(step.price_bearing).toBe(false);
      expect(step.idempotent).toBe(true);
      expect(step.required_authority).toBe('AUTH-0');
      // Strictly verified context customer ID, ignoring untrusted payload
      expect(step.input_parameters).toEqual({
        tenant_id,
        customer_identifier: 'cust-verified-77',
      });
    });

    it('formulates valid PlannedStep for product search', async () => {
      const runtime = new SalesAgentRuntime({ registry: createRegistryPort() });
      const signal: SignalEnvelope = {
        signal_id: 'sig-search-2',
        tenant_id,
        correlation_id: 'corr-sales-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-1', channel_type: 'web' },
        payload: { message: 'Search for wireless headphones' },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);

      expect(plan.steps).toHaveLength(1);
      const step = plan.steps[0]!;
      expect(step.agent_id).toBe('SAL-02');
      expect(step.skill_id).toBe('skill.sales.search_product');
      expect(step.adapter_target).toBe('API-001.CatalogConnector');
      expect(step.mutating).toBe(false);
      expect(step.price_bearing).toBe(false);
      expect(step.idempotent).toBe(true);
      expect(step.input_parameters).toEqual({
        tenant_id,
        query: 'wireless headphones',
      });
    });

    it('formulates valid PlannedStep for inventory check', async () => {
      const runtime = new SalesAgentRuntime({ registry: createRegistryPort() });
      const signal: SignalEnvelope = {
        signal_id: 'sig-inv-2',
        tenant_id,
        correlation_id: 'corr-sales-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-1', channel_type: 'web' },
        payload: { message: 'Do we have in stock SKU-EV-BATT-01?' },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);

      expect(plan.steps).toHaveLength(1);
      const step = plan.steps[0]!;
      expect(step.agent_id).toBe('SAL-02');
      expect(step.skill_id).toBe('skill.sales.check_stock');
      expect(step.adapter_target).toBe('API-001.InventoryConnector');
      expect(step.mutating).toBe(false);
      expect(step.price_bearing).toBe(false);
      expect(step.idempotent).toBe(true);
      expect(step.input_parameters).toEqual({
        tenant_id,
        sku_id: 'SKU-EV-BATT-01',
      });
    });

    it.each([
      ['Is SKU-LOCAL-1 in stock?', ['skill.sales.check_stock']],
      ['SKU-LOCAL-1 còn hàng không?', ['skill.sales.check_stock']],
      ['What is the price of SKU-LOCAL-1?', ['skill.sales.check_stock', 'skill.sales.check_price']],
      ['How much does SKU-LOCAL-1 cost?', ['skill.sales.check_stock', 'skill.sales.check_price']],
      ['SKU-LOCAL-1 giá bao nhiêu?', ['skill.sales.check_stock', 'skill.sales.check_price']],
      ['SKU-LOCAL-1 bao nhiêu tiền?', ['skill.sales.check_stock', 'skill.sales.check_price']],
    ] as const)('plans only the requested reads with pricing enabled: %s', async (message, skills) => {
      const runtime = new SalesAgentRuntime({
        registry: createRegistryPort({
          'skill.sales.check_price': { ...canonicalSalesRegistry['skill.sales.check_price']!, enabled: true },
        }),
      });
      const signal: SignalEnvelope = {
        signal_id: 'sig-inventory-pricing-enabled',
        tenant_id,
        correlation_id: 'corr-sales-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-1', channel_type: 'web' },
        payload: { message },
      };
      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(plan.steps.map((step) => step.skill_id)).toEqual(skills);
    });

    it('formulates valid PlannedStep for product recommendation with canonical parameters', async () => {
      const runtime = new SalesAgentRuntime({ registry: createRegistryPort() });
      const signal: SignalEnvelope = {
        signal_id: 'sig-rec-2',
        tenant_id,
        correlation_id: 'corr-sales-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-1', channel_type: 'web' },
        payload: {
          content: 'Suggest substitute items for SKU-BATT-99',
          current_cart_skus: ['SKU-BATT-99'],
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);

      expect(plan.steps).toHaveLength(1);
      const step = plan.steps[0]!;
      expect(step.agent_id).toBe('SAL-03');
      expect(step.skill_id).toBe('skill.sales.recommend_product');
      expect(step.adapter_target).toBe('Core.RecommendationEngine');
      expect(step.required_authority).toBe('AUTH-1');
      expect(step.mutating).toBe(false);
      expect(step.price_bearing).toBe(false);
      expect(step.idempotent).toBe(true);
      expect(step.input_parameters).toEqual({
        tenant_id,
        customer_id: 'cust-verified-77',
        current_cart_skus: ['SKU-BATT-99'],
        recommendation_type: 'CROSS_SELL',
      });
    });
  });

  describe('Customer Identity Protection and Context Isolation', () => {
    it('fails closed with no plan if customer lookup has unverified context, ignoring untrusted payload', async () => {
      const runtime = new SalesAgentRuntime({ registry: createRegistryPort() });
      const signal: SignalEnvelope = {
        signal_id: 'sig-cust-fake',
        tenant_id,
        correlation_id: 'corr-sales-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-1', channel_type: 'web' },
        payload: {
          message: 'Show customer profile',
          customer_id: 'injected-fake-id',
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, unverifiedContext);
      const routing = await runtime.resolveRouting(signal, unverifiedContext, hypothesis);
      const plan = await runtime.formulatePlan(routing, unverifiedContext, hypothesis);

      expect(plan.steps).toHaveLength(0);
      expect(plan.fallback_strategy).toBe('FAIL_CLOSED');
    });

    it('allows anonymous recommendations without trusting a caller-supplied customer id', async () => {
      const runtime = new SalesAgentRuntime({ registry: createRegistryPort() });
      const signal: SignalEnvelope = {
        signal_id: 'sig-rec-fake',
        tenant_id,
        correlation_id: 'corr-sales-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-1', channel_type: 'web' },
        payload: {
          message: 'Recommend bundle items',
          customer_id: 'injected-fake-id',
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, unverifiedContext);
      const routing = await runtime.resolveRouting(signal, unverifiedContext, hypothesis);
      const plan = await runtime.formulatePlan(routing, unverifiedContext, hypothesis);

      expect(hypothesis.intent).toBe('recommend');
      expect(routing.target_agent).toBe('SAL-03');
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0]).toMatchObject({
        skill_id: 'skill.sales.recommend_product',
        input_parameters: {
          tenant_id,
          current_cart_skus: [],
          recommendation_type: 'CROSS_SELL',
        },
      });
      expect((plan.steps[0]?.input_parameters as Record<string, unknown>).customer_id).toBeUndefined();
      expect(plan.fallback_strategy).toBe('FAIL_CLOSED');
    });
  });

  describe('Unknown and Ambiguous Intent Handling', () => {
    it('emits a typed refusal for an invalid API-stamped intent proposal', async () => {
      const runtime = new SalesAgentRuntime({ registry: createRegistryPort() });
      const signal: SignalEnvelope = {
        signal_id: 'sig-invalid-intent',
        tenant_id,
        correlation_id: 'corr-sales-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-1', channel_type: 'web' },
        payload: {
          module: 'sales',
          message: 'I need a laptop for graphic design',
          sales_proposal_source: 'API_GATEWAY',
          sales_intent_failure: 'LLM_INVALID_RESPONSE',
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      expect(hypothesis.reasoning).toContain('LLM_INVALID_RESPONSE');
      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);

      expect(routing.requires_clarification).toBe(false);

      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);

      expect(plan.steps).toEqual([]);
      expect(plan.terminal_response).toMatchObject({
        response_kind: 'REFUSAL',
        template_key: 'core.cannot_help',
        reason_code: 'LLM_INVALID_RESPONSE',
      });
      expect(plan.terminal_response?.text).toBeTruthy();
    });

    it('refuses a requested stock-and-price answer when check_price is unavailable', async () => {
      const runtime = new SalesAgentRuntime({
        registry: createRegistryPort({
          'skill.sales.check_price': {
            ...canonicalSalesRegistry['skill.sales.check_price']!,
            enabled: true,
          },
        }),
        gate: {
          async available(_tenantId, skillId) {
            return skillId === 'skill.sales.check_price'
              ? { available: false, reason: 'DISABLED_BY_TENANT' }
              : { available: true, reason: 'OK' };
          },
        },
      });
      const signal: SignalEnvelope = {
        signal_id: 'sig-disabled-check-price',
        tenant_id,
        correlation_id: 'corr-sales-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-1', channel_type: 'web' },
        payload: { message: 'NM-L01-BLK còn hàng không, giá bao nhiêu?' },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      expect(hypothesis.intent).toBe('sku_stock_price');
      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);

      expect(plan.steps).toEqual([]);
      expect(plan.terminal_response).toMatchObject({
        response_kind: 'REFUSAL',
        template_key: 'core.skill_unavailable',
        reason_code: 'DISABLED_BY_TENANT',
      });
    });

    it.each([true, false])('refuses disconnected SKU reads when the pricing row enabled flag is %s', async (enabled) => {
      const runtime = new SalesAgentRuntime({
        registry: createRegistryPort({
          'skill.sales.check_price': {
            ...canonicalSalesRegistry['skill.sales.check_price']!,
            enabled,
          },
        }),
        gate: {
          async available(_tenantId, skillId) {
            return skillId === 'skill.sales.check_stock' || skillId === 'skill.sales.check_price'
              ? { available: false, reason: 'CONNECTOR_UNBOUND' }
              : { available: true, reason: 'OK' };
          },
        },
      });
      const signal: SignalEnvelope = {
        signal_id: 'sig-disconnected-sku',
        tenant_id,
        correlation_id: 'corr-disconnected-sku',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-disconnected-sku', channel_type: 'web' },
        payload: { message: 'NM-L01-BLK còn hàng không, giá bao nhiêu?' },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, unverifiedContext);
      expect(hypothesis.intent).toBe('sku_stock_price');
      const routing = await runtime.resolveRouting(signal, unverifiedContext, hypothesis);
      expect(routing.requires_clarification).toBe(false);
      const plan = await runtime.formulatePlan(routing, unverifiedContext, hypothesis);
      expect(plan.steps).toEqual([]);
      expect(plan.terminal_response).toMatchObject({
        response_kind: 'REFUSAL',
        template_key: 'core.skill_unavailable',
        reason_code: 'CONNECTOR_UNBOUND',
      });
    });


    it('clarifies and emits empty plan for unrecognized message content', async () => {
      const runtime = new SalesAgentRuntime({ registry: createRegistryPort() });
      const signal: SignalEnvelope = {
        signal_id: 'sig-unknown',
        tenant_id,
        correlation_id: 'corr-sales-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-1', channel_type: 'web' },
        payload: { text: 'Hello, testing 1 2 3 random chatter' },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      expect(hypothesis.intent).toBe('unknown');

      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.target_agent).toBe('SAL-01');
      expect(routing.requires_clarification).toBe(true);

      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(plan.steps).toHaveLength(0);
      expect(plan.fallback_strategy).toBe('FAIL_CLOSED');
    });

    it('clarifies and emits empty plan for ambiguous conflicting intents', async () => {
      const runtime = new SalesAgentRuntime({ registry: createRegistryPort() });
      const signal: SignalEnvelope = {
        signal_id: 'sig-ambiguous',
        tenant_id,
        correlation_id: 'corr-sales-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-1', channel_type: 'web' },
        payload: { message: 'Can you show customer profile and recommend bundle products?' },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      expect(hypothesis.intent).toBe('ambiguous');

      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.target_agent).toBe('SAL-01');
      expect(routing.requires_clarification).toBe(true);

      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(plan.steps).toHaveLength(0);
      expect(plan.fallback_strategy).toBe('FAIL_CLOSED');
    });
  });

  describe('Disabled, Missing, Unauthorized or Non-READ Skill Rows Fail Closed', () => {
    it('emits no plan when skill row is marked enabled: false', async () => {
      const disabledRegistry = createRegistryPort({
        'skill.sales.search_product': {
          ...canonicalSalesRegistry['skill.sales.search_product']!,
          enabled: false,
        },
      });

      const runtime = new SalesAgentRuntime({ registry: disabledRegistry });
      const signal: SignalEnvelope = {
        signal_id: 'sig-disabled',
        tenant_id,
        correlation_id: 'corr-sales-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-1', channel_type: 'web' },
        payload: { message: 'Search for laptops' },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);

      expect(plan.steps).toHaveLength(0);
      expect(plan.fallback_strategy).toBe('FAIL_CLOSED');
    });

    it('emits no plan when skill row is missing from the registry resolver', async () => {
      const emptyRegistry: SkillRegistryPort = {
        get() {
          return null;
        },
      };

      const runtime = new SalesAgentRuntime({ registry: emptyRegistry });
      const signal: SignalEnvelope = {
        signal_id: 'sig-missing',
        tenant_id,
        correlation_id: 'corr-sales-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-1', channel_type: 'web' },
        payload: { message: 'Check stock SKU-BATT-01' },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);

      expect(plan.steps).toHaveLength(0);
      expect(plan.fallback_strategy).toBe('FAIL_CLOSED');
    });

    it('emits no plan when skill row declares a mutating or non-READ effect_class', async () => {
      const mutatingRegistry = createRegistryPort({
        'skill.sales.search_product': {
          ...canonicalSalesRegistry['skill.sales.search_product']!,
          effect_class: 'INTERNAL',
        },
      });

      const runtime = new SalesAgentRuntime({ registry: mutatingRegistry });
      const signal: SignalEnvelope = {
        signal_id: 'sig-mutating',
        tenant_id,
        correlation_id: 'corr-sales-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-1', channel_type: 'web' },
        payload: { message: 'Search for monitors' },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);

      expect(plan.steps).toHaveLength(0);
      expect(plan.fallback_strategy).toBe('FAIL_CLOSED');
    });

    it('emits no plan when target agent is not in allowed_agents list', async () => {
      const unauthorizedRegistry = createRegistryPort({
        'skill.sales.check_stock': {
          ...canonicalSalesRegistry['skill.sales.check_stock']!,
          allowed_agents: ['CS-01'], // SAL-02 omitted
        },
      });

      const runtime = new SalesAgentRuntime({ registry: unauthorizedRegistry });
      const signal: SignalEnvelope = {
        signal_id: 'sig-unauthorized',
        tenant_id,
        correlation_id: 'corr-sales-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-1', channel_type: 'web' },
        payload: { message: 'Check stock SKU-BATT-01' },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.target_agent).toBe('SAL-02');

      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(plan.steps).toHaveLength(0);
      expect(plan.fallback_strategy).toBe('FAIL_CLOSED');
    });
  });

  describe('SAL-02 Enabled Price Capability', () => {
    it('plans skill.sales.check_price when check_price registry row is enabled', async () => {
      const enabledPriceRegistry = createRegistryPort({
        'skill.sales.check_price': {
          ...canonicalSalesRegistry['skill.sales.check_price']!,
          enabled: true,
        },
      });
      const runtime = new SalesAgentRuntime({ registry: enabledPriceRegistry });
      const signal: SignalEnvelope = {
        signal_id: 'sig-price-enabled',
        tenant_id,
        correlation_id: 'corr-sales-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-1', channel_type: 'web' },
        payload: { message: 'What is the price for SKU-RUN-456?' },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      expect(hypothesis.intent).toBe('sku_stock_price');

      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.target_agent).toBe('SAL-02');
      expect(routing.requires_clarification).toBe(false);

      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(plan.steps).toHaveLength(2);
      expect(plan.steps[0]!.skill_id).toBe('skill.sales.check_stock');
      const step = plan.steps[1]!;
      expect(step.skill_id).toBe('skill.sales.check_price');
      expect(step.adapter_target).toBe('API-001.PricingEngine');
      expect(step.agent_id).toBe('SAL-02');
      expect(step.price_bearing).toBe(false);
      expect(step.mutating).toBe(false);
      expect(step.required_authority).toBe('AUTH-3');
      expect(step.timeout_ms).toBe(2000);
      expect(step.input_parameters).toEqual({
        tenant_id,
        sku_id: 'SKU-RUN-456',
        customer_id: verifiedCustomer.customer_id,
      });
      // Never emits a price value itself
      expect((step.input_parameters as Record<string, unknown>).price).toBeUndefined();
      expect((step.input_parameters as Record<string, unknown>).final_price).toBeUndefined();
    });

    it.each([
      'What is the price of SKU NM-L01-BLK? Quote the full numeric price in VND.',
      'NM-L01-BLK giá bao nhiêu?',
    ])('includes an authoritative price read for anonymous SKU inquiry: %s', async (message) => {
      const runtime = new SalesAgentRuntime({ registry: createRegistryPort({
        'skill.sales.check_price': {
          ...canonicalSalesRegistry['skill.sales.check_price']!,
          enabled: true,
        },
      }) });
      const signal: SignalEnvelope = {
        signal_id: 'sig-anonymous-sku-price', tenant_id, correlation_id: 'corr-sales-1',
        source_channel: 'WEB_CHAT', event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-1', channel_type: 'web' },
        payload: { message },
      };
      const hypothesis = await runtime.deriveHypothesis(signal, unverifiedContext);
      expect(hypothesis.intent).toBe('sku_stock_price');
      const routing = await runtime.resolveRouting(signal, unverifiedContext, hypothesis);
      const plan = await runtime.formulatePlan(routing, unverifiedContext, hypothesis);
      const price = plan.steps.find((step) => step.skill_id === 'skill.sales.check_price');
      expect(price).toMatchObject({
        adapter_target: 'API-001.PricingEngine', mutating: false,
        input_parameters: { tenant_id, sku_id: 'NM-L01-BLK' },
      });
      expect(price?.input_parameters).not.toHaveProperty('customer_id');
      expect(price?.input_parameters).not.toHaveProperty('list_price');
    });

    it('requires clarification when price is enabled but SKU is missing', async () => {
      const enabledPriceRegistry = createRegistryPort({
        'skill.sales.check_price': {
          ...canonicalSalesRegistry['skill.sales.check_price']!,
          enabled: true,
        },
      });
      const runtime = new SalesAgentRuntime({ registry: enabledPriceRegistry });
      const signal: SignalEnvelope = {
        signal_id: 'sig-price-no-sku',
        tenant_id,
        correlation_id: 'corr-sales-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-1', channel_type: 'web' },
        payload: { message: 'How much does this item cost?' },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      expect(hypothesis.intent).toBe('price');

      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.target_agent).toBe('SAL-02');
      expect(routing.requires_clarification).toBe(true);
      expect(routing.clarification_prompt).toContain('SKU');

      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(plan.steps).toHaveLength(0);
    });
  });

  describe('API-stamped advisor proposals', () => {
    it('plans budget and use-case advice when the gateway omitted the message category', async () => {
      const runtime = new SalesAgentRuntime({
        registry: createRegistryPort({
          'skill.sales.check_price': {
            ...canonicalSalesRegistry['skill.sales.check_price']!,
            enabled: true,
          },
        }),
        advisor_state: new SalesAdvisorExecutionState(),
        advisor_price_floor_bound: true,
      });
      const signal: SignalEnvelope = {
        signal_id: 'sig-advisor-message-category',
        tenant_id,
        correlation_id: 'corr-advisor-message-category',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-advisor-message-category', channel_type: 'web' },
        payload: {
          module: 'sales',
          message: 'Recommend a laptop under 20 million VND for graphic design.',
          sales_proposal_source: 'API_GATEWAY',
          sales_intent: 'advisor',
          sales_requirements: {
            budget: { amount: 20_000_000, currency: 'VND' },
            use_case: 'graphic design',
          },
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, unverifiedContext);
      const routing = await runtime.resolveRouting(signal, unverifiedContext, hypothesis);
      expect(routing.requires_clarification).toBe(false);
      const plan = await runtime.formulatePlan(routing, unverifiedContext, hypothesis);
      expect(plan.steps.map((step) => step.skill_id)).toEqual([
        'skill.sales.search_product',
        'skill.sales.check_stock',
        'skill.sales.check_price',
        'skill.sales.recommend_product',
      ]);
      expect(plan.steps[0]?.input_parameters).toEqual({ tenant_id, query: 'graphic design', limit: 20 });
      expect(plan.terminal_response).toBeUndefined();
    });

    it.each([
      { skill_id: 'skill.sales.check_price', enabled: true },
      { skill_id: 'skill.sales.check_price', enabled: false },
      { skill_id: 'skill.sales.check_stock', enabled: true },
    ])('refuses advisor reads when $skill_id is unbound (pricing enabled: $enabled)', async ({ skill_id, enabled }) => {
      const runtime = new SalesAgentRuntime({
        registry: createRegistryPort({
          'skill.sales.check_price': {
            ...canonicalSalesRegistry['skill.sales.check_price']!,
            enabled,
          },
        }),
        advisor_state: new SalesAdvisorExecutionState(),
        advisor_price_floor_bound: true,
        gate: {
          async available(_tenantId, requestedSkillId) {
            return requestedSkillId === skill_id
              ? { available: false, reason: 'CONNECTOR_UNBOUND' }
              : { available: true, reason: 'OK' };
          },
        },
      });
      const signal: SignalEnvelope = {
        signal_id: 'sig-advisor-unbound',
        tenant_id,
        correlation_id: 'corr-advisor-unbound',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-advisor-unbound', channel_type: 'web' },
        payload: {
          message: 'Recommend a laptop under 20 million VND for graphic design.',
          sales_proposal_source: 'API_GATEWAY',
          sales_intent: 'advisor',
          sales_requirements: {
            budget: { amount: 20_000_000, currency: 'VND' },
            use_case: 'graphic design',
          },
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, unverifiedContext);
      const routing = await runtime.resolveRouting(signal, unverifiedContext, hypothesis);
      expect(routing.requires_clarification).toBe(false);
      const plan = await runtime.formulatePlan(routing, unverifiedContext, hypothesis);
      expect(plan.steps).toEqual([]);
      expect(plan.terminal_response).toMatchObject({
        response_kind: 'REFUSAL',
        template_key: 'core.skill_unavailable',
        reason_code: 'CONNECTOR_UNBOUND',
      });
    });

    it('plans generic-currency read steps without requiring quote signing while keeping proposed SKU unverified', async () => {
      const advisor_state = new SalesAdvisorExecutionState();
      const runtime = new SalesAgentRuntime({
        registry: createRegistryPort({
          'skill.sales.check_price': {
            ...canonicalSalesRegistry['skill.sales.check_price']!,
            enabled: true,
          },
        }),
        advisor_state,
        advisor_price_floor_bound: true,
      });
      const signal: SignalEnvelope = {
        signal_id: 'sig-advisor-usd',
        tenant_id,
        correlation_id: 'corr-sales-advisor-usd',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-advisor-usd', channel_type: 'web' },
        payload: {
          message: 'Find a portable travel device',
          sales_proposal_source: 'API_GATEWAY',
          sales_intent: 'advisor',
          sales_requirements: {
            category: 'electronics',
            budget: { amount: 900, currency: 'USD' },
            use_case: 'travel',
            product_eligibility: { sku: 'SKU-PROPOSED-ONLY', category: 'portable' },
          },
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      expect(hypothesis.intent).toBe('advisor');
      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.requires_clarification).toBe(false);

      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(plan.steps.map((step) => step.skill_id)).toEqual([
        'skill.sales.search_product',
        'skill.sales.check_stock',
        'skill.sales.check_price',
        'skill.sales.recommend_product',
      ]);
      expect(plan.steps[0]?.input_parameters).toMatchObject({
        tenant_id,
        query: 'SKU-PROPOSED-ONLY',
        category_id: 'portable',
      });
      expect(plan.steps[1]?.input_parameters).toMatchObject({ tenant_id, sku_id: '' });
      expect(plan.steps[2]?.input_parameters).toMatchObject({ tenant_id, sku_id: '' });
      expect(plan.steps[1]?.input_bindings).toEqual({
        sku_id: { source_step_index: 1, response_path: 'products.0.sku' },
      });
      expect(plan.steps[2]?.input_bindings).toEqual({
        sku_id: { source_step_index: 2, response_path: 'sku_id' },
      });
    });
    it('plans anonymous laptop advice through catalog, stock, price, and recommendation reads', async () => {
      const advisor_state = new SalesAdvisorExecutionState();
      const runtime = new SalesAgentRuntime({
        registry: createRegistryPort({
          'skill.sales.check_price': {
            ...canonicalSalesRegistry['skill.sales.check_price']!,
            enabled: true,
          },
        }),
        advisor_state,
        advisor_price_floor_bound: true,
      });
      const message = 'laptop dưới 20 triệu cho thiết kế đồ họa';
      const signal: SignalEnvelope = {
        signal_id: 'sig-anonymous-laptop-advisor',
        tenant_id,
        correlation_id: 'corr-anonymous-laptop-advisor',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-anonymous-laptop-advisor', channel_type: 'web' },
        payload: {
          message,
          sales_proposal_source: 'API_GATEWAY',
          sales_intent: 'advisor',
          sales_requirements: {
            category: 'laptops',
            budget: { amount: 20_000_000, currency: 'VND' },
            use_case: message,
            product_eligibility: { category: 'laptops' },
          },
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, unverifiedContext);
      const routing = await runtime.resolveRouting(signal, unverifiedContext, hypothesis);
      expect(routing.requires_clarification).toBe(false);
      const plan = await runtime.formulatePlan(routing, unverifiedContext, hypothesis);

      expect(plan.steps.map((step) => step.skill_id)).toEqual([
        'skill.sales.search_product',
        'skill.sales.check_stock',
        'skill.sales.check_price',
        'skill.sales.recommend_product',
      ]);
      expect(plan.steps[0]?.input_parameters).toMatchObject({
        tenant_id,
        query: message,
        category_id: 'laptops',
      });
      expect(plan.steps[2]?.input_parameters).not.toHaveProperty('customer_id');
      expect(plan.steps[3]?.input_parameters).not.toHaveProperty('customer_id');
      expect(plan.steps[1]?.input_bindings).toEqual({
        sku_id: { source_step_index: 1, response_path: 'products.0.sku' },
      });
      expect(plan.steps[2]?.input_bindings).toEqual({
        sku_id: { source_step_index: 2, response_path: 'sku_id' },
      });
      expect(plan.steps[3]?.depends_on_steps).toEqual([1, 2, 3]);
      expect(plan.steps.every((step) => !step.mutating)).toBe(true);

      const unavailableRuntime = new SalesAgentRuntime({
        registry: createRegistryPort({
          'skill.sales.check_price': {
            ...canonicalSalesRegistry['skill.sales.check_price']!,
            enabled: true,
          },
        }),
        advisor_state: new SalesAdvisorExecutionState(),
        advisor_price_floor_bound: true,
        gate: {
          async available(_tenantId, skillId) {
            return skillId === 'skill.sales.check_price'
              ? { available: false, reason: 'DISABLED_BY_TENANT' }
              : { available: true, reason: 'OK' };
          },
        },
      });
      const unavailableHypothesis = await unavailableRuntime.deriveHypothesis(signal, unverifiedContext);
      const unavailableRouting = await unavailableRuntime.resolveRouting(signal, unverifiedContext, unavailableHypothesis);
      const unavailablePlan = await unavailableRuntime.formulatePlan(
        unavailableRouting, unverifiedContext, unavailableHypothesis,
      );
      expect(unavailablePlan.steps).toEqual([]);
      expect(unavailablePlan.terminal_response).toMatchObject({
        response_kind: 'REFUSAL',
        reason_code: 'DISABLED_BY_TENANT',
      });
    });

    it('clarifies with the missing fields instead of inventing advisor requirements', async () => {
      const runtime = new SalesAgentRuntime({ registry: createRegistryPort() });
      const signal: SignalEnvelope = {
        signal_id: 'sig-advisor-missing-use-case',
        tenant_id,
        correlation_id: 'corr-sales-advisor-missing',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-advisor-missing', channel_type: 'web' },
        payload: {
          sales_proposal_source: 'API_GATEWAY',
          sales_intent: 'advisor',
          sales_requirements: {
            category: 'electronics',
            budget: { amount: 900, currency: 'EUR' },
          },
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.requires_clarification).toBe(true);
      expect(routing.clarification_prompt).toContain('use case');
      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(plan.steps).toHaveLength(0);
    });

    it('rejects legacy budget_vnd instead of silently assuming a currency', async () => {
      const runtime = new SalesAgentRuntime({ registry: createRegistryPort() });
      const signal: SignalEnvelope = {
        signal_id: 'sig-advisor-legacy-budget',
        tenant_id,
        correlation_id: 'corr-sales-advisor-legacy',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-advisor-legacy', channel_type: 'web' },
        payload: {
          sales_proposal_source: 'API_GATEWAY',
          sales_intent: 'advisor',
          sales_requirements: {
            category: 'electronics',
            budget_vnd: 900,
            use_case: 'travel',
          },
        },
      };

      await expect(runtime.deriveHypothesis(signal, verifiedContext)).rejects.toMatchObject({
        code: 'SALES_STRUCTURED_INTENT_INVALID',
      });
    });
  });
});
