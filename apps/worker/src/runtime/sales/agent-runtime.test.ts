import { describe, expect, it } from 'vitest';
import type {
  Customer360Fact,
  HydratedContext,
  HypothesisRecord,
  RoutingDecision,
  SignalEnvelope,
} from '@agentos/core-engine/contracts';

import {
  SalesAgentRuntime,
  type SalesPurchaseEvidencePort,
  type SkillRegistryPort,
  type SkillRegistryRowMetadata,
} from './agent-runtime.js';
import type {
  SalesReplenishmentPolicyPort,
} from './skills/types.js';

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

  const defaultPurchaseEvidence: SalesPurchaseEvidencePort = {
    read: async () => [
      {
        order_id: 'ORD-PRIOR-999',
        order_date: '2026-08-01T00:00:00Z',
        items: ['SKU-RUN-456'],
        sku_ids: ['SKU-RUN-456'],
      },
    ],
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
      expect(hypothesis.intent).toBe('price');

      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.target_agent).toBe('SAL-02');
      expect(routing.requires_clarification).toBe(false);

      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(plan.steps).toHaveLength(1);
      const step = plan.steps[0]!;
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

  describe('SAL-04 Cart Recovery Routing and Planning', () => {
    const enabledCommerceRegistry = createRegistryPort({
      'skill.sales.check_stock': {
        ...canonicalSalesRegistry['skill.sales.check_stock']!,
        allowed_agents: ['SAL-01', 'SAL-02', 'SAL-04'],
        enabled: true,
      },
      'skill.sales.check_price': {
        ...canonicalSalesRegistry['skill.sales.check_price']!,
        enabled: true,
      },
      'skill.sales.retrieve_customer': {
        ...canonicalSalesRegistry['skill.sales.retrieve_customer']!,
        allowed_agents: ['SAL-01', 'SAL-02', 'SAL-03', 'SAL-04', 'SAL-05'],
        enabled: true,
      },
      'skill.sales.create_cart': {
        ...canonicalSalesRegistry['skill.sales.create_cart']!,
        enabled: true,
      },
      'skill.sales.create_order': {
        ...canonicalSalesRegistry['skill.sales.create_order']!,
        enabled: true,
      },
      'skill.sales.send_message': {
        ...canonicalSalesRegistry['skill.sales.send_message']!,
        enabled: true,
      },
    });

    it('deterministically classifies cart.abandoned signal with cart_id and skus to SAL-04', async () => {
      const runtime = new SalesAgentRuntime({ registry: enabledCommerceRegistry });
      const signal: SignalEnvelope = {
        signal_id: 'sig-cart-abandoned-1',
        tenant_id,
        correlation_id: 'corr-cart-1',
        source_channel: 'WEB_CHAT',
        event_type: 'cart.abandoned',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-cart-1', channel_type: 'web' },
        payload: {
          cart_id: 'cart-uuid-101',
          skus: ['SKU-RUN-456'],
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      expect(hypothesis.intent).toBe('cart_recovery');

      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.target_agent).toBe('SAL-04');
      expect(routing.requires_clarification).toBe(false);
    });

    it('classifies cart recovery text inquiry to SAL-04', async () => {
      const runtime = new SalesAgentRuntime({ registry: enabledCommerceRegistry });
      const signal: SignalEnvelope = {
        signal_id: 'sig-cart-text-1',
        tenant_id,
        correlation_id: 'corr-cart-2',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-cart-2', channel_type: 'web' },
        payload: {
          message: 'Can I recover my abandoned cart for SKU-RUN-456?',
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      expect(hypothesis.intent).toBe('cart_recovery');

      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.target_agent).toBe('SAL-04');
    });

    it('never uses SAL-04 as fallback for generic or unknown prompt', async () => {
      const runtime = new SalesAgentRuntime({ registry: enabledCommerceRegistry });
      const signal: SignalEnvelope = {
        signal_id: 'sig-generic',
        tenant_id,
        correlation_id: 'corr-generic',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-gen', channel_type: 'web' },
        payload: { message: 'Hello, what services do you provide?' },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      expect(hypothesis.intent).toBe('unknown');

      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.target_agent).toBe('SAL-01');
      expect(routing.target_agent).not.toBe('SAL-04');
      expect(routing.target_agent).not.toBe('SAL-05');
    });

    it('discards payload customer_id and preserves verified server-side identity', async () => {
      const runtime = new SalesAgentRuntime({ registry: enabledCommerceRegistry });
      const signal: SignalEnvelope = {
        signal_id: 'sig-spoof',
        tenant_id,
        correlation_id: 'corr-spoof',
        source_channel: 'WEB_CHAT',
        event_type: 'cart.abandoned',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-spoof', channel_type: 'web' },
        payload: {
          customer_id: 'attacker-injected-id',
          cart_id: 'cart-123',
          skus: ['SKU-RUN-456'],
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);

      for (const step of plan.steps) {
        const params = step.input_parameters as Record<string, unknown>;
        if (params.customer_id) {
          expect(params.customer_id).toBe(verifiedCustomer.customer_id);
          expect(params.customer_id).not.toBe('attacker-injected-id');
        }
        if (params.recipient_id) {
          expect(params.recipient_id).toBe(verifiedCustomer.customer_id);
          expect(params.recipient_id).not.toBe('attacker-injected-id');
        }
      }
    });

    it('plans steps in canonical order (consent -> stock -> price -> cart -> message)', async () => {
      const runtime = new SalesAgentRuntime({ registry: enabledCommerceRegistry });
      const signal: SignalEnvelope = {
        signal_id: 'sig-orderly',
        tenant_id,
        correlation_id: 'corr-orderly',
        source_channel: 'WEB_CHAT',
        event_type: 'cart.abandoned',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-ord', channel_type: 'web' },
        payload: {
          cart_id: 'cart-canonical',
          skus: ['SKU-RUN-456'],
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);

      const skillIds = plan.steps.map((s) => s.skill_id);
      expect(skillIds).toEqual([
        'skill.sales.retrieve_customer',
        'skill.sales.check_stock',
        'skill.sales.check_price',
        'skill.sales.create_cart',
        'skill.sales.send_message',
      ]);

      const consentStep = plan.steps.find((s) => s.skill_id === 'skill.sales.retrieve_customer')!;
      expect(consentStep).toBeDefined();
      expect(consentStep.step_index).toBe(1);
      expect(consentStep.agent_id).toBe('SAL-04');
      expect(consentStep.mutating).toBe(false);
      expect(consentStep.price_bearing).toBe(false);
      expect(consentStep.required_authority).toBe('AUTH-0');
      expect(consentStep.input_parameters).toEqual({
        tenant_id,
        customer_identifier: verifiedCustomer.customer_id,
      });
      expect(skillIds).not.toContain('skill.sales.create_order');
      expect(plan.steps.some((s) => s.skill_id === 'skill.sales.create_order')).toBe(false);
      // Determinism: planning the SAME signal twice yields byte-identical input parameters
      const plan2 = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(JSON.stringify(plan.steps.map((s) => s.input_parameters))).toBe(
        JSON.stringify(plan2.steps.map((s) => s.input_parameters)),
      );

      for (const step of plan.steps) {
        const params = step.input_parameters as Record<string, unknown>;
        expect(params.effect_key).toBeUndefined();
        expect(params.idempotency_key).toBeUndefined();
        // Legitimate server-bound tenant_id and customer_id must appear and be accepted
        expect(params.tenant_id).toBe(tenant_id);
        const json = JSON.stringify(params);
        const strippedJson = json
          .replaceAll(tenant_id, '')
          .replaceAll(verifiedCustomer.customer_id, '');
        expect(strippedJson).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
        expect(json).not.toMatch(/cart_[0-9a-f]{8}/i);
        expect(json).not.toMatch(/order_[0-9a-f]{8}/i);
        expect(json).not.toMatch(/msg_[0-9a-f]{8}/i);
      }

      const priceStep = plan.steps.find((s) => s.skill_id === 'skill.sales.check_price')!;
      expect(priceStep).toBeDefined();
      expect(priceStep.price_bearing).toBe(false);
      expect(priceStep.mutating).toBe(false);

      // Check step properties on mutating steps
      const cartStep = plan.steps.find((s) => s.skill_id === 'skill.sales.create_cart')!;
      expect(cartStep.mutating).toBe(true);
      expect(cartStep.required_authority).toBe('AUTH-3');
      expect(cartStep.timeout_ms).toBe(2000);
      expect(cartStep.input_parameters).toEqual({
        tenant_id,
        session_id: 'sess-sales-1',
        customer_id: verifiedCustomer.customer_id,
        items: [{ sku_id: 'SKU-RUN-456', quantity: 1 }],
      });

      const messageStep = plan.steps.find((s) => s.skill_id === 'skill.sales.send_message')!;
      expect(messageStep.mutating).toBe(true);
      expect(messageStep.required_authority).toBe('AUTH-3');
      expect(messageStep.timeout_ms).toBe(3000);
      expect(messageStep.input_parameters).toEqual({
        tenant_id,
        recipient_id: verifiedCustomer.customer_id,
        channel: 'WEB',
        message_content: {
          text: 'You left items in your cart. Complete your purchase now!',
        },
      });
    });

    it('fails closed when takeover_active is true (no outbound steps planned)', async () => {
      const runtime = new SalesAgentRuntime({ registry: enabledCommerceRegistry });
      const signal: SignalEnvelope = {
        signal_id: 'sig-taken-over',
        tenant_id,
        correlation_id: 'corr-taken-over',
        source_channel: 'WEB_CHAT',
        event_type: 'cart.abandoned',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-to', channel_type: 'web' },
        payload: {
          cart_id: 'cart-taken-over',
          skus: ['SKU-RUN-456'],
        },
      };

      const takenOverContext: HydratedContext = {
        ...verifiedContext,
        working_memory: {
          ...verifiedContext.working_memory,
          takeover_active: true,
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, takenOverContext);
      const routing = await runtime.resolveRouting(signal, takenOverContext, hypothesis);
      const plan = await runtime.formulatePlan(routing, takenOverContext, hypothesis);

      expect(plan.steps).toHaveLength(0);
      expect(plan.fallback_strategy).toBe('FAIL_CLOSED');
    });

    it('requires clarification and plans no steps when marketing consent is false or suppression is active', async () => {
      const runtime = new SalesAgentRuntime({ registry: enabledCommerceRegistry });
      const signal: SignalEnvelope = {
        signal_id: 'sig-optout',
        tenant_id,
        correlation_id: 'corr-optout',
        source_channel: 'WEB_CHAT',
        event_type: 'cart.abandoned',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-optout', channel_type: 'web' },
        payload: {
          cart_id: 'cart-optout',
          skus: ['SKU-RUN-456'],
        },
      };

      const noConsentContext: HydratedContext = {
        ...verifiedContext,
        customer: {
          ...verifiedCustomer,
          consent_marketing: false,
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, noConsentContext);
      const routing = await runtime.resolveRouting(signal, noConsentContext, hypothesis);
      expect(routing.requires_clarification).toBe(true);
      expect(routing.clarification_prompt).toContain('consent');

      const plan = await runtime.formulatePlan(routing, noConsentContext, hypothesis);
      expect(plan.steps).toHaveLength(0);
    });

    it('refuses cart recovery and plans no message step when consent authority skill.sales.retrieve_customer is disabled', async () => {
      const disabledConsentRegistry = createRegistryPort({
        'skill.sales.retrieve_customer': {
          ...canonicalSalesRegistry['skill.sales.retrieve_customer']!,
          allowed_agents: ['SAL-01', 'SAL-02', 'SAL-03', 'SAL-04', 'SAL-05'],
          enabled: false,
        },
        'skill.sales.check_stock': {
          ...canonicalSalesRegistry['skill.sales.check_stock']!,
          allowed_agents: ['SAL-01', 'SAL-02', 'SAL-04'],
          enabled: true,
        },
        'skill.sales.check_price': {
          ...canonicalSalesRegistry['skill.sales.check_price']!,
          enabled: true,
        },
        'skill.sales.create_cart': {
          ...canonicalSalesRegistry['skill.sales.create_cart']!,
          enabled: true,
        },
        'skill.sales.send_message': {
          ...canonicalSalesRegistry['skill.sales.send_message']!,
          enabled: true,
        },
      });
      const runtime = new SalesAgentRuntime({ registry: disabledConsentRegistry });
      const signal: SignalEnvelope = {
        signal_id: 'sig-cart-no-consent-row',
        tenant_id,
        correlation_id: 'corr-cart-no-consent',
        source_channel: 'WEB_CHAT',
        event_type: 'cart.abandoned',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-cart-no-consent', channel_type: 'web' },
        payload: {
          cart_id: 'cart-no-consent',
          skus: ['SKU-RUN-456'],
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      expect(hypothesis.reasoning).toContain('skill.sales.retrieve_customer');

      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.requires_clarification).toBe(true);
      expect(routing.clarification_prompt).toContain('skill.sales.retrieve_customer');
      expect(routing.rationalization).toContain('skill.sales.retrieve_customer');

      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(plan.steps).toHaveLength(0);
      expect(plan.fallback_strategy).toBe('FAIL_CLOSED');
      expect(plan.steps.some((s) => s.skill_id === 'skill.sales.send_message')).toBe(false);
    });

    it('refuses cart recovery when consent authority is not allowed for SAL-04', async () => {
      const disallowedConsentRegistry = createRegistryPort({
        'skill.sales.retrieve_customer': {
          ...canonicalSalesRegistry['skill.sales.retrieve_customer']!,
          allowed_agents: ['SAL-01', 'SAL-02', 'SAL-03'], // SAL-04 missing
          enabled: true,
        },
        'skill.sales.check_stock': {
          ...canonicalSalesRegistry['skill.sales.check_stock']!,
          allowed_agents: ['SAL-01', 'SAL-02', 'SAL-04'],
          enabled: true,
        },
        'skill.sales.check_price': {
          ...canonicalSalesRegistry['skill.sales.check_price']!,
          allowed_agents: ['SAL-02', 'SAL-04'],
          enabled: true,
        },
        'skill.sales.create_cart': {
          ...canonicalSalesRegistry['skill.sales.create_cart']!,
          enabled: true,
        },
        'skill.sales.send_message': {
          ...canonicalSalesRegistry['skill.sales.send_message']!,
          enabled: true,
        },
      });
      const runtime = new SalesAgentRuntime({ registry: disallowedConsentRegistry });
      const signal: SignalEnvelope = {
        signal_id: 'sig-cart-disallowed-consent',
        tenant_id,
        correlation_id: 'corr-cart-disallowed',
        source_channel: 'WEB_CHAT',
        event_type: 'cart.abandoned',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-cart-disallowed', channel_type: 'web' },
        payload: {
          cart_id: 'cart-disallowed',
          skus: ['SKU-RUN-456'],
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      expect(hypothesis.reasoning).toContain('skill.sales.retrieve_customer');

      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.requires_clarification).toBe(true);
      expect(routing.clarification_prompt).toContain('skill.sales.retrieve_customer');

      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(plan.steps).toHaveLength(0);
      expect(plan.fallback_strategy).toBe('FAIL_CLOSED');
    });

    it('fails closed when outbound channel is missing from session context (never defaults to EMAIL)', async () => {
      const runtime = new SalesAgentRuntime({ registry: enabledCommerceRegistry });
      const signal: SignalEnvelope = {
        signal_id: 'sig-cart-no-channel',
        tenant_id,
        correlation_id: 'corr-cart-no-channel',
        source_channel: 'WEB_CHAT',
        event_type: 'cart.abandoned',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-cart-no-channel', channel_type: 'web' },
        payload: {
          cart_id: 'cart-no-channel',
          skus: ['SKU-RUN-456'],
        },
      };

      const noChannelContext: HydratedContext = {
        ...verifiedContext,
        working_memory: {
          ...verifiedContext.working_memory,
          last_touch_channel: '',
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, noChannelContext);
      expect(hypothesis.reasoning).toContain('outbound channel missing');

      const routing = await runtime.resolveRouting(signal, noChannelContext, hypothesis);
      expect(routing.requires_clarification).toBe(true);
      expect(routing.clarification_prompt).toContain('outbound channel');

      const plan = await runtime.formulatePlan(routing, noChannelContext, hypothesis);
      expect(plan.steps).toHaveLength(0);
      expect(plan.fallback_strategy).toBe('FAIL_CLOSED');
    });

    it('formulatePlan directly refuses with FAIL_CLOSED and 0 steps when consent row is unavailable', async () => {
      // Mode 1: not permitted for routed agent (this fixture deliberately omits SAL-04 from
      // the canonical allowed_agents, which lists SAL-01..SAL-05)
      const notPermittedRuntime = new SalesAgentRuntime({
        registry: createRegistryPort({
          'skill.sales.retrieve_customer': {
            ...canonicalSalesRegistry['skill.sales.retrieve_customer']!,
            allowed_agents: ['SAL-01', 'SAL-02', 'SAL-03'],
          },
        }),
      });
      const routing: RoutingDecision = {
        target_agent: 'SAL-04',
        requires_clarification: false,
        rationalization: 'Direct formulation test',
      };
      const hypothesis: HypothesisRecord = {
        classification: 'HYPOTHESIS',
        intent: 'cart_recovery',
        confidence: 0.95,
        churn_risk_score: 0.1,
        purchase_propensity: 0.9,
        reasoning: 'Direct formulation test',
        derived_from_signals: ['sig-direct'],
      };

      const planNotPermitted = await notPermittedRuntime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(planNotPermitted.steps).toHaveLength(0);
      expect(planNotPermitted.fallback_strategy).toBe('FAIL_CLOSED');

      // Mode 2: disabled
      const disabledRuntime = new SalesAgentRuntime({
        registry: createRegistryPort({
          'skill.sales.retrieve_customer': {
            ...canonicalSalesRegistry['skill.sales.retrieve_customer']!,
            allowed_agents: ['SAL-01', 'SAL-02', 'SAL-03', 'SAL-04', 'SAL-05'],
            enabled: false,
          },
        }),
      });
      const planDisabled = await disabledRuntime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(planDisabled.steps).toHaveLength(0);
      expect(planDisabled.fallback_strategy).toBe('FAIL_CLOSED');

      // Mode 3: absent
      const absentRuntime = new SalesAgentRuntime({
        registry: {
          get(id: string) {
            if (id === 'skill.sales.retrieve_customer') return null;
            return canonicalSalesRegistry[id] ?? null;
          },
        },
      });
      const planAbsent = await absentRuntime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(planAbsent.steps).toHaveLength(0);
      expect(planAbsent.fallback_strategy).toBe('FAIL_CLOSED');
    });
  });

  describe('SAL-05 Replenishment Refusals and Planning', () => {
    const enabledReplenishRegistry = createRegistryPort({
      'skill.sales.retrieve_customer': {
        ...canonicalSalesRegistry['skill.sales.retrieve_customer']!,
        allowed_agents: ['SAL-01', 'SAL-02', 'SAL-03', 'SAL-04', 'SAL-05'],
        enabled: true,
      },
      'skill.sales.check_stock': {
        ...canonicalSalesRegistry['skill.sales.check_stock']!,
        allowed_agents: ['SAL-01', 'SAL-02', 'SAL-05'],
        enabled: true,
      },
      'skill.sales.check_price': {
        ...canonicalSalesRegistry['skill.sales.check_price']!,
        allowed_agents: ['SAL-02', 'SAL-04', 'SAL-05'],
        enabled: true,
      },
      'skill.sales.create_order': {
        ...canonicalSalesRegistry['skill.sales.create_order']!,
        enabled: true,
      },
      'skill.sales.send_message': {
        ...canonicalSalesRegistry['skill.sales.send_message']!,
        enabled: true,
      },
    });

    const defaultReplenishmentPolicy: SalesReplenishmentPolicyPort = {
      read: async () => ({
        replenishment_interval_days: 30,
        evidence_staleness_window_days: 15,
        owner_approved: true as const,
      }),
    };

    const validReplenishmentSignal: SignalEnvelope = {
      signal_id: 'sig-rep-valid',
      tenant_id,
      correlation_id: 'corr-rep-valid',
      source_channel: 'WEB_CHAT',
      event_type: 'replenishment.cycle',
      timestamp: '2026-09-01T00:00:00Z',
      subject: { session_id: 'sess-rep-valid', channel_type: 'web' },
      payload: {
        prior_purchase_reference: 'ORD-PRIOR-999',
        sku_id: 'SKU-RUN-456',
        approved_interval_days: 30,
      },
    };

    it('deterministically classifies valid replenishment signal to SAL-05 with successful plan', async () => {
      const runtime = new SalesAgentRuntime({
        registry: enabledReplenishRegistry,
        replenishment_policy: defaultReplenishmentPolicy,
        purchase_evidence: defaultPurchaseEvidence,
      });
      const hypothesis = await runtime.deriveHypothesis(validReplenishmentSignal, verifiedContext);
      expect(hypothesis.intent).toBe('replenishment');
      expect(hypothesis.reasoning).toContain('succeeded');

      const routing = await runtime.resolveRouting(validReplenishmentSignal, verifiedContext, hypothesis);
      expect(routing.target_agent).toBe('SAL-05');
      expect(routing.requires_clarification).toBe(false);

      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(plan.steps.length).toBeGreaterThan(0);
      const skillIds = plan.steps.map((s) => s.skill_id);
      expect(skillIds).toEqual([
        'skill.sales.retrieve_customer',
        'skill.sales.check_stock',
        'skill.sales.check_price',
        'skill.sales.send_message',
      ]);

      const consentStep = plan.steps.find((s) => s.skill_id === 'skill.sales.retrieve_customer')!;
      expect(consentStep).toBeDefined();
      expect(consentStep.step_index).toBe(1);
      expect(consentStep.agent_id).toBe('SAL-05');
      expect(consentStep.mutating).toBe(false);
      expect(consentStep.price_bearing).toBe(false);
      expect(consentStep.required_authority).toBe('AUTH-0');
      expect(consentStep.input_parameters).toEqual({
        tenant_id,
        customer_identifier: verifiedCustomer.customer_id,
      });
      expect(skillIds).not.toContain('skill.sales.create_order');
      expect(plan.steps.some((s) => s.skill_id === 'skill.sales.create_order')).toBe(false);
      // Determinism: planning the SAME signal twice yields byte-identical input parameters
      const plan2 = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(JSON.stringify(plan.steps.map((s) => s.input_parameters))).toBe(
        JSON.stringify(plan2.steps.map((s) => s.input_parameters)),
      );

      for (const step of plan.steps) {
        const params = step.input_parameters as Record<string, unknown>;
        expect(params.effect_key).toBeUndefined();
        expect(params.idempotency_key).toBeUndefined();
        // Legitimate server-bound tenant_id and customer_id must appear and be accepted
        expect(params.tenant_id).toBe(tenant_id);
        const json = JSON.stringify(params);
        const strippedJson = json
          .replaceAll(tenant_id, '')
          .replaceAll(verifiedCustomer.customer_id, '');
        expect(strippedJson).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
        expect(json).not.toMatch(/reorder_[0-9a-f]{8}/i);
        expect(json).not.toMatch(/msg_[0-9a-f]{8}/i);
        expect(json).not.toMatch(/order_[0-9a-f]{8}/i);
      }

      const priceStep = plan.steps.find((s) => s.skill_id === 'skill.sales.check_price')!;
      expect(priceStep).toBeDefined();
      expect(priceStep.price_bearing).toBe(false);
      expect(priceStep.mutating).toBe(false);

      const messageStep = plan.steps.find((s) => s.skill_id === 'skill.sales.send_message')!;
      expect(messageStep.input_parameters).toEqual({
        tenant_id,
        recipient_id: verifiedCustomer.customer_id,
        channel: 'WEB',
        message_content: {
          text: "It's time to reorder your previously purchased product!",
        },
      });
    });

    it('never uses SAL-05 as fallback for generic prompt', async () => {
      const runtime = new SalesAgentRuntime({
        registry: enabledReplenishRegistry,
        replenishment_policy: defaultReplenishmentPolicy,
        purchase_evidence: defaultPurchaseEvidence,
      });
      const signal: SignalEnvelope = {
        signal_id: 'sig-gen-2',
        tenant_id,
        correlation_id: 'corr-gen-2',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        timestamp: '2026-09-01T00:00:00Z',
        subject: { session_id: 'sess-gen-2', channel_type: 'web' },
        payload: { message: 'Can someone help me?' },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.target_agent).toBe('SAL-01');
      expect(routing.target_agent).not.toBe('SAL-05');
    });

    // Refusal Condition 1: Purchase evidence missing or stale
    it('refuses when purchase evidence is missing', async () => {
      const runtime = new SalesAgentRuntime({
        registry: enabledReplenishRegistry,
        replenishment_policy: defaultReplenishmentPolicy,
      });
      const signal: SignalEnvelope = {
        ...validReplenishmentSignal,
        payload: {
          approved_interval_days: 30,
          // prior_purchase_reference omitted
        },
      };
      const anonymousContext: HydratedContext = {
        ...verifiedContext,
        customer: null,
      };

      const hypothesis = await runtime.deriveHypothesis(signal, anonymousContext);
      expect(hypothesis.reasoning).toContain('purchase evidence missing or stale');

      const routing = await runtime.resolveRouting(signal, anonymousContext, hypothesis);
      expect(routing.requires_clarification).toBe(true);
      expect(routing.rationalization).toContain('purchase evidence missing or stale');

      const plan = await runtime.formulatePlan(routing, anonymousContext, hypothesis);
      expect(plan.steps).toHaveLength(0);
    });

    it('refuses when purchase evidence is marked stale', async () => {
      const stalePurchaseEvidence: SalesPurchaseEvidencePort = {
        read: async () => [
          {
            order_id: 'ORD-PRIOR-999',
            order_date: '2025-01-01T00:00:00Z',
            items: ['SKU-RUN-456'],
            sku_ids: ['SKU-RUN-456'],
          },
        ],
      };
      const runtime = new SalesAgentRuntime({
        registry: enabledReplenishRegistry,
        replenishment_policy: defaultReplenishmentPolicy,
        purchase_evidence: stalePurchaseEvidence,
      });
      const staleContext: HydratedContext = verifiedContext;
      const signal: SignalEnvelope = {
        ...validReplenishmentSignal,
        payload: {
          ...((validReplenishmentSignal.payload as Record<string, unknown>) ?? {}),
          purchase_evidence_stale: true,
        },
      };
      const hypothesis = await runtime.deriveHypothesis(signal, staleContext);
      expect(hypothesis.reasoning).toContain('purchase evidence missing or stale');

      const routing = await runtime.resolveRouting(signal, staleContext, hypothesis);
      expect(routing.requires_clarification).toBe(true);
      expect(routing.rationalization).toContain('purchase evidence missing or stale');
    });

    // Refusal Condition 2: No owner-approved replenishment interval
    it('refuses when no owner-approved replenishment interval is present (never invents one)', async () => {
      const runtime = new SalesAgentRuntime({
        registry: enabledReplenishRegistry,
        purchase_evidence: defaultPurchaseEvidence,
      });
      const signal: SignalEnvelope = {
        ...validReplenishmentSignal,
        payload: {
          prior_purchase_reference: 'ORD-PRIOR-999',
          // approved_interval_days omitted
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      expect(hypothesis.reasoning).toContain('no owner-approved replenishment interval');

      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.requires_clarification).toBe(true);
      expect(routing.rationalization).toContain('no owner-approved replenishment interval');
    });

    // Refusal Condition 3: Consent missing or withdrawn
    it('refuses when marketing consent is missing or withdrawn', async () => {
      const runtime = new SalesAgentRuntime({
        registry: enabledReplenishRegistry,
        replenishment_policy: defaultReplenishmentPolicy,
        purchase_evidence: defaultPurchaseEvidence,
      });
      const noConsentContext: HydratedContext = {
        ...verifiedContext,
        customer: {
          ...verifiedCustomer,
          consent_marketing: false,
        },
      };

      const hypothesis = await runtime.deriveHypothesis(validReplenishmentSignal, noConsentContext);
      expect(hypothesis.reasoning).toContain('consent missing or withdrawn');

      const routing = await runtime.resolveRouting(validReplenishmentSignal, noConsentContext, hypothesis);
      expect(routing.requires_clarification).toBe(true);
      expect(routing.rationalization).toContain('consent missing or withdrawn');
    });

    // Refusal Condition 4: Suppression active
    it('refuses when suppression is active', async () => {
      const runtime = new SalesAgentRuntime({
        registry: enabledReplenishRegistry,
        replenishment_policy: defaultReplenishmentPolicy,
        purchase_evidence: defaultPurchaseEvidence,
      });
      const suppressedContext: HydratedContext = {
        ...verifiedContext,
        customer: {
          ...verifiedCustomer,
          suppression_active: true,
        },
      };

      const hypothesis = await runtime.deriveHypothesis(validReplenishmentSignal, suppressedContext);
      expect(hypothesis.reasoning).toContain('suppression active');

      const routing = await runtime.resolveRouting(validReplenishmentSignal, suppressedContext, hypothesis);
      expect(routing.requires_clarification).toBe(true);
      expect(routing.rationalization).toContain('suppression active');
    });

    // Refusal Condition 5: Product inactive
    it('refuses when product is inactive', async () => {
      const inactiveProductRegistry = createRegistryPort({
        'skill.sales.retrieve_customer': {
          ...canonicalSalesRegistry['skill.sales.retrieve_customer']!,
          allowed_agents: ['SAL-01', 'SAL-02', 'SAL-03', 'SAL-04', 'SAL-05'],
          enabled: true,
        },
        'skill.sales.check_stock': {
          ...canonicalSalesRegistry['skill.sales.check_stock']!,
          allowed_agents: ['SAL-01', 'SAL-02', 'SAL-05'],
          enabled: true,
        },
        'skill.sales.check_price': {
          ...canonicalSalesRegistry['skill.sales.check_price']!,
          allowed_agents: ['SAL-02', 'SAL-04', 'SAL-05'],
          enabled: false,
        },
        'skill.sales.create_order': {
          ...canonicalSalesRegistry['skill.sales.create_order']!,
          enabled: true,
        },
        'skill.sales.send_message': {
          ...canonicalSalesRegistry['skill.sales.send_message']!,
          enabled: true,
        },
      });
      const runtime = new SalesAgentRuntime({
        registry: inactiveProductRegistry,
        replenishment_policy: defaultReplenishmentPolicy,
        purchase_evidence: defaultPurchaseEvidence,
      });
      const signal: SignalEnvelope = {
        ...validReplenishmentSignal,
        payload: {
          ...((validReplenishmentSignal.payload as Record<string, unknown>) ?? {}),
          product_active: false,
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      expect(hypothesis.reasoning).toContain('product inactive');

      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.requires_clarification).toBe(true);
      expect(routing.rationalization).toContain('product inactive');
    });

    // Refusal Condition 6: Stock unavailable
    it('refuses when stock is unavailable', async () => {
      const unavailableStockRegistry = createRegistryPort({
        'skill.sales.retrieve_customer': {
          ...canonicalSalesRegistry['skill.sales.retrieve_customer']!,
          allowed_agents: ['SAL-01', 'SAL-02', 'SAL-03', 'SAL-04', 'SAL-05'],
          enabled: true,
        },
        'skill.sales.check_stock': {
          ...canonicalSalesRegistry['skill.sales.check_stock']!,
          allowed_agents: ['SAL-01', 'SAL-02', 'SAL-05'],
          enabled: false,
        },
        'skill.sales.check_price': {
          ...canonicalSalesRegistry['skill.sales.check_price']!,
          allowed_agents: ['SAL-02', 'SAL-04', 'SAL-05'],
          enabled: true,
        },
        'skill.sales.create_order': {
          ...canonicalSalesRegistry['skill.sales.create_order']!,
          enabled: true,
        },
        'skill.sales.send_message': {
          ...canonicalSalesRegistry['skill.sales.send_message']!,
          enabled: true,
        },
      });
      const runtime = new SalesAgentRuntime({
        registry: unavailableStockRegistry,
        replenishment_policy: defaultReplenishmentPolicy,
        purchase_evidence: defaultPurchaseEvidence,
      });
      const signal: SignalEnvelope = {
        ...validReplenishmentSignal,
        payload: {
          ...((validReplenishmentSignal.payload as Record<string, unknown>) ?? {}),
          in_stock: false,
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      expect(hypothesis.reasoning).toContain('stock unavailable');

      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.requires_clarification).toBe(true);
      expect(routing.rationalization).toContain('stock unavailable');
    });

    // Refusal Condition 7: Recent purchase that invalidates reorder hypothesis
    it('refuses when a recent purchase invalidates the reorder hypothesis', async () => {
      const recentPurchaseEvidence: SalesPurchaseEvidencePort = {
        read: async () => [
          {
            order_id: 'ORD-PRIOR-999',
            order_date: '2026-08-28T00:00:00Z',
            items: ['SKU-RUN-456'],
            sku_ids: ['SKU-RUN-456'],
          },
        ],
      };
      const runtime = new SalesAgentRuntime({
        registry: enabledReplenishRegistry,
        replenishment_policy: defaultReplenishmentPolicy,
        purchase_evidence: recentPurchaseEvidence,
      });
      const recentPurchaseContext: HydratedContext = verifiedContext;
      const signal: SignalEnvelope = {
        ...validReplenishmentSignal,
        payload: {
          ...((validReplenishmentSignal.payload as Record<string, unknown>) ?? {}),
          recent_purchase_exists: true,
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, recentPurchaseContext);
      expect(hypothesis.reasoning).toContain('recent purchase invalidates reorder hypothesis');

      const routing = await runtime.resolveRouting(signal, recentPurchaseContext, hypothesis);
      expect(routing.requires_clarification).toBe(true);
      expect(routing.rationalization).toContain('recent purchase invalidates reorder hypothesis');
    });

    it('fails closed when takeover_active is true (no outbound steps planned)', async () => {
      const runtime = new SalesAgentRuntime({
        registry: enabledReplenishRegistry,
        replenishment_policy: defaultReplenishmentPolicy,
        purchase_evidence: defaultPurchaseEvidence,
      });
      const takenOverContext: HydratedContext = {
        ...verifiedContext,
        working_memory: {
          ...verifiedContext.working_memory,
          takeover_active: true,
        },
      };

      const hypothesis = await runtime.deriveHypothesis(validReplenishmentSignal, takenOverContext);
      const routing = await runtime.resolveRouting(validReplenishmentSignal, takenOverContext, hypothesis);
      const plan = await runtime.formulatePlan(routing, takenOverContext, hypothesis);

      expect(plan.steps).toHaveLength(0);
      expect(plan.fallback_strategy).toBe('FAIL_CLOSED');
    });

    it('refuses when payload asserts every favourable field but carries no authoritative purchase evidence and no owner-approved interval', async () => {
      const runtime = new SalesAgentRuntime({ registry: enabledReplenishRegistry });
      const spoofedSignal: SignalEnvelope = {
        ...validReplenishmentSignal,
        payload: {
          prior_purchase_reference: 'ORD-FAKE-999',
          sku_id: 'SKU-RUN-456',
          approved_interval_days: 30,
          replenishment_interval_days: 30,
          cycle_days: 30,
          reorder_interval_days: 30,
          purchase_evidence_stale: false,
          is_stale: false,
          evidence_stale: false,
          consent_marketing: true,
          suppression_active: false,
          product_active: true,
          is_active: true,
          product_status: 'ACTIVE',
          sku_status: 'ACTIVE',
          in_stock: true,
          repurchased_recently: false,
        },
      };
      const noEvidenceContext: HydratedContext = verifiedContext;

      const hypothesis = await runtime.deriveHypothesis(spoofedSignal, noEvidenceContext);
      expect(hypothesis.reasoning).toContain('purchase evidence missing or stale');
      const routing = await runtime.resolveRouting(spoofedSignal, noEvidenceContext, hypothesis);
      expect(routing.requires_clarification).toBe(true);
      const plan = await runtime.formulatePlan(routing, noEvidenceContext, hypothesis);
      expect(plan.steps).toHaveLength(0);
    });

    it('adversarial: payload claims approved interval but runtime policy is unbound -> still refused', async () => {
      const runtime = new SalesAgentRuntime({
        registry: enabledReplenishRegistry,
        purchase_evidence: defaultPurchaseEvidence,
      });
      const signal: SignalEnvelope = {
        ...validReplenishmentSignal,
        payload: {
          prior_purchase_reference: 'ORD-PRIOR-999',
          sku_id: 'SKU-RUN-456',
          approved_interval_days: 30,
          replenishment_interval_days: 30,
          cycle_days: 30,
          reorder_interval_days: 30,
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      expect(hypothesis.reasoning).toContain('no owner-approved replenishment interval');
      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.requires_clarification).toBe(true);
      expect(routing.rationalization).toContain('no owner-approved replenishment interval');
    });
    it('adversarial: payload claims recent_purchase_exists false while recent authoritative purchase exists -> refused', async () => {
      const recentPurchaseEvidence: SalesPurchaseEvidencePort = {
        read: async () => [
          {
            order_id: 'ORD-PRIOR-999',
            order_date: '2026-08-29T00:00:00Z',
            items: ['SKU-RUN-456'],
            sku_ids: ['SKU-RUN-456'],
          },
        ],
      };
      const runtime = new SalesAgentRuntime({
        registry: enabledReplenishRegistry,
        replenishment_policy: defaultReplenishmentPolicy,
        purchase_evidence: recentPurchaseEvidence,
      });
      const recentContext: HydratedContext = verifiedContext;
      const signal: SignalEnvelope = {
        ...validReplenishmentSignal,
        payload: {
          prior_purchase_reference: 'ORD-PRIOR-999',
          sku_id: 'SKU-RUN-456',
          recent_purchase_exists: false,
          recent_purchase: false,
          repurchased_recently: false,
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, recentContext);
      expect(hypothesis.reasoning).toContain('recent purchase invalidates reorder hypothesis');
      const routing = await runtime.resolveRouting(signal, recentContext, hypothesis);
      expect(routing.requires_clarification).toBe(true);
      expect(routing.rationalization).toContain('recent purchase invalidates reorder hypothesis');
    });

    it('adversarial: payload claims in_stock true while authoritative stock read is unreachable -> refused', async () => {
      const unreachableStockRegistry = createRegistryPort({
        'skill.sales.retrieve_customer': {
          ...canonicalSalesRegistry['skill.sales.retrieve_customer']!,
          allowed_agents: ['SAL-01', 'SAL-02', 'SAL-03', 'SAL-04', 'SAL-05'],
          enabled: true,
        },
        'skill.sales.check_stock': {
          ...canonicalSalesRegistry['skill.sales.check_stock']!,
          allowed_agents: ['SAL-01', 'SAL-02', 'SAL-05'],
          enabled: false,
        },
        'skill.sales.check_price': {
          ...canonicalSalesRegistry['skill.sales.check_price']!,
          allowed_agents: ['SAL-02', 'SAL-04', 'SAL-05'],
          enabled: true,
        },
        'skill.sales.send_message': {
          ...canonicalSalesRegistry['skill.sales.send_message']!,
          enabled: true,
        },
      });
      const runtime = new SalesAgentRuntime({
        registry: unreachableStockRegistry,
        replenishment_policy: defaultReplenishmentPolicy,
        purchase_evidence: defaultPurchaseEvidence,
      });
      const signal: SignalEnvelope = {
        ...validReplenishmentSignal,
        payload: {
          prior_purchase_reference: 'ORD-PRIOR-999',
          sku_id: 'SKU-RUN-456',
          in_stock: true,
          stock_available: true,
          available_quantity: 999,
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      expect(hypothesis.reasoning).toContain('stock unavailable');
      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.requires_clarification).toBe(true);
      expect(routing.rationalization).toContain('stock unavailable');
    });

    it('adversarial: payload claims unverified prior purchase reference -> refused', async () => {
      const runtime = new SalesAgentRuntime({
        registry: enabledReplenishRegistry,
        replenishment_policy: defaultReplenishmentPolicy,
        purchase_evidence: defaultPurchaseEvidence,
      });
      const signal: SignalEnvelope = {
        ...validReplenishmentSignal,
        payload: {
          prior_purchase_reference: 'ORD-ATTACKER-UNVERIFIED',
          sku_id: 'SKU-RUN-456',
        },
      };

      const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
      expect(hypothesis.reasoning).toContain('purchase evidence missing or stale');
      const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
      expect(routing.requires_clarification).toBe(true);
      expect(routing.rationalization).toContain('purchase evidence missing or stale');
    });

    it('adversarial: adverse payload fields do not override authoritative verified context and policy', async () => {
      const runtime = new SalesAgentRuntime({
        registry: enabledReplenishRegistry,
        replenishment_policy: defaultReplenishmentPolicy,
        purchase_evidence: defaultPurchaseEvidence,
      });
      const adversePayloadSignal: SignalEnvelope = {
        ...validReplenishmentSignal,
        payload: {
          prior_purchase_reference: 'ORD-PRIOR-999',
          sku_id: 'SKU-RUN-456',
          approved_interval_days: 9999,
          consent_marketing: false,
          suppression_active: true,
          product_active: false,
          in_stock: false,
          recent_purchase_exists: true,
          purchase_evidence_stale: true,
        },
      };

      const hypothesis = await runtime.deriveHypothesis(adversePayloadSignal, verifiedContext);
      expect(hypothesis.intent).toBe('replenishment');
      expect(hypothesis.reasoning).toContain('succeeded');

      const routing = await runtime.resolveRouting(adversePayloadSignal, verifiedContext, hypothesis);
      expect(routing.target_agent).toBe('SAL-05');
      expect(routing.requires_clarification).toBe(false);

      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(plan.steps.length).toBeGreaterThan(0);
    });

    it('adversarial: valid purchase reference but unbought SKU -> refused', async () => {
      const runtime = new SalesAgentRuntime({
        registry: enabledReplenishRegistry,
        replenishment_policy: defaultReplenishmentPolicy,
        purchase_evidence: defaultPurchaseEvidence,
      });
      const unboughtSkuSignal: SignalEnvelope = {
        ...validReplenishmentSignal,
        payload: {
          prior_purchase_reference: 'ORD-PRIOR-999',
          sku_id: 'SKU-UNBOUGHT-999',
          approved_interval_days: 30,
        },
      };

      const hypothesis = await runtime.deriveHypothesis(unboughtSkuSignal, verifiedContext);
      expect(hypothesis.reasoning).toContain('purchase evidence missing or stale');

      const routing = await runtime.resolveRouting(unboughtSkuSignal, verifiedContext, hypothesis);
      expect(routing.requires_clarification).toBe(true);
      expect(routing.rationalization).toContain('purchase evidence missing or stale');

      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(plan.steps).toHaveLength(0);
      expect(plan.fallback_strategy).toBe('FAIL_CLOSED');
    });

    it('uses authoritative SKU in plan steps when prior purchase is verified', async () => {
      const runtime = new SalesAgentRuntime({
        registry: enabledReplenishRegistry,
        replenishment_policy: defaultReplenishmentPolicy,
        purchase_evidence: defaultPurchaseEvidence,
      });
      const verifiedSkuSignal: SignalEnvelope = {
        ...validReplenishmentSignal,
        payload: {
          prior_purchase_reference: 'ORD-PRIOR-999',
          sku_id: 'SKU-RUN-456',
          approved_interval_days: 30,
        },
      };

      const hypothesis = await runtime.deriveHypothesis(verifiedSkuSignal, verifiedContext);
      expect(hypothesis.intent).toBe('replenishment');
      expect(hypothesis.reasoning).toContain('succeeded');

      const routing = await runtime.resolveRouting(verifiedSkuSignal, verifiedContext, hypothesis);
      expect(routing.target_agent).toBe('SAL-05');
      expect(routing.requires_clarification).toBe(false);

      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(plan.steps.length).toBeGreaterThan(0);

      for (const step of plan.steps) {
        if ('sku_id' in step.input_parameters) {
          expect(step.input_parameters.sku_id).toBe('SKU-RUN-456');
          expect(step.input_parameters.sku_id).not.toBe('UNKNOWN');
        }
      }
    });

    it('refuses replenishment and plans no message step when consent authority skill.sales.retrieve_customer is disabled', async () => {
      const disabledConsentReplenishRegistry = createRegistryPort({
        'skill.sales.retrieve_customer': {
          ...canonicalSalesRegistry['skill.sales.retrieve_customer']!,
          allowed_agents: ['SAL-01', 'SAL-02', 'SAL-03', 'SAL-04', 'SAL-05'],
          enabled: false,
        },
        'skill.sales.check_stock': {
          ...canonicalSalesRegistry['skill.sales.check_stock']!,
          allowed_agents: ['SAL-01', 'SAL-02', 'SAL-05'],
          enabled: true,
        },
        'skill.sales.check_price': {
          ...canonicalSalesRegistry['skill.sales.check_price']!,
          allowed_agents: ['SAL-02', 'SAL-04', 'SAL-05'],
          enabled: true,
        },
        'skill.sales.send_message': {
          ...canonicalSalesRegistry['skill.sales.send_message']!,
          enabled: true,
        },
      });
      const runtime = new SalesAgentRuntime({
        registry: disabledConsentReplenishRegistry,
        replenishment_policy: defaultReplenishmentPolicy,
        purchase_evidence: defaultPurchaseEvidence,
      });

      const hypothesis = await runtime.deriveHypothesis(validReplenishmentSignal, verifiedContext);
      expect(hypothesis.reasoning).toContain('skill.sales.retrieve_customer');

      const routing = await runtime.resolveRouting(validReplenishmentSignal, verifiedContext, hypothesis);
      expect(routing.requires_clarification).toBe(true);
      expect(routing.clarification_prompt).toContain('skill.sales.retrieve_customer');

      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(plan.steps).toHaveLength(0);
      expect(plan.fallback_strategy).toBe('FAIL_CLOSED');
      expect(plan.steps.some((s) => s.skill_id === 'skill.sales.send_message')).toBe(false);
    });

    it('refuses replenishment when outbound channel is missing from session context (never defaults to EMAIL)', async () => {
      const runtime = new SalesAgentRuntime({
        registry: enabledReplenishRegistry,
        replenishment_policy: defaultReplenishmentPolicy,
        purchase_evidence: defaultPurchaseEvidence,
      });
      const noChannelContext: HydratedContext = {
        ...verifiedContext,
        working_memory: {
          ...verifiedContext.working_memory,
          last_touch_channel: '',
        },
      };

      const hypothesis = await runtime.deriveHypothesis(validReplenishmentSignal, noChannelContext);
      expect(hypothesis.reasoning).toContain('outbound channel missing');

      const routing = await runtime.resolveRouting(validReplenishmentSignal, noChannelContext, hypothesis);
      expect(routing.requires_clarification).toBe(true);
      expect(routing.clarification_prompt).toContain('outbound channel');

      const plan = await runtime.formulatePlan(routing, noChannelContext, hypothesis);
      expect(plan.steps).toHaveLength(0);
      expect(plan.fallback_strategy).toBe('FAIL_CLOSED');
    });
  });

  describe('Dependency Reachability Guard on isRowExecutable', () => {
    it('refuses plan step when skill row dependency is not resolvable', async () => {
      const runtime = new SalesAgentRuntime({
        registry: createRegistryPort(),
        resolvableDependencies: ['PostgreSQL.Customer360Store'], // API-001.CatalogConnector not included
      });
      const signal: SignalEnvelope = {
        signal_id: 'sig-unresolvable-dep',
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
  });
});
