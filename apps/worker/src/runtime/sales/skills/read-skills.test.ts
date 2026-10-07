/**
 * @file Sales skill services: read, recommendation and customer skills.
 *
 * Split from `index.test.ts`; the sibling files hold the remaining groups exactly
 * once and every assertion body is unchanged.
 */

import { computeEffectKey } from '@agentos/core-engine';
import { type ActionDraft } from '@agentos/core-engine/contracts';
import { describe, expect, it, vi } from 'vitest';
import { type Customer360Fact } from '@agentos/core-engine/contracts';
import { type CustomerEventTimeline } from '@agentos/database';
import { type ErpReadPort } from '../../connectors.js';
import { SalesAdvisorExecutionState } from '../advisor-adapters.js';
import { type AssignableAuthority } from '@agentos/core-engine/contracts';
import { createSalesSkillServices, GATE_SALES_SKILLS, computeQuoteToken, type SalesCartPort, type SalesCommunicationPort, type SalesConsentPort, type SalesCustomer360Fact, type SalesFrequencyCapConfig, type SalesFrequencyCapPort, type SalesOrderPort, type SalesPaymentPolicyPort, type SalesPriceFloorApproved, type SalesPriceFloorDecision, type SalesPriceFloorPort, type SalesPriceFloorRefused, type SalesQuotePort, type SalesRecommendationRevenueEvidencePort, type SalesReplenishmentPolicyPort } from './index.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

const CUSTOMER_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';

const CORRELATION_ID = 'corr-sales-1';

const SNAPSHOT_AT = '2026-09-24T10:00:00.000Z';

const TEST_QUOTE_SECRET = 'test-quote-signing-secret-key-32-chars!';

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

function createPriceFloorPort(
  overrides?: Partial<SalesPriceFloorApproved> | SalesPriceFloorRefused | undefined,
): SalesPriceFloorPort {
  return {
    read: vi.fn(async (): Promise<SalesPriceFloorDecision> => {
      if (overrides && 'reason' in overrides && overrides.reason !== undefined) {
        return {
          ok: false,
          owner_approved: false,
          reason: overrides.reason,
        };
      }
      return {
        ok: true,
        list_price: 100,
        currency: 'TWD',
        p_floor: 80,
        floor_source: 'engine:approved:pricing-v1',
        owner_approved: true,
        quote_ttl_seconds: 3600,
        ...overrides,
      };
    }),
  };
}

function createCartPort(overrides?: {
  subtotal?: number | undefined;
  currency?: string | undefined;
  quote_token?: string | undefined;
  quote_expires_at?: string | undefined;
  sku_id?: string | undefined;
  p_floor?: number | undefined;
}): SalesCartPort {
  const subtotal = overrides?.subtotal ?? 100;
  const currency = overrides?.currency ?? 'TWD';
  const sku_id = overrides?.sku_id ?? 'SKU-1';
  const p_floor = overrides?.p_floor ?? 80;
  const quote_expires_at = overrides?.quote_expires_at ?? '2026-09-24T12:00:00.000Z';
  const quote_token = overrides?.quote_token !== undefined
    ? overrides.quote_token
    : computeQuoteToken(TEST_QUOTE_SECRET, {
      tenant_id: TENANT_ID,
      sku_id,
      customer_id: CUSTOMER_ID,
      final_price: subtotal,
      p_floor,
      currency,
      quote_expires_at,
    });
  return {
    createCart: vi.fn(async (input) => ({
      cart_id: 'cart-00000000-0000-4000-8000-000000000001',
      item_count: input.items.reduce((sum, item) => sum + item.quantity, 0),
      subtotal,
      currency,
      updated_at: '2026-09-24T10:00:00.000Z',
    })),
    getCart: vi.fn(async ({ cart_id }) => ({
      cart_id,
      item_count: 1,
      subtotal,
      currency,
      sku_id,
      p_floor,
      quote_token,
      quote_expires_at,
      updated_at: '2026-09-24T10:00:00.000Z',
    })),
  };
}

function createOrderPort(overrides?: {
  total_amount?: number | undefined;
  currency?: string | undefined;
  supported_payment_methods?: readonly string[] | undefined;
}): SalesOrderPort {
  const total_amount = overrides?.total_amount ?? 100;
  const currency = overrides?.currency ?? 'TWD';
  const supported_payment_methods = overrides?.supported_payment_methods ?? [
    'CREDIT_CARD',
    'CVS_COD',
    'LINE_PAY',
    'JKOPAY',
    'STRIPE',
    'PAYPAL',
  ];
  return {
    createOrder: vi.fn(async (_input) => ({
      order_id: 'order-00000000-0000-4000-8000-000000000001',
      order_number: 'ORD-2026-0001',
      total_amount,
      currency,
      status: 'PENDING_PAYMENT' as const,
      payment_url: 'https://pay.example.com/checkout/ord-1',
      created_at: '2026-09-24T10:00:00.000Z',
    })),
    readSupportedPaymentMethods: vi.fn(async () => supported_payment_methods),
  };
}

function createCommunicationPort(): SalesCommunicationPort {
  return {
    sendMessage: vi.fn(async (_input) => ({
      message_id: 'msg-00000000-0000-4000-8000-000000000001',
      provider_reference: 'line:ref-12345',
      delivered_at: '2026-09-24T10:00:00.000Z',
    })),
  };
}

function createConsentPort(overrides: {
  consented?: boolean | undefined;
  suppressed?: boolean | undefined;
  reason?: string | undefined;
  consent_marketing?: boolean | undefined;
  suppression_active?: boolean | undefined;
} = {}): SalesConsentPort {
  return {
    read: vi.fn(async () => ({
      consented: overrides.consented ?? true,
      suppressed: overrides.suppressed ?? false,
      ...(overrides.reason ? { reason: overrides.reason } : {}),
    })),
    getConsent: vi.fn(async () => ({
      consent_marketing: overrides.consent_marketing ?? overrides.consented ?? true,
      suppression_active: overrides.suppression_active ?? overrides.suppressed ?? false,
    })),
  };
}

function createFrequencyCapPort(cap: SalesFrequencyCapConfig | number = { allowed: true, remaining: 3 }): SalesFrequencyCapPort {
  return {
    read: vi.fn(async () => cap),
  };
}

function createReplenishmentPolicyPort(): SalesReplenishmentPolicyPort {
  return {
    read: vi.fn(async () => ({
      replenishment_interval_days: 30,
      evidence_staleness_window_days: 7,
      owner_approved: true as const,
    })),
  };
}

function createServices(overrides: {
  erp_read?: ErpReadPort | null | undefined;
  revenue_evidence?: SalesRecommendationRevenueEvidencePort | undefined;
  price_floor?: SalesPriceFloorPort | null | undefined;
  cart?: SalesCartPort | null | undefined;
  order?: SalesOrderPort | null | undefined;
  communication?: SalesCommunicationPort | null | undefined;
  consent?: SalesConsentPort | null | undefined;
  frequency_cap?: SalesFrequencyCapPort | null | undefined;
  replenishment_policy?: SalesReplenishmentPolicyPort | null | undefined;
  quote?: SalesQuotePort | null | undefined;
  payment_policy?: SalesPaymentPolicyPort | null | undefined;
  is_takeover_active?: ((tenant_id: string, correlation_id: string) => Promise<boolean> | boolean) | undefined;
  takeover_active?: boolean | undefined;
  customer?: Customer360Fact | SalesCustomer360Fact | null | undefined;
  timeline?: CustomerEventTimeline | null | undefined;
  resolve_grant?: ((tenant_id: string, agent_id: string) => Promise<AssignableAuthority | null>) | undefined;
  quote_signing_secret?: string | undefined;
  now?: (() => Date) | undefined;
  advisor_state?: SalesAdvisorExecutionState | undefined;
} = {}) {
  const quote_signing_secret = overrides.quote_signing_secret !== undefined
    ? overrides.quote_signing_secret
    : (overrides.order || overrides.price_floor ? TEST_QUOTE_SECRET : undefined);
  return createSalesSkillServices({
    now: overrides.now ?? (() => new Date(SNAPSHOT_AT)),
    erp_read: overrides.erp_read !== undefined ? overrides.erp_read : createErpRead(),
    context: {
      verifiedCustomerFor: vi.fn(async () => overrides.customer !== undefined ? overrides.customer : customer),
      verifiedTimelineFor: vi.fn(async () => overrides.timeline !== undefined ? overrides.timeline : timeline),
    },
    ...(overrides.revenue_evidence === undefined ? {} : { revenue_evidence: overrides.revenue_evidence }),
    ...(overrides.price_floor === undefined ? {} : { price_floor: overrides.price_floor }),
    ...(overrides.cart === undefined ? {} : { cart: overrides.cart }),
    ...(overrides.order === undefined ? {} : { order: overrides.order }),
    ...(overrides.communication === undefined ? {} : { communication: overrides.communication }),
    ...(overrides.consent === undefined ? {} : { consent: overrides.consent }),
    ...(overrides.frequency_cap === undefined ? {} : { frequency_cap: overrides.frequency_cap }),
    ...(overrides.replenishment_policy === undefined ? {} : { replenishment_policy: overrides.replenishment_policy }),
    ...(overrides.quote === undefined ? {} : { quote: overrides.quote }),
    ...(overrides.payment_policy === undefined ? {} : { payment_policy: overrides.payment_policy }),
    ...(overrides.is_takeover_active === undefined ? {} : { is_takeover_active: overrides.is_takeover_active }),
    ...(overrides.takeover_active === undefined ? {} : { takeover_active: overrides.takeover_active }),
    ...(overrides.advisor_state === undefined ? {} : { advisor_state: overrides.advisor_state }),
    ...(quote_signing_secret === undefined ? {} : { quote_signing_secret }),
    resolve_correlation_id: vi.fn(async () => CORRELATION_ID),
    resolve_grant: overrides.resolve_grant ?? vi.fn(async () => 'AUTH-1'),
  });
}

function createFullyBoundServices(overrides: {
  priceFloorOverrides?: Partial<SalesPriceFloorApproved> | SalesPriceFloorRefused | undefined;
  consentOverrides?: { consented?: boolean | undefined; suppressed?: boolean | undefined; reason?: string | undefined } | undefined;
  frequencyCapConfig?: SalesFrequencyCapConfig | number | undefined;
  takeoverActive?: boolean | undefined;
  customer?: Customer360Fact | SalesCustomer360Fact | undefined;
  timeline?: CustomerEventTimeline | undefined;
  erp_read?: ErpReadPort | null | undefined;
  revenue_evidence?: SalesRecommendationRevenueEvidencePort | undefined;
  quote?: SalesQuotePort | null | undefined;
  payment_policy?: SalesPaymentPolicyPort | null | undefined;
  orderOverrides?: { total_amount?: number; currency?: string; supported_payment_methods?: readonly string[] } | undefined;
  cartOverrides?: { subtotal?: number; currency?: string; quote_token?: string; quote_expires_at?: string } | undefined;
  quote_signing_secret?: string | undefined;
  now?: (() => Date) | undefined;
  advisor_state?: SalesAdvisorExecutionState | undefined;
} = {}) {
  const revenue_evidence: SalesRecommendationRevenueEvidencePort = {
    read: vi.fn(async () => ({
      conversion_probability: 0.7,
      expected_revenue: 70,
      currency: 'TWD',
      model_id: 'owner-model-v1',
      provenance_reference: 'finance:approved-model:1',
    })),
  };
  return createServices({
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
    ...(overrides.erp_read !== undefined ? { erp_read: overrides.erp_read } : {}),
    revenue_evidence: overrides.revenue_evidence !== undefined ? overrides.revenue_evidence : revenue_evidence,
    price_floor: createPriceFloorPort(overrides.priceFloorOverrides),
    cart: createCartPort(overrides.cartOverrides),
    order: createOrderPort(overrides.orderOverrides),
    communication: createCommunicationPort(),
    consent: createConsentPort(overrides.consentOverrides),
    frequency_cap: createFrequencyCapPort(overrides.frequencyCapConfig),
    replenishment_policy: createReplenishmentPolicyPort(),
    ...(overrides.quote !== undefined ? { quote: overrides.quote } : {}),
    ...(overrides.payment_policy !== undefined ? { payment_policy: overrides.payment_policy } : {}),
    takeover_active: overrides.takeoverActive !== undefined ? overrides.takeoverActive : false,
    ...(overrides.customer !== undefined ? { customer: overrides.customer } : {}),
    ...(overrides.timeline !== undefined ? { timeline: overrides.timeline } : {}),
    ...(overrides.advisor_state !== undefined ? { advisor_state: overrides.advisor_state } : {}),
    resolve_grant: vi.fn(async () => 'AUTH-3'),
    quote_signing_secret: overrides.quote_signing_secret ?? TEST_QUOTE_SECRET,
  });
}

describe('SalesSkillServices - read, recommendation and customer skills', () => {

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
  it('searches with bounded deduplicated inventory reads and keeps failed stock unknown', async () => {
    const inventoryKeys: string[] = [];
    const erp_read: ErpReadPort = {
      read: vi.fn(async ({ resource, tenant_id, key }) => {
        if (resource === 'products') {
          return {
            resource,
            tenant_id,
            observed_at: SNAPSHOT_AT,
            value: {
              tenant_id,
              snapshot_at: SNAPSHOT_AT,
              items: [
                {
                  tenant_id,
                  product_id: 'product-unknown',
                  sku: 'SKU-UNKNOWN',
                  name: 'Union Select accessory',
                  currency: 'TWD',
                  original_list_price: 100,
                  is_active: true,
                },
                {
                  tenant_id,
                  product_id: 'product-known',
                  sku: 'SKU-KNOWN',
                  name: 'Union Select known accessory',
                  currency: 'TWD',
                  original_list_price: 120,
                  is_active: true,
                },
              ],
            },
          };
        }
        inventoryKeys.push(key ?? '');
        if (key === 'SKU-UNKNOWN') throw new Error('inventory unavailable');
        return {
          resource,
          tenant_id,
          observed_at: SNAPSHOT_AT,
          value: {
            tenant_id,
            snapshot_at: SNAPSHOT_AT,
            items: [{ tenant_id, sku_id: key, total_available_to_promise: 2 }],
          },
        };
      }),
    };
    const services = createServices({ erp_read });
    const search = await services.tool_port.invoke({
      skill_id: 'skill.sales.search_product',
      tool_binding: 'API-001.CatalogConnector',
      input: { tenant_id: TENANT_ID, query: 'union select', limit: 20 },
      context: {
        run_id: 'run-search-batch',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02' as const,
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-1' as const,
        effect_key: 'effect-search-batch',
      },
    });

    expect(search).toMatchObject({
      products: [
        { sku: 'SKU-KNOWN', in_stock: true },
        { sku: 'SKU-UNKNOWN', in_stock: null },
      ],
      total_found: 2,
    });
    expect(inventoryKeys.sort()).toEqual(['SKU-KNOWN', 'SKU-UNKNOWN']);
  });
  it('accepts ordinary catalog text that resembles non-instructional marker syntax', async () => {
    const services = createServices();
    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.search_product',
      tool_binding: 'API-001.CatalogConnector',
      input: { tenant_id: TENANT_ID, query: 'system: accessory' },
      context: {
        run_id: 'run-search-marker-false-positive',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02' as const,
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-1' as const,
        effect_key: 'effect-search-marker-false-positive',
      },
    })).resolves.toMatchObject({
      total_found: 0,
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

  it('binds ERP provider reconciliation for Sales mutations and preserves UNKNOWN without proof', async () => {
    const providerReceipt = {
      execution_id: 'API-001:action-sales-reconciled',
      adapter_status: 'SUCCESS' as const,
      provider_reference: 'MOCK-ERP:tenant-sales:action-sales-reconciled',
      response_payload: { reconciled: true },
      latency_ms: 0,
      token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
    };
    let providerProofAvailable = true;
    const reconcile = vi.fn(async () => providerProofAvailable
      ? { outcome: 'SUCCEEDED' as const, receipt: providerReceipt }
      : { outcome: 'INDETERMINATE' as const });
    const services = createServices({
      erp_read: { ...createErpRead(), reconcile },
    });
    const input = {
      tenant_id: TENANT_ID,
      effect_key: 'effect-sales-cart-unknown',
      action_id: 'action-sales-reconciled',
      adapter_target: 'API-002.CommerceCartAPI',
      skill_id: 'skill.sales.create_cart',
    };

    await expect(services.dispatcher.reconcile?.(input)).resolves.toEqual({
      outcome: 'SUCCEEDED',
      receipt: providerReceipt,
    });
    expect(reconcile).toHaveBeenCalledWith(input);

    providerProofAvailable = false;
    await expect(services.dispatcher.reconcile?.(input)).resolves.toEqual({
      outcome: 'INDETERMINATE',
    });
  });

  it('dispatches recommendation through the Sales engine and validates the canonical recommendation output', async () => {
    const revenue_evidence: SalesRecommendationRevenueEvidencePort = {
      read: vi.fn(async () => ({
        conversion_probability: 0.7,
        expected_revenue: 70,
        currency: 'TWD',
        model_id: 'owner-model-v1',
        provenance_reference: 'finance:approved-model:1',
      })),
    };
    const services = createServices({ revenue_evidence, price_floor: createPriceFloorPort() });
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
      ranking_method: 'authoritative_catalog_order',
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
    })).rejects.toMatchObject({
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
    })).rejects.toMatchObject({
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
    const services = createServices({ revenue_evidence, price_floor: createPriceFloorPort() });
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

  it('disables all four new skills when their dependencies are unbound, refusing dispatch with SKILL_DISABLED', async () => {
    const services = createServices();

    // Four new skills must be disabled in registry
    expect(services.registry.resolve('skill.sales.check_price').enabled).toBe(false);
    expect(services.registry.resolve('skill.sales.create_cart').enabled).toBe(false);
    expect(services.registry.resolve('skill.sales.create_order').enabled).toBe(false);
    expect(services.registry.resolve('skill.sales.send_message').enabled).toBe(false);

    // Read skills retain enabled state
    expect(services.registry.resolve('skill.sales.search_product').enabled).toBe(true);
    expect(services.registry.resolve('skill.sales.check_stock').enabled).toBe(true);
    expect(services.registry.resolve('skill.sales.retrieve_customer').enabled).toBe(true);
    expect(services.registry.resolve('skill.sales.recommend_product').enabled).toBe(true);

    // Enabled set reflects this
    expect(services.enabled_skills?.has('skill.sales.check_price')).toBe(false);
    expect(services.enabled_skills?.has('skill.sales.create_cart')).toBe(false);
    expect(services.enabled_skills?.has('skill.sales.create_order')).toBe(false);
    expect(services.enabled_skills?.has('skill.sales.send_message')).toBe(false);
    expect(services.enabled_skills?.has('skill.sales.search_product')).toBe(true);

    // Unbound list reports human-readable reasons for every unbound port
    expect(services.unbound).toContain('API-001.PricingEngine: no pricing engine port is bound; skill.sales.check_price refuses');
    expect(services.unbound).toContain('API-002.CommerceCartAPI: no cart port is bound; skill.sales.create_cart refuses');
    expect(services.unbound).toContain('API-001.OrderConnector: no order connector port is bound; skill.sales.create_order refuses');
    expect(services.unbound).toContain('API-003.CommunicationConnector: no communication port is bound; skill.sales.send_message refuses');
    expect(services.unbound).toContain('SalesConsent: no consent port is bound; skill.sales.send_message refuses');
    expect(services.unbound).toContain('SalesFrequencyCap: no frequency cap port is bound; skill.sales.send_message refuses');
    expect(services.unbound).toContain('SalesReplenishmentPolicy: no replenishment policy port is bound; SAL-05 replenishment refuses');
    expect(services.unbound).toContain('SalesTakeover: no takeover authority is bound; skill.sales.send_message refuses');

    // Dispatching check_price refuses with SKILL_DISABLED
    const priceAction: ActionDraft = {
      action_id: '00000000-0000-0000-0000-000000000010',
      run_id: 'run-dispatch-1',
      tenant_id: TENANT_ID,
      agent_id: 'SAL-02',
      skill_id: 'skill.sales.check_price',
      adapter_target: 'API-001.PricingEngine',
      step_index: 10,
      mutating: false,
      price_bearing: false,
      request_id: 'req-price-disabled',
      action_revision: 0,
      effect_key: computeEffectKey({
        tenant_id: TENANT_ID,
        skill_id: 'skill.sales.check_price',
        step_index: 10,
        action_revision: 0,
        request_id: 'req-price-disabled',
      }),
      required_authority: 'AUTH-3',
      payload: {
        tenant_id: TENANT_ID,
        sku_id: 'SKU-1',
        customer_id: CUSTOMER_ID,
      },
    };

    await expect(services.dispatcher.dispatch(priceAction)).rejects.toMatchObject({
      code: 'SKILL_DISABLED',
    });
  });

  it('dispatches all 8 canonical skills through the SkillRuntimeEngine when all ports are bound', async () => {
    const services = createFullyBoundServices();

    // Every skill is enabled in registry
    for (const skill_id of GATE_SALES_SKILLS) {
      expect(services.registry.resolve(skill_id).enabled).toBe(true);
    }

    // 1. search_product
    const searchReceipt = await services.dispatcher.dispatch({
      action_id: '00000000-0000-0000-0000-000000000001',
      run_id: 'run-1',
      tenant_id: TENANT_ID,
      agent_id: 'SAL-02',
      skill_id: 'skill.sales.search_product',
      adapter_target: 'API-001.CatalogConnector',
      step_index: 1,
      mutating: false,
      price_bearing: false,
      request_id: 'req-1',
      action_revision: 0,
      effect_key: computeEffectKey({ tenant_id: TENANT_ID, skill_id: 'skill.sales.search_product', step_index: 1, action_revision: 0, request_id: 'req-1' }),
      required_authority: 'AUTH-0',
      payload: { tenant_id: TENANT_ID, query: 'accessory' },
    });
    expect(searchReceipt.adapter_status).toBe('SUCCESS');

    // 2. check_stock
    const stockReceipt = await services.dispatcher.dispatch({
      action_id: '00000000-0000-0000-0000-000000000002',
      run_id: 'run-1',
      tenant_id: TENANT_ID,
      agent_id: 'SAL-02',
      skill_id: 'skill.sales.check_stock',
      adapter_target: 'API-001.InventoryConnector',
      step_index: 2,
      mutating: false,
      price_bearing: false,
      request_id: 'req-2',
      action_revision: 0,
      effect_key: computeEffectKey({ tenant_id: TENANT_ID, skill_id: 'skill.sales.check_stock', step_index: 2, action_revision: 0, request_id: 'req-2' }),
      required_authority: 'AUTH-0',
      payload: { tenant_id: TENANT_ID, sku_id: 'SKU-1' },
    });
    expect(stockReceipt.adapter_status).toBe('SUCCESS');

    // 3. retrieve_customer
    const customerReceipt = await services.dispatcher.dispatch({
      action_id: '00000000-0000-0000-0000-000000000003',
      run_id: 'run-1',
      tenant_id: TENANT_ID,
      agent_id: 'SAL-01',
      skill_id: 'skill.sales.retrieve_customer',
      adapter_target: 'PostgreSQL.Customer360Store',
      step_index: 3,
      mutating: false,
      price_bearing: false,
      request_id: 'req-3',
      action_revision: 0,
      effect_key: computeEffectKey({ tenant_id: TENANT_ID, skill_id: 'skill.sales.retrieve_customer', step_index: 3, action_revision: 0, request_id: 'req-3' }),
      required_authority: 'AUTH-0',
      payload: { tenant_id: TENANT_ID, customer_identifier: CUSTOMER_ID },
    });
    expect(customerReceipt.adapter_status).toBe('SUCCESS');

    // 4. recommend_product
    const recommendReceipt = await services.dispatcher.dispatch({
      action_id: '00000000-0000-0000-0000-000000000004',
      run_id: 'run-1',
      tenant_id: TENANT_ID,
      agent_id: 'SAL-03',
      skill_id: 'skill.sales.recommend_product',
      adapter_target: 'Core.RecommendationEngine',
      step_index: 4,
      mutating: false,
      price_bearing: false,
      request_id: 'req-4',
      action_revision: 0,
      effect_key: computeEffectKey({ tenant_id: TENANT_ID, skill_id: 'skill.sales.recommend_product', step_index: 4, action_revision: 0, request_id: 'req-4' }),
      required_authority: 'AUTH-1',
      payload: { tenant_id: TENANT_ID, customer_id: CUSTOMER_ID, current_cart_skus: [] },
    });
    expect(recommendReceipt.adapter_status).toBe('SUCCESS');

    // 5. check_price
    const priceReceipt = await services.dispatcher.dispatch({
      action_id: '00000000-0000-0000-0000-000000000005',
      run_id: 'run-1',
      tenant_id: TENANT_ID,
      agent_id: 'SAL-02',
      skill_id: 'skill.sales.check_price',
      adapter_target: 'API-001.PricingEngine',
      step_index: 5,
      mutating: false,
      price_bearing: false,
      request_id: 'req-5',
      action_revision: 0,
      effect_key: computeEffectKey({ tenant_id: TENANT_ID, skill_id: 'skill.sales.check_price', step_index: 5, action_revision: 0, request_id: 'req-5' }),
      required_authority: 'AUTH-3',
      payload: {
        tenant_id: TENANT_ID,
        sku_id: 'SKU-1',
        customer_id: CUSTOMER_ID,
        requested_discount_percent: 10,
      },
    });
    expect(priceReceipt.adapter_status).toBe('SUCCESS');
    expect(priceReceipt.response_payload).toMatchObject({
      sku_id: 'SKU-1',
      list_price: 100,
      final_price: 90,
      p_floor: 80,
      discount_allowed: true,
      currency: 'TWD',
    });
    expect(typeof (priceReceipt.response_payload as Record<string, unknown>).quote_token).toBe('string');
    expect(typeof (priceReceipt.response_payload as Record<string, unknown>).quote_expires_at).toBe('string');

    // 6. create_cart
    const cartEffectKey = computeEffectKey({ tenant_id: TENANT_ID, skill_id: 'skill.sales.create_cart', step_index: 6, action_revision: 0, request_id: 'req-6' });
    const cartReceipt = await services.dispatcher.dispatch({
      action_id: '00000000-0000-0000-0000-000000000006',
      run_id: 'run-1',
      tenant_id: TENANT_ID,
      agent_id: 'SAL-02',
      skill_id: 'skill.sales.create_cart',
      adapter_target: 'API-002.CommerceCartAPI',
      step_index: 6,
      mutating: true,
      price_bearing: false,
      request_id: 'req-6',
      action_revision: 0,
      effect_key: cartEffectKey,
      required_authority: 'AUTH-3',
      payload: {
        tenant_id: TENANT_ID,
        session_id: 'session-1',
        items: [{ sku_id: 'SKU-1', quantity: 2 }],
        idempotency_key: 'idemp-1',
      },
    });
    expect(cartReceipt.adapter_status).toBe('SUCCESS');
    expect(cartReceipt.response_payload).toEqual({
      cart_id: 'cart-00000000-0000-4000-8000-000000000001',
      item_count: 2,
      subtotal: 100,
      currency: 'TWD',
      updated_at: '2026-09-24T10:00:00.000Z',
    });

    // 7. create_order
    const orderEffectKey = computeEffectKey({ tenant_id: TENANT_ID, skill_id: 'skill.sales.create_order', step_index: 7, action_revision: 0, request_id: 'req-7' });
    const orderReceipt = await services.dispatcher.dispatch({
      action_id: '00000000-0000-0000-0000-000000000007',
      run_id: 'run-1',
      tenant_id: TENANT_ID,
      agent_id: 'SAL-02',
      skill_id: 'skill.sales.create_order',
      adapter_target: 'API-001.OrderConnector',
      step_index: 7,
      mutating: true,
      price_bearing: true,
      request_id: 'req-7',
      action_revision: 0,
      effect_key: orderEffectKey,
      required_authority: 'AUTH-3',
      payload: {
        tenant_id: TENANT_ID,
        cart_id: 'cart-00000000-0000-4000-8000-000000000001',
        customer_id: CUSTOMER_ID,
        shipping_address: { street: 'Main St 1' },
        payment_method: 'CREDIT_CARD',
        effect_key: orderEffectKey,
        quote_token: computeQuoteToken(TEST_QUOTE_SECRET, {
          tenant_id: TENANT_ID,
          sku_id: 'SKU-1',
          customer_id: CUSTOMER_ID,
          final_price: 100,
          p_floor: 80,
          currency: 'TWD',
          quote_expires_at: (priceReceipt.response_payload as Record<string, unknown>).quote_expires_at as string,
        }),
        quote_expires_at: (priceReceipt.response_payload as Record<string, unknown>).quote_expires_at,
        sku_id: 'SKU-1',
        p_floor: 80,
      },
    });
    expect(orderReceipt.adapter_status).toBe('SUCCESS');
    expect(orderReceipt.response_payload).toEqual({
      order_id: 'order-00000000-0000-4000-8000-000000000001',
      order_number: 'ORD-2026-0001',
      total_amount: 100,
      currency: 'TWD',
      status: 'PENDING_PAYMENT',
      payment_url: 'https://pay.example.com/checkout/ord-1',
      created_at: '2026-09-24T10:00:00.000Z',
    });

    // 8. send_message
    const msgEffectKey = computeEffectKey({ tenant_id: TENANT_ID, skill_id: 'skill.sales.send_message', step_index: 8, action_revision: 0, request_id: 'req-8' });
    const msgReceipt = await services.dispatcher.dispatch({
      action_id: '00000000-0000-0000-0000-000000000008',
      run_id: 'run-1',
      tenant_id: TENANT_ID,
      agent_id: 'SAL-02',
      skill_id: 'skill.sales.send_message',
      adapter_target: 'API-003.CommunicationConnector',
      step_index: 8,
      mutating: true,
      price_bearing: false,
      request_id: 'req-8',
      action_revision: 0,
      effect_key: msgEffectKey,
      required_authority: 'AUTH-3',
      payload: {
        tenant_id: TENANT_ID,
        recipient_id: CUSTOMER_ID,
        channel: 'LINE',
        message_content: { text: 'Your items are in stock!' },
        effect_key: msgEffectKey,
      },
    });
    expect(msgReceipt.adapter_status).toBe('SUCCESS');
    expect(msgReceipt.response_payload).toEqual({
      message_id: 'msg-00000000-0000-4000-8000-000000000001',
      provider_reference: 'line:ref-12345',
      delivered_at: '2026-09-24T10:00:00.000Z',
    });
  });

  it('retrieve_customer: derives last_order_date from verified purchase evidence without hardcoded null', async () => {
    const customerWithEvidence: SalesCustomer360Fact = {
      ...customer,
      purchase_evidence: [
        { order_id: 'ord-1', order_date: '2026-09-20T12:00:00.000Z' },
        { order_id: 'ord-2', order_date: '2026-09-24T15:30:00.000Z' },
      ],
    };
    const services = createServices({ customer: customerWithEvidence });
    const output = await services.tool_port.invoke({
      skill_id: 'skill.sales.retrieve_customer',
      tool_binding: 'PostgreSQL.Customer360Store',
      input: {
        tenant_id: TENANT_ID,
        customer_identifier: CUSTOMER_ID,
      },
      context: {
        run_id: 'run-1',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-01' as const,
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-0' as const,
        effect_key: 'effect-read-evidence',
      },
    });

    expect(output).toEqual({
      customer_id: CUSTOMER_ID,
      total_orders: 2,
      lifetime_value: 120,
      verified: true,
      rfm_segment: 'LOYAL',
      last_order_date: '2026-09-24T15:30:00.000Z',
    });
  });

  it('binds an advisor recommendation to the SKU this run actually searched and verified', async () => {
    const advisor_state = new SalesAdvisorExecutionState();
    advisor_state.setRequirements(TENANT_ID, CORRELATION_ID, {
      category: 'accessories',
      budget: { amount: 100, currency: 'TWD' },
      use_case: 'accessories',
    });
    const erp_read: ErpReadPort = {
      read: vi.fn(async ({ resource, tenant_id, key }) => ({
        resource,
        tenant_id,
        observed_at: SNAPSHOT_AT,
        value: resource === 'products'
          ? {
              tenant_id,
              snapshot_at: SNAPSHOT_AT,
              items: [
                {
                  tenant_id,
                  product_id: 'product-alpha',
                  sku: 'AAA-1',
                  name: 'Alpha Misc',
                  currency: 'TWD',
                  original_list_price: 100,
                  is_active: true,
                  categories: ['misc'],
                },
                {
                  tenant_id,
                  product_id: 'product-1',
                  sku: 'SKU-1',
                  name: 'Accessory',
                  currency: 'TWD',
                  original_list_price: 100,
                  is_active: true,
                  categories: ['accessories'],
                },
              ],
            }
          : {
              tenant_id,
              snapshot_at: SNAPSHOT_AT,
              items: [{ tenant_id, sku_id: key, total_available_to_promise: 3 }],
            },
      })),
    };
    const services = createFullyBoundServices({ erp_read, advisor_state });

    const search = await services.tool_port.invoke({
      skill_id: 'skill.sales.search_product',
      tool_binding: 'API-001.CatalogConnector',
      input: { tenant_id: TENANT_ID, query: 'accessory', category_id: 'accessories', limit: 20 },
      context: {
        run_id: 'run-advisor-1',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02' as const,
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-1' as const,
        effect_key: 'effect-advisor-search',
      },
    });
    const searchPayload = search as unknown as Record<string, unknown>;
    expect(searchPayload['products']).toEqual([
      expect.objectContaining({ sku: 'SKU-1', in_stock: true }),
    ]);
    expect(advisor_state.candidateSkuFor(TENANT_ID, CORRELATION_ID)).toBe('SKU-1');

    const recommendation = await services.tool_port.invoke({
      skill_id: 'skill.sales.recommend_product',
      tool_binding: 'Core.RecommendationEngine',
      input: { tenant_id: TENANT_ID, customer_id: CUSTOMER_ID, current_cart_skus: [] },
      context: {
        run_id: 'run-advisor-1',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02' as const,
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-1' as const,
        effect_key: 'effect-advisor-recommend',
      },
    });

    // The alphabetically first catalog row is `AAA-1`; the recommendation must not leave the
    // evidence trail this run actually verified, so it stays on `SKU-1`.
    const recommendationPayload = recommendation as unknown as Record<string, unknown>;
    expect(recommendationPayload['product']).toMatchObject({ sku: 'SKU-1', price: 100 });
  });

  it('search_product and check_stock reject invalid inputs safely without throwing TypeError (B-71)', async () => {
    const services = createServices();
    const context = {
      run_id: 'run-test-b71',
      tenant_id: TENANT_ID,
      caller_agent: 'SAL-02' as const,
      correlation_id: CORRELATION_ID,
      granted_authority: 'AUTH-1' as const,
      effect_key: 'effect-test-b71',
    };

    await expect(
      services.tool_port.invoke({
        skill_id: 'skill.sales.search_product',
        tool_binding: 'API-001.CatalogConnector',
        input: { tenant_id: TENANT_ID, query: undefined as any },
        context,
      }),
    ).rejects.toMatchObject({ code: 'MALFORMED_QUERY' });

    await expect(
      services.tool_port.invoke({
        skill_id: 'skill.sales.search_product',
        tool_binding: 'API-001.CatalogConnector',
        input: { tenant_id: TENANT_ID, query: '   ' },
        context,
      }),
    ).rejects.toMatchObject({ code: 'MALFORMED_QUERY' });

    await expect(
      services.tool_port.invoke({
        skill_id: 'skill.sales.check_stock',
        tool_binding: 'API-001.InventoryConnector',
        input: { tenant_id: TENANT_ID, sku_id: undefined as any },
        context,
      }),
    ).rejects.toMatchObject({ code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });

    await expect(
      services.tool_port.invoke({
        skill_id: 'skill.sales.check_stock',
        tool_binding: 'API-001.InventoryConnector',
        input: { tenant_id: TENANT_ID, sku_id: '   ' },
        context,
      }),
    ).rejects.toMatchObject({ code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });

    await expect(
      services.tool_port.invoke({
        skill_id: 'skill.sales.check_stock',
        tool_binding: 'API-001.InventoryConnector',
        input: null as any,
        context,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
