/**
 * @file Sales skill services: cart and order skills.
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

describe('SalesSkillServices - cart and order skills', () => {

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
 
  it('create_order: refuses a caller effect key that differs from the server-derived key', async () => {
    const orderPortMock = createOrderPort();
    const createOrderSpy = vi.spyOn(orderPortMock, 'createOrder');
    const services = createServices({ order: orderPortMock, cart: createCartPort() });

    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.create_order',
      tool_binding: 'API-001.OrderConnector',
      input: {
        tenant_id: TENANT_ID,
        cart_id: 'cart-1',
        customer_id: CUSTOMER_ID,
        shipping_address: { street: 'Test' },
        payment_method: 'CREDIT_CARD',
        effect_key: 'caller-effect-key',
      },
      context: {
        run_id: 'run-effect-key-mismatch',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02' as const,
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3' as const,
        effect_key: 'server-effect-key',
      },
    })).rejects.toMatchObject({ code: 'EFFECT_KEY_MISMATCH' });

    expect(createOrderSpy).not.toHaveBeenCalled();
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

  it('rejects cart creation with non-positive quantity (B-64)', async () => {
    const services = createServices({ cart: createCartPort() });
    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.create_cart',
      tool_binding: 'API-002.CommerceCartAPI',
      input: {
        tenant_id: TENANT_ID,
        customer_id: CUSTOMER_ID,
        items: [{ sku_id: 'SKU-1', quantity: -1 }],
        effect_key: 'effect-cart-neg-qty',
      },
      context: {
        run_id: 'run-cart-neg-qty',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-cart-neg-qty',
      },
    })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('rejects order creation with empty cart_id (B-65)', async () => {
    const services = createServices({ order: createOrderPort() });
    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.create_order',
      tool_binding: 'API-001.OrderConnector',
      input: {
        tenant_id: TENANT_ID,
        cart_id: '   ',
        customer_id: CUSTOMER_ID,
        payment_method: 'CREDIT_CARD',
        effect_key: 'effect-order-empty-cart',
      },
      context: {
        run_id: 'run-empty-cart',
        tenant_id: TENANT_ID,
        caller_agent: 'SAL-02',
        correlation_id: CORRELATION_ID,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-order-empty-cart',
      },
    })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

