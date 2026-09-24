import { describe, expect, it } from 'vitest';
import type {
  Customer360Fact,
  HydratedContext,
  SignalEnvelope,
} from '@agentos/core-engine/contracts';

import {
  SalesAgentRuntime,
  type SkillRegistryPort,
  type SkillRegistryRowMetadata,
} from './agent-runtime.js';

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
      allowed_agents: ['SAL-01', 'SAL-02', 'SAL-03'],
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

    it('fails closed with no plan if recommendation has unverified context, ignoring untrusted payload', async () => {
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

      expect(plan.steps).toHaveLength(0);
      expect(plan.fallback_strategy).toBe('FAIL_CLOSED');
    });
  });

  describe('Unknown and Ambiguous Intent Handling', () => {
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
});
