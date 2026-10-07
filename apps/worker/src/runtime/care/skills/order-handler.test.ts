import { describe, expect, it, vi } from 'vitest';
import type { SkillToolInvocation } from '@agentos/skills';

import type { ErpReadPort } from '../../connectors.js';
import { handleOrderConnector } from './order-handler.js';

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

  it('refuses an unknown ERP status instead of defaulting it', async () => {
    await expect(
      handleOrderConnector(
        invocation('IN_TRANSIT_UNKNOWN'),
        erpRead('IN_TRANSIT_UNKNOWN'),
        async () => IDENTITY,
      ),
    ).rejects.toMatchObject({ code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
  });

  it('rejects line item with non-positive quantity', async () => {
    const invalidErp: ErpReadPort = {
      read: vi.fn().mockResolvedValue({
        resource: 'orders',
        observed_at: '2026-01-04T10:00:00Z',
        tenant_id: TENANT_ID,
        value: {
          order_id: 'ORD-1',
          customer_id: CUSTOMER_ID,
          status: 'SHIPPED',
          total_price: 100,
          currency: 'TWD',
          order_date: '2026-01-05T14:30:00Z',
          line_items: [
            {
              sku_id: 'SKU-1',
              product_name: 'Standard Widget',
              quantity: 0,
              unit_price: 100,
              currency: 'TWD',
            },
          ],
        },
      }),
    };

    await expect(
      handleOrderConnector(invocation('SHIPPED'), invalidErp, async () => IDENTITY),
    ).rejects.toMatchObject({
      code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE',
    });
  });

  it('rejects line item with NaN or negative unit price', async () => {
    const nanErp: ErpReadPort = {
      read: vi.fn().mockResolvedValue({
        resource: 'orders',
        observed_at: '2026-01-04T10:00:00Z',
        tenant_id: TENANT_ID,
        value: {
          order_id: 'ORD-1',
          customer_id: CUSTOMER_ID,
          status: 'SHIPPED',
          total_price: 100,
          currency: 'TWD',
          order_date: '2026-01-05T14:30:00Z',
          line_items: [
            {
              sku_id: 'SKU-1',
              product_name: 'Standard Widget',
              quantity: 1,
              unit_price: Number.NaN,
              currency: 'TWD',
            },
          ],
        },
      }),
    };

    await expect(
      handleOrderConnector(invocation('SHIPPED'), nanErp, async () => IDENTITY),
    ).rejects.toMatchObject({
      code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE',
    });
  });

  it('rejects order with NaN or negative total price', async () => {
    const negativeTotalErp: ErpReadPort = {
      read: vi.fn().mockResolvedValue({
        resource: 'orders',
        observed_at: '2026-01-04T10:00:00Z',
        tenant_id: TENANT_ID,
        value: {
          order_id: 'ORD-1',
          customer_id: CUSTOMER_ID,
          status: 'SHIPPED',
          total_price: -50,
          currency: 'TWD',
          order_date: '2026-01-05T14:30:00Z',
          line_items: [
            {
              sku_id: 'SKU-1',
              product_name: 'Standard Widget',
              quantity: 1,
              unit_price: 50,
              currency: 'TWD',
            },
          ],
        },
      }),
    };

    await expect(
      handleOrderConnector(invocation('SHIPPED'), negativeTotalErp, async () => IDENTITY),
    ).rejects.toMatchObject({
      code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE',
    });
  });

  it('rejects an invocation where input is null or not an object with VALIDATION_FAILED', async () => {
    const invalidInvocation = {
      ...invocation('SHIPPED'),
      input: null,
    };
    await expect(
      handleOrderConnector(invalidInvocation as unknown as SkillToolInvocation<unknown>, erpRead('SHIPPED'), async () => IDENTITY),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

