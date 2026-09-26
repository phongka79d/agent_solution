import { computeEffectKey } from '@agentos/core-engine';
import type { ActionDraft } from '@agentos/core-engine/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { Customer360Fact } from '@agentos/core-engine/contracts';
import type { CustomerEventTimeline } from '@agentos/database';
import type { ErpReadPort } from '../../connectors.js';
import { SalesContextAggregator } from '../context-aggregator.js';
import type { AssignableAuthority } from '@agentos/core-engine/contracts';
import {
  createSalesSkillServices,
  resolveEnabledSalesSkills,
  GATE_SALES_SKILLS,
  ENABLED_SALES_SKILLS,
  computeQuoteToken,
  type SalesCartPort,
  type SalesCommunicationOutput,
  type SalesCommunicationPort,
  type SalesConsentPort,
  type SalesCustomer360Fact,
  type SalesFrequencyCapConfig,
  type SalesFrequencyCapPort,
  type SalesOrderPort,
  type SalesPaymentPolicyPort,
  type SalesPriceFloorApproved,
  type SalesPriceFloorDecision,
  type SalesPriceFloorPort,
  type SalesPriceFloorRefused,
  type SalesQuotePort,
  type SalesRecommendationRevenueEvidencePort,
  type SalesReplenishmentPolicyPort,
} from './index.js';

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
    resolve_grant: vi.fn(async () => 'AUTH-3'),
    quote_signing_secret: overrides.quote_signing_secret ?? TEST_QUOTE_SECRET,
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

  it('check_price: enforces floor invariant and refuses unapproved or missing floor decisions', async () => {
    const services = createFullyBoundServices();

    // 1. Discount pushing final_price below p_floor yields discount_allowed = false and final_price = list_price
    const breachOutput = await services.tool_port.invoke({
      skill_id: 'skill.sales.check_price',
      tool_binding: 'API-001.PricingEngine',
      input: {
        tenant_id: TENANT_ID,
        sku_id: 'SKU-1',
        customer_id: CUSTOMER_ID,
        requested_discount_percent: 30, // 100 * 0.7 = 70 < p_floor (80)
      },
      context: {
        run_id: 'run-1',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02' as const,
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3' as const,
        effect_key: 'effect-price-1',
      },
    });
    expect(breachOutput).toMatchObject({
      sku_id: 'SKU-1',
      list_price: 100,
      final_price: 100,
      p_floor: 80,
      discount_allowed: false,
      currency: 'TWD',
    });
    // Internal costs/provenance must NOT be exposed in customer-facing output
    expect(breachOutput).not.toHaveProperty('floor_source');
    expect(breachOutput).not.toHaveProperty('cogs');

    // 2. Unapproved floor decision refuses with P_FLOOR_UNAVAILABLE
    const unapprovedServices = createServices({
      price_floor: {
        read: vi.fn(async () => ({
          ok: false as const,
          owner_approved: false as const,
          reason: 'Owner has not approved pricing floor for tenant',
        })),
      },
    });
    await expect(unapprovedServices.tool_port.invoke({
      skill_id: 'skill.sales.check_price',
      tool_binding: 'API-001.PricingEngine',
      input: { tenant_id: TENANT_ID, sku_id: 'SKU-1', customer_id: CUSTOMER_ID },
      context: {
        run_id: 'run-1',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02' as const,
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3' as const,
        effect_key: 'effect-price-2',
      },
    })).rejects.toMatchObject({ code: 'P_FLOOR_UNAVAILABLE' });

    // 3. Floor decision missing provenance refuses with P_FLOOR_UNAVAILABLE
    const noProvenanceServices = createFullyBoundServices({
      priceFloorOverrides: { floor_source: '' },
    });
    await expect(noProvenanceServices.tool_port.invoke({
      skill_id: 'skill.sales.check_price',
      tool_binding: 'API-001.PricingEngine',
      input: { tenant_id: TENANT_ID, sku_id: 'SKU-1', customer_id: CUSTOMER_ID },
      context: {
        run_id: 'run-1',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02' as const,
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3' as const,
        effect_key: 'effect-price-3',
      },
    })).rejects.toMatchObject({ code: 'P_FLOOR_UNAVAILABLE' });
  });

  it('create_cart: enforces effect_key, verifies inventory stock, and checks floor provenance on discounts', async () => {
    const services = createFullyBoundServices();

    // 1. Missing effect key refuses EFFECT_KEY_REQUIRED
    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.create_cart',
      tool_binding: 'API-002.CommerceCartAPI',
      input: {
        tenant_id: TENANT_ID,
        session_id: 'session-1',
        items: [{ sku_id: 'SKU-1', quantity: 1 }],
        idempotency_key: 'idemp-1',
      },
      context: {
        run_id: 'run-1',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02' as const,
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3' as const,
        effect_key: '',
      },
    })).rejects.toMatchObject({ code: 'EFFECT_KEY_REQUIRED' });

    // 2. Insufficient stock refuses OUT_OF_STOCK (total_available_to_promise is 3 in mock, requesting 10)
    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.create_cart',
      tool_binding: 'API-002.CommerceCartAPI',
      input: {
        tenant_id: TENANT_ID,
        session_id: 'session-1',
        items: [{ sku_id: 'SKU-1', quantity: 10 }],
        idempotency_key: 'idemp-2',
      },
      context: {
        run_id: 'run-1',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02' as const,
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3' as const,
        effect_key: 'effect-cart-2',
      },
    })).rejects.toMatchObject({ code: 'OUT_OF_STOCK' });

    // 3. Discount-sensitive payload without owner-approved floor provenance refuses P_FLOOR_UNAVAILABLE
    const cartWithoutFloorProvenance = createFullyBoundServices({
      priceFloorOverrides: { ok: false, owner_approved: false, reason: 'Floor unapproved' },
    });
    await expect(cartWithoutFloorProvenance.tool_port.invoke({
      skill_id: 'skill.sales.create_cart',
      tool_binding: 'API-002.CommerceCartAPI',
      input: {
        tenant_id: TENANT_ID,
        session_id: 'session-1',
        items: [{ sku_id: 'SKU-1', quantity: 1 }],
        idempotency_key: 'idemp-3',
        discount_percent: 15,
      },
      context: {
        run_id: 'run-1',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02' as const,
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3' as const,
        effect_key: 'effect-cart-3',
      },
    })).rejects.toMatchObject({ code: 'P_FLOOR_UNAVAILABLE' });
  });

  it('create_order: enforces effect_key and derives total_amount from port without price synthesis', async () => {
    const orderPortMock = createOrderPort();
    const cartPortMock = createCartPort();
    const services = createServices({
      order: orderPortMock,
      cart: cartPortMock,
    });

    // 1. Missing effect key refuses EFFECT_KEY_REQUIRED
    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.create_order',
      tool_binding: 'API-001.OrderConnector',
      input: {
        tenant_id: TENANT_ID,
        cart_id: 'cart-1',
        customer_id: CUSTOMER_ID,
        shipping_address: { street: 'Test' },
        payment_method: 'CREDIT_CARD',
        effect_key: '',
      },
      context: {
        run_id: 'run-1',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02' as const,
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3' as const,
        effect_key: '',
      },
    })).rejects.toMatchObject({ code: 'EFFECT_KEY_REQUIRED' });

    // 2. Succeeds when effect_key present and takes price verbatim from orderPort
    const orderOutput = await services.tool_port.invoke({
      skill_id: 'skill.sales.create_order',
      tool_binding: 'API-001.OrderConnector',
      input: {
        tenant_id: TENANT_ID,
        cart_id: 'cart-1',
        customer_id: CUSTOMER_ID,
        shipping_address: { street: 'Test' },
        payment_method: 'CREDIT_CARD',
        effect_key: 'effect-order-1',
      },
      context: {
        run_id: 'run-1',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02' as const,
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3' as const,
        effect_key: 'effect-order-1',
      },
    });
    expect(orderOutput).toEqual({
      order_id: 'order-00000000-0000-4000-8000-000000000001',
      order_number: 'ORD-2026-0001',
      total_amount: 100,
      currency: 'TWD',
      status: 'PENDING_PAYMENT',
      payment_url: 'https://pay.example.com/checkout/ord-1',
      created_at: '2026-09-24T10:00:00.000Z',
    });
  });

  it('create_order: post-dispatch reconciliation refuses when order port returned total differs from authoritative quote', async () => {
    const orderPortMock = createOrderPort({ total_amount: 150 });
    const createOrderSpy = vi.spyOn(orderPortMock, 'createOrder');
    const cartPortMock = createCartPort({ subtotal: 100 });
    const services = createServices({
      order: orderPortMock,
      cart: cartPortMock,
    });

    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.create_order',
      tool_binding: 'API-001.OrderConnector',
      input: {
        tenant_id: TENANT_ID,
        cart_id: 'cart-1',
        customer_id: CUSTOMER_ID,
        shipping_address: { street: 'Test St' },
        payment_method: 'CREDIT_CARD',
        effect_key: 'effect-tampered-price',
      },
      context: {
        run_id: 'run-tamper-1',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-tampered-price',
      },
    })).rejects.toMatchObject({
      code: 'PRICE_MISMATCH',
      message: expect.stringContaining('does not match authoritative quote'),
    });

    // Post-dispatch integrity check: order creation was attempted once, but on total mismatch refusal, the order is not treated as created
    expect(createOrderSpy).toHaveBeenCalledTimes(1);
  });

  it('create_order: post-dispatch reconciliation refuses when order port returned currency differs from authoritative quote', async () => {
    const orderPortMock = createOrderPort({ total_amount: 100, currency: 'USD' });
    const createOrderSpy = vi.spyOn(orderPortMock, 'createOrder');
    const cartPortMock = createCartPort({ subtotal: 100, currency: 'TWD' });
    const services = createServices({
      order: orderPortMock,
      cart: cartPortMock,
    });

    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.create_order',
      tool_binding: 'API-001.OrderConnector',
      input: {
        tenant_id: TENANT_ID,
        cart_id: 'cart-1',
        customer_id: CUSTOMER_ID,
        shipping_address: { street: 'Test St' },
        payment_method: 'CREDIT_CARD',
        effect_key: 'effect-tampered-currency',
      },
      context: {
        run_id: 'run-tamper-curr',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-tampered-currency',
      },
    })).rejects.toMatchObject({
      code: 'PRICE_MISMATCH',
    });
    // Post-dispatch integrity check: order creation was attempted once, but on currency mismatch refusal, the order is not treated as created
    expect(createOrderSpy).toHaveBeenCalledTimes(1);
  });

  it('create_order: refuses caller-supplied total differing from authoritative quote before ERP dispatch with zero ERP calls', async () => {
    const orderPortMock = createOrderPort({ total_amount: 100 });
    const createOrderSpy = vi.spyOn(orderPortMock, 'createOrder');
    const cartPortMock = createCartPort({ subtotal: 100 });
    const services = createServices({
      order: orderPortMock,
      cart: cartPortMock,
    });

    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.create_order',
      tool_binding: 'API-001.OrderConnector',
      input: {
        tenant_id: TENANT_ID,
        cart_id: 'cart-1',
        customer_id: CUSTOMER_ID,
        shipping_address: { street: 'Test St' },
        payment_method: 'CREDIT_CARD',
        effect_key: 'effect-caller-supplied-price',
        total_amount: 50,
      } as unknown as Record<string, unknown>,
      context: {
        run_id: 'run-csp-1',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-caller-supplied-price',
      },
    })).rejects.toMatchObject({
      code: 'PRICE_MISMATCH',
      message: expect.stringContaining('Caller-supplied total'),
    });

    // Rejected before ERP dispatch
    expect(createOrderSpy).not.toHaveBeenCalled();
  });

  it('create_order: refuses unsupported payment method before dispatch with zero ERP calls; supported one proceeds', async () => {
    const orderPortMock = createOrderPort({
      supported_payment_methods: ['CREDIT_CARD', 'LINE_PAY'],
    });
    const createOrderSpy = vi.spyOn(orderPortMock, 'createOrder');
    const cartPortMock = createCartPort({ subtotal: 100 });
    const services = createServices({
      order: orderPortMock,
      cart: cartPortMock,
    });

    // 1. Unsupported method CVS_COD -> rejected before dispatch, 0 ERP calls
    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.create_order',
      tool_binding: 'API-001.OrderConnector',
      input: {
        tenant_id: TENANT_ID,
        cart_id: 'cart-1',
        customer_id: CUSTOMER_ID,
        shipping_address: { street: 'Test St' },
        payment_method: 'CVS_COD',
        effect_key: 'effect-unsupported-pm',
      },
      context: {
        run_id: 'run-pm-1',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-unsupported-pm',
      },
    })).rejects.toMatchObject({
      code: 'PAYMENT_METHOD_UNSUPPORTED',
      message: expect.stringContaining('CVS_COD'),
    });
    expect(createOrderSpy).not.toHaveBeenCalled();

    // 2. Supported method CREDIT_CARD -> proceeds with dispatch
    const output = await services.tool_port.invoke({
      skill_id: 'skill.sales.create_order',
      tool_binding: 'API-001.OrderConnector',
      input: {
        tenant_id: TENANT_ID,
        cart_id: 'cart-1',
        customer_id: CUSTOMER_ID,
        shipping_address: { street: 'Test St' },
        payment_method: 'CREDIT_CARD',
        effect_key: 'effect-supported-pm',
      },
      context: {
        run_id: 'run-pm-2',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-supported-pm',
      },
    });
    expect(createOrderSpy).toHaveBeenCalledTimes(1);
    expect(output).toMatchObject({
      order_id: 'order-00000000-0000-4000-8000-000000000001',
      total_amount: 100,
    });
  });

  it('create_order: refuses with AUTHORITATIVE_SOURCE_UNAVAILABLE and reports unbound when quote source is unbound or fails', async () => {
    // 1. Completely unbound quote dependency
    const orderPortMock = createOrderPort();
    const createOrderSpy = vi.spyOn(orderPortMock, 'createOrder');
    const unboundQuoteServices = createServices({
      order: orderPortMock,
    });

    expect(unboundQuoteServices.registry.resolve('skill.sales.create_order').enabled).toBe(false);
    expect(unboundQuoteServices.enabled_skills?.has('skill.sales.create_order')).toBe(false);
    expect(unboundQuoteServices.unbound).toContain(
      'API-002.CommerceCartAPI quote: no authoritative quote/cart port is bound; skill.sales.create_order refuses',
    );

    await expect(unboundQuoteServices.tool_port.invoke({
      skill_id: 'skill.sales.create_order',
      tool_binding: 'API-001.OrderConnector',
      input: {
        tenant_id: TENANT_ID,
        cart_id: 'cart-1',
        customer_id: CUSTOMER_ID,
        shipping_address: { street: 'Test St' },
        payment_method: 'CREDIT_CARD',
        effect_key: 'effect-unbound-quote',
      },
      context: {
        run_id: 'run-uq-1',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-unbound-quote',
      },
    })).rejects.toMatchObject({
      code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE',
    });
    expect(createOrderSpy).not.toHaveBeenCalled();

    // 2. Quote read throws
    const throwingCartPort: SalesCartPort = {
      getCart: vi.fn(async () => {
        throw new Error('CommerceCart database timeout');
      }),
    };
    const throwingQuoteServices = createServices({
      order: orderPortMock,
      cart: throwingCartPort,
    });
    await expect(throwingQuoteServices.tool_port.invoke({
      skill_id: 'skill.sales.create_order',
      tool_binding: 'API-001.OrderConnector',
      input: {
        tenant_id: TENANT_ID,
        cart_id: 'cart-1',
        customer_id: CUSTOMER_ID,
        shipping_address: { street: 'Test St' },
        payment_method: 'CREDIT_CARD',
        effect_key: 'effect-throwing-quote',
      },
      context: {
        run_id: 'run-tq-1',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-throwing-quote',
      },
    })).rejects.toMatchObject({
      code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      message: expect.stringContaining('CommerceCart database timeout'),
    });
    expect(createOrderSpy).not.toHaveBeenCalled();
  });

  it('create_order: refuses with AUTHORITATIVE_SOURCE_UNAVAILABLE and reports unbound when payment policy is unbound or fails', async () => {
    const bareOrderPort: SalesOrderPort = {
      createOrder: vi.fn(async () => ({
        order_id: 'order-1',
        order_number: 'ORD-1',
        total_amount: 100,
        currency: 'TWD',
        status: 'PENDING_PAYMENT' as const,
        created_at: '2026-09-24T10:00:00.000Z',
      })),
    };
    const createOrderSpy = vi.spyOn(bareOrderPort, 'createOrder');
    const cartPortMock = createCartPort();
    const unboundPolicyServices = createServices({
      order: bareOrderPort,
      cart: cartPortMock,
    });

    expect(unboundPolicyServices.registry.resolve('skill.sales.create_order').enabled).toBe(false);
    expect(unboundPolicyServices.enabled_skills?.has('skill.sales.create_order')).toBe(false);
    expect(unboundPolicyServices.unbound).toContain(
      'SalesPaymentPolicy: no payment policy port is bound; skill.sales.create_order refuses',
    );

    await expect(unboundPolicyServices.tool_port.invoke({
      skill_id: 'skill.sales.create_order',
      tool_binding: 'API-001.OrderConnector',
      input: {
        tenant_id: TENANT_ID,
        cart_id: 'cart-1',
        customer_id: CUSTOMER_ID,
        shipping_address: { street: 'Test St' },
        payment_method: 'CREDIT_CARD',
        effect_key: 'effect-unbound-policy',
      },
      context: {
        run_id: 'run-up-1',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-unbound-policy',
      },
    })).rejects.toMatchObject({
      code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE',
    });
    expect(createOrderSpy).not.toHaveBeenCalled();
  });

  it('create_order: strictly uses tenant payment policy and never hardcodes methods or platform defaults', async () => {
    const tenantAPolicy: SalesPaymentPolicyPort = {
      readSupportedPaymentMethods: vi.fn(async () => ['PAYPAL']),
    };
    const orderPortMock = createOrderPort();
    const createOrderSpy = vi.spyOn(orderPortMock, 'createOrder');
    const cartPortMock = createCartPort();
    const services = createServices({
      order: orderPortMock,
      cart: cartPortMock,
      payment_policy: tenantAPolicy,
    });

    // CREDIT_CARD (which is valid in canonical union) must be refused because tenant A only allows PAYPAL
    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.create_order',
      tool_binding: 'API-001.OrderConnector',
      input: {
        tenant_id: TENANT_ID,
        cart_id: 'cart-1',
        customer_id: CUSTOMER_ID,
        shipping_address: { street: 'Test St' },
        payment_method: 'CREDIT_CARD',
        effect_key: 'effect-tenant-pm',
      },
      context: {
        run_id: 'run-tpm-1',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-tenant-pm',
      },
    })).rejects.toMatchObject({
      code: 'PAYMENT_METHOD_UNSUPPORTED',
    });
    expect(createOrderSpy).not.toHaveBeenCalled();

    // PAYPAL succeeds
    await services.tool_port.invoke({
      skill_id: 'skill.sales.create_order',
      tool_binding: 'API-001.OrderConnector',
      input: {
        tenant_id: TENANT_ID,
        cart_id: 'cart-1',
        customer_id: CUSTOMER_ID,
        shipping_address: { street: 'Test St' },
        payment_method: 'PAYPAL',
        effect_key: 'effect-tenant-pm-2',
      },
      context: {
        run_id: 'run-tpm-2',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-tenant-pm-2',
      },
    });
    expect(createOrderSpy).toHaveBeenCalledTimes(1);
  });

  it('send_message: enforces consent, suppression, human takeover, and tenant frequency cap in strict order', async () => {
    const msgInput = {
      tenant_id: TENANT_ID,
      recipient_id: CUSTOMER_ID,
      channel: 'LINE' as const,
      message_content: { text: 'Reminder' },
      effect_key: 'effect-msg-1',
    };
    const msgContext = {
      run_id: 'run-1',
      tenant_id: TENANT_ID,
      caller_agent: 'SAL-02' as const,
      correlation_id: CORRELATION_ID,
      granted_authority: 'AUTH-3' as const,
      effect_key: 'effect-msg-1',
    };

    // 1. Missing channel consent -> CONSENT_REQUIRED (preempts suppression, takeover, frequency cap)
    const noConsentServices = createFullyBoundServices({
      consentOverrides: { consented: false, suppressed: true, reason: 'No consent for LINE' },
      takeoverActive: true,
      frequencyCapConfig: { allowed: false, remaining: 0 },
    });
    await expect(noConsentServices.tool_port.invoke({
      skill_id: 'skill.sales.send_message',
      tool_binding: 'API-003.CommunicationConnector',
      input: msgInput,
      context: msgContext,
    })).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });

    // 2. Active suppression -> CONSENT_REQUIRED carrying suppression reason (preempts takeover and frequency cap)
    const suppressedServices = createFullyBoundServices({
      consentOverrides: { consented: true, suppressed: true, reason: 'Recipient in cooldown' },
      takeoverActive: true,
      frequencyCapConfig: { allowed: false, remaining: 0 },
    });
    await expect(suppressedServices.tool_port.invoke({
      skill_id: 'skill.sales.send_message',
      tool_binding: 'API-003.CommunicationConnector',
      input: msgInput,
      context: msgContext,
    })).rejects.toMatchObject({ code: 'CONSENT_REQUIRED', message: expect.stringContaining('Recipient in cooldown') });

    // 3. Human takeover -> HUMAN_TAKEOVER (preempts frequency cap)
    const takeoverServices = createFullyBoundServices({
      takeoverActive: true,
      frequencyCapConfig: { allowed: false, remaining: 0 },
    });
    await expect(takeoverServices.tool_port.invoke({
      skill_id: 'skill.sales.send_message',
      tool_binding: 'API-003.CommunicationConnector',
      input: msgInput,
      context: msgContext,
    })).rejects.toMatchObject({ code: 'HUMAN_TAKEOVER' });
    // 4. Missing tenant frequency cap configuration -> FREQUENCY_CAP_UNAVAILABLE (never a platform default)
    const noCapServices = createServices({
      communication: createCommunicationPort(),
      consent: createConsentPort(),
      takeover_active: false,
      frequency_cap: { read: vi.fn(async () => undefined) },
    });
    await expect(noCapServices.tool_port.invoke({
      skill_id: 'skill.sales.send_message',
      tool_binding: 'API-003.CommunicationConnector',
      input: msgInput,
      context: msgContext,
    })).rejects.toMatchObject({ code: 'FREQUENCY_CAP_UNAVAILABLE' });

    // 5. Tenant frequency cap exceeded -> FREQUENCY_CAP_EXCEEDED
    const capExceededServices = createFullyBoundServices({
      frequencyCapConfig: { allowed: false, remaining: 0 },
    });
    await expect(capExceededServices.tool_port.invoke({
      skill_id: 'skill.sales.send_message',
      tool_binding: 'API-003.CommunicationConnector',
      input: msgInput,
      context: msgContext,
    })).rejects.toMatchObject({ code: 'FREQUENCY_CAP_EXCEEDED' });

    // 6. All cleared -> sends message
    const validServices = createFullyBoundServices();
    const msgOutput = await validServices.tool_port.invoke({
      skill_id: 'skill.sales.send_message',
      tool_binding: 'API-003.CommunicationConnector',
      input: msgInput,
      context: msgContext,
    });
    expect(msgOutput).toEqual({
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

  it('exports GATE_SALES_SKILLS, ENABLED_SALES_SKILLS, and resolveEnabledSalesSkills', () => {
    expect(GATE_SALES_SKILLS.size).toBe(8);
    expect(ENABLED_SALES_SKILLS).toBe(GATE_SALES_SKILLS);

    const emptyResolved = resolveEnabledSalesSkills({
      erp_read: null,
      context: { verifiedCustomerFor: vi.fn(), verifiedTimelineFor: vi.fn() },
      resolve_correlation_id: vi.fn(),
      resolve_grant: vi.fn(),
    });
    // Read rows kept enabled, new rows disabled
    expect(emptyResolved.has('skill.sales.search_product')).toBe(true);
    expect(emptyResolved.has('skill.sales.check_price')).toBe(false);
    expect(emptyResolved.has('skill.sales.create_cart')).toBe(false);
    expect(emptyResolved.has('skill.sales.create_order')).toBe(false);
    expect(emptyResolved.has('skill.sales.send_message')).toBe(false);

    const withPriceOnlyResolved = resolveEnabledSalesSkills({
      erp_read: null,
      context: { verifiedCustomerFor: vi.fn(), verifiedTimelineFor: vi.fn() },
      resolve_correlation_id: vi.fn(),
      resolve_grant: vi.fn(),
      price_floor: createPriceFloorPort(),
    });
    expect(withPriceOnlyResolved.has('skill.sales.check_price')).toBe(false);

    const withPriceResolved = resolveEnabledSalesSkills({
      erp_read: null,
      context: { verifiedCustomerFor: vi.fn(), verifiedTimelineFor: vi.fn() },
      resolve_correlation_id: vi.fn(),
      resolve_grant: vi.fn(),
      price_floor: createPriceFloorPort(),
      quote_signing_secret: TEST_QUOTE_SECRET,
    });
    expect(withPriceResolved.has('skill.sales.check_price')).toBe(true);
    expect(withPriceResolved.has('skill.sales.create_cart')).toBe(false);

    // send_message requires communication, consent, frequency cap, AND takeover authority
    const withoutTakeoverResolved = resolveEnabledSalesSkills({
      erp_read: null,
      context: { verifiedCustomerFor: vi.fn(), verifiedTimelineFor: vi.fn() },
      resolve_correlation_id: vi.fn(),
      resolve_grant: vi.fn(),
      communication: createCommunicationPort(),
      consent: createConsentPort(),
      frequency_cap: createFrequencyCapPort(),
    });
    expect(withoutTakeoverResolved.has('skill.sales.send_message')).toBe(false);

    const withTakeoverResolved = resolveEnabledSalesSkills({
      erp_read: null,
      context: { verifiedCustomerFor: vi.fn(), verifiedTimelineFor: vi.fn() },
      resolve_correlation_id: vi.fn(),
      resolve_grant: vi.fn(),
      communication: createCommunicationPort(),
      consent: createConsentPort(),
      frequency_cap: createFrequencyCapPort(),
      takeover_active: false,
    });
    expect(withTakeoverResolved.has('skill.sales.send_message')).toBe(true);

    // create_order requires order, quote, and payment policy
    const withOrderOnly = resolveEnabledSalesSkills({
      erp_read: null,
      context: { verifiedCustomerFor: vi.fn(), verifiedTimelineFor: vi.fn() },
      resolve_correlation_id: vi.fn(),
      resolve_grant: vi.fn(),
      order: createOrderPort(),
    });
    expect(withOrderOnly.has('skill.sales.create_order')).toBe(false);

    const withOrderAndCart = resolveEnabledSalesSkills({
      erp_read: null,
      context: { verifiedCustomerFor: vi.fn(), verifiedTimelineFor: vi.fn() },
      resolve_correlation_id: vi.fn(),
      resolve_grant: vi.fn(),
      order: createOrderPort(),
      cart: createCartPort(),
    });
    expect(withOrderAndCart.has('skill.sales.create_order')).toBe(true);
  });
  it('SalesConsentPort: exposes customer-level read (getConsent) as well as channel-specific read (read) from same boundary', async () => {
    const consentPort = createConsentPort({
      consented: true,
      suppressed: false,
      consent_marketing: true,
      suppression_active: false,
    });

    const channelDecision = await consentPort.read({
      tenant_id: TENANT_ID,
      customer_id: CUSTOMER_ID,
      channel: 'LINE',
    });
    expect(channelDecision.consented).toBe(true);
    expect(channelDecision.suppressed).toBe(false);

    const customerConsent = await consentPort.getConsent({
      tenant_id: TENANT_ID,
      customer_id: CUSTOMER_ID,
    });
    expect(customerConsent).toEqual({
      consent_marketing: true,
      suppression_active: false,
    });
  });

  it('send_message: enforces human takeover fail-closed invariants across all authority shapes', async () => {
    const msgInput = {
      tenant_id: TENANT_ID,
      recipient_id: CUSTOMER_ID,
      channel: 'LINE' as const,
      message_content: { text: 'Exclusive offer' },
      effect_key: 'effect-takeover-1',
    };
    const msgContext = {
      run_id: 'run-1',
      tenant_id: TENANT_ID,
      caller_agent: 'SAL-02' as const,
      correlation_id: CORRELATION_ID,
      granted_authority: 'AUTH-3' as const,
      effect_key: 'effect-takeover-1',
    };

    // 1. With NO takeover authority bound:
    // a) skill is disabled and reported unbound
    const commPortMock = createCommunicationPort();
    const sendSpy = vi.spyOn(commPortMock, 'sendMessage');
    const unboundServices = createServices({
      communication: commPortMock,
      consent: createConsentPort(),
      frequency_cap: createFrequencyCapPort(),
    });
    expect(unboundServices.registry.resolve('skill.sales.send_message').enabled).toBe(false);
    expect(unboundServices.enabled_skills?.has('skill.sales.send_message')).toBe(false);
    expect(unboundServices.unbound).toContain(
      'SalesTakeover: no takeover authority is bound; skill.sales.send_message refuses',
    );

    // b) dispatch refuses with SKILL_DISABLED, zero adapter dispatches
    await expect(
      unboundServices.dispatcher.dispatch({
        action_id: '00000000-0000-0000-0000-000000000099',
        run_id: 'run-1',
        tenant_id: TENANT_ID,
        agent_id: 'SAL-02',
        skill_id: 'skill.sales.send_message',
        adapter_target: 'API-003.CommunicationConnector',
        step_index: 1,
        mutating: true,
        price_bearing: false,
        request_id: 'req-takeover-unbound',
        action_revision: 0,
        effect_key: 'effect-takeover-1',
        required_authority: 'AUTH-3',
        payload: msgInput,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_DISABLED' });
    expect(sendSpy).not.toHaveBeenCalled();

    // c) tool_port.invoke directly refuses with HUMAN_TAKEOVER stating authority is unbound, zero adapter dispatches
    await expect(
      unboundServices.tool_port.invoke({
        skill_id: 'skill.sales.send_message',
        tool_binding: 'API-003.CommunicationConnector',
        input: msgInput,
        context: msgContext,
      }),
    ).rejects.toMatchObject({
      code: 'HUMAN_TAKEOVER',
      message: expect.stringContaining('unbound'),
    });
    expect(sendSpy).not.toHaveBeenCalled();

    // 2. With bound takeover authority reporting active hold:
    // a) via takeover_active: true -> refused HUMAN_TAKEOVER, zero adapter dispatches
    const activeFlagComm = createCommunicationPort();
    const activeFlagSpy = vi.spyOn(activeFlagComm, 'sendMessage');
    const activeFlagServices = createFullyBoundServices({
      takeoverActive: true,
    });
    await expect(
      activeFlagServices.tool_port.invoke({
        skill_id: 'skill.sales.send_message',
        tool_binding: 'API-003.CommunicationConnector',
        input: msgInput,
        context: msgContext,
      }),
    ).rejects.toMatchObject({
      code: 'HUMAN_TAKEOVER',
      message: expect.stringContaining('active session lock'),
    });
    expect(activeFlagSpy).not.toHaveBeenCalled();

    // b) via is_takeover_active function returning true -> refused HUMAN_TAKEOVER, zero adapter dispatches
    const activeFnComm = createCommunicationPort();
    const activeFnSpy = vi.spyOn(activeFnComm, 'sendMessage');
    const activeFnServices = createServices({
      communication: activeFnComm,
      consent: createConsentPort(),
      frequency_cap: createFrequencyCapPort(),
      is_takeover_active: vi.fn(async () => true),
    });
    expect(activeFnServices.registry.resolve('skill.sales.send_message').enabled).toBe(true);
    await expect(
      activeFnServices.tool_port.invoke({
        skill_id: 'skill.sales.send_message',
        tool_binding: 'API-003.CommunicationConnector',
        input: msgInput,
        context: msgContext,
      }),
    ).rejects.toMatchObject({
      code: 'HUMAN_TAKEOVER',
      message: expect.stringContaining('active session lock'),
    });
    expect(activeFnSpy).not.toHaveBeenCalled();

    // c) via context reader takeoverActiveFor returning true -> refused HUMAN_TAKEOVER, zero adapter dispatches
    const activeCtxComm = createCommunicationPort();
    const activeCtxSpy = vi.spyOn(activeCtxComm, 'sendMessage');
    const activeCtxServices = createSalesSkillServices({
      erp_read: createErpRead(),
      context: {
        verifiedCustomerFor: vi.fn(async () => customer),
        verifiedTimelineFor: vi.fn(async () => timeline),
        takeoverActiveFor: vi.fn(async () => true),
      },
      communication: activeCtxComm,
      consent: createConsentPort(),
      frequency_cap: createFrequencyCapPort(),
      resolve_correlation_id: vi.fn(async () => CORRELATION_ID),
      resolve_grant: vi.fn(async () => 'AUTH-3'),
    });
    expect(activeCtxServices.registry.resolve('skill.sales.send_message').enabled).toBe(true);
    await expect(
      activeCtxServices.tool_port.invoke({
        skill_id: 'skill.sales.send_message',
        tool_binding: 'API-003.CommunicationConnector',
        input: msgInput,
        context: msgContext,
      }),
    ).rejects.toMatchObject({
      code: 'HUMAN_TAKEOVER',
      message: expect.stringContaining('active session lock'),
    });
    expect(activeCtxSpy).not.toHaveBeenCalled();

    // 3. With bound takeover authority reporting no hold:
    // a) via takeover_active: false -> dispatches successfully
    const inactiveFlagComm = createCommunicationPort();
    const inactiveFlagSpy = vi.spyOn(inactiveFlagComm, 'sendMessage');
    const inactiveFlagServices = createServices({
      communication: inactiveFlagComm,
      consent: createConsentPort(),
      frequency_cap: createFrequencyCapPort(),
      takeover_active: false,
    });
    expect(inactiveFlagServices.registry.resolve('skill.sales.send_message').enabled).toBe(true);
    const inactiveFlagOutput = await inactiveFlagServices.tool_port.invoke({
      skill_id: 'skill.sales.send_message',
      tool_binding: 'API-003.CommunicationConnector',
      input: msgInput,
      context: msgContext,
    });
    expect(inactiveFlagOutput).toMatchObject({
      message_id: 'msg-00000000-0000-4000-8000-000000000001',
      provider_reference: 'line:ref-12345',
    });
    expect(inactiveFlagSpy).toHaveBeenCalledTimes(1);

    // b) via is_takeover_active function returning false -> dispatches successfully
    const inactiveFnComm = createCommunicationPort();
    const inactiveFnSpy = vi.spyOn(inactiveFnComm, 'sendMessage');
    const inactiveFnServices = createServices({
      communication: inactiveFnComm,
      consent: createConsentPort(),
      frequency_cap: createFrequencyCapPort(),
      is_takeover_active: vi.fn(async () => false),
    });
    expect(inactiveFnServices.registry.resolve('skill.sales.send_message').enabled).toBe(true);
    const inactiveFnOutput = await inactiveFnServices.tool_port.invoke({
      skill_id: 'skill.sales.send_message',
      tool_binding: 'API-003.CommunicationConnector',
      input: msgInput,
      context: msgContext,
    });
    expect(inactiveFnOutput).toMatchObject({
      message_id: 'msg-00000000-0000-4000-8000-000000000001',
      provider_reference: 'line:ref-12345',
    });
    expect(inactiveFnSpy).toHaveBeenCalledTimes(1);

    // c) via context reader takeoverActiveFor returning false -> dispatches successfully
    const inactiveCtxComm = createCommunicationPort();
    const inactiveCtxSpy = vi.spyOn(inactiveCtxComm, 'sendMessage');
    const inactiveCtxServices = createSalesSkillServices({
      erp_read: createErpRead(),
      context: {
        verifiedCustomerFor: vi.fn(async () => customer),
        verifiedTimelineFor: vi.fn(async () => timeline),
        takeoverActiveFor: vi.fn(async () => false),
      },
      communication: inactiveCtxComm,
      consent: createConsentPort(),
      frequency_cap: createFrequencyCapPort(),
      resolve_correlation_id: vi.fn(async () => CORRELATION_ID),
      resolve_grant: vi.fn(async () => 'AUTH-3'),
    });
    expect(inactiveCtxServices.registry.resolve('skill.sales.send_message').enabled).toBe(true);
    const inactiveCtxOutput = await inactiveCtxServices.tool_port.invoke({
      skill_id: 'skill.sales.send_message',
      tool_binding: 'API-003.CommunicationConnector',
      input: msgInput,
      context: msgContext,
    });
    expect(inactiveCtxOutput).toMatchObject({
      message_id: 'msg-00000000-0000-4000-8000-000000000001',
      provider_reference: 'line:ref-12345',
    });
    expect(inactiveCtxSpy).toHaveBeenCalledTimes(1);

    // 4. Failing closed when bound takeover reader throws
    const throwingFnServices = createServices({
      communication: createCommunicationPort(),
      consent: createConsentPort(),
      frequency_cap: createFrequencyCapPort(),
      is_takeover_active: vi.fn(async () => {
        throw new Error('Takeover service connection reset');
      }),
    });
    await expect(
      throwingFnServices.tool_port.invoke({
        skill_id: 'skill.sales.send_message',
        tool_binding: 'API-003.CommunicationConnector',
        input: msgInput,
        context: msgContext,
      }),
    ).rejects.toMatchObject({
      code: 'HUMAN_TAKEOVER',
      message: expect.stringContaining('active session lock'),
    });
  });

  it('send_message: with real SalesContextAggregator and sessionControl port, enforces hold, no-hold, and unverified correlation fail-closed', async () => {
    const isTakenOver = vi.fn(async (_tid: string, sessionId: string) => sessionId === 'held-session');
    const aggregator = new SalesContextAggregator({
      repositories: {
        getProfile: vi.fn(async () => ({
          customer_id: CUSTOMER_ID,
          tenant_id: TENANT_ID,
          verified_phone: null,
          verified_email: null,
          total_spent: '120.00',
          order_count: 2,
          rfm_segment_hypothesis: 'LOYAL',
          consent_marketing: true,
          consent_updated_at: new Date(SNAPSHOT_AT),
          suppression_active: false,
          line_user_id: null,
          created_at: new Date(SNAPSHOT_AT),
        })),
        listTimeline: vi.fn(async () => timeline),
      },
      sessionControl: { isTakenOver },
    });

    const commPort = createCommunicationPort();
    const sendSpy = vi.spyOn(commPort, 'sendMessage');
    const services = createSalesSkillServices({
      erp_read: createErpRead(),
      context: aggregator,
      communication: commPort,
      consent: createConsentPort(),
      frequency_cap: createFrequencyCapPort(),
      resolve_correlation_id: vi.fn(async () => 'test-corr'),
      resolve_grant: vi.fn(async () => 'AUTH-3'),
    });

    const baseInput = {
      tenant_id: TENANT_ID,
      recipient_id: CUSTOMER_ID,
      channel: 'WEB',
      message_content: { text: 'Test message' },
      effect_key: 'effect-takeover-e2e',
    };

    // 1. With operator hold on session -> refused HUMAN_TAKEOVER
    await aggregator.hydrateContext(TENANT_ID, { session_id: 'held-session', channel_type: 'web', verified_customer_id: CUSTOMER_ID }, 'corr-held');
    await expect(
      services.tool_port.invoke({
        skill_id: 'skill.sales.send_message',
        tool_binding: 'API-003.CommunicationConnector',
        input: baseInput,
        context: {
          run_id: 'run-1',
          tenant_id: TENANT_ID,
          correlation_id: 'corr-held',
          caller_agent: 'SAL-01',
          granted_authority: 'AUTH-3',
          effect_key: 'effect-takeover-e2e',
        },
      }),
    ).rejects.toMatchObject({
      code: 'HUMAN_TAKEOVER',
      message: expect.stringContaining('active session lock'),
    });
    expect(sendSpy).not.toHaveBeenCalled();

    // 2. With no hold on session -> proceeds
    await aggregator.hydrateContext(TENANT_ID, { session_id: 'free-session', channel_type: 'web', verified_customer_id: CUSTOMER_ID }, 'corr-free');
    const output = await services.tool_port.invoke({
      skill_id: 'skill.sales.send_message',
      tool_binding: 'API-003.CommunicationConnector',
      input: baseInput,
      context: {
        run_id: 'run-2',
        tenant_id: TENANT_ID,
        correlation_id: 'corr-free',
        caller_agent: 'SAL-01',
        granted_authority: 'AUTH-3',
        effect_key: 'effect-takeover-e2e',
      },
    });
    const sendOutput = output as SalesCommunicationOutput;
    expect(sendOutput.provider_reference).toBe('line:ref-12345');
    expect(sendSpy).toHaveBeenCalledOnce();

    // 3. With aggregator holding no verified state for the correlation -> fails closed
    await expect(
      services.tool_port.invoke({
        skill_id: 'skill.sales.send_message',
        tool_binding: 'API-003.CommunicationConnector',
        input: baseInput,
        context: {
          run_id: 'run-3',
          tenant_id: TENANT_ID,
          correlation_id: 'unverified-correlation-id',
          caller_agent: 'SAL-01',
          granted_authority: 'AUTH-3',
          effect_key: 'effect-takeover-e2e',
        },
      }),
    ).rejects.toMatchObject({
      code: 'HUMAN_TAKEOVER',
      message: expect.stringContaining('active session lock'),
    });
  });

  it('check_price: HMAC-SHA256 signs quote token with server secret binding tenant, sku, customer, price, floor, currency, and expiry', async () => {
    const services = createFullyBoundServices();
    const output = await services.tool_port.invoke({
      skill_id: 'skill.sales.check_price',
      tool_binding: 'API-001.PricingEngine',
      input: {
        tenant_id: TENANT_ID,
        sku_id: 'SKU-1',
        customer_id: CUSTOMER_ID,
      },
      context: {
        run_id: 'run-price-token-1',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-price-token-1',
      },
    });

    const quoteRecord = output as Record<string, unknown>;
    expect(typeof quoteRecord.quote_token).toBe('string');
    expect(quoteRecord.quote_token).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof quoteRecord.quote_expires_at).toBe('string');

    const expectedToken = computeQuoteToken(TEST_QUOTE_SECRET, {
      tenant_id: TENANT_ID,
      sku_id: 'SKU-1',
      customer_id: CUSTOMER_ID,
      final_price: 100,
      p_floor: 80,
      currency: 'TWD',
      quote_expires_at: quoteRecord.quote_expires_at as string,
    });

    expect(quoteRecord.quote_token).toBe(expectedToken);
    // Ensure secret value is never exposed in the returned payload
    expect(JSON.stringify(quoteRecord)).not.toContain(TEST_QUOTE_SECRET);
  });

  it('check_price: refuses with P_FLOOR_UNAVAILABLE and returns no token when signing secret is unbound', async () => {
    const services = createServices({
      price_floor: createPriceFloorPort(),
      quote_signing_secret: '',
    });

    expect(services.unbound).toContain(
      'QuoteSigningSecret: no quote signing secret is bound; skill.sales.check_price refuses',
    );

    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.check_price',
      tool_binding: 'API-001.PricingEngine',
      input: {
        tenant_id: TENANT_ID,
        sku_id: 'SKU-1',
        customer_id: CUSTOMER_ID,
      },
      context: {
        run_id: 'run-price-unbound',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-price-unbound',
      },
    })).rejects.toMatchObject({
      code: 'P_FLOOR_UNAVAILABLE',
      message: expect.stringContaining('Quote signing secret is not bound'),
    });
  });

  it('create_order: PRE-DISPATCH refuses with AUTHORITATIVE_SOURCE_UNAVAILABLE when signing secret is unbound with zero ERP calls', async () => {
    const orderPortMock = createOrderPort();
    const createOrderSpy = vi.spyOn(orderPortMock, 'createOrder');
    const cartPortMock = createCartPort();
    const services = createServices({
      order: orderPortMock,
      cart: cartPortMock,
      quote_signing_secret: '',
    });

    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.create_order',
      tool_binding: 'API-001.OrderConnector',
      input: {
        tenant_id: TENANT_ID,
        cart_id: 'cart-1',
        customer_id: CUSTOMER_ID,
        shipping_address: { street: 'Test St' },
        payment_method: 'CREDIT_CARD',
        effect_key: 'effect-order-unbound-secret',
      },
      context: {
        run_id: 'run-unbound-sec',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-order-unbound-secret',
      },
    })).rejects.toMatchObject({
      code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      message: expect.stringContaining('Quote signing secret is not bound'),
    });

    expect(createOrderSpy).not.toHaveBeenCalled();
  });

  it('create_order: PRE-DISPATCH refuses when quote token is missing with zero ERP calls', async () => {
    const orderPortMock = createOrderPort();
    const createOrderSpy = vi.spyOn(orderPortMock, 'createOrder');
    const cartPortMock = createCartPort({ quote_token: '' });
    const services = createServices({
      order: orderPortMock,
      cart: cartPortMock,
    });

    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.create_order',
      tool_binding: 'API-001.OrderConnector',
      input: {
        tenant_id: TENANT_ID,
        cart_id: 'cart-1',
        customer_id: CUSTOMER_ID,
        shipping_address: { street: 'Test St' },
        payment_method: 'CREDIT_CARD',
        effect_key: 'effect-order-missing-token',
        quote_token: '',
      },
      context: {
        run_id: 'run-missing-token',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-order-missing-token',
      },
    })).rejects.toMatchObject({
      code: 'PRICE_MISMATCH',
      message: expect.stringContaining('Price quote token is required'),
    });

    expect(createOrderSpy).not.toHaveBeenCalled();
  });

  it('create_order: PRE-DISPATCH refuses when quote token is malformed with zero ERP calls', async () => {
    const orderPortMock = createOrderPort();
    const createOrderSpy = vi.spyOn(orderPortMock, 'createOrder');
    const cartPortMock = createCartPort();
    const services = createServices({
      order: orderPortMock,
      cart: cartPortMock,
    });

    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.create_order',
      tool_binding: 'API-001.OrderConnector',
      input: {
        tenant_id: TENANT_ID,
        cart_id: 'cart-1',
        customer_id: CUSTOMER_ID,
        shipping_address: { street: 'Test St' },
        payment_method: 'CREDIT_CARD',
        effect_key: 'effect-order-malformed-token',
        quote_token: 'not-a-valid-64-hex-token',
      },
      context: {
        run_id: 'run-malformed-token',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-order-malformed-token',
      },
    })).rejects.toMatchObject({
      code: 'PRICE_MISMATCH',
      message: expect.stringContaining('Price quote token is malformed'),
    });

    expect(createOrderSpy).not.toHaveBeenCalled();
  });

  it('create_order: PRE-DISPATCH refuses when quote token is expired with zero ERP calls', async () => {
    const orderPortMock = createOrderPort();
    const createOrderSpy = vi.spyOn(orderPortMock, 'createOrder');
    const expiredExpiry = '2020-01-01T00:00:00.000Z';
    const expiredToken = computeQuoteToken(TEST_QUOTE_SECRET, {
      tenant_id: TENANT_ID,
      sku_id: 'SKU-1',
      customer_id: CUSTOMER_ID,
      final_price: 100,
      p_floor: 80,
      currency: 'TWD',
      quote_expires_at: expiredExpiry,
    });
    const cartPortMock = createCartPort({
      quote_token: expiredToken,
      quote_expires_at: expiredExpiry,
    });
    const services = createServices({
      order: orderPortMock,
      cart: cartPortMock,
    });

    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.create_order',
      tool_binding: 'API-001.OrderConnector',
      input: {
        tenant_id: TENANT_ID,
        cart_id: 'cart-1',
        customer_id: CUSTOMER_ID,
        shipping_address: { street: 'Test St' },
        payment_method: 'CREDIT_CARD',
        effect_key: 'effect-order-expired-token',
      },
      context: {
        run_id: 'run-expired-token',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-order-expired-token',
      },
    })).rejects.toMatchObject({
      code: 'PRICE_MISMATCH',
      message: expect.stringContaining('Price quote token has expired'),
    });

    expect(createOrderSpy).not.toHaveBeenCalled();
  });

  it('create_order: PRE-DISPATCH refuses when quote token is tampered with zero ERP calls', async () => {
    const orderPortMock = createOrderPort();
    const createOrderSpy = vi.spyOn(orderPortMock, 'createOrder');
    const validToken = computeQuoteToken(TEST_QUOTE_SECRET, {
      tenant_id: TENANT_ID,
      sku_id: 'SKU-1',
      customer_id: CUSTOMER_ID,
      final_price: 100,
      p_floor: 80,
      currency: 'TWD',
      quote_expires_at: '2026-09-24T12:00:00.000Z',
    });
    // Flip last character to tamper with token signature
    const tamperedToken = validToken.slice(0, -1) + (validToken.endsWith('a') ? 'b' : 'a');
    const cartPortMock = createCartPort({ quote_token: tamperedToken });
    const services = createServices({
      order: orderPortMock,
      cart: cartPortMock,
    });

    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.create_order',
      tool_binding: 'API-001.OrderConnector',
      input: {
        tenant_id: TENANT_ID,
        cart_id: 'cart-1',
        customer_id: CUSTOMER_ID,
        shipping_address: { street: 'Test St' },
        payment_method: 'CREDIT_CARD',
        effect_key: 'effect-order-tampered-token',
      },
      context: {
        run_id: 'run-tampered-token',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-order-tampered-token',
      },
    })).rejects.toMatchObject({
      code: 'PRICE_MISMATCH',
      message: expect.stringContaining('Price quote token signature verification failed'),
    });

    expect(createOrderSpy).not.toHaveBeenCalled();
  });

  it('create_order: PRE-DISPATCH refuses when token produced for one sku is presented for another with zero ERP calls', async () => {
    const orderPortMock = createOrderPort();
    const createOrderSpy = vi.spyOn(orderPortMock, 'createOrder');
    // Token produced for SKU-2 instead of SKU-1
    const wrongSkuToken = computeQuoteToken(TEST_QUOTE_SECRET, {
      tenant_id: TENANT_ID,
      sku_id: 'SKU-2',
      customer_id: CUSTOMER_ID,
      final_price: 100,
      p_floor: 80,
      currency: 'TWD',
      quote_expires_at: '2026-09-24T12:00:00.000Z',
    });
    const cartPortMock = createCartPort({
      sku_id: 'SKU-1',
      quote_token: wrongSkuToken,
    });
    const services = createServices({
      order: orderPortMock,
      cart: cartPortMock,
    });

    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.create_order',
      tool_binding: 'API-001.OrderConnector',
      input: {
        tenant_id: TENANT_ID,
        cart_id: 'cart-1',
        customer_id: CUSTOMER_ID,
        shipping_address: { street: 'Test St' },
        payment_method: 'CREDIT_CARD',
        effect_key: 'effect-order-wrong-sku',
      },
      context: {
        run_id: 'run-wrong-sku',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-order-wrong-sku',
      },
    })).rejects.toMatchObject({
      code: 'PRICE_MISMATCH',
      message: expect.stringContaining('Price quote token signature verification failed'),
    });

    expect(createOrderSpy).not.toHaveBeenCalled();
  });

  it('create_order: PRE-DISPATCH refuses when token produced for one customer is presented for another with zero ERP calls', async () => {
    const orderPortMock = createOrderPort();
    const createOrderSpy = vi.spyOn(orderPortMock, 'createOrder');
    // Token produced for different customer
    const wrongCustomerToken = computeQuoteToken(TEST_QUOTE_SECRET, {
      tenant_id: TENANT_ID,
      sku_id: 'SKU-1',
      customer_id: 'different-customer-id',
      final_price: 100,
      p_floor: 80,
      currency: 'TWD',
      quote_expires_at: '2026-09-24T12:00:00.000Z',
    });
    const cartPortMock = createCartPort({
      quote_token: wrongCustomerToken,
    });
    const services = createServices({
      order: orderPortMock,
      cart: cartPortMock,
    });

    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.create_order',
      tool_binding: 'API-001.OrderConnector',
      input: {
        tenant_id: TENANT_ID,
        cart_id: 'cart-1',
        customer_id: CUSTOMER_ID,
        shipping_address: { street: 'Test St' },
        payment_method: 'CREDIT_CARD',
        effect_key: 'effect-order-wrong-cust',
      },
      context: {
        run_id: 'run-wrong-cust',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-order-wrong-cust',
      },
    })).rejects.toMatchObject({
      code: 'PRICE_MISMATCH',
      message: expect.stringContaining('Price quote token signature verification failed'),
    });

    expect(createOrderSpy).not.toHaveBeenCalled();
  });

  it('create_order: PRE-DISPATCH refuses when token produced for one price is presented for another with zero ERP calls', async () => {
    const orderPortMock = createOrderPort();
    const createOrderSpy = vi.spyOn(orderPortMock, 'createOrder');
    // Token produced for price 50 instead of 100
    const wrongPriceToken = computeQuoteToken(TEST_QUOTE_SECRET, {
      tenant_id: TENANT_ID,
      sku_id: 'SKU-1',
      customer_id: CUSTOMER_ID,
      final_price: 50,
      p_floor: 80,
      currency: 'TWD',
      quote_expires_at: '2026-09-24T12:00:00.000Z',
    });
    const cartPortMock = createCartPort({
      subtotal: 100,
      quote_token: wrongPriceToken,
    });
    const services = createServices({
      order: orderPortMock,
      cart: cartPortMock,
    });

    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.create_order',
      tool_binding: 'API-001.OrderConnector',
      input: {
        tenant_id: TENANT_ID,
        cart_id: 'cart-1',
        customer_id: CUSTOMER_ID,
        shipping_address: { street: 'Test St' },
        payment_method: 'CREDIT_CARD',
        effect_key: 'effect-order-wrong-price',
      },
      context: {
        run_id: 'run-wrong-price',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-order-wrong-price',
      },
    })).rejects.toMatchObject({
      code: 'PRICE_MISMATCH',
      message: expect.stringContaining('Price quote token signature verification failed'),
    });

    expect(createOrderSpy).not.toHaveBeenCalled();
  });

  it('create_order: PRE-DISPATCH refuses when token was signed under another secret with zero ERP calls', async () => {
    const orderPortMock = createOrderPort();
    const createOrderSpy = vi.spyOn(orderPortMock, 'createOrder');
    // Token signed with attacker secret
    const foreignToken = computeQuoteToken('attacker-secret-key-32-chars-long!', {
      tenant_id: TENANT_ID,
      sku_id: 'SKU-1',
      customer_id: CUSTOMER_ID,
      final_price: 100,
      p_floor: 80,
      currency: 'TWD',
      quote_expires_at: '2026-09-24T12:00:00.000Z',
    });
    const cartPortMock = createCartPort({
      quote_token: foreignToken,
    });
    const services = createServices({
      order: orderPortMock,
      cart: cartPortMock,
    });

    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.create_order',
      tool_binding: 'API-001.OrderConnector',
      input: {
        tenant_id: TENANT_ID,
        cart_id: 'cart-1',
        customer_id: CUSTOMER_ID,
        shipping_address: { street: 'Test St' },
        payment_method: 'CREDIT_CARD',
        effect_key: 'effect-order-foreign-secret',
      },
      context: {
        run_id: 'run-foreign-secret',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-order-foreign-secret',
      },
    })).rejects.toMatchObject({
      code: 'PRICE_MISMATCH',
      message: expect.stringContaining('Price quote token signature verification failed'),
    });

    expect(createOrderSpy).not.toHaveBeenCalled();
  });

  it('create_order: PRE-DISPATCH accepts valid signed quote token and proceeds to ERP dispatch', async () => {
    const orderPortMock = createOrderPort();
    const createOrderSpy = vi.spyOn(orderPortMock, 'createOrder');
    const cartPortMock = createCartPort();
    const services = createServices({
      order: orderPortMock,
      cart: cartPortMock,
    });

    const output = await services.tool_port.invoke({
      skill_id: 'skill.sales.create_order',
      tool_binding: 'API-001.OrderConnector',
      input: {
        tenant_id: TENANT_ID,
        cart_id: 'cart-1',
        customer_id: CUSTOMER_ID,
        shipping_address: { street: 'Test St' },
        payment_method: 'CREDIT_CARD',
        effect_key: 'effect-order-valid-token',
      },
      context: {
        run_id: 'run-valid-token',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-order-valid-token',
      },
    });

    expect(output).toEqual({
      order_id: 'order-00000000-0000-4000-8000-000000000001',
      order_number: 'ORD-2026-0001',
      total_amount: 100,
      currency: 'TWD',
      status: 'PENDING_PAYMENT',
      payment_url: 'https://pay.example.com/checkout/ord-1',
      created_at: '2026-09-24T10:00:00.000Z',
    });
    expect(createOrderSpy).toHaveBeenCalledOnce();
    // Ensure secret value is never exposed in output
    expect(JSON.stringify(output)).not.toContain(TEST_QUOTE_SECRET);
  });
});
