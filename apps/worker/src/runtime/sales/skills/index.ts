import { computeEffectKey, computeRequestFingerprint, evaluateAuthorityVerdict } from '@agentos/core-engine';
import { createSalesSkills, createSkillRegistry, createSkillRuntimeEngine } from '@agentos/skills';

import { createSalesSkillDispatcher } from './dispatcher.js';
import { createSalesSkillToolPort, hasAuthoritativeQuotePort, hasPaymentPolicyPort, hasTakeoverAuthority } from './tool-port.js';
import type { SalesSkillOptions, SalesSkillServices } from './types.js';

export type {
  ErpReadPort,
  SalesCartInput,
  SalesCartItem,
  SalesCartOutput,
  SalesCartPort,
  SalesCommunicationInput,
  SalesCommunicationOutput,
  SalesCommunicationPort,
  SalesConsentDecision,
  SalesConsentPort,
  SalesConsentQuery,
  SalesContextAggregatorLike,
  SalesCustomer360Fact,
  SalesFrequencyCapConfig,
  SalesFrequencyCapPort,
  SalesFrequencyCapQuery,
  SalesOrderInput,
  SalesOrderOutput,
  SalesOrderPort,
  SalesPaymentPolicy,
  SalesPaymentPolicyPort,
  SalesPaymentPolicyQuery,
  SalesPriceFloorApproved,
  SalesPriceFloorDecision,
  SalesPriceFloorPort,
  SalesPriceFloorQuery,
  SalesPriceFloorRefused,
  SalesQuote,
  SalesQuotePort,
  SalesQuoteQuery,
  SalesRecommendationRevenueEvidence,
  SalesRecommendationRevenueEvidencePort,
  SalesReplenishmentPolicy,
  SalesReplenishmentPolicyPort,
  SalesReplenishmentPolicyQuery,
  SalesSkillOptions,
  SalesSkillServices,
  SalesSkillToolPortOptions,
  VerifiedPurchaseEvidence,
} from './types.js';
export {
  type AuthoritativeQuoteResult,
  type QuoteTokenPayload,
  SalesSkillToolError,
  buildCanonicalQuotePayload,
  computeQuoteToken,
  createSalesSkillToolPort,
  hasAuthoritativeQuotePort,
  hasPaymentPolicyPort,
  hasQuoteSigningSecret,
  hasTakeoverAuthority,
  timingSafeCompare,
} from './tool-port.js';
export { createSalesSkillDispatcher } from './dispatcher.js';

/** Canonical gate allowlist naming all 8 Sales skills. */
export const GATE_SALES_SKILLS: ReadonlySet<string> = new Set([
  'skill.sales.search_product',
  'skill.sales.check_stock',
  'skill.sales.retrieve_customer',
  'skill.sales.recommend_product',
  'skill.sales.check_price',
  'skill.sales.create_cart',
  'skill.sales.create_order',
  'skill.sales.send_message',
]);

/** Retained alias for backwards-compatibility; mirrors GATE_SALES_SKILLS. */
export const ENABLED_SALES_SKILLS: ReadonlySet<string> = GATE_SALES_SKILLS;

/**
 * Computes the enabled Sales skill set: a row is enabled only when BOTH the gate
 * allowlist names it AND every port its handler requires is actually bound
 * (read rows keep today's enabled state).
 */
export function resolveEnabledSalesSkills(
  options: SalesSkillOptions,
  gateAllowlist: ReadonlySet<string> = GATE_SALES_SKILLS,
): ReadonlySet<string> {
  const enabled = new Set<string>();

  // Read rows keep today's enabled state
  if (gateAllowlist.has('skill.sales.search_product')) {
    enabled.add('skill.sales.search_product');
  }
  if (gateAllowlist.has('skill.sales.check_stock')) {
    enabled.add('skill.sales.check_stock');
  }
  if (gateAllowlist.has('skill.sales.retrieve_customer')) {
    enabled.add('skill.sales.retrieve_customer');
  }
  if (gateAllowlist.has('skill.sales.recommend_product')) {
    enabled.add('skill.sales.recommend_product');
  }

  // Check price requires SalesPriceFloorPort
  const priceFloorPort = options.price_floor;
  // A quote without its signing secret cannot be proven, so the row stays unbound rather than
  // enabled-but-unusable: enablement and the unbound report must agree.
  const quoteSigningBound = typeof options.quote_signing_secret === 'string'
    && options.quote_signing_secret.trim().length > 0;
  if (gateAllowlist.has('skill.sales.check_price') && Boolean(priceFloorPort) && quoteSigningBound) {
    enabled.add('skill.sales.check_price');
  }

  // Create cart requires SalesCartPort
  const cartPort = options.cart;
  if (gateAllowlist.has('skill.sales.create_cart') && Boolean(cartPort)) {
    enabled.add('skill.sales.create_cart');
  }

  // Create order requires SalesOrderPort, authoritative quote, and payment policy
  const orderPort = options.order;
  const quoteBound = hasAuthoritativeQuotePort(options);
  const paymentPolicyBound = hasPaymentPolicyPort(options);
  if (
    gateAllowlist.has('skill.sales.create_order')
    && Boolean(orderPort)
    && quoteBound
    && paymentPolicyBound
  ) {
    enabled.add('skill.sales.create_order');
  }

  // Send message requires CommunicationPort, ConsentPort, FrequencyCapPort, and Takeover authority
  const commPort = options.communication;
  const consentPort = options.consent;
  const freqCapPort = options.frequency_cap;
  if (
    gateAllowlist.has('skill.sales.send_message')
    && Boolean(commPort)
    && Boolean(consentPort)
    && Boolean(freqCapPort)
    && hasTakeoverAuthority(options)
  ) {
    enabled.add('skill.sales.send_message');
  }

  return enabled;
}

export function createSalesSkillServices(options: SalesSkillOptions): SalesSkillServices {
  const tool_port = createSalesSkillToolPort({
    erp_read: options.erp_read,
    context: options.context,
    ...(options.revenue_evidence === undefined ? {} : { revenue_evidence: options.revenue_evidence }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.price_floor === undefined ? {} : { price_floor: options.price_floor }),
    ...(options.cart === undefined ? {} : { cart: options.cart }),
    ...(options.order === undefined ? {} : { order: options.order }),
    ...(options.communication === undefined ? {} : { communication: options.communication }),
    ...(options.consent === undefined ? {} : { consent: options.consent }),
    ...(options.frequency_cap === undefined ? {} : { frequency_cap: options.frequency_cap }),
    ...(options.replenishment_policy === undefined ? {} : { replenishment_policy: options.replenishment_policy }),
    ...(options.quote === undefined ? {} : { quote: options.quote }),
    ...(options.payment_policy === undefined ? {} : { payment_policy: options.payment_policy }),
    ...(options.is_takeover_active === undefined ? {} : { is_takeover_active: options.is_takeover_active }),
    ...(options.takeover_active === undefined ? {} : { takeover_active: options.takeover_active }),
    ...(options.quote_signing_secret === undefined ? {} : { quote_signing_secret: options.quote_signing_secret }),
  });
  const clock = options.now ?? (() => new Date());
  const enabled_skills = resolveEnabledSalesSkills(options);
  const registry = createSkillRegistry();
  for (const row of createSalesSkills({ tools: tool_port, clock })) {
    registry.register({ ...row, enabled: enabled_skills.has(row.skill_id) });
  }
  const engine = createSkillRuntimeEngine({
    registry,
    digestPayload: (payload) => computeRequestFingerprint(payload as Record<string, unknown>),
    deriveEffectKey: (identity) => computeEffectKey(identity),
    evaluateAuthority: (granted, required) => evaluateAuthorityVerdict(granted, required),
    ...(options.now === undefined ? {} : { now: () => options.now!().getTime() }),
  });
  const dispatcher = createSalesSkillDispatcher({
    engine,
    resolve_correlation_id: options.resolve_correlation_id,
    resolve_grant: options.resolve_grant,
  });

  const unbound: string[] = [];
  if (options.erp_read === null) {
    unbound.push('API-001 catalog/inventory: no ERP read connector is bound');
  }
  if (options.revenue_evidence === undefined) {
    unbound.push('Core.RecommendationEngine revenue evidence: no owner-approved revenue model is bound');
  }
  const priceFloorPort = options.price_floor;
  if (!priceFloorPort) {
    unbound.push('API-001.PricingEngine: no pricing engine port is bound; skill.sales.check_price refuses');
  }
  if (!options.quote_signing_secret || options.quote_signing_secret.trim().length === 0) {
    unbound.push('QuoteSigningSecret: no quote signing secret is bound; skill.sales.check_price refuses');
  }
  const cartPort = options.cart;
  if (!cartPort) {
    unbound.push('API-002.CommerceCartAPI: no cart port is bound; skill.sales.create_cart refuses');
  }
  const orderPort = options.order;
  if (!orderPort) {
    unbound.push('API-001.OrderConnector: no order connector port is bound; skill.sales.create_order refuses');
  }
  if (!hasAuthoritativeQuotePort(options)) {
    unbound.push('API-002.CommerceCartAPI quote: no authoritative quote/cart port is bound; skill.sales.create_order refuses');
  }
  if (!hasPaymentPolicyPort(options)) {
    unbound.push('SalesPaymentPolicy: no payment policy port is bound; skill.sales.create_order refuses');
  }
  const commPort = options.communication;
  if (!commPort) {
    unbound.push('API-003.CommunicationConnector: no communication port is bound; skill.sales.send_message refuses');
  }
  const consentPort = options.consent;
  if (!consentPort) {
    unbound.push('SalesConsent: no consent port is bound; skill.sales.send_message refuses');
  }
  const freqCapPort = options.frequency_cap;
  if (!freqCapPort) {
    unbound.push('SalesFrequencyCap: no frequency cap port is bound; skill.sales.send_message refuses');
  }
  if (!hasTakeoverAuthority(options)) {
    unbound.push('SalesTakeover: no takeover authority is bound; skill.sales.send_message refuses');
  }
  const replenishmentPort = options.replenishment_policy;
  if (!replenishmentPort) {
    unbound.push('SalesReplenishmentPolicy: no replenishment policy port is bound; SAL-05 replenishment refuses');
  }

  return { registry, tool_port, dispatcher, unbound, enabled_skills, engine };
}
