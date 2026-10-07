/**
 * @file Sales skill services: quote, price floor and payment-policy skills.
 *
 * Split from `index.test.ts`; the sibling files hold the remaining groups exactly
 * once and every assertion body is unchanged.
 */

import { describe, expect, it, vi } from 'vitest';
import { type Customer360Fact } from '@agentos/core-engine/contracts';
import { type CustomerEventTimeline } from '@agentos/database';
import { type ErpReadPort } from '../../connectors.js';
import { type AssignableAuthority } from '@agentos/core-engine/contracts';
import { createSalesSkillServices, computeQuoteToken, type SalesCartPort, type SalesCommunicationPort, type SalesConsentPort, type SalesCustomer360Fact, type SalesFrequencyCapConfig, type SalesFrequencyCapPort, type SalesOrderPort, type SalesPaymentPolicyPort, type SalesPriceFloorApproved, type SalesPriceFloorDecision, type SalesPriceFloorPort, type SalesPriceFloorRefused, type SalesQuotePort, type SalesRecommendationRevenueEvidencePort, type SalesReplenishmentPolicyPort } from './index.js';

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

describe('SalesSkillServices - quote, price floor and payment-policy skills', () => {

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

    // 1b. Out-of-bounds or negative requested discount yields discount_allowed = false and final_price = list_price
    const invalidDiscountOutput = await services.tool_port.invoke({
      skill_id: 'skill.sales.check_price',
      tool_binding: 'API-001.PricingEngine',
      input: {
        tenant_id: TENANT_ID,
        sku_id: 'SKU-1',
        customer_id: CUSTOMER_ID,
        requested_discount_percent: 120,
      },
      context: {
        run_id: 'run-1',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02' as const,
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3' as const,
        effect_key: 'effect-price-1b',
      },
    });
    expect(invalidDiscountOutput).toMatchObject({
      sku_id: 'SKU-1',
      list_price: 100,
      final_price: 100,
      discount_allowed: false,
    });

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
  it('check_price: forwards proposed_price to the authoritative pricing engine', async () => {
    const read = vi.fn(async () => ({
      ok: true as const,
      owner_approved: true as const,
      list_price: 100,
      currency: 'TWD',
      p_floor: 80,
      floor_source: 'engine:approved:pricing-v1',
      quote_ttl_seconds: 3600,
    }));
    const services = createServices({
      price_floor: { read },
    });

    const output = await services.tool_port.invoke({
      skill_id: 'skill.sales.check_price',
      tool_binding: 'API-001.PricingEngine',
      input: {
        tenant_id: TENANT_ID,
        sku_id: 'SKU-1',
        customer_id: CUSTOMER_ID,
        proposed_price: 90,
      },
      context: {
        run_id: 'run-price-proposed',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02' as const,
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3' as const,
        effect_key: 'effect-price-proposed',
      },
    });

    expect(read).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      sku_id: 'SKU-1',
      proposed_price: 90,
    });
    expect((output as Record<string, unknown>).final_price).toBe(90);
    expect((output as Record<string, unknown>).discount_allowed).toBe(true);
  });

  it('check_price: rejects proposed_price below p_floor and keeps list_price', async () => {
    const read = vi.fn(async () => ({
      ok: true as const,
      owner_approved: true as const,
      list_price: 100,
      currency: 'TWD',
      p_floor: 80,
      floor_source: 'engine:approved:pricing-v1',
      quote_ttl_seconds: 3600,
    }));
    const services = createServices({
      price_floor: { read },
    });

    const output = await services.tool_port.invoke({
      skill_id: 'skill.sales.check_price',
      tool_binding: 'API-001.PricingEngine',
      input: {
        tenant_id: TENANT_ID,
        sku_id: 'SKU-1',
        customer_id: CUSTOMER_ID,
        proposed_price: 70,
      },
      context: {
        run_id: 'run-price-proposed-low',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02' as const,
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3' as const,
        effect_key: 'effect-price-proposed-low',
      },
    });

    expect((output as Record<string, unknown>).final_price).toBe(100);
    expect((output as Record<string, unknown>).discount_allowed).toBe(false);
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
