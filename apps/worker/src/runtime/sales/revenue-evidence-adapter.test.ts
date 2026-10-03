import { describe, expect, it } from 'vitest';
import type { TenantTransactionRunner } from '@agentos/database';

import { createSalesRevenueEvidencePort } from './revenue-evidence-adapter.js';

const TENANT = '99999999-9999-4999-8999-999999999999';
const CUSTOMER = '99000000-0000-4000-8000-000000000005';

function runnerReturning(rows: ReadonlyArray<Record<string, unknown>>) {
  const calls: Array<{ readonly params: readonly unknown[] }> = [];
  const runInTenantTransaction: TenantTransactionRunner = async (_tenant_id, work) => {
    return work({
      query: async (_sql: string, params: readonly unknown[]) => {
        calls.push({ params });
        return { rows: [...rows], rowCount: rows.length };
      },
    } as never);
  };
  return { runInTenantTransaction, calls };
}

describe('createSalesRevenueEvidencePort', () => {
  it('derives the estimate from the tenant\'s own realized orders and names that provenance', async () => {
    const { runInTenantTransaction } = runnerReturning([
      { order_count: 1, average_total: '790000.00', currency: 'VND' },
    ]);
    const port = createSalesRevenueEvidencePort({
      model_id: 'sales-realized-orders-v1',
      provenance: 'finance:realized-orders:v1',
      runInTenantTransaction,
    });

    const evidence = await port.read({
      tenant_id: TENANT,
      customer_id: CUSTOMER,
      sku: 'NM-L01-BLK',
      recommendation_type: 'CROSS_SELL',
      confidence: 0.9,
      list_price: 18_900_000,
      currency: 'VND',
    });

    expect(evidence).toEqual({
      conversion_probability: 0.1,
      expected_revenue: 790_000,
      currency: 'VND',
      model_id: 'sales-realized-orders-v1',
      provenance_reference: `finance:realized-orders:v1;agentos.orders:${TENANT}:${CUSTOMER}:1`,
    });
  });

  it('refuses a customer with no realized order or a currency the recorded orders do not use', async () => {
    const empty = createSalesRevenueEvidencePort({
      model_id: 'sales-realized-orders-v1',
      provenance: 'finance:realized-orders:v1',
      runInTenantTransaction: runnerReturning([]).runInTenantTransaction,
    });
    await expect(empty.read({
      tenant_id: TENANT,
      customer_id: CUSTOMER,
      sku: 'NM-L01-BLK',
      recommendation_type: 'CROSS_SELL',
      confidence: 0.9,
      list_price: 18_900_000,
      currency: 'VND',
    })).rejects.toThrow('REVENUE_EVIDENCE_UNAVAILABLE');

    const usd = createSalesRevenueEvidencePort({
      model_id: 'sales-realized-orders-v1',
      provenance: 'finance:realized-orders:v1',
      runInTenantTransaction: runnerReturning([{ order_count: 2, average_total: '10.00', currency: 'USD' }])
        .runInTenantTransaction,
    });
    await expect(usd.read({
      tenant_id: TENANT,
      customer_id: CUSTOMER,
      sku: 'NM-L01-BLK',
      recommendation_type: 'CROSS_SELL',
      confidence: 0.9,
      list_price: 18_900_000,
      currency: 'VND',
    })).rejects.toThrow('REVENUE_EVIDENCE_CURRENCY_MISMATCH');
  });
});
