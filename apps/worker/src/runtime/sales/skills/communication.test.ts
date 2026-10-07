/**
 * @file Sales skill services: message, consent and registry exports.
 *
 * Split from `index.test.ts`; the sibling files hold the remaining groups exactly
 * once and every assertion body is unchanged.
 */

import { describe, expect, it, vi } from 'vitest';
import { type Customer360Fact } from '@agentos/core-engine/contracts';
import { type CustomerEventTimeline } from '@agentos/database';
import { type ErpReadPort } from '../../connectors.js';
import { SalesContextAggregator } from '../context-aggregator.js';
import { type AssignableAuthority } from '@agentos/core-engine/contracts';
import { createSalesSkillServices, resolveEnabledSalesSkills, GATE_SALES_SKILLS, ENABLED_SALES_SKILLS, computeQuoteToken, type SalesCartPort, type SalesCommunicationOutput, type SalesCommunicationPort, type SalesConsentPort, type SalesCustomer360Fact, type SalesFrequencyCapConfig, type SalesFrequencyCapPort, type SalesOrderPort, type SalesPaymentPolicyPort, type SalesPriceFloorApproved, type SalesPriceFloorDecision, type SalesPriceFloorPort, type SalesPriceFloorRefused, type SalesQuotePort, type SalesRecommendationRevenueEvidencePort, type SalesReplenishmentPolicyPort } from './index.js';

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

describe('SalesSkillServices - message, consent and registry exports', () => {

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
 
  it('send_message: refuses a caller effect key that differs from the server-derived key', async () => {
    const communication = createCommunicationPort();
    const sendMessageSpy = vi.spyOn(communication, 'sendMessage');
    const services = createServices({
      communication,
      consent: createConsentPort(),
      frequency_cap: createFrequencyCapPort(),
      takeover_active: false,
    });

    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.send_message',
      tool_binding: 'API-003.CommunicationConnector',
      input: {
        tenant_id: TENANT_ID,
        recipient_id: CUSTOMER_ID,
        channel: 'LINE',
        message_content: { text: 'Reminder' },
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

    expect(sendMessageSpy).not.toHaveBeenCalled();
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

  it('rejects message with missing or empty recipient, channel, or content (B-75)', async () => {
    const services = createServices();
    const effectKey = 'effect-msg-val';
    const invoke = (input: Record<string, unknown>) =>
      services.tool_port.invoke({
        skill_id: 'skill.sales.send_message',
        tool_binding: 'API-003.CommunicationConnector',
        input: input as any,
        context: {
          run_id: 'run-val',
          tenant_id: TENANT_ID,
          correlation_id: CORRELATION_ID,
          caller_agent: 'SAL-01',
          granted_authority: 'AUTH-3',
          effect_key: effectKey,
        },
      });

    await expect(
      invoke({
        tenant_id: TENANT_ID,
        recipient_id: '',
        channel: 'LINE',
        message_content: { text: 'hello' },
        effect_key: effectKey,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    await expect(
      invoke({
        tenant_id: TENANT_ID,
        recipient_id: CUSTOMER_ID,
        channel: '',
        message_content: { text: 'hello' },
        effect_key: effectKey,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    await expect(
      invoke({
        tenant_id: TENANT_ID,
        recipient_id: CUSTOMER_ID,
        channel: 'LINE',
        message_content: { text: '   ' },
        effect_key: effectKey,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

