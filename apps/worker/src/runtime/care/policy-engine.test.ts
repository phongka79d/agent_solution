import { describe, expect, it } from 'vitest';
import type { ActionDraft, Customer360Fact, HydratedContext } from '@agentos/core-engine/contracts';
import { OrchestratorError } from '@agentos/core-engine/contracts';

import { createCarePolicyEngine } from './factory.js';

describe('CarePolicyEngine', () => {
  const tenant_id = '00000000-0000-4000-8000-000000000001';

  const verifiedCustomer: Customer360Fact = {
    customer_id: 'cust-42',
    tenant_id,
    verified_phone: '+15551234567',
    verified_email: 'customer@example.com',
    total_spent: 200,
    order_count: 2,
    rfm_segment_hypothesis: 'REGULAR',
    consent_marketing: true,
    consent_updated_at: '2026-09-01T00:00:00Z',
    suppression_active: false,
    created_at: '2026-09-01T00:00:00Z',
  };

  const context: HydratedContext = {
    correlation_id: 'corr-test',
    tenant_id,
    customer: verifiedCustomer,
    working_memory: {
      session_id: 'sess-test',
      last_touch_channel: 'web',
      turn_count: 1,
      takeover_active: false,
    },
    knowledge_citations: [],
    hydrated_at: '2026-09-01T00:00:00Z',
  };

  const engine = createCarePolicyEngine();

  describe('validateAction', () => {
    it('normalizes valid action payload against registered skill schema', async () => {
      const action: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000010',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'CS-01',
        skill_id: 'skill.care.lookup_order',
        adapter_target: 'API-001',
        step_index: 0,
        mutating: false,
        price_bearing: false,
        request_id: 'req-1',
        action_revision: 0,
        effect_key: 'eff-1',
        required_authority: 'AUTH-1',
        payload: {
          order_id: 'ORD-123',
          customer_id: 'cust-42',
          verification_reference: 'cust-42',
          verification_status: 'VERIFIED',
        },
      };

      const validated = await engine.validateAction(action, context);
      expect(validated.skill_id).toBe('skill.care.lookup_order');
    });

    it('rejects action with unknown fields in payload', async () => {
      const action: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000011',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'CS-01',
        skill_id: 'skill.care.lookup_order',
        adapter_target: 'API-001',
        step_index: 0,
        mutating: false,
        price_bearing: false,
        request_id: 'req-1',
        action_revision: 0,
        effect_key: 'eff-1',
        required_authority: 'AUTH-1',
        payload: {
          order_id: 'ORD-123',
          customer_id: 'cust-42',
          // Unknown field injected into payload
          unauthorized_admin_override: true,
        },
      };

      await expect(engine.validateAction(action, context)).rejects.toThrow(OrchestratorError);
      await expect(engine.validateAction(action, context)).rejects.toMatchObject({
        code: 'POLICY_INPUT_INVALID',
      });
    });

    it('rejects cross-tenant assertion', async () => {
      const action: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000012',
        run_id: 'run-1',
        tenant_id: '00000000-0000-4000-8000-999999999999', // Mismatched tenant
        agent_id: 'CS-01',
        skill_id: 'skill.care.lookup_order',
        adapter_target: 'API-001',
        step_index: 0,
        mutating: false,
        price_bearing: false,
        request_id: 'req-1',
        action_revision: 0,
        effect_key: 'eff-1',
        required_authority: 'AUTH-1',
        payload: {
          order_id: 'ORD-123',
          customer_id: 'cust-42',
        },
      };

      await expect(engine.validateAction(action, context)).rejects.toThrow(OrchestratorError);
      await expect(engine.validateAction(action, context)).rejects.toMatchObject({
        code: 'CROSS_TENANT_ASSERTION',
      });
    });

    it('rejects lookup_order on unverified customer', async () => {
      const unverifiedContext: HydratedContext = {
        ...context,
        customer: null,
      };

      const action: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000013',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'CS-01',
        skill_id: 'skill.care.lookup_order',
        adapter_target: 'API-001',
        step_index: 0,
        mutating: false,
        price_bearing: false,
        request_id: 'req-1',
        action_revision: 0,
        effect_key: 'eff-1',
        required_authority: 'AUTH-1',
        payload: {
          order_id: 'ORD-123',
          customer_id: 'cust-42',
        },
      };

      await expect(engine.validateAction(action, unverifiedContext)).rejects.toThrow(OrchestratorError);
      await expect(engine.validateAction(action, unverifiedContext)).rejects.toMatchObject({
        code: 'IDENTITY_UNVERIFIED',
      });
    });

    it('normalizes valid escalate_to_human action payload against canonical schema', async () => {
      const action: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000014',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'CS-01',
        skill_id: 'skill.care.escalate_to_human',
        adapter_target: 'Orchestrator.HandoffBus',
        step_index: 1,
        mutating: true,
        price_bearing: false,
        request_id: 'req-1',
        action_revision: 0,
        effect_key: 'eff-1',
        required_authority: 'AUTH-3',
        payload: {
          tenant_id,
          session_id: 'sess-1',
          conversation_id: 'conv-1',
          customer_id: 'cust-42',
          escalation_reason: 'customer_complaint',
          summary_context: 'Product damaged in transit',
          effect_key: 'eff-1',
        },
      };

      const validated = await engine.validateAction(action, context);
      expect(validated.skill_id).toBe('skill.care.escalate_to_human');
      expect(validated.payload).toEqual(action.payload);
    });

    it('rejects escalate_to_human action with actually unknown fields in payload', async () => {
      const action: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000015',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'CS-01',
        skill_id: 'skill.care.escalate_to_human',
        adapter_target: 'Orchestrator.HandoffBus',
        step_index: 1,
        mutating: true,
        price_bearing: false,
        request_id: 'req-1',
        action_revision: 0,
        effect_key: 'eff-1',
        required_authority: 'AUTH-3',
        payload: {
          tenant_id,
          session_id: 'sess-1',
          conversation_id: 'conv-1',
          escalation_reason: 'customer_complaint',
          unauthorized_extra_field: 'illegal',
        },
      };

      await expect(engine.validateAction(action, context)).rejects.toThrow(OrchestratorError);
      await expect(engine.validateAction(action, context)).rejects.toMatchObject({
        code: 'POLICY_INPUT_INVALID',
      });
    });

    it('rejects escalate_to_human action with cross-customer assertion', async () => {
      const action: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000016',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'CS-01',
        skill_id: 'skill.care.escalate_to_human',
        adapter_target: 'Orchestrator.HandoffBus',
        step_index: 1,
        mutating: true,
        price_bearing: false,
        request_id: 'req-1',
        action_revision: 0,
        effect_key: 'eff-1',
        required_authority: 'AUTH-3',
        payload: {
          tenant_id,
          session_id: 'sess-1',
          conversation_id: 'conv-1',
          customer_id: 'cust-mismatch-999',
          escalation_reason: 'customer_complaint',
        },
      };

      await expect(engine.validateAction(action, context)).rejects.toThrow(OrchestratorError);
      await expect(engine.validateAction(action, context)).rejects.toMatchObject({
        code: 'CROSS_CUSTOMER_ASSERTION',
      });
    });

    it('rejects action with payload cross-tenant assertion', async () => {
      const action: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000017',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'CS-01',
        skill_id: 'skill.care.escalate_to_human',
        adapter_target: 'Orchestrator.HandoffBus',
        step_index: 1,
        mutating: true,
        price_bearing: false,
        request_id: 'req-1',
        action_revision: 0,
        effect_key: 'eff-1',
        required_authority: 'AUTH-3',
        payload: {
          tenant_id: '00000000-0000-4000-8000-999999999999',
          session_id: 'sess-1',
          conversation_id: 'conv-1',
          escalation_reason: 'customer_complaint',
        },
      };

      await expect(engine.validateAction(action, context)).rejects.toThrow(OrchestratorError);
      await expect(engine.validateAction(action, context)).rejects.toMatchObject({
        code: 'CROSS_TENANT_ASSERTION',
      });
    });
  });

  describe('evaluateAuthority', () => {
    it('returns AUTO_APPROVED when assigned authority meets required authority', async () => {
      const action: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000020',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'CS-01', // CS-01 has AUTH-2
        skill_id: 'skill.care.lookup_order',
        adapter_target: 'API-001',
        step_index: 0,
        mutating: false,
        price_bearing: false,
        request_id: 'req-1',
        action_revision: 0,
        effect_key: 'eff-1',
        required_authority: 'AUTH-1', // AUTH-1 <= AUTH-2
        payload: {
          order_id: 'ORD-123',
          customer_id: 'cust-42',
        },
      };

      const result = await engine.evaluateAuthority(action, context);
      expect(result.verdict).toBe('AUTO_APPROVED');
    });

    it('returns DENIED for AUTH-5 required authority (prohibited action)', async () => {
      const action: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000021',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'CS-01',
        skill_id: 'skill.care.lookup_order',
        adapter_target: 'API-001',
        step_index: 0,
        mutating: false,
        price_bearing: false,
        request_id: 'req-1',
        action_revision: 0,
        effect_key: 'eff-1',
        required_authority: 'AUTH-5',
        payload: {
          order_id: 'ORD-123',
        },
      };

      const result = await engine.evaluateAuthority(action, context);
      expect(result.verdict).toBe('DENIED');
      expect(result.reason).toContain('AUTH-5');
    });

    it('returns DENIED with HUMAN_TAKEOVER when takeover is active and action is mutating', async () => {
      const takeoverContext: HydratedContext = {
        ...context,
        working_memory: {
          ...context.working_memory,
          takeover_active: true,
        },
      };

      const mutatingAction: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000022',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'CS-01',
        skill_id: 'skill.care.lookup_order',
        adapter_target: 'API-001',
        step_index: 0,
        mutating: true,
        price_bearing: false,
        request_id: 'req-1',
        action_revision: 0,
        effect_key: 'eff-1',
        required_authority: 'AUTH-1',
        payload: {
          order_id: 'ORD-123',
        },
      };

      const result = await engine.evaluateAuthority(mutatingAction, takeoverContext);
      expect(result.verdict).toBe('DENIED');
      expect(result.reason).toContain('HUMAN_TAKEOVER');
    });
  });
});
