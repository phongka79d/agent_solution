/**
 * @file Demo revenue evidence for `skill.sales.recommend_product`.
 *
 * The recommendation row must not invent an expected revenue: it either reads an owner-approved
 * model or refuses. This binding derives the estimate from the tenant's own recorded paid orders and
 * says so in its provenance, so the demo shows a figure that traces to rows a reviewer can open —
 * and a customer with no paid order is refused (`UNAVAILABLE`) instead of being given a number.
 */

import { assertTenantContext, withTenantContext, type TenantTransactionRunner } from '@agentos/database';

import type { SalesRecommendationRevenueEvidencePort } from './skills/types.js';

/** Orders that count as realized demand for the estimate. */
const PAID_ORDER_STATUSES = ['paid', 'fulfilled', 'shipped', 'delivered'] as const;

const MODEL_ID = 'novamart-demo-orders-v1';

export interface SalesRevenueEvidencePortOptions {
  /** Injected tenant transaction runner; defaults to the canonical RLS-scoped runner. */
  readonly runInTenantTransaction?: TenantTransactionRunner;
}

interface OrderAggregate {
  readonly order_count: number;
  readonly average_total: string;
  readonly currency: string;
}

/**
 * Builds the demo revenue-evidence port.
 *
 * @param options Injected transaction runner.
 * @returns A port that refuses when the tenant holds no realized order for the customer.
 */
export function createSalesRevenueEvidencePort(
  options: SalesRevenueEvidencePortOptions = {},
): SalesRecommendationRevenueEvidencePort {
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
        model_id: MODEL_ID,
        provenance_reference: `agentos.orders:${input.tenant_id}:${input.customer_id}:${String(orderCount)}`,
      };
    },
  };
}
