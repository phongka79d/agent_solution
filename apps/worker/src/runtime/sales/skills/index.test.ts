import { computeEffectKey } from '@agentos/core-engine';
import type { ActionDraft } from '@agentos/core-engine/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { Customer360Fact } from '@agentos/core-engine/contracts';
import type { CustomerEventTimeline } from '@agentos/database';
import type { ErpReadPort } from '../../connectors.js';

import {
  createSalesSkillServices,
  SalesSkillToolError,
  type SalesRecommendationRevenueEvidencePort,
} from './index.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const CUSTOMER_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const CORRELATION_ID = 'corr-sales-1';
const SNAPSHOT_AT = '2026-09-24T10:00:00.000Z';
const customer: Customer360Fact = {
  customer_id: CUSTOMER_ID,
  tenant_id: TENANT_ID,
  verified_phone: null,
  verified_email: null,
  total_spent: 120,
  order_count: 2,
  rfm_segment_hypothesis: 'LOYAL',
  consent_marketing: true,
  consent_updated_at: SNAPSHOT_AT,
  suppression_active: false,
  created_at: SNAPSHOT_AT,
};
const timeline: CustomerEventTimeline = {
  items: [{
    event_id: 'event-1',
    source_event_id: 'source-1',
    event_name: 'product_view',
    session_id: 'session-1',
    channel: 'web',
    occurred_at: SNAPSHOT_AT,
    payload: { category: 'accessories' },
  }],
  next_cursor: null,
};

function createErpRead(): ErpReadPort {
  return {
    read: vi.fn(async ({ resource, tenant_id, key }) => {
      if (resource === 'products') {
        return {
          resource,
          tenant_id,
          observed_at: SNAPSHOT_AT,
          value: {
            tenant_id,
            snapshot_at: SNAPSHOT_AT,
            items: [{
              tenant_id,
              product_id: 'product-1',
              sku: 'SKU-1',
              name: 'Accessory',
              currency: 'TWD',
              original_list_price: 100,
              is_active: true,
              categories: ['accessories'],
            }],
          },
        };
      }
      return {
        resource,
        tenant_id,
        observed_at: SNAPSHOT_AT,
        value: {
          tenant_id,
          snapshot_at: SNAPSHOT_AT,
          items: [{ tenant_id, sku_id: key, total_available_to_promise: 3 }],
        },
      };
    }),
  };
}

function createServices(overrides: {
  erp_read?: ErpReadPort | null;
  revenue_evidence?: SalesRecommendationRevenueEvidencePort;
} = {}) {
  return createSalesSkillServices({
    erp_read: overrides.erp_read ?? createErpRead(),
    context: {
      verifiedCustomerFor: vi.fn(async () => customer),
      verifiedTimelineFor: vi.fn(async () => timeline),
    },
    ...(overrides.revenue_evidence === undefined ? {} : { revenue_evidence: overrides.revenue_evidence }),
    resolve_correlation_id: vi.fn(async () => CORRELATION_ID),
    resolve_grant: vi.fn(async () => 'AUTH-1'),
  });
}

describe('SalesSkillServices', () => {
  it('executes catalog and inventory reads with exact row-shaped outputs', async () => {
    const services = createServices();
    const context = {
      run_id: 'run-1',
      tenant_id: TENANT_ID,
      caller_agent: 'SAL-02' as const,
      correlation_id: CORRELATION_ID,
      granted_authority: 'AUTH-1' as const,
      effect_key: 'effect-read-1',
    };

    const search = await services.tool_port.invoke({
      skill_id: 'skill.sales.search_product',
      tool_binding: 'API-001.CatalogConnector',
      input: { tenant_id: TENANT_ID, query: 'accessory' },
      context,
    });
    expect(search).toEqual({
      products: [{
        product_id: 'product-1',
        sku: 'SKU-1',
        name: 'Accessory',
        list_price: 100,
        currency: 'TWD',
        in_stock: true,
      }],
      total_found: 1,
    });

    const stock = await services.tool_port.invoke({
      skill_id: 'skill.sales.check_stock',
      tool_binding: 'API-001.InventoryConnector',
      input: { tenant_id: TENANT_ID, sku_id: 'SKU-1' },
      context,
    });
    expect(stock).toEqual({
      sku_id: 'SKU-1',
      available_quantity: 3,
      in_stock: true,
      checked_at: SNAPSHOT_AT,
    });
  });

  it('dispatches canonical search and stock outputs through strict runtime validation', async () => {
    const services = createServices();
    const makeDraft = (skill_id: ActionDraft['skill_id'], payload: Record<string, unknown>, step_index: number): ActionDraft => ({
      action_id: `00000000-0000-0000-0000-00000000000${step_index}`,
      run_id: 'run-dispatch-1',
      tenant_id: TENANT_ID,
      agent_id: 'SAL-02',
      skill_id,
      adapter_target: skill_id.endsWith('search_product')
        ? 'API-001.CatalogConnector'
        : 'API-001.InventoryConnector',
      step_index,
      mutating: false,
      price_bearing: false,
      request_id: `request-${step_index}`,
      action_revision: 0,
      effect_key: computeEffectKey({
        tenant_id: TENANT_ID,
        skill_id,
        step_index,
        action_revision: 0,
        request_id: `request-${step_index}`,
      }),
      required_authority: 'AUTH-0',
      payload,
    });

    const searchReceipt = await services.dispatcher.dispatch(makeDraft(
      'skill.sales.search_product',
      { tenant_id: TENANT_ID, query: 'accessory' },
      1,
    ));
    expect(searchReceipt.adapter_status).toBe('SUCCESS');
    expect(searchReceipt.response_payload).toEqual({
      products: [{
        product_id: 'product-1',
        sku: 'SKU-1',
        name: 'Accessory',
        list_price: 100,
        currency: 'TWD',
        in_stock: true,
      }],
      total_found: 1,
    });

    const stockReceipt = await services.dispatcher.dispatch(makeDraft(
      'skill.sales.check_stock',
      { tenant_id: TENANT_ID, sku_id: 'SKU-1' },
      2,
    ));
    expect(stockReceipt.adapter_status).toBe('SUCCESS');
    expect(stockReceipt.response_payload).toEqual({
      sku_id: 'SKU-1',
      available_quantity: 3,
      in_stock: true,
      checked_at: SNAPSHOT_AT,
    });
  });

  it('dispatches recommendation through the Sales engine and validates the canonical seven-field output', async () => {
    const revenue_evidence: SalesRecommendationRevenueEvidencePort = {
      read: vi.fn(async () => ({
        conversion_probability: 0.7,
        expected_revenue: 70,
        currency: 'TWD',
        model_id: 'owner-model-v1',
        provenance_reference: 'finance:approved-model:1',
      })),
    };
    const services = createServices({ revenue_evidence });
    const request_id = 'request-recommendation-1';
    const skill_id = 'skill.sales.recommend_product';
    const action: ActionDraft = {
      action_id: '00000000-0000-0000-0000-000000000003',
      run_id: 'run-dispatch-1',
      tenant_id: TENANT_ID,
      agent_id: 'SAL-03',
      skill_id,
      adapter_target: 'Core.RecommendationEngine',
      step_index: 3,
      mutating: false,
      price_bearing: false,
      request_id,
      action_revision: 0,
      effect_key: computeEffectKey({
        tenant_id: TENANT_ID,
        skill_id,
        step_index: 3,
        action_revision: 0,
        request_id,
      }),
      required_authority: 'AUTH-1',
      payload: {
        tenant_id: TENANT_ID,
        customer_id: CUSTOMER_ID,
        current_cart_skus: [],
      },
    };

    const receipt = await services.dispatcher.dispatch(action);

    expect(receipt.adapter_status).toBe('SUCCESS');
    expect(receipt.response_payload).toEqual({
      customer: CUSTOMER_ID,
      product: { sku: 'SKU-1', name: 'Accessory', price: 100 },
      reason: 'Available product selected from verified Customer360 event event-1.',
      evidence: {
        verified_timeline_event_ids: ['event-1'],
        verified_model: 'owner-model-v1',
        historical_spend: 120,
        category_affinity: 'verified timeline overlap',
      },
      eligibility: {
        stock_available: true,
        consent_verified: true,
        suppression_cleared: true,
      },
      confidence: 0.8,
      expected_outcome: {
        conversion_probability: 0.7,
        expected_revenue: 70,
        currency: 'TWD',
      },
    });
  });

  it.each([
    ['negative price', { original_list_price: -1, currency: 'TWD' }],
    ['blank currency', { original_list_price: 100, currency: '   ' }],
  ])('fails closed for an authoritative recommendation product with %s', async (_caseName, productFields) => {
    const erp_read: ErpReadPort = {
      read: vi.fn(async ({ resource, tenant_id, key }) => resource === 'products'
        ? {
            resource,
            tenant_id,
            observed_at: SNAPSHOT_AT,
            value: {
              tenant_id,
              snapshot_at: SNAPSHOT_AT,
              items: [{
                tenant_id,
                product_id: 'product-invalid',
                sku: 'SKU-INVALID',
                name: 'Invalid product',
                is_active: true,
                ...productFields,
              }],
            },
          }
        : {
            resource,
            tenant_id,
            observed_at: SNAPSHOT_AT,
            value: {
              tenant_id,
              snapshot_at: SNAPSHOT_AT,
              items: [{ tenant_id, sku_id: key, total_available_to_promise: 3 }],
            },
          }),
    };
    const services = createServices({
      erp_read,
      revenue_evidence: {
        read: vi.fn(async () => ({
          conversion_probability: 0.7,
          expected_revenue: 70,
          currency: 'TWD',
          model_id: 'owner-model-v1',
          provenance_reference: 'finance:approved-model:1',
        })),
      },
    });

    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.recommend_product',
      tool_binding: 'Core.RecommendationEngine',
      input: {
        tenant_id: TENANT_ID,
        customer_id: CUSTOMER_ID,
        current_cart_skus: [],
      },
      context: {
        run_id: 'run-1',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-03' as const,
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-1' as const,
        effect_key: 'effect-read-invalid-product',
      },
    })).rejects.toMatchObject<SalesSkillToolError>({
      code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE',
    });
  });

  it('returns Customer360 values in the exact retrieve_customer row shape', async () => {
    const services = createServices();
    const output = await services.tool_port.invoke({
      skill_id: 'skill.sales.retrieve_customer',
      tool_binding: 'PostgreSQL.Customer360Store',
      input: { tenant_id: TENANT_ID, customer_identifier: CUSTOMER_ID },
      context: {
        run_id: 'run-1',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-01' as const,
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-0' as const,
        effect_key: 'effect-read-2',
      },
    });
    expect(output).toEqual({
      customer_id: CUSTOMER_ID,
      total_orders: 2,
      lifetime_value: 120,
      verified: true,
      rfm_segment: 'LOYAL',
      last_order_date: null,
    });
  });

  it('refuses recommendation execution without owner-approved revenue evidence', async () => {
    const services = createServices();
    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.recommend_product',
      tool_binding: 'Core.RecommendationEngine',
      input: {
        tenant_id: TENANT_ID,
        customer_id: CUSTOMER_ID,
        current_cart_skus: [],
      },
      context: {
        run_id: 'run-1',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-03' as const,
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-1' as const,
        effect_key: 'effect-read-3',
      },
    })).rejects.toMatchObject<SalesSkillToolError>({
      code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE',
    });
  });

  it('uses only owner-approved revenue evidence when recommendation execution is enabled', async () => {
    const revenue_evidence: SalesRecommendationRevenueEvidencePort = {
      read: vi.fn(async () => ({
        conversion_probability: 0.7,
        expected_revenue: 70,
        currency: 'TWD',
        model_id: 'owner-model-v1',
        provenance_reference: 'finance:approved-model:1',
      })),
    };
    const services = createServices({ revenue_evidence });
    const output = await services.tool_port.invoke({
      skill_id: 'skill.sales.recommend_product',
      tool_binding: 'Core.RecommendationEngine',
      input: {
        tenant_id: TENANT_ID,
        customer_id: CUSTOMER_ID,
        current_cart_skus: [],
      },
      context: {
        run_id: 'run-1',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-03' as const,
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-1' as const,
        effect_key: 'effect-read-4',
      },
    });
    expect(output).toMatchObject({
      customer: CUSTOMER_ID,
      product: { sku: 'SKU-1', name: 'Accessory', price: 100 },
      confidence: 0.8,
      expected_outcome: {
        conversion_probability: 0.7,
        expected_revenue: 70,
        currency: 'TWD',
      },
      evidence: {
        verified_timeline_event_ids: ['event-1'],
        verified_model: 'owner-model-v1',
      },
    });
  });
});
