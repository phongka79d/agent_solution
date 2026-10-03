import type { ExecutionReceipt, HydratedContext, ImmutableEvidenceRecord } from '@agentos/core-engine/contracts';
import { ErpRefusalError } from '@agentos/adapters';

import { describe, expect, it, vi } from 'vitest';
import type { SkillToolInvocation } from '@agentos/skills';

import type { ErpReadPort } from '../../connectors.js';
import { handleOrderConnector } from './order-handler.js';
import { VerifiedResponseFinalizer } from '../../shared/response.js';


const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const CUSTOMER_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const VERIFICATION_REFERENCE = 'verification-ref';

const IDENTITY = {
  id: VERIFICATION_REFERENCE,
  customer_id: CUSTOMER_ID,
  verified_at: new Date('2026-01-01T00:00:00Z'),
};

function invocation(status: string): SkillToolInvocation<unknown> {
  return {
    skill_id: 'skill.care.lookup_order',
    tool_binding: 'API-001.OrderConnector',
    input: {
      tenant_id: TENANT_ID,
      order_identifier: 'ORD-1',
      customer_id: CUSTOMER_ID,
      verification_reference: VERIFICATION_REFERENCE,
      verification_status: 'VERIFIED',
      status,
    },
    context: {
      run_id: 'run-1',
      tenant_id: TENANT_ID,
      correlation_id: 'corr-1',
      caller_agent: 'CS-01',
      granted_authority: 'AUTH-0',
      effect_key: '0'.repeat(64),
    },
  };
}

function erpRead(status: string): ErpReadPort {
  return {
    read: vi.fn().mockResolvedValue({
      resource: 'orders',
      observed_at: '2026-01-04T10:00:00Z',
      tenant_id: TENANT_ID,
      value: {
        order_id: 'ORD-1',
        customer_id: CUSTOMER_ID,
        status,
        total_price: 100,
        currency: 'TWD',
        order_date: '2026-01-05T14:30:00Z',
        line_items: [
          {
            sku_id: 'SKU-1',
            product_name: 'Standard Widget',
            quantity: 1,
            unit_price: 100,
            currency: 'TWD',
          },
        ],
      },
    }),
  };
}

describe('handleOrderConnector ERP status mapping', () => {
  it.each([
    ['SHIPPED', 'SHIPPED'],
    ['FULFILLED', 'SHIPPED'],
    ['DELIVERED', 'DELIVERED'],
    ['PAID', 'PROCESSING'],
    ['CONFIRMED', 'PROCESSING'],
    ['PENDING', 'PENDING'],
    ['PROCESSING', 'PROCESSING'],
    ['CANCELLED', 'CANCELLED'],
    ['CANCELED', 'CANCELLED'],
    ['RETURNED', 'RETURNED'],
  ] as const)('maps ERP %s to %s', async (erpStatus, expectedStatus) => {
    const output = await handleOrderConnector<{ status: string }>(
      invocation(erpStatus),
      erpRead(erpStatus),
      async () => IDENTITY,
    );

    expect(output.status).toBe(expectedStatus);
  });
  it('projects a PAID order through the handler receipt and verified response finalizer', async () => {
    const output = await handleOrderConnector<Record<string, unknown>>(
      invocation('PAID'),
      erpRead('PAID'),
      async () => IDENTITY,
    );
    const receipt: ExecutionReceipt = {
      execution_id: 'execution-order-1',
      adapter_status: 'SUCCESS',
      provider_reference: 'provider-order-1',
      response_payload: output,
      latency_ms: 10,
      token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
    };
    const evidence: ImmutableEvidenceRecord = {
      evidence_id: 'evidence-order-1',
      run_id: 'run-1',
      tenant_id: TENANT_ID,
      correlation_id: 'corr-1',
      step_index: 1,
      effect_key: 'effect-1',
      previous_evidence_hash: 'b'.repeat(64),
      payload_sha256: 'a'.repeat(64),
      chain_hash: 'c'.repeat(64),
      signature: 'd'.repeat(64),
      created_at: '2026-01-01T00:00:00Z',
      receipt,
    };
    const context: HydratedContext = {
      tenant_id: TENANT_ID,
      correlation_id: 'corr-1',
      customer: {
        customer_id: CUSTOMER_ID,
        tenant_id: TENANT_ID,
        verified_phone: null,
        verified_email: null,
        total_spent: 0,
        order_count: 1,
        rfm_segment_hypothesis: 'HIBERNATING',
        consent_marketing: false,
        consent_updated_at: null,
        suppression_active: false,
        created_at: '2026-01-01T00:00:00Z',
      },
      working_memory: {
        session_id: 'session-1',
        conversation_id: 'conversation-1',
        last_touch_channel: 'WEB_CHAT',
        turn_count: 1,
        takeover_active: false,
      },
      knowledge_citations: [],
      hydrated_at: '2026-01-01T00:00:00Z',
    };

    const response = await new VerifiedResponseFinalizer().finalize({
      tenant_id: TENANT_ID,
      run_id: 'run-1',
      conversation_id: 'conversation-1',
      domain: 'support',
      context,
      successful_receipts: [{ receipt, evidence }],
    });
    expect(response.text).toBe('Tình trạng đơn hàng ORD-1: Đang xử lý.');
  });


  it.each(['TIMEOUT', 'UNKNOWN'] as const)('preserves a retryable %s provider read failure', async (failure) => {
    const port: ErpReadPort = {
      read: vi.fn().mockRejectedValue(new ErpRefusalError(
        'INDETERMINATE_OUTCOME', 'API-001', `the orders read outcome is unconfirmed (${failure})`,
      )),
    };
    await expect(handleOrderConnector(invocation('PAID'), port, async () => IDENTITY))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('keeps a confirmed non-404 provider rejection unavailable rather than treating it as a miss', async () => {
    const port: ErpReadPort = {
      read: vi.fn().mockRejectedValue(new ErpRefusalError(
        'PROVIDER_REJECTED', 'API-001', 'provider rejected the orders read with status 403',
      )),
    };
    await expect(handleOrderConnector(invocation('PAID'), port, async () => IDENTITY))
      .rejects.toMatchObject({ code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
  });

  it('refuses an unknown ERP status instead of defaulting it', async () => {
    await expect(
      handleOrderConnector(
        invocation('IN_TRANSIT_UNKNOWN'),
        erpRead('IN_TRANSIT_UNKNOWN'),
        async () => IDENTITY,
      ),
    ).rejects.toMatchObject({ code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
  });
});
