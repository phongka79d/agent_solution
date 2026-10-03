/**
 * Revenue evidence for `skill.sales.recommend_product`, backed by tenant-owned realized orders.
 * Model identity and methodology provenance are deployment configuration, never code defaults.
 */

import { assertTenantContext, withTenantContext, type TenantTransactionRunner } from '@agentos/database';

import type { SalesRecommendationRevenueEvidencePort } from './skills/types.js';

/** Orders that count as realized demand for the estimate. */
const PAID_ORDER_STATUSES = ['paid', 'fulfilled', 'shipped', 'delivered'] as const;


export interface SalesRevenueEvidencePortOptions {
  readonly model_id: string;
  readonly provenance: string;
  /** Injected transaction runner; defaults to the canonical RLS-scoped runner. */
  readonly runInTenantTransaction?: TenantTransactionRunner;
}

interface OrderAggregate {
  readonly order_count: number;
  readonly average_total: string;
  readonly currency: string;
}

/**
 * Builds the tenant-scoped revenue evidence port from configured model metadata.
 *
 * @param options Model metadata and optional transaction runner.
 * @returns A port deriving estimates only from realized tenant order records.
 */
export function createSalesRevenueEvidencePort(
  options: SalesRevenueEvidencePortOptions,
): SalesRecommendationRevenueEvidencePort {
  const model_id = options.model_id.trim();
  const provenance = options.provenance.trim();
  if (model_id.length === 0 || provenance.length === 0) {
    throw new Error('Sales revenue evidence model_id and provenance must be configured');
  }
  const runInTenantTransaction = options.runInTenantTransaction ?? withTenantContext;

  return {
    async read(input) {
      assertTenantContext(input.tenant_id);
      const rows = await runInTenantTransaction(input.tenant_id, async (client) => {
        const result = await client.query<OrderAggregate>(
          `SELECT COUNT(*)::int AS order_count,
                  AVG(total_amount)::text AS average_total,
                  MIN(currency) AS currency
             FROM agentos.orders
            WHERE tenant_id = $1
              AND customer_id = $2
              AND status = ANY($3::text[])`,
          [input.tenant_id, input.customer_id, [...PAID_ORDER_STATUSES]],
        );
        return result.rows;
      });

      const aggregate = rows[0];
      const orderCount = aggregate === undefined ? 0 : Number(aggregate.order_count);
      const averageTotal = aggregate === undefined ? Number.NaN : Number(aggregate.average_total);
      const currency = aggregate?.currency;
      if (
        orderCount < 1
        || !Number.isFinite(averageTotal)
        || averageTotal <= 0
        || typeof currency !== 'string'
        || currency.trim().length === 0
      ) {
        throw new Error(
          'REVENUE_EVIDENCE_UNAVAILABLE: this customer has no realized order in this tenant, so no expected revenue can be stated.',
        );
      }
      if (currency !== input.currency) {
        throw new Error(
          'REVENUE_EVIDENCE_CURRENCY_MISMATCH: the recorded orders are not priced in the requested currency.',
        );
      }

      return {
        conversion_probability: Math.min(0.5, Number((0.1 * orderCount).toFixed(2))),
        expected_revenue: Number(averageTotal.toFixed(2)),
        currency,
        model_id,
        provenance_reference: `${provenance};agentos.orders:${input.tenant_id}:${input.customer_id}:${String(orderCount)}`,
      };
    },
  };
}
