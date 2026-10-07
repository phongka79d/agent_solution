import type {
  HydratedContext,
  SignalEnvelope,
} from '@agentos/core-engine/contracts';
import type { SalesReplenishmentPolicy, SalesReplenishmentPolicyPort } from './skills/types.js';
import {
  extractMessageContent,
  extractSku,
  isRowExecutable,
  lookupRegistryRow,
  type DependencyReachabilityPredicate,
  type SkillRegistryResolver,
} from './intent-classifier.js';

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
export interface SalesPurchaseEvidencePort {
  read(query: SalesPurchaseEvidenceQuery): Promise<readonly VerifiedPurchaseEvidence[]>;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

function isValidIsoTimestamp(ts: unknown): ts is string {
  if (typeof ts !== 'string' || !ISO_TIMESTAMP.test(ts.trim())) return false;
  const ms = new Date(ts.trim()).getTime();
  return Number.isFinite(ms);
}

export function getEvidenceSkus(evidence: VerifiedPurchaseEvidence): readonly string[] {
  return evidence.sku_ids ?? evidence.items ?? [];
}

export interface ReplenishmentEvaluationOptions {
  readonly registry?: SkillRegistryResolver | undefined;
  readonly resolvableDependencies?: DependencyReachabilityPredicate | undefined;
  readonly replenishment_policy?: SalesReplenishmentPolicyPort | undefined;
  readonly replenishment_policy_port?: SalesReplenishmentPolicyPort | undefined;
  readonly purchase_evidence?: SalesPurchaseEvidencePort | undefined;
  /** Shared with hypothesis extraction so one evaluation uses one authoritative source read. */
  readonly purchase_evidence_read?: Promise<readonly VerifiedPurchaseEvidence[]> | undefined;
  /** Shared with hypothesis extraction so one evaluation uses one authoritative policy read. */
  readonly replenishment_policy_read?: Promise<SalesReplenishmentPolicy | undefined> | undefined;
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

    const quantityValue = 'quantity' in item ? item.quantity : undefined;
    if (quantityValue !== undefined && (typeof quantityValue !== 'number' || !Number.isFinite(quantityValue))) {
      throw new Error('purchase evidence missing or stale: purchase evidence missing');
    }
    const quantity = typeof quantityValue === 'number' ? quantityValue : undefined;
    const totalAmountValue = 'total_amount' in item ? item.total_amount : undefined;
    if (
      totalAmountValue !== undefined
      && (typeof totalAmountValue !== 'number' || !Number.isFinite(totalAmountValue))
    ) {
      throw new Error('purchase evidence missing or stale: purchase evidence missing');
    }
    const totalAmount = typeof totalAmountValue === 'number' ? totalAmountValue : undefined;
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

  validated.sort((left, right) => {
    const byDate = new Date(right.order_date).getTime() - new Date(left.order_date).getTime();
    return Number.isFinite(byDate) && byDate !== 0
      ? byDate
      : left.order_id.localeCompare(right.order_id);
  });

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
  if (!context.customer || (!port && !options?.purchase_evidence_read)) {
    return 'purchase evidence missing or stale: purchase evidence missing';
  }

  let purchases: readonly VerifiedPurchaseEvidence[];
  try {
    purchases = options?.purchase_evidence_read
      ? await options.purchase_evidence_read
      : await extractVerifiedPurchases(context, port);
  } catch (err) {
    if (err instanceof Error && err.message.includes('evidence stale')) {
      return 'purchase evidence missing or stale: evidence stale';
    }
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
  if (!policyPort && !options?.replenishment_policy_read) {
    return 'no owner-approved replenishment interval';
  }

  const querySku = resolvedSku;
  let policy: SalesReplenishmentPolicy | undefined;
  try {
    policy = options?.replenishment_policy_read
      ? await options.replenishment_policy_read
      : await policyPort!.read({
          tenant_id: context.tenant_id,
          sku_id: querySku,
        });
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
  let currentMs: number;
  try {
    const currentDate = nowFn ? nowFn() : (signal.timestamp ? new Date(signal.timestamp) : new Date());
    currentMs = currentDate.getTime();
  } catch {
    return 'purchase evidence missing or stale: purchase evidence missing';
  }
  if (!Number.isFinite(currentMs)) {
    return 'purchase evidence missing or stale: purchase evidence missing';
  }

  const intervalDays = policy.replenishment_interval_days;
  const intervalMs = intervalDays * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(intervalMs)) {
    return 'no owner-approved replenishment interval';
  }

  const matchedOrderDate = new Date(matchedEvidence.order_date);
  const matchedOrderMs = matchedOrderDate.getTime();
  if (!Number.isFinite(matchedOrderMs)) {
    return 'purchase evidence missing or stale: purchase evidence missing';
  }

  const elapsedSinceMatchedMs = currentMs - matchedOrderMs;
  if (!Number.isFinite(elapsedSinceMatchedMs)) {
    return 'purchase evidence missing or stale: purchase evidence missing';
  }
  if (elapsedSinceMatchedMs < intervalMs) {
    return 'recent purchase invalidates reorder hypothesis';
  }

  for (const purchase of purchases) {
    if (purchase.order_id === matchedEvidence.order_id) continue;
    if (purchase.items && !purchase.items.includes(querySku)) continue;
    const pDate = new Date(purchase.order_date);
    const pMs = pDate.getTime();
    if (!Number.isFinite(pMs)) {
      return 'purchase evidence missing or stale: purchase evidence missing';
    }
    const elapsedSincePurchaseMs = currentMs - pMs;
    if (
      !Number.isFinite(elapsedSincePurchaseMs)
      || (elapsedSincePurchaseMs < intervalMs && pMs > matchedOrderMs)
    ) {
      if (!Number.isFinite(elapsedSincePurchaseMs)) {
        return 'purchase evidence missing or stale: purchase evidence missing';
      }
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
  if (!Number.isFinite(maxAgeMs)) {
    return 'no owner-approved replenishment interval';
  }
  if (elapsedSinceMatchedMs > maxAgeMs) {
    return 'purchase evidence missing or stale: evidence stale';
  }

  return null;
}
