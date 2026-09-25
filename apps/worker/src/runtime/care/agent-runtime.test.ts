import { describe, expect, it } from 'vitest';
import type {
  Customer360Fact,
  HydratedContext,
  SignalEnvelope,
} from '@agentos/core-engine/contracts';

import {
  CareAgentRuntime,
  type SkillRegistryPort,
} from './agent-runtime.js';

describe('CareAgentRuntime', () => {
  const tenant_id = '00000000-0000-4000-8000-000000000001';

  const verifiedCustomer: Customer360Fact = {
    customer_id: 'cust-verified-42',
    tenant_id,
    verified_phone: '+15550001111',
    verified_email: 'verified@example.com',
    total_spent: 500,
    order_count: 5,
    rfm_segment_hypothesis: 'LOYAL',
    consent_marketing: true,
    consent_updated_at: '2026-09-01T00:00:00Z',
    suppression_active: false,
    created_at: '2026-09-01T00:00:00Z',
  };

  const verifiedContext: HydratedContext = {
    correlation_id: 'corr-1',
    tenant_id,
    customer: verifiedCustomer,
    working_memory: {
      session_id: 'sess-1',
      conversation_id: '33333333-3333-4333-8333-333333333333',
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

  const mockRegistry: SkillRegistryPort = {
    get(skill_id: string) {
      if (skill_id === 'skill.care.lookup_order') {
        return {
          skill_id: 'skill.care.lookup_order',
          effect_class: 'READ',
          guarded_dependency: 'API-001.OrderConnector',
          required_authority: 'AUTH-0',
          timeout_ms: 2000,
        };
      }
      if (skill_id === 'skill.care.search_faq') {
        return {
          skill_id: 'skill.care.search_faq',
          effect_class: 'READ',
          guarded_dependency: 'SecondBrain.FAQEngine',
          required_authority: 'AUTH-0',
          timeout_ms: 1500,
        };
      }
      if (skill_id === 'skill.care.escalate_to_human') {
        return {
          skill_id: 'skill.care.escalate_to_human',
          effect_class: 'INTERNAL',
          guarded_dependency: 'Orchestrator.HandoffBus',
          required_authority: 'AUTH-3',
          timeout_ms: 1000,
        };
      }
      return null;
    },
  };

  const verificationResolver = (correlation_id: string): string | null => {
    if (correlation_id === 'corr-1') {
      return 'identity-row-verified-42';
    }
    return null;
  };

  const runtime = new CareAgentRuntime({
    registry: mockRegistry,
    verificationResolver,
  });

  it('yields lookup_order plan with server-resolved identity fields for verified order request', async () => {
    const signal: SignalEnvelope = {
      signal_id: 'sig-order-1',
      tenant_id,
      correlation_id: 'corr-1',
      source_channel: 'WEB_CHAT',
      event_type: 'message.received',
      timestamp: '2026-09-01T00:00:00Z',
      subject: {
        session_id: 'sess-1',
        channel_type: 'web',
      },
      payload: {
        message: 'Where is my order ORD-987654? Please check status.',
        module: 'support',
        // Untrusted message tries to inject a fake customer_id
        customer_id: 'malicious-attacker-id',
      },
    };

    const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
    expect(hypothesis.classification).toBe('HYPOTHESIS');
    expect(hypothesis.intent).toBe('order_lookup');
    expect(hypothesis.confidence).toBe(0.95);
    expect(hypothesis.derived_from_signals).toContain('sig-order-1');

    const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
    expect(routing.target_agent).toBe('CS-01');
    expect(routing.requires_clarification).toBe(false);
    expect(routing.rationalization).toBeTruthy();

    const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
    expect(plan.steps).toHaveLength(1);
    const step = plan.steps[0]!;
    expect(step.step_index).toBe(1);
    expect(step.agent_id).toBe('CS-01');
    expect(step.skill_id).toBe('skill.care.lookup_order');
    expect(step.adapter_target).toBe('API-001.OrderConnector');
    expect(step.required_authority).toBe('AUTH-0');
    expect(step.timeout_ms).toBe(2000);
    expect(step.mutating).toBe(false);
    expect(step.idempotent).toBe(true);
    expect(step.price_bearing).toBe(false);
    expect(step.depends_on_steps).toEqual([]);

    // Resolved SERVER-SIDE, NOT echoed from signal payload
    expect(step.input_parameters.order_identifier).toBe('ORD-987654');
    expect(step.input_parameters.customer_id).toBe('cust-verified-42');
    expect(step.input_parameters.verification_reference).toBe('identity-row-verified-42');
    expect(step.input_parameters.verification_status).toBe('VERIFIED');
    expect(step.input_parameters).not.toHaveProperty('tenant_id');

    expect(plan.fallback_strategy).toBe('FAIL_CLOSED');
  });

  it('yields search_faq plan for general question with no order reference', async () => {
    const signal: SignalEnvelope = {
      signal_id: 'sig-faq-1',
      tenant_id,
      correlation_id: 'corr-1',
      source_channel: 'WEB_CHAT',
      event_type: 'message.received',
      timestamp: '2026-09-01T00:00:00Z',
      subject: {
        session_id: 'sess-1',
        channel_type: 'web',
      },
      payload: {
        message: 'What is your refund and return policy for international orders?',
        module: 'support',
      },
    };

    const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
    expect(hypothesis.classification).toBe('HYPOTHESIS');
    expect(hypothesis.intent).toBe('faq_search');

    const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
    expect(routing.target_agent).toBe('CS-01');
    expect(routing.requires_clarification).toBe(false);

    const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
    expect(plan.steps).toHaveLength(1);
    const step = plan.steps[0]!;
    expect(step.step_index).toBe(1);
    expect(step.agent_id).toBe('CS-01');
    expect(step.skill_id).toBe('skill.care.search_faq');
    expect(step.adapter_target).toBe('SecondBrain.FAQEngine');
    expect(step.required_authority).toBe('AUTH-0');
    expect(step.timeout_ms).toBe(1500);
    expect(step.mutating).toBe(false);
    expect(step.idempotent).toBe(true);
    expect(step.price_bearing).toBe(false);
    expect(step.depends_on_steps).toEqual([]);
    expect(step.input_parameters.query_text).toContain('refund and return policy');
    expect(plan.fallback_strategy).toBe('FAIL_CLOSED');
  });

  it('refuses order-status intent on unverified session with NO plan', async () => {
    const signal: SignalEnvelope = {
      signal_id: 'sig-order-unverified',
      tenant_id,
      correlation_id: 'corr-1',
      source_channel: 'WEB_CHAT',
      event_type: 'message.received',
      timestamp: '2026-09-01T00:00:00Z',
      subject: {
        session_id: 'sess-1',
        channel_type: 'web',
      },
      payload: {
        message: 'Can you check status on order #554433?',
        module: 'support',
      },
    };

    const hypothesis = await runtime.deriveHypothesis(signal, unverifiedContext);
    expect(hypothesis.intent).toBe('order_lookup_unverified');

    const routing = await runtime.resolveRouting(signal, unverifiedContext, hypothesis);
    expect(routing.target_agent).toBe('CS-01');
    expect(routing.requires_clarification).toBe(true);
    expect(routing.clarification_prompt).toBeTruthy();

    const plan = await runtime.formulatePlan(routing, unverifiedContext, hypothesis);
    expect(plan.steps).toHaveLength(0);
    expect(plan.fallback_strategy).toBe('FAIL_CLOSED');
  });

  it('refuses order-status intent without a verified identity reference with NO plan', async () => {
    const signal: SignalEnvelope = {
      signal_id: 'sig-order-unbound',
      tenant_id,
      correlation_id: 'corr-unbound',
      source_channel: 'WEB_CHAT',
      event_type: 'message.received',
      timestamp: '2026-09-01T00:00:00Z',
      subject: {
        session_id: 'sess-unbound',
        channel_type: 'web',
      },
      payload: {
        message: 'Can you check status on order ORD-12345?',
        module: 'support',
      },
    };

    const unboundContext: HydratedContext = {
      ...verifiedContext,
      correlation_id: 'corr-unbound',
    };

    const hypothesis = await runtime.deriveHypothesis(signal, unboundContext);
    expect(hypothesis.intent).toBe('order_lookup');

    const routing = await runtime.resolveRouting(signal, unboundContext, hypothesis);
    // Even if routing were direct, formulation refuses plan because verification reference is missing
    const plan = await runtime.formulatePlan(routing, unboundContext, hypothesis);
    expect(plan.steps).toHaveLength(0);
    expect(plan.fallback_strategy).toBe('FAIL_CLOSED');
  });

  it('refuses unsupported intent or clarification-required message with NO plan', async () => {
    const signal: SignalEnvelope = {
      signal_id: 'sig-gibberish',
      tenant_id,
      correlation_id: 'corr-1',
      source_channel: 'WEB_CHAT',
      event_type: 'message.received',
      timestamp: '2026-09-01T00:00:00Z',
      subject: {
        session_id: 'sess-1',
        channel_type: 'web',
      },
      payload: {
        message: 'hello there abcdef 12345',
        module: 'support',
      },
    };

    const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
    expect(hypothesis.intent).toBe('requires_clarification');

    const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
    expect(routing.target_agent).toBe('CS-01');
    expect(routing.requires_clarification).toBe(true);
    expect(routing.clarification_prompt).toBeTruthy();

    const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
    expect(plan.steps).toHaveLength(0);
    expect(plan.fallback_strategy).toBe('FAIL_CLOSED');
  });


  it.each([
    ['product info', 'Is this bag waterproof?', 'product_info', 'skill.care.search_faq'],
    ['price', 'How much is the listed price?', 'price', 'skill.care.search_faq'],
    ['stock', 'Is this item in stock?', 'stock', 'skill.care.search_faq'],
    ['order status', 'Where is my order ORD-12345?', 'order_lookup', 'skill.care.lookup_order'],
    ['shipping', 'Can you check shipping for tracking AB-12345?', 'shipping', 'skill.care.search_faq'],
    ['return policy', 'What is your return and refund policy?', 'faq_search', 'skill.care.search_faq'],
    ['return execution', 'I want to return this item and get my money back.', 'return_refund', 'skill.care.search_faq'],
    ['payment issue', 'I was charged twice for the same order.', 'payment', 'skill.care.search_faq'],
    ['complaint', 'My parcel arrived damaged and this is unacceptable.', 'complaint', 'HUMAN_HANDOFF'],
    ['usage support', 'How do I activate the warranty?', 'usage', 'skill.care.search_faq'],
    ['human request', 'I want to talk to a human agent.', 'human_escalation', 'HUMAN_HANDOFF']
  ])('classifies %s and uses only its permitted route', async (_name, message, expectedIntent, expectedTarget) => {
    const signal: SignalEnvelope = {
      signal_id: `sig-${String(expectedIntent)}`,
      tenant_id,
      correlation_id: 'corr-1',
      source_channel: 'WEB_CHAT',
      event_type: 'message.received',
      timestamp: '2026-09-01T00:00:00Z',
      subject: { session_id: 'sess-1', channel_type: 'web' },
      payload: { message },
    };
    const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
    expect(hypothesis.classification).toBe('HYPOTHESIS');
    expect(hypothesis.intent).toBe(expectedIntent);

    const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
    expect(routing.target_agent).toBe(expectedTarget === 'HUMAN_HANDOFF' ? 'HUMAN_HANDOFF' : 'CS-01');
    if (expectedTarget === 'HUMAN_HANDOFF') {
      expect(routing.requires_clarification).toBe(false);
      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(plan.steps.map((step) => step.skill_id)).toEqual(['skill.care.escalate_to_human']);
      expect(plan.steps[0]?.input_parameters).toMatchObject({
        tenant_id,
        session_id: 'sess-1',
        conversation_id: '33333333-3333-4333-8333-333333333333',
      });

      const unboundMemory = { ...verifiedContext.working_memory };
      delete unboundMemory.conversation_id;
      const unboundPlan = await runtime.formulatePlan(routing, {
        ...verifiedContext,
        working_memory: unboundMemory,
      }, hypothesis);
      expect(unboundPlan.steps).toEqual([]);
      expect(unboundPlan.fallback_strategy).toBe('FAIL_CLOSED');
    } else {
      expect(routing.requires_clarification).toBe(false);
      const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
      expect(plan.steps.map((step) => step.skill_id)).toEqual([expectedTarget]);
    }
  });
  it('refuses plan generation with empty steps when registry row is missing', async () => {
    const emptyRuntime = new CareAgentRuntime({
      registry: { get: () => null },
      verificationResolver,
    });

    const signal: SignalEnvelope = {
      signal_id: 'sig-order-1',
      tenant_id,
      correlation_id: 'corr-1',
      source_channel: 'WEB_CHAT',
      event_type: 'message.received',
      timestamp: '2026-09-01T00:00:00Z',
      subject: {
        session_id: 'sess-1',
        channel_type: 'web',
      },
      payload: {
        message: 'Where is my order ORD-987654? Please check status.',
        module: 'support',
      },
    };

    const hypothesis = await emptyRuntime.deriveHypothesis(signal, verifiedContext);
    const routing = await emptyRuntime.resolveRouting(signal, verifiedContext, hypothesis);
    const plan = await emptyRuntime.formulatePlan(routing, verifiedContext, hypothesis);

    expect(plan.steps).toHaveLength(0);
    expect(plan.fallback_strategy).toBe('FAIL_CLOSED');
  });
});
