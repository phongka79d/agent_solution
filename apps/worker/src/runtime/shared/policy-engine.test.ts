import { describe, expect, it } from 'vitest';

import type { ActionDraft, Customer360Fact, HydratedContext } from '@agentos/core-engine/contracts';
import { SALES_ALLOWED_PAYLOAD_FIELDS, SALES_SKILLS } from '../sales/policy-engine.js';
import { DomainPolicyEngine } from './policy-engine.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const CUSTOMER: Customer360Fact = {
  customer_id: 'customer-1',
  tenant_id: TENANT_ID,
  verified_phone: '+15551234567',
  verified_email: 'customer@example.com',
  total_spent: 0,
  order_count: 0,
  rfm_segment_hypothesis: 'REGULAR',
  consent_marketing: true,
  consent_updated_at: '2026-09-01T00:00:00Z',
  suppression_active: false,
  created_at: '2026-09-01T00:00:00Z',
};
const CONTEXT: HydratedContext = {
  correlation_id: 'corr-auth4-test',
  tenant_id: TENANT_ID,
  customer: CUSTOMER,
  working_memory: {
    session_id: 'session-1',
    last_touch_channel: 'web',
    turn_count: 1,
    takeover_active: false,
  },
  knowledge_citations: [],
  hydrated_at: '2026-09-01T00:00:00Z',
};

const AUTH4_ACTION: ActionDraft = {
  action_id: '00000000-0000-4000-8000-000000000010',
  run_id: 'run-auth4-test',
  tenant_id: TENANT_ID,
  agent_id: 'SAL-02',
  skill_id: 'skill.sales.create_order',
  adapter_target: 'API-002.CommerceOrderAPI',
  step_index: 0,
  mutating: true,
  price_bearing: false,
  request_id: 'request-auth4-test',
  action_revision: 0,
  effect_key: 'effect-auth4-test',
  required_authority: 'AUTH-4',
  payload: {
    tenant_id: TENANT_ID,
    customer_id: CUSTOMER.customer_id,
    effect_key: 'effect-auth4-test',
  },
};

describe('DomainPolicyEngine approvals', () => {
  it('keeps AUTH-4 approval-required and emits no ticket id when no approvals port is bound', async () => {
    const auditRecords: Array<{ readonly approval_id: string | null }> = [];
    const engine = new DomainPolicyEngine({
      skills: SALES_SKILLS,
      allowed_payload_fields: SALES_ALLOWED_PAYLOAD_FIELDS,
      resolveGrant: async () => 'AUTH-3',
      audit: {
        append: async (record) => {
          auditRecords.push(record);
        },
      },
      auditSecret: 'auth4-test-secret',
    });

    const result = await engine.evaluateAuthority(AUTH4_ACTION, CONTEXT);

    expect(result.verdict).toBe('AWAITING_HUMAN_APPROVAL');
    expect(result).not.toHaveProperty('approval_id');
    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0]?.approval_id).toBeNull();
  });
});
