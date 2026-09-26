/**
 * @file Sales Agent Runtime (implement/04 §3.2, implement/05 §4.2, implement/06 §8.1).
 *
 * Invariant:
 * The Sales agent runtime is entirely DETERMINISTIC with NO LLM calls.
 *
 * Intent Routing Architecture:
 *   - SAL-01 (Lead Qualification):
 *       Customer lookup / profile inquiry -> `skill.sales.retrieve_customer`
 *       Customer identity is resolved strictly from `context.customer`, NEVER from untrusted payload.
 *   - SAL-02 (AI Sales Advisor):
 *       Catalog product search -> `skill.sales.search_product`
 *       Inventory availability check -> `skill.sales.check_stock`
 *       Price inquiry -> `skill.sales.check_price` (READ row, requires active price capability and SKU)
 *       Disabled price query -> Clarifies (P2 floor price / dynamic pricing evaluation disabled)
 *   - SAL-03 (Recommendation Agent):
 *       Product recommendations / cross-sell -> `skill.sales.recommend_product`
 *       Requires hydrated verified customer context; fails closed if absent.
 *   - SAL-04 (Cart Recovery):
 *       Multi-step recovery plan (consent -> suppression -> stock -> price -> floor/policy -> bounded cart -> reminder message).
 *       Customer confirms purchase downstream; autonomous order authoring (`skill.sales.create_order`) is NEVER planned.
 *   - SAL-05 (Replenishment):
 *       Multi-step replenishment plan (consent -> suppression -> stock -> price -> floor/policy -> reminder message).
 *       Customer confirms purchase downstream; autonomous order authoring (`skill.sales.create_order`) is NEVER planned.
 *
 * Safe Execution Plan Formulate Invariant:
 *   - Only executable, enabled skill rows present in the injected registry resolver are planned.
 *   - Read skills (retrieve_customer, search_product, check_stock, check_price, recommend_product) are planned for advisory queries.
 *   - Bounded mutating cart and notification skills (create_cart, send_message) are planned only for verified, consented SAL-04/SAL-05 workflows.
 *   - Autonomous order synthesis (`skill.sales.create_order`) with invented shipping or payment details is strictly forbidden.
 *   - Planned step input parameters never carry non-deterministic keys (randomUUID, Date.now); canonical identity and idempotency are owned downstream.
 *   - Price lookup (`skill.sales.check_price`) is an authoritative READ and carries `price_bearing: false` from its registry row.
 *   - Unauthorized rows, disabled rows, or unexecutable dependencies fail closed with an empty plan.
 */

import { randomUUID } from 'node:crypto';
import type {
  AuthorityLevel,
  ExecutionPlan,
  HandoffIntent,
  HydratedContext,
  HypothesisRecord,
  IAgentRuntime,
  PlannedStep,
  PlatformAgentId,
  RoutingDecision,
  SignalEnvelope,
} from '@agentos/core-engine/contracts';
import type { SkillEffectClass } from '@agentos/skills';
import type {
  SalesReplenishmentPolicy,
  SalesReplenishmentPolicyPort,
} from './skills/types.js';
/** Authoritative Customer 360 verified purchase/order evidence entry. */
export interface VerifiedPurchaseEvidence {
  readonly order_id: string;
  readonly order_date: string;
  readonly sku_ids?: readonly string[] | undefined;
  readonly items?: readonly string[] | undefined;
  readonly quantity?: number | undefined;
  readonly total_amount?: number | undefined;
  readonly currency?: string | undefined;
}

/** Query parameters for authoritative purchase evidence retrieval. */
export interface SalesPurchaseEvidenceQuery {
  readonly tenant_id: string;
  readonly customer_id: string;
}

/** Authoritative purchase evidence port for Sales runtime. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

function isValidIsoTimestamp(ts: unknown): ts is string {
  if (typeof ts !== 'string' || !ISO_TIMESTAMP.test(ts.trim())) return false;
  const ms = new Date(ts.trim()).getTime();
  return Number.isFinite(ms) && !isNaN(ms);
}

export interface SalesPurchaseEvidencePort {
  read(query: SalesPurchaseEvidenceQuery): Promise<readonly VerifiedPurchaseEvidence[]>;
}

function getEvidenceSkus(evidence: VerifiedPurchaseEvidence): readonly string[] {
  return evidence.sku_ids ?? evidence.items ?? [];
}
/**
 * Effect policy derivation matrix transcribed from implement/05 §6.5:
 * Only READ rows are permitted in the Sales foundation runtime.
 */
export interface DerivedEffectPolicy {
  readonly mutating: boolean;
  readonly idempotent: boolean;
  readonly price_bearing: boolean;
}

export function deriveEffectPolicy(effectClass: SkillEffectClass): DerivedEffectPolicy {
  switch (effectClass) {
    case 'READ':
      return { mutating: false, idempotent: true, price_bearing: false };
    case 'INTERNAL':
      return { mutating: true, idempotent: false, price_bearing: false };
    case 'EFFECT':
      return { mutating: true, idempotent: false, price_bearing: false };
    case 'APPROVAL':
      return { mutating: true, idempotent: false, price_bearing: false };
    default:
      return { mutating: false, idempotent: true, price_bearing: false };
  }
}

/**
 * Minimal skill registry row interface required for policy extraction (implement/05 §3, §6.5).
 */
export interface SkillRegistryRowMetadata {
  readonly skill_id: string;
  readonly effect_class: SkillEffectClass;
  readonly guarded_dependency: string;
  readonly required_authority: AuthorityLevel;
  readonly timeout_ms: number;
  readonly allowed_agents?: readonly string[] | undefined;
  readonly enabled?: boolean | undefined;
  readonly mutating?: boolean | undefined;
  readonly idempotent?: boolean | undefined;
  readonly price_bearing?: boolean | undefined;
}

export interface SkillRegistryPort {
  get?(skill_id: string): SkillRegistryRowMetadata | null | undefined;
  resolve?(skill_id: string): SkillRegistryRowMetadata | null | undefined;
}

export type SkillRegistryResolver =
  | SkillRegistryPort
  | ((skill_id: string) => SkillRegistryRowMetadata | null | undefined)
  | Map<string, SkillRegistryRowMetadata>;

function lookupRegistryRow(
  registry: SkillRegistryResolver | undefined,
  skillId: string,
): SkillRegistryRowMetadata | null {
  if (!registry) return null;
  try {
    if (typeof registry === 'function') {
      return registry(skillId) ?? null;
    }
    if (registry instanceof Map) {
      return registry.get(skillId) ?? null;
    }
    if (typeof registry.get === 'function') {
      return registry.get(skillId) ?? null;
    }
    if (typeof registry.resolve === 'function') {
      return registry.resolve(skillId) ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Extracts raw textual message from signal payload.
 */
/** Reads only the admitted package reason for the canonical marketing → sales edge. */
function extractSalesHandoffReason(signal: SignalEnvelope): string | undefined {
  const raw = signal.payload.handoff;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const handoff = raw as Record<string, unknown>;
  if (handoff.target_domain !== 'sales' || typeof handoff.reason !== 'string') return undefined;
  return handoff.reason.trim().length > 0 ? handoff.reason : undefined;
}

export function extractMessageContent(signal: SignalEnvelope): string {
  const p = signal.payload as Record<string, unknown> | null | undefined;
  if (!p || typeof p !== 'object') return '';
  if (typeof p.message === 'string') return p.message.trim();
  if (typeof p.content === 'string') return p.content.trim();
  if (typeof p.text === 'string') return p.text.trim();
  return '';
}

/**
 * Extracts SKU identifier from message text.
 * Matches:
 *  - SKU-XXXX, PROD-XXXX, ITEM-XXXX
 *  - sku #12345, sku: 12345
 */
export function extractSku(text: string): string | null {
  if (!text) return null;

  // 1. Prefixed canonical IDs: SKU-XXXX, PROD-XXXX, ITEM-XXXX
  const prefixMatch = text.match(/\b((?:SKU|PROD|ITEM)-[A-Za-z0-9_-]+)\b/i);
  if (prefixMatch && prefixMatch[1]) return prefixMatch[1].toUpperCase();

  // 2. Keyword followed by SKU code
  const kwMatch = text.match(/\b(?:sku|product|item)\s*(?:#|id|code|no\.?|num)?\s*[:#]?\s*([A-Za-z0-9_-]{3,})/i);
  if (kwMatch && kwMatch[1]) {
    const candidate = kwMatch[1].trim();
    if (!/^(status|details|update|info|is|the|my|available|stock|price|cost|costs|check|search|in|out|have|has|need|rate|rates|value|quote|quotation|discount|fee|fees)$/i.test(candidate)) {
      return candidate.toUpperCase();
    }
  }

  return null;
}

/**
 * Cleans query text by stripping search-preamble phrases.
 */
export function cleanSearchQuery(text: string): string {
  if (!text) return '';
  let q = text
    .replace(/\b(?:search(?:\s+for)?|find|look(?:\s+for)?|looking(?:\s+for)?|show(?:\s+me)?|browse|catalog|list)\b/gi, '')
    .replace(/[?!.]+$/g, '')
    .trim();
  return q.length > 0 ? q : text.trim();
}

/**
 * Identifies if text expresses a price inquiry (disabled in P2).
 */
export function isPriceInquiry(text: string): boolean {
  if (!text) return false;
  return /\b(price|pricing|discount|cost|how much|quote|quotation|rate|fee|p_floor)\b/i.test(text);
}

/**
 * Identifies if text expresses an inventory / stock check.
 */
export function isInventoryInquiry(text: string): boolean {
  if (!text) return false;
  return /\b(stock|inventory|available|availability|in stock|out of stock|quantity)\b/i.test(text);
}

/**
 * Identifies if text expresses a recommendation / cross-sell request.
 */
export function isRecommendInquiry(text: string): boolean {
  if (!text) return false;
  return /\b(recommend|recommendation|recommendations|suggest|suggestion|suggestions|cross-sell|upsell|bundle|substitute|pair with|complementary)\b/i.test(text);
}

/**
 * Identifies if text expresses a customer lookup / profile inquiry.
 */
export function isCustomerLookupInquiry(text: string): boolean {
  if (!text) return false;
  return /\b(customer|profile|account|my account|purchase history|order history|loyalty|my details|user info|member info)\b/i.test(text);
}

/**
 * Identifies if text expresses a product catalog search.
 */
export function isProductSearchInquiry(text: string): boolean {
  if (!text) return false;
  return /\b(search|find|looking for|look for|catalog|browse|show me|products?)\b/i.test(text);
}
export type DependencyReachabilityPredicate =
  | readonly string[]
  | ((guardedDependency: string) => boolean);

export function isDependencyResolvable(
  dependency: string | undefined,
  resolvableDependencies?: DependencyReachabilityPredicate,
): boolean {
  if (!dependency || typeof dependency !== 'string' || dependency.trim().length === 0) {
    return false;
  }
  if (resolvableDependencies) {
    if (typeof resolvableDependencies === 'function') {
      return resolvableDependencies(dependency);
    }
    if (Array.isArray(resolvableDependencies)) {
      return resolvableDependencies.includes(dependency);
    }
  }
  return true;
}

export function isRowExecutable(
  row: SkillRegistryRowMetadata | null | undefined,
  targetAgent: PlatformAgentId,
  resolvableDependencies?: DependencyReachabilityPredicate,
): row is SkillRegistryRowMetadata {
  if (!row) return false;
  if (row.enabled === false) return false;
  if (row.allowed_agents && !row.allowed_agents.includes(targetAgent)) {
    return false;
  }
  if (!isDependencyResolvable(row.guarded_dependency, resolvableDependencies)) {
    return false;
  }
  return true;
}

/**
 * Identifies if text expresses a cart recovery inquiry.
 */
export function isCartRecoveryInquiry(text: string): boolean {
  if (!text) return false;
  return /\b(abandoned[ -]?cart|cart[ -]?recovery|recover[ -]?cart|left in cart|items left in cart|resume my cart|forgot my cart)\b/i.test(text);
}

/**
 * Identifies if text expresses a replenishment / reorder inquiry.
 */
export function isReplenishmentInquiry(text: string): boolean {
  if (!text) return false;
  return /\b(replenish|replenishment|reorder|repurchase|recurring order|refill|subscribe again|order again|buy again)\b/i.test(text);
}

export interface CartRecoveryData {
  readonly cartId?: string | undefined;
  readonly skus: readonly string[];
}

export function extractCartRecoveryData(signal: SignalEnvelope): CartRecoveryData | null {
  const payload = (signal.payload ?? {}) as Record<string, unknown>;
  const rawCartId = payload.cart_id ?? payload.cartId;
  const cartId = typeof rawCartId === 'string' && rawCartId.trim().length > 0 ? rawCartId.trim() : undefined;

  const rawSkus = payload.skus ?? payload.sku_list ?? payload.cart_skus ?? payload.items;
  const skus: string[] = [];
  if (Array.isArray(rawSkus)) {
    for (const item of rawSkus) {
      if (typeof item === 'string' && item.trim().length > 0) {
        skus.push(item.trim());
      } else if (item && typeof item === 'object') {
        const itemObj = item as Record<string, unknown>;
        const skuId = itemObj.sku_id ?? itemObj.sku;
        if (typeof skuId === 'string' && skuId.trim().length > 0) {
          skus.push(skuId.trim());
        }
      }
    }
  }

  const isCartAbandonedEvent =
    signal.event_type === 'cart.abandoned' ||
    signal.event_type === 'cart_abandoned' ||
    signal.event_type.endsWith('.cart.abandoned');

  if (isCartAbandonedEvent || (cartId && skus.length > 0)) {
    return { cartId, skus: Object.freeze(skus) };
  }
  return null;
}

export function isReplenishmentSignal(signal: SignalEnvelope, text: string): boolean {
  const payload = (signal.payload ?? {}) as Record<string, unknown>;
  const rawRef =
    payload.prior_purchase_reference ??
    payload.order_reference ??
    payload.prior_order_id ??
    payload.purchase_reference ??
    payload.last_purchase_reference ??
    payload.previous_order_id;
  const hasRef = typeof rawRef === 'string' && rawRef.trim().length > 0;
  const isReplenishmentEvent =
    signal.event_type === 'replenishment' ||
    signal.event_type === 'replenishment.cycle' ||
    signal.event_type === 'customer.repurchase' ||
    signal.event_type.includes('replenishment');
  const hasText = isReplenishmentInquiry(text);

  return hasRef || isReplenishmentEvent || hasText;
}

 export interface ReplenishmentEvaluationOptions {
   readonly registry?: SkillRegistryResolver | undefined;
   readonly resolvableDependencies?: DependencyReachabilityPredicate | undefined;
   readonly replenishment_policy?: SalesReplenishmentPolicyPort | undefined;
  readonly replenishment_policy_port?: SalesReplenishmentPolicyPort | undefined;
  readonly purchase_evidence?: SalesPurchaseEvidencePort | undefined;
   readonly now?: (() => Date) | undefined;
 }

export async function extractVerifiedPurchases(
  context: HydratedContext,
  port?: SalesPurchaseEvidencePort | undefined,
): Promise<readonly VerifiedPurchaseEvidence[]> {
  if (!port) {
    throw new Error('purchase evidence missing or stale: purchase evidence missing');
  }

  const customerId = context.customer?.customer_id;
  if (!customerId || typeof customerId !== 'string' || customerId.trim().length === 0) {
    throw new Error('purchase evidence missing or stale: purchase evidence missing');
  }

  const tenantId = context.tenant_id;
  if (!tenantId || typeof tenantId !== 'string' || tenantId.trim().length === 0) {
    throw new Error('purchase evidence missing or stale: purchase evidence missing');
  }

  let rawList: readonly VerifiedPurchaseEvidence[];
  try {
    rawList = await port.read({ tenant_id: tenantId, customer_id: customerId });
  } catch {
    throw new Error('purchase evidence missing or stale: purchase evidence missing');
  }

  if (!Array.isArray(rawList) || rawList.length === 0) {
    throw new Error('purchase evidence missing or stale: purchase evidence missing');
  }

  const validated: VerifiedPurchaseEvidence[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') {
      throw new Error('purchase evidence missing or stale: purchase evidence missing');
    }
    const orderId = 'order_id' in item && typeof item.order_id === 'string' ? item.order_id.trim() : null;
    if (!orderId) {
      throw new Error('purchase evidence missing or stale: purchase evidence missing');
    }
    const orderDate = 'order_date' in item && typeof item.order_date === 'string' ? item.order_date.trim() : null;
    if (!orderDate || !isValidIsoTimestamp(orderDate)) {
      throw new Error('purchase evidence missing or stale: purchase evidence missing');
    }

    const rawSkuIds =
      ('sku_ids' in item && Array.isArray(item.sku_ids) ? item.sku_ids : undefined) ??
      ('items' in item && Array.isArray(item.items) ? item.items : undefined);
    let itemsList: string[] | undefined = undefined;
    if (Array.isArray(rawSkuIds)) {
      const filtered = rawSkuIds.filter(
        (s): s is string => typeof s === 'string' && s.trim().length > 0,
      );
      if (filtered.length > 0) {
        itemsList = filtered.map((s) => s.trim());
      }
    }

    const quantity =
      'quantity' in item && typeof item.quantity === 'number' && Number.isFinite(item.quantity)
        ? item.quantity
        : undefined;
    const totalAmount =
      'total_amount' in item && typeof item.total_amount === 'number' && Number.isFinite(item.total_amount)
        ? item.total_amount
        : undefined;
    const currency =
      'currency' in item && typeof item.currency === 'string' && item.currency.trim().length > 0
        ? item.currency.trim()
        : undefined;

    validated.push({
      order_id: orderId,
      order_date: orderDate,
      ...(itemsList ? { items: itemsList, sku_ids: itemsList } : {}),
      ...(quantity !== undefined ? { quantity } : {}),
      ...(totalAmount !== undefined ? { total_amount: totalAmount } : {}),
      ...(currency !== undefined ? { currency } : {}),
    });
  }

  if (validated.length === 0) {
    throw new Error('purchase evidence missing or stale: purchase evidence missing');
  }

  return Object.freeze(validated);
 }

export async function evaluateReplenishmentRefusal(
  signal: SignalEnvelope,
  context: HydratedContext,
  options?: ReplenishmentEvaluationOptions,
): Promise<string | null> {
  const payload = (signal.payload ?? {}) as Record<string, unknown>;
  const text = extractMessageContent(signal);
  const sku =
    extractSku(text) ??
    (typeof payload.sku_id === 'string' && payload.sku_id.trim().length > 0
      ? payload.sku_id.trim()
      : undefined);

  // 1. Authoritative purchase evidence
  const port = options?.purchase_evidence;
  if (!port || !context.customer) {
     return 'purchase evidence missing or stale: purchase evidence missing';
   }

  let purchases: readonly VerifiedPurchaseEvidence[];
  try {
    purchases = await extractVerifiedPurchases(context, port);
  } catch (err) {
    if (err instanceof Error && err.message.includes('evidence stale')) {
      return 'purchase evidence missing or stale: evidence stale';
    }
    return 'purchase evidence missing or stale: purchase evidence missing';
  }

  if (purchases.length === 0) {
    return 'purchase evidence missing or stale: purchase evidence missing';
  }

  const rawRef =
    payload.prior_purchase_reference ??
    payload.order_reference ??
    payload.prior_order_id ??
    payload.purchase_reference ??
    payload.last_purchase_reference ??
    payload.previous_order_id;
  const payloadHypothesisRef =
    typeof rawRef === 'string' && rawRef.trim().length > 0 ? rawRef.trim() : null;

  let matchedEvidence: VerifiedPurchaseEvidence | undefined;
  let resolvedSku: string | undefined;

  if (payloadHypothesisRef) {
    matchedEvidence = purchases.find((p) => p.order_id === payloadHypothesisRef);
    if (!matchedEvidence) {
      // Caller-asserted order reference does not match authoritative verified evidence -> refuses
      return 'purchase evidence missing or stale: purchase evidence missing';
    }
    const matchedSkus = getEvidenceSkus(matchedEvidence);
    if (sku) {
      const hasItemEvidence = matchedSkus.length > 0;
      const skuInMatchedOrder = hasItemEvidence && matchedSkus.includes(sku);
      const skuInAnyPurchase = purchases.some((p) => getEvidenceSkus(p).includes(sku));
      if (hasItemEvidence ? !skuInMatchedOrder : !skuInAnyPurchase) {
        return 'purchase evidence missing or stale: purchase evidence missing';
      }
      resolvedSku = sku;
    } else {
      resolvedSku = matchedSkus[0];
    }
  } else {
    if (sku) {
      matchedEvidence = purchases.find((p) => getEvidenceSkus(p).includes(sku));
      if (!matchedEvidence) {
        return 'purchase evidence missing or stale: purchase evidence missing';
      }
      resolvedSku = sku;
    } else {
      matchedEvidence = purchases[0];
      resolvedSku = matchedEvidence ? getEvidenceSkus(matchedEvidence)[0] : undefined;
    }
  }

  if (!matchedEvidence || !resolvedSku) {
    return 'purchase evidence missing or stale: purchase evidence missing';
  }

  // 2. Owner-approved replenishment policy port (SAL-05)
  const policyPort = options?.replenishment_policy;
  if (!policyPort) {
    return 'no owner-approved replenishment interval';
  }

  const querySku = resolvedSku;
  let policy: SalesReplenishmentPolicy | undefined;
  try {
    const policyResult = policyPort.read({
      tenant_id: context.tenant_id,
      sku_id: querySku,
    });
    policy = policyResult instanceof Promise ? await policyResult : policyResult;
  } catch {
    return 'no owner-approved replenishment interval';
  }

  if (
    !policy ||
    policy.owner_approved !== true ||
    typeof policy.replenishment_interval_days !== 'number' ||
    policy.replenishment_interval_days <= 0 ||
    !Number.isFinite(policy.replenishment_interval_days) ||
    typeof policy.evidence_staleness_window_days !== 'number' ||
    policy.evidence_staleness_window_days <= 0 ||
    !Number.isFinite(policy.evidence_staleness_window_days)
  ) {
    return 'no owner-approved replenishment interval';
  }

  // 3. Consent missing or withdrawn (server-hydrated customer record only)
  if (context.customer.consent_marketing !== true) {
    return 'consent missing or withdrawn';
  }

  // 4. Suppression active (server-hydrated customer record only)
  if (context.customer.suppression_active === true) {
    return 'suppression active';
  }

  // 5. Consent authority unavailable: authoritative Customer360 read must be reachable
  const registry = options?.registry;
  const resolvableDependencies = options?.resolvableDependencies;
  const consentRow = lookupRegistryRow(registry, 'skill.sales.retrieve_customer');
  if (!consentRow || !isRowExecutable(consentRow, 'SAL-05', resolvableDependencies) || consentRow.effect_class !== 'READ') {
    return 'consent authority skill.sales.retrieve_customer unavailable';
  }

  // 6. Outbound touch channel missing: outbound-bearing plan requires verified channel from context
  const rawChannel = context.working_memory?.last_touch_channel;
  const channel = typeof rawChannel === 'string' && rawChannel.trim().length > 0 ? rawChannel.trim() : null;
  if (!channel) {
    return 'outbound channel missing';
  }

  // 7. Product inactive: authoritative catalog/price read must be reachable
  const productRow =
    lookupRegistryRow(registry, 'skill.sales.check_price') ??
    lookupRegistryRow(registry, 'skill.sales.search_product');
  if (!isRowExecutable(productRow, 'SAL-05', resolvableDependencies)) {
    return 'product inactive';
  }

  // 8. Stock unavailable: authoritative stock read must be reachable
  const stockRow = lookupRegistryRow(registry, 'skill.sales.check_stock');
  if (!isRowExecutable(stockRow, 'SAL-05', resolvableDependencies)) {
    return 'stock unavailable';
  }
  // 7. Recent purchase that invalidates reorder hypothesis
  const nowFn = options?.now;
  const currentDate = nowFn ? nowFn() : (signal.timestamp ? new Date(signal.timestamp) : new Date());
  const currentMs = currentDate.getTime();

  const intervalDays = policy.replenishment_interval_days;
  const intervalMs = intervalDays * 24 * 60 * 60 * 1000;

  const matchedOrderDate = new Date(matchedEvidence.order_date);
  const matchedOrderMs = matchedOrderDate.getTime();
  if (isNaN(matchedOrderMs)) {
    return 'purchase evidence missing or stale: purchase evidence missing';
  }

  if (currentMs - matchedOrderMs < intervalMs) {
    return 'recent purchase invalidates reorder hypothesis';
  }

  for (const purchase of purchases) {
    if (purchase.order_id === matchedEvidence.order_id) continue;
    if (purchase.items && !purchase.items.includes(querySku)) continue;
    const pDate = new Date(purchase.order_date);
    const pMs = pDate.getTime();
    if (!isNaN(pMs) && currentMs - pMs < intervalMs && pMs > matchedOrderMs) {
      return 'recent purchase invalidates reorder hypothesis';
    }
  }

  // 8. Purchase evidence stale (beyond evidence staleness window)
  const stalenessWindowDays = policy.evidence_staleness_window_days;
  const maxAgeDays =
    stalenessWindowDays >= intervalDays
      ? stalenessWindowDays
      : intervalDays + stalenessWindowDays;
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  const elapsedMs = currentMs - matchedOrderMs;
  if (elapsedMs > maxAgeMs) {
    return 'purchase evidence missing or stale: evidence stale';
  }

  return null;
}

export type SalesIntent =
  | 'customer_lookup'
  | 'product_search'
  | 'inventory'
  | 'price'
  | 'disabled_price'
  | 'recommend'
  | 'cart_recovery'
  | 'replenishment'
  | 'ambiguous'
  | 'unknown';

export interface ParsedSalesRationale {
  readonly reason: string;
  readonly intent: SalesIntent;
  readonly sku?: string | undefined;
  readonly query?: string | undefined;
  readonly cartSkus?: readonly string[] | undefined;
  readonly cartId?: string | undefined;
  readonly priorPurchaseRef?: string | undefined;
  readonly replenishmentIntervalDays?: number | undefined;
  readonly refusalReason?: string | undefined;
  readonly handoff_reason?: string | undefined;
}

export interface SalesAgentRuntimeOptions {
  readonly registry?: SkillRegistryResolver | undefined;
  readonly now?: (() => Date) | undefined;
  readonly resolvableDependencies?: DependencyReachabilityPredicate | undefined;
   readonly replenishment_policy?: SalesReplenishmentPolicyPort | undefined;
  readonly replenishment_policy_port?: SalesReplenishmentPolicyPort | undefined;
  readonly purchase_evidence?: SalesPurchaseEvidencePort | undefined;
 }

 /**
  * SalesAgentRuntime implements deterministic sales reasoning across SAL-01, SAL-02, and SAL-03.
  */
 export class SalesAgentRuntime implements IAgentRuntime {
   public readonly now?: (() => Date) | undefined;
   private readonly registry?: SkillRegistryResolver | undefined;
   private readonly resolvableDependencies?: DependencyReachabilityPredicate | undefined;
   private readonly replenishment_policy?: SalesReplenishmentPolicyPort | undefined;
  private readonly purchase_evidence?: SalesPurchaseEvidencePort | undefined;
   private readonly retainedRationales = new WeakMap<HypothesisRecord, ParsedSalesRationale>();

   constructor(options: SalesAgentRuntimeOptions = {}) {
     this.registry = options.registry;
     this.now = options.now;
     this.resolvableDependencies = options.resolvableDependencies;
    this.replenishment_policy = options.replenishment_policy ?? options.replenishment_policy_port;
    this.purchase_evidence = options.purchase_evidence;
   }

  async deriveHypothesis(signal: SignalEnvelope, context: HydratedContext): Promise<HypothesisRecord> {
    const text = extractMessageContent(signal);
    const priceRow = lookupRegistryRow(this.registry, 'skill.sales.check_price');
    const isPriceEnabled = priceRow?.enabled === true;

    const hasPrice = isPriceInquiry(text);
    const hasRecommend = isRecommendInquiry(text);
    const hasInventory = isInventoryInquiry(text);
    const hasCustomer = isCustomerLookupInquiry(text);
    const hasSearch = isProductSearchInquiry(text);

    const cartRecoveryData = extractCartRecoveryData(signal);
    const hasCartRecovery = Boolean(cartRecoveryData) || isCartRecoveryInquiry(text);

    const hasReplenish = isReplenishmentSignal(signal, text);

    // Count how many distinct strong categories matched
    const matchesCount = [
      hasPrice,
      hasRecommend,
      hasInventory,
      hasCustomer,
      hasSearch,
      hasCartRecovery,
      hasReplenish,
    ].filter(Boolean).length;

    let intent: SalesIntent = 'unknown';
    let confidence = 0.0;
    let rationaleData: ParsedSalesRationale = {
      reason: 'Message could not be deterministically mapped to a supported Sales intent.',
      intent: 'unknown',
    };

    if (matchesCount > 1 && (!hasPrice || isPriceEnabled)) {
      // Multiple conflicting non-disabled intents -> ambiguous
      intent = 'ambiguous';
      confidence = 0.3;
      rationaleData = {
        reason: 'Ambiguous request with multiple conflicting sales intents.',
        intent: 'ambiguous',
      };
    } else if (hasPrice) {
      if (isPriceEnabled) {
        const sku = extractSku(text);
        intent = 'price';
        confidence = 0.95;
        rationaleData = {
          reason: sku
            ? `Price inquiry for SKU '${sku}'.`
            : `Price inquiry without specific SKU in text: '${text}'.`,
          intent: 'price',
          sku: sku ?? undefined,
        };
      } else {
        // Price inquiry takes precedence to ensure fail-closed clarification under P2 policy
        intent = 'disabled_price';
        confidence = 0.95;
        rationaleData = {
          reason: `Price inquiry detected: '${text}'. Dynamic pricing and quotes are disabled under P2 policy.`,
          intent: 'disabled_price',
        };
      }
    } else if (hasCartRecovery) {
      intent = 'cart_recovery';
      confidence = 0.95;
      const sku = extractSku(text);
      const skus = [...(cartRecoveryData?.skus ?? [])];
      if (sku && !skus.includes(sku)) {
        skus.push(sku);
      }

      const consentRow = lookupRegistryRow(this.registry, 'skill.sales.retrieve_customer');
      const isConsentExecutable =
        Boolean(consentRow) &&
        this.isRowExecutable(consentRow, 'SAL-04') &&
        consentRow?.effect_class === 'READ';
      const rawChannel = context.working_memory?.last_touch_channel;
      const hasChannel = typeof rawChannel === 'string' && rawChannel.trim().length > 0;

      let refusalReason: string | undefined;
      if (!isConsentExecutable) {
        refusalReason = 'consent authority skill.sales.retrieve_customer unavailable';
      } else if (!hasChannel) {
        refusalReason = 'outbound channel missing';
      }

      if (refusalReason) {
        rationaleData = {
          reason: `Cart recovery evaluation failed: ${refusalReason}.`,
          intent: 'cart_recovery',
          cartId: cartRecoveryData?.cartId,
          cartSkus: Object.freeze(skus),
          sku: sku ?? skus[0],
          refusalReason,
        };
      } else {
        rationaleData = {
          reason: cartRecoveryData?.cartId
            ? `Cart recovery signal detected for cart '${cartRecoveryData.cartId}'.`
            : `Cart recovery intent detected: '${text}'.`,
          intent: 'cart_recovery',
          cartId: cartRecoveryData?.cartId,
          cartSkus: Object.freeze(skus),
          sku: sku ?? skus[0],
        };
      }
    } else if (hasReplenish) {
      intent = 'replenishment';
      confidence = 0.95;
      const payload = (signal.payload ?? {}) as Record<string, unknown>;
      const sku = extractSku(text) ?? (typeof payload.sku_id === 'string' ? payload.sku_id : undefined);

      const refusalReason = await evaluateReplenishmentRefusal(signal, context, {
        registry: this.registry,
        resolvableDependencies: this.resolvableDependencies,
        replenishment_policy: this.replenishment_policy,
        purchase_evidence: this.purchase_evidence,
        now: this.now,
      });

      let purchases: readonly VerifiedPurchaseEvidence[] = [];
      try {
        purchases = await extractVerifiedPurchases(context, this.purchase_evidence);
      } catch {
        purchases = [];
      }
      const rawPayloadRef =
        payload.prior_purchase_reference ??
        payload.order_reference ??
        payload.prior_order_id ??
        payload.purchase_reference ??
        payload.last_purchase_reference ??
        payload.previous_order_id;
      const hypothesisRef =
        typeof rawPayloadRef === 'string' && rawPayloadRef.trim().length > 0
          ? rawPayloadRef.trim()
          : undefined;
      let matched: VerifiedPurchaseEvidence | undefined;
      let resolvedSku: string | undefined;

      if (hypothesisRef) {
        matched = purchases.find((p) => p.order_id === hypothesisRef);
        if (matched) {
          const matchedSkus = getEvidenceSkus(matched);
          if (sku) {
            const hasItemEvidence = matchedSkus.length > 0;
            const skuInMatchedOrder = hasItemEvidence && matchedSkus.includes(sku);
            const skuInAnyPurchase = purchases.some((p) => getEvidenceSkus(p).includes(sku));
            if (hasItemEvidence ? skuInMatchedOrder : skuInAnyPurchase) {
              resolvedSku = sku;
            }
          } else {
            resolvedSku = matchedSkus[0];
          }
        }
      } else {
        if (sku) {
          matched = purchases.find((p) => getEvidenceSkus(p).includes(sku));
          if (matched) {
            resolvedSku = sku;
          }
        } else {
          matched = purchases[0];
          resolvedSku = matched ? getEvidenceSkus(matched)[0] : undefined;
        }
      }
      const priorPurchaseRef = matched?.order_id;

      let replenishmentIntervalDays: number | undefined;
      if (this.replenishment_policy && resolvedSku) {
        try {
          const policyRes = this.replenishment_policy.read({
            tenant_id: context.tenant_id,
            sku_id: resolvedSku,
          });
          const policy = policyRes instanceof Promise ? await policyRes : policyRes;
          if (
            policy &&
            policy.owner_approved === true &&
            typeof policy.replenishment_interval_days === 'number' &&
            policy.replenishment_interval_days > 0
          ) {
            replenishmentIntervalDays = policy.replenishment_interval_days;
          }
        } catch {
          replenishmentIntervalDays = undefined;
        }
      }

      if (refusalReason) {
        rationaleData = {
          reason: `Replenishment evaluation failed: ${refusalReason}.`,
          intent: 'replenishment',
          priorPurchaseRef,
          replenishmentIntervalDays,
          sku: resolvedSku,
          refusalReason,
        };
      } else {
        rationaleData = {
          reason: `Replenishment evaluation succeeded for prior purchase '${priorPurchaseRef ?? 'unknown'}'.`,
          intent: 'replenishment',
          priorPurchaseRef,
          replenishmentIntervalDays,
          sku: resolvedSku,
        };
      }
    } else if (hasCustomer) {
      intent = 'customer_lookup';
      confidence = 0.95;
      rationaleData = {
        reason: `Customer profile inquiry: '${text}'.`,
        intent: 'customer_lookup',
      };
    } else if (hasRecommend) {
      intent = 'recommend';
      confidence = 0.95;
      const payloadCartSkus = (signal.payload as Record<string, unknown> | null)?.current_cart_skus;
      const cartSkus = Array.isArray(payloadCartSkus)
        ? (payloadCartSkus.filter((item): item is string => typeof item === 'string'))
        : [];
      const extracted = extractSku(text);
      if (extracted && !cartSkus.includes(extracted)) {
        cartSkus.push(extracted);
      }
      rationaleData = {
        reason: `Product recommendation inquiry: '${text}'.`,
        intent: 'recommend',
        cartSkus,
      };
    } else if (hasInventory) {
      const sku = extractSku(text);
      intent = 'inventory';
      confidence = 0.95;
      rationaleData = {
        reason: sku
          ? `Inventory check request for SKU '${sku}'.`
          : `Inventory check request without specific SKU in text: '${text}'.`,
        intent: 'inventory',
        sku: sku ?? undefined,
      };
    } else if (hasSearch) {
      const query = cleanSearchQuery(text);
      intent = 'product_search';
      confidence = 0.9;
      rationaleData = {
        reason: `Catalog product search for query '${query}'.`,
        intent: 'product_search',
        query,
      };
    }

    const handoff_reason = extractSalesHandoffReason(signal);
    if (handoff_reason) {
      rationaleData = { ...rationaleData, handoff_reason };
    }

    const derived_from_signals = [signal.signal_id];
    if (rationaleData.sku) {
      derived_from_signals.push(`sku:${rationaleData.sku}`);
    }

    const hypothesis: HypothesisRecord = {
      classification: 'HYPOTHESIS',
      intent,
      confidence,
      churn_risk_score: 0.0,
      purchase_propensity: context.customer ? 0.75 : 0.25,
      reasoning: rationaleData.reason,
      derived_from_signals,
    };

    this.retainedRationales.set(hypothesis, rationaleData);
    return hypothesis;
  }

  async resolveRouting(
    _signal: SignalEnvelope,
    context: HydratedContext,
    hypothesis: HypothesisRecord,
  ): Promise<RoutingDecision> {
    const rationale = this.retainedRationales.get(hypothesis);
    const intent = rationale?.intent ?? (hypothesis.intent as SalesIntent);

    switch (intent) {
      case 'customer_lookup':
        return {
          target_agent: 'SAL-01' as PlatformAgentId,
          requires_clarification: false,
          rationalization: hypothesis.reasoning,
        };

      case 'product_search':
        if (!rationale?.query || rationale.query.trim().length === 0) {
          return {
            target_agent: 'SAL-02' as PlatformAgentId,
            requires_clarification: true,
            clarification_prompt: 'What product are you looking to search for?',
            rationalization: 'Product search requires a non-empty query.',
          };
        }
        return {
          target_agent: 'SAL-02' as PlatformAgentId,
          requires_clarification: false,
          rationalization: hypothesis.reasoning,
        };

      case 'inventory':
        if (!rationale?.sku) {
          return {
            target_agent: 'SAL-02' as PlatformAgentId,
            requires_clarification: true,
            clarification_prompt: 'Please provide the product SKU or code to check stock availability.',
            rationalization: 'Inventory check requires a valid SKU.',
          };
        }
        return {
          target_agent: 'SAL-02' as PlatformAgentId,
          requires_clarification: false,
          rationalization: hypothesis.reasoning,
        };

      case 'price': {
        const priceRow = lookupRegistryRow(this.registry, 'skill.sales.check_price');
        if (!priceRow || priceRow.enabled === false) {
          return {
            target_agent: 'SAL-02' as PlatformAgentId,
            requires_clarification: true,
            clarification_prompt:
              'Price quotes and automated discount calculations are currently disabled under platform policy. Please contact sales directly.',
            rationalization: hypothesis.reasoning,
          };
        }
        if (!rationale?.sku) {
          return {
            target_agent: 'SAL-02' as PlatformAgentId,
            requires_clarification: true,
            clarification_prompt: 'Please provide the product SKU or code to check price.',
            rationalization: 'Price inquiry requires a valid SKU.',
          };
        }
        return {
          target_agent: 'SAL-02' as PlatformAgentId,
          requires_clarification: false,
          rationalization: hypothesis.reasoning,
        };
      }

      case 'disabled_price':
        return {
          target_agent: 'SAL-02' as PlatformAgentId,
          requires_clarification: true,
          clarification_prompt:
            'Price quotes and automated discount calculations are currently disabled under platform policy. Please contact sales directly.',
          rationalization: hypothesis.reasoning,
        };

      case 'cart_recovery':
        if (rationale?.refusalReason) {
          return {
            target_agent: 'SAL-04' as PlatformAgentId,
            requires_clarification: true,
            clarification_prompt: `Cart recovery cannot be scheduled: ${rationale.refusalReason}.`,
            rationalization: hypothesis.reasoning,
          };
        }
        if (!rationale?.cartId && (!rationale?.cartSkus || rationale.cartSkus.length === 0)) {
          return {
            target_agent: 'SAL-04' as PlatformAgentId,
            requires_clarification: true,
            clarification_prompt: 'Cart recovery requires a cart identifier or items list.',
            rationalization: 'Cart recovery requires an identified cart or SKUs.',
          };
        }
        if (!context.customer) {
          return {
            target_agent: 'SAL-04' as PlatformAgentId,
            requires_clarification: true,
            clarification_prompt: 'Cart recovery requires verified customer context.',
            rationalization: 'Customer context missing for cart recovery.',
          };
        }
        if (context.customer.consent_marketing !== true) {
          return {
            target_agent: 'SAL-04' as PlatformAgentId,
            requires_clarification: true,
            clarification_prompt: 'Customer has not consented to marketing communications.',
            rationalization: 'Marketing consent missing or withdrawn for cart recovery.',
          };
        }
        if (context.customer.suppression_active) {
          return {
            target_agent: 'SAL-04' as PlatformAgentId,
            requires_clarification: true,
            clarification_prompt: 'Customer suppression rule is active.',
            rationalization: 'Customer suppression is active.',
          };
        }
        {
          const consentRow = lookupRegistryRow(this.registry, 'skill.sales.retrieve_customer');
          if (!consentRow || !this.isRowExecutable(consentRow, 'SAL-04') || consentRow.effect_class !== 'READ') {
            return {
              target_agent: 'SAL-04' as PlatformAgentId,
              requires_clarification: true,
              clarification_prompt:
                'Cart recovery cannot be scheduled: consent authority skill.sales.retrieve_customer unavailable.',
              rationalization:
                'Cart recovery refused: missing consent authority skill.sales.retrieve_customer.',
            };
          }
          const rawChannel = context.working_memory?.last_touch_channel;
          const channel = typeof rawChannel === 'string' && rawChannel.trim().length > 0 ? rawChannel.trim() : null;
          if (!channel) {
            return {
              target_agent: 'SAL-04' as PlatformAgentId,
              requires_clarification: true,
              clarification_prompt:
                'Cart recovery cannot be scheduled: outbound channel missing.',
              rationalization:
                'Cart recovery refused: missing outbound touch channel.',
            };
          }
        }
        return {
          target_agent: 'SAL-04' as PlatformAgentId,
          requires_clarification: false,
          rationalization: hypothesis.reasoning,
        };

      case 'replenishment':
        if (rationale?.refusalReason) {
          return {
            target_agent: 'SAL-05' as PlatformAgentId,
            requires_clarification: true,
            clarification_prompt: `Replenishment cannot be scheduled: ${rationale.refusalReason}.`,
            rationalization: hypothesis.reasoning,
          };
        }
        return {
          target_agent: 'SAL-05' as PlatformAgentId,
          requires_clarification: false,
          rationalization: hypothesis.reasoning,
        };
      case 'recommend':
        return {
          target_agent: 'SAL-03' as PlatformAgentId,
          requires_clarification: false,
          rationalization: hypothesis.reasoning,
        };

      case 'ambiguous':
        return {
          target_agent: 'SAL-01' as PlatformAgentId,
          requires_clarification: true,
          clarification_prompt:
            'Your request contains multiple inquiries. Please clarify whether you would like to search for products, check stock, or receive product recommendations.',
          rationalization: hypothesis.reasoning,
        };

      case 'unknown':
      default:
        return {
          target_agent: 'SAL-01' as PlatformAgentId,
          requires_clarification: true,
          clarification_prompt:
            'How can I assist you with product catalog searches, inventory checks, or recommendations today?',
          rationalization: hypothesis.reasoning,
        };
    }
  }

  async formulatePlan(
    routing: RoutingDecision,
    context: HydratedContext,
    hypothesis: HypothesisRecord,
  ): Promise<ExecutionPlan> {
    const plan = await this.composePlan(routing, context, hypothesis);

    return this.withHandoffIntent(plan, context, this.retainedRationales.get(hypothesis));
  }

  private async composePlan(
    routing: RoutingDecision,
    context: HydratedContext,
    hypothesis: HypothesisRecord,
  ): Promise<ExecutionPlan> {
    const plan_id = `plan_${randomUUID().slice(0, 8)}`;

    // Clarification-required routing always emits an empty plan
    if (routing.requires_clarification) {
      return {
        plan_id,
        steps: [],
        fallback_strategy: 'FAIL_CLOSED',
      };
    }

    const rationale = this.retainedRationales.get(hypothesis);
    const intent = rationale?.intent ?? (hypothesis.intent as SalesIntent);

    if (intent === 'customer_lookup') {
      // Invariant: Customer identity is derived exclusively from server-hydrated context, NEVER from payload
      const customerId = context.customer?.customer_id;
      if (!customerId) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      const row = lookupRegistryRow(this.registry, 'skill.sales.retrieve_customer');
      if (!this.isRowExecutable(row, routing.target_agent) || row.effect_class !== 'READ') {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      const step = this.buildPlannedStep(
        1,
        routing.target_agent,
        row,
        {
          tenant_id: context.tenant_id,
          customer_identifier: customerId,
        },
        [],
      );

      return {
        plan_id,
        steps: [step],
        fallback_strategy: 'FAIL_CLOSED',
      };
    }

    if (intent === 'product_search') {
      const query = rationale?.query?.trim();
      if (!query) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      const row = lookupRegistryRow(this.registry, 'skill.sales.search_product');
      if (!this.isRowExecutable(row, routing.target_agent) || row.effect_class !== 'READ') {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      const step = this.buildPlannedStep(
        1,
        routing.target_agent,
        row,
        {
          tenant_id: context.tenant_id,
          query,
        },
        [],
      );

      return {
        plan_id,
        steps: [step],
        fallback_strategy: 'FAIL_CLOSED',
      };
    }

    if (intent === 'inventory') {
      const sku = rationale?.sku;
      if (!sku) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      const row = lookupRegistryRow(this.registry, 'skill.sales.check_stock');
      if (!this.isRowExecutable(row, routing.target_agent) || row.effect_class !== 'READ') {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      const step = this.buildPlannedStep(
        1,
        routing.target_agent,
        row,
        {
          tenant_id: context.tenant_id,
          sku_id: sku,
        },
        [],
      );

      return {
        plan_id,
        steps: [step],
        fallback_strategy: 'FAIL_CLOSED',
      };
    }

    if (intent === 'price') {
      const sku = rationale?.sku;
      if (!sku) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      const row = lookupRegistryRow(this.registry, 'skill.sales.check_price');
      if (!this.isRowExecutable(row, routing.target_agent) || row.effect_class !== 'READ') {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      const customerId = context.customer?.customer_id;
      if (!customerId) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      const step = this.buildPlannedStep(
        1,
        routing.target_agent,
        row,
        {
          tenant_id: context.tenant_id,
          sku_id: sku,
          customer_id: customerId,
        },
        [],
      );

      return {
        plan_id,
        steps: [step],
        fallback_strategy: 'FAIL_CLOSED',
      };
    }

    if (intent === 'recommend') {
      // Invariant: Recommendations strictly require a hydrated customer context
      const customerId = context.customer?.customer_id;
      if (!customerId) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      const row = lookupRegistryRow(this.registry, 'skill.sales.recommend_product');
      if (!this.isRowExecutable(row, routing.target_agent) || row.effect_class !== 'READ') {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      const cartSkus = rationale?.cartSkus ? [...rationale.cartSkus] : [];
      const step = this.buildPlannedStep(
        1,
        routing.target_agent,
        row,
        {
          tenant_id: context.tenant_id,
          customer_id: customerId,
          current_cart_skus: cartSkus,
          recommendation_type: 'CROSS_SELL',
        },
        [],
      );

      return {
        plan_id,
        steps: [step],
        fallback_strategy: 'FAIL_CLOSED',
      };
    }

    if (intent === 'cart_recovery') {
      const customerId = context.customer?.customer_id;
      if (!customerId) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      // With the unbound session-control port or active takeover, no outbound step is planned
      if (context.working_memory.takeover_active) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      if (context.customer.consent_marketing !== true || context.customer.suppression_active) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      const skus = rationale?.cartSkus && rationale.cartSkus.length > 0
        ? [...rationale.cartSkus]
        : (rationale?.sku ? [rationale.sku] : []);

      if (rationale?.refusalReason) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      // Authoritative consent/context read: skill.sales.retrieve_customer (AUTH-0, Customer360)
      const consentRow = lookupRegistryRow(this.registry, 'skill.sales.retrieve_customer');
      if (!consentRow || !this.isRowExecutable(consentRow, routing.target_agent) || consentRow.effect_class !== 'READ') {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      // Outbound channel must come from server-bound context; fails closed if absent
      const rawChannel = context.working_memory?.last_touch_channel;
      const channel =
        typeof rawChannel === 'string' && rawChannel.trim().length > 0
          ? rawChannel.trim().toUpperCase()
          : null;
      if (!channel) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      const steps: PlannedStep[] = [];
      let stepIndex = 1;

      // Canonical order: (consent -> suppression -> stock -> price -> floor/policy -> cart -> message action)

      // 1. Authoritative consent/context read
      const dependsOn = steps.length > 0 ? [steps[steps.length - 1]!.step_index] : [];
      steps.push(
        this.buildPlannedStep(
          stepIndex++,
          routing.target_agent,
          consentRow,
          {
            tenant_id: context.tenant_id,
            customer_identifier: customerId,
          },
          dependsOn,
        ),
      );

      // 2. Suppression (if optional suppression row is executable)
      const suppressionRow = lookupRegistryRow(this.registry, 'skill.sales.check_suppression');
      if (suppressionRow && this.isRowExecutable(suppressionRow, routing.target_agent)) {
        const suppressionDepends = [steps[steps.length - 1]!.step_index];
        steps.push(
          this.buildPlannedStep(
            stepIndex++,
            routing.target_agent,
            suppressionRow,
            {
              tenant_id: context.tenant_id,
              customer_id: customerId,
            },
            suppressionDepends,
          ),
        );
      }

      // 3. Stock
      const stockRow = lookupRegistryRow(this.registry, 'skill.sales.check_stock');
      if (stockRow && this.isRowExecutable(stockRow, routing.target_agent) && skus.length > 0) {
        const stockDepends = [steps[steps.length - 1]!.step_index];
        steps.push(
          this.buildPlannedStep(
            stepIndex++,
            routing.target_agent,
            stockRow,
            {
              tenant_id: context.tenant_id,
              sku_id: skus[0]!,
            },
            stockDepends,
          ),
        );
      }

      // 4. Price
      const priceRow = lookupRegistryRow(this.registry, 'skill.sales.check_price');
      if (priceRow && this.isRowExecutable(priceRow, routing.target_agent) && skus.length > 0) {
        const priceDepends = [steps[steps.length - 1]!.step_index];
        steps.push(
          this.buildPlannedStep(
            stepIndex++,
            routing.target_agent,
            priceRow,
            {
              tenant_id: context.tenant_id,
              sku_id: skus[0]!,
              customer_id: customerId,
            },
            priceDepends,
          ),
        );
      }

      // 5. Floor/policy
      const floorRow =
        lookupRegistryRow(this.registry, 'skill.sales.check_floor') ??
        lookupRegistryRow(this.registry, 'skill.sales.verify_policy') ??
        lookupRegistryRow(this.registry, 'skill.sales.check_price_floor');
      if (floorRow && this.isRowExecutable(floorRow, routing.target_agent) && skus.length > 0) {
        const floorDepends = [steps[steps.length - 1]!.step_index];
        steps.push(
          this.buildPlannedStep(
            stepIndex++,
            routing.target_agent,
            floorRow,
            {
              tenant_id: context.tenant_id,
              sku_id: skus[0]!,
              customer_id: customerId,
            },
            floorDepends,
          ),
        );
      }

      // 6. Cart action
      const cartRow = lookupRegistryRow(this.registry, 'skill.sales.create_cart');
      if (cartRow && this.isRowExecutable(cartRow, routing.target_agent)) {
        const cartDepends = [steps[steps.length - 1]!.step_index];
        steps.push(
          this.buildPlannedStep(
            stepIndex++,
            routing.target_agent,
            cartRow,
            {
              tenant_id: context.tenant_id,
              session_id: context.working_memory.session_id,
              customer_id: customerId,
              items: skus.map((skuId) => ({ sku_id: skuId, quantity: 1 })),
            },
            cartDepends,
          ),
        );
      }

      // 7. Message action
      const messageRow = lookupRegistryRow(this.registry, 'skill.sales.send_message');
      if (messageRow && this.isRowExecutable(messageRow, routing.target_agent)) {
        const messageDepends = [steps[steps.length - 1]!.step_index];
        steps.push(
          this.buildPlannedStep(
            stepIndex++,
            routing.target_agent,
            messageRow,
            {
              tenant_id: context.tenant_id,
              recipient_id: customerId,
              channel,
              message_content: {
                text: 'You left items in your cart. Complete your purchase now!',
              },
            },
            messageDepends,
          ),
        );
      }

      if (steps.length === 0) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      return {
        plan_id,
        steps,
        fallback_strategy: 'FAIL_CLOSED',
      };
    }

    if (intent === 'replenishment') {
      const customerId = context.customer?.customer_id;
      if (!customerId) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      if (rationale?.refusalReason) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      // With the unbound session-control port or active takeover, no outbound step is planned
      if (context.working_memory.takeover_active) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      if (context.customer.consent_marketing !== true || context.customer.suppression_active) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      const sku = rationale?.sku;
      if (!sku) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }
      // Authoritative consent/context read: skill.sales.retrieve_customer (AUTH-0, Customer360)
      const consentRow = lookupRegistryRow(this.registry, 'skill.sales.retrieve_customer');
      if (!consentRow || !this.isRowExecutable(consentRow, routing.target_agent) || consentRow.effect_class !== 'READ') {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      // Outbound channel must come from server-bound context; fails closed if absent
      const rawChannel = context.working_memory?.last_touch_channel;
      const channel =
        typeof rawChannel === 'string' && rawChannel.trim().length > 0
          ? rawChannel.trim().toUpperCase()
          : null;
      if (!channel) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      const steps: PlannedStep[] = [];
      let stepIndex = 1;

      // Canonical order: (consent -> suppression -> stock -> price -> floor/policy -> message action)

      // 1. Authoritative consent/context read
      const dependsOn = steps.length > 0 ? [steps[steps.length - 1]!.step_index] : [];
      steps.push(
        this.buildPlannedStep(
          stepIndex++,
          routing.target_agent,
          consentRow,
          {
            tenant_id: context.tenant_id,
            customer_identifier: customerId,
          },
          dependsOn,
        ),
      );

      // 2. Suppression (if optional suppression row is executable)
      const suppressionRow = lookupRegistryRow(this.registry, 'skill.sales.check_suppression');
      if (suppressionRow && this.isRowExecutable(suppressionRow, routing.target_agent)) {
        const suppressionDepends = [steps[steps.length - 1]!.step_index];
        steps.push(
          this.buildPlannedStep(
            stepIndex++,
            routing.target_agent,
            suppressionRow,
            {
              tenant_id: context.tenant_id,
              customer_id: customerId,
            },
            suppressionDepends,
          ),
        );
      }

      // 3. Stock
      const stockRow = lookupRegistryRow(this.registry, 'skill.sales.check_stock');
      if (stockRow && sku && this.isRowExecutable(stockRow, routing.target_agent)) {
        const stockDepends = [steps[steps.length - 1]!.step_index];
        steps.push(
          this.buildPlannedStep(
            stepIndex++,
            routing.target_agent,
            stockRow,
            {
              tenant_id: context.tenant_id,
              sku_id: sku,
            },
            stockDepends,
          ),
        );
      }

      // 4. Price
      const priceRow = lookupRegistryRow(this.registry, 'skill.sales.check_price');
      if (priceRow && sku && this.isRowExecutable(priceRow, routing.target_agent)) {
        const priceDepends = [steps[steps.length - 1]!.step_index];
        steps.push(
          this.buildPlannedStep(
            stepIndex++,
            routing.target_agent,
            priceRow,
            {
              tenant_id: context.tenant_id,
              sku_id: sku,
              customer_id: customerId,
            },
            priceDepends,
          ),
        );
      }

      // 5. Floor/policy
      const floorRow =
        lookupRegistryRow(this.registry, 'skill.sales.check_floor') ??
        lookupRegistryRow(this.registry, 'skill.sales.verify_policy') ??
        lookupRegistryRow(this.registry, 'skill.sales.check_price_floor');
      if (floorRow && sku && this.isRowExecutable(floorRow, routing.target_agent)) {
        const floorDepends = [steps[steps.length - 1]!.step_index];
        steps.push(
          this.buildPlannedStep(
            stepIndex++,
            routing.target_agent,
            floorRow,
            {
              tenant_id: context.tenant_id,
              sku_id: sku,
              customer_id: customerId,
            },
            floorDepends,
          ),
        );
      }

      // 6. Message action
      const messageRow = lookupRegistryRow(this.registry, 'skill.sales.send_message');
      if (messageRow && this.isRowExecutable(messageRow, routing.target_agent)) {
        const messageDepends = [steps[steps.length - 1]!.step_index];
        steps.push(
          this.buildPlannedStep(
            stepIndex++,
            routing.target_agent,
            messageRow,
            {
              tenant_id: context.tenant_id,
              recipient_id: customerId,
              channel,
              message_content: {
                text: "It's time to reorder your previously purchased product!",
              },
            },
            messageDepends,
          ),
        );
      }

      if (steps.length === 0) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      return {
        plan_id,
        steps,
        fallback_strategy: 'FAIL_CLOSED',
      };
    }

    // Default fail-closed for any unmapped intent or price intent
    return {
      plan_id,
      steps: [],
      fallback_strategy: 'FAIL_CLOSED',
    };
  }

  private withHandoffIntent(
    plan: ExecutionPlan,
    context: HydratedContext,
    rationale: ParsedSalesRationale | undefined,
  ): ExecutionPlan {
    if (
      plan.steps.length === 0
      || !context.customer?.customer_id
      || !rationale?.handoff_reason
      || !plan.steps.every((step) => step.agent_id.startsWith('SAL-'))
    ) {
      return plan;
    }

    const handoff_intent: HandoffIntent = {
      source_domain: 'sales',
      target_domain: 'care',
      target_agent: 'CS-01',
      reason: rationale.handoff_reason,
    };
    return { ...plan, handoff_intent };
  }

  private buildPlannedStep(
    stepIndex: number,
    agentId: PlatformAgentId,
    row: SkillRegistryRowMetadata,
    inputParameters: Record<string, unknown>,
    dependsOnSteps: readonly number[],
  ): PlannedStep {
    const policy = deriveEffectPolicy(row.effect_class);
    return {
      step_index: stepIndex,
      agent_id: agentId,
      skill_id: row.skill_id,
      adapter_target: row.guarded_dependency,
      input_parameters: inputParameters,
      required_authority: row.required_authority,
      mutating: row.mutating ?? policy.mutating,
      price_bearing: row.price_bearing ?? policy.price_bearing,
      idempotent: row.idempotent ?? policy.idempotent,
      timeout_ms: row.timeout_ms,
      depends_on_steps: [...dependsOnSteps],
    };
  }

  /**
   * Validates that a registry row exists, is enabled, has a resolvable guarded dependency,
   * and is authorized for the target agent.
   */
  private isRowExecutable(
    row: SkillRegistryRowMetadata | null,
    targetAgent: PlatformAgentId,
  ): row is SkillRegistryRowMetadata {
    return isRowExecutable(row, targetAgent, this.resolvableDependencies);
  }
}
