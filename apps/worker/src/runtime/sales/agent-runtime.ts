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
import { OrchestratorError } from '@agentos/core-engine/contracts';
import type {
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
import {
  BUILTIN_SALES_LEXICON,
  cleanSearchQuery,
  extractCartRecoveryData,
  extractMessageContent,
  extractSku,
  isCartRecoveryInquiry,
  isCustomerLookupInquiry,
  isDependencyResolvable,
  isInventoryInquiry,
  isPriceInquiry,
  isProductSearchInquiry,
  isRecommendInquiry,
  isReplenishmentInquiry,
  isReplenishmentSignal,
  isRowExecutable,
  lookupRegistryRow,
  mergeSalesLexicon,
  type CartRecoveryData,
  type DependencyReachabilityPredicate,
  type SalesLexicon,
  type SalesLexiconPort,
  type SalesLexiconWarningCode,
  type SkillRegistryPort,
  type SkillRegistryResolver,
  type SkillRegistryRowMetadata,
} from './intent-classifier.js';
import {
  evaluateReplenishmentRefusal,
  extractVerifiedPurchases,
  getEvidenceSkus,
  type ReplenishmentEvaluationOptions,
  type SalesPurchaseEvidencePort,
  type SalesPurchaseEvidenceQuery,
  type VerifiedPurchaseEvidence,
} from './replenishment-evaluator.js';
import {
  buildPlannedStep,
  deriveEffectPolicy,
  type DerivedEffectPolicy,
} from './plan-composer.js';
import {
  type SalesAdvisorExecutionState,
  type SalesAdvisorRequirements,
} from './advisor-adapters.js';
import type { SalesReplenishmentPolicyPort } from './skills/types.js';
export {
  BUILTIN_SALES_LEXICON,
  cleanSearchQuery,
  deriveEffectPolicy,
  evaluateReplenishmentRefusal,
  extractCartRecoveryData,
  extractMessageContent,
  extractSku,
  extractVerifiedPurchases,
  isCartRecoveryInquiry,
  isCustomerLookupInquiry,
  isDependencyResolvable,
  isInventoryInquiry,
  isPriceInquiry,
  isProductSearchInquiry,
  isRecommendInquiry,
  isReplenishmentInquiry,
  isReplenishmentSignal,
  isRowExecutable,
  mergeSalesLexicon,
};
export type {
  CartRecoveryData,
  DependencyReachabilityPredicate,
  DerivedEffectPolicy,
  ReplenishmentEvaluationOptions,
  SalesLexicon,
  SalesLexiconPort,
  SalesLexiconWarningCode,
  SalesPurchaseEvidencePort,
  SalesPurchaseEvidenceQuery,
  SkillRegistryPort,
  SkillRegistryResolver,
  SkillRegistryRowMetadata,
  VerifiedPurchaseEvidence,
};
/** Returns the brokered journey leg encoded by the orchestrator, when present. */
function readHandoffTargetDomain(signal: SignalEnvelope): string | undefined {
  // Only the orchestrator writes this channel: a customer-facing delivery that carries a handoff
  // payload is not a brokered handoff, and reading one would let a caller route itself onward.
  if (signal.source_channel !== 'ORCHESTRATOR_HANDOFF') return undefined;
  const raw = signal.payload.handoff;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const handoff = raw as Record<string, unknown>;
  return typeof handoff.target_domain === 'string' ? handoff.target_domain : undefined;
}

/** Reads only the broker-stamped reason for the canonical marketing → sales edge. */
function extractSalesHandoffReason(signal: SignalEnvelope): string | undefined {
  if (readHandoffTargetDomain(signal) !== 'sales') return undefined;
  const reason = signal.payload.handoff_reason;
  return typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : undefined;
}

function readAdvisorRequirements(signal: SignalEnvelope): SalesAdvisorRequirements | undefined {
  const payload = signal.payload;
  const hasStructuredFields = Object.hasOwn(payload, 'sales_proposal_source')
    || Object.hasOwn(payload, 'sales_intent')
    || Object.hasOwn(payload, 'sales_requirements');
  if (!hasStructuredFields) return undefined;

  // These fields are stamped by the API gateway only after its trusted classifier has
  // normalized the customer message. Presence is therefore mandatory: malformed or
  // mismatched structured data must refuse instead of falling back to legacy text parsing.
  if (
    payload.sales_proposal_source !== 'API_GATEWAY'
    || signal.source_channel !== 'WEB_CHAT'
    || signal.event_type !== 'message.received'
    || payload.sales_intent !== 'advisor'
  ) {
    throw new OrchestratorError(
      'SALES_STRUCTURED_INTENT_INVALID',
      'Sales advisor requirements are only accepted from the API-stamped WEB_CHAT message path.',
    );
  }

  const raw = payload.sales_requirements;
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    throw new OrchestratorError(
      'SALES_STRUCTURED_INTENT_INVALID',
      'Server-stamped Sales advisor intent requires a requirements object when provided.',
    );
  }
  const requirements = (raw ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(requirements)) {
    if (key !== 'category' && key !== 'budget' && key !== 'use_case' && key !== 'product_eligibility') {
      throw new OrchestratorError(
        'SALES_STRUCTURED_INTENT_INVALID',
        `Unknown server-stamped Sales requirement '${key}'.`,
      );
    }
  }

  const category = parseBoundedRequirementString(requirements.category, 'category', 64, true);
  const use_case = parseBoundedRequirementString(requirements.use_case, 'use_case', 160, true);

  let budget: SalesAdvisorRequirements['budget'];
  if (requirements.budget !== undefined) {
    const rawBudget = requirements.budget;
    if (typeof rawBudget !== 'object' || rawBudget === null || Array.isArray(rawBudget)) {
      throw new OrchestratorError(
        'SALES_STRUCTURED_INTENT_INVALID',
        'Sales advisor budget must be an object with amount and currency.',
      );
    }
    const budgetRecord = rawBudget as Record<string, unknown>;
    for (const key of Object.keys(budgetRecord)) {
      if (key !== 'amount' && key !== 'currency') {
        throw new OrchestratorError(
          'SALES_STRUCTURED_INTENT_INVALID',
          `Unknown server-stamped Sales budget field '${key}'.`,
        );
      }
    }
    const amount = budgetRecord.amount;
    const currency = budgetRecord.currency;
    if (
      typeof amount !== 'number'
      || !Number.isSafeInteger(amount)
      || amount <= 0
      || typeof currency !== 'string'
      || !/^[A-Z]{3}$/.test(currency.trim())
    ) {
      throw new OrchestratorError(
        'SALES_STRUCTURED_INTENT_INVALID',
        'Sales advisor budget must contain a positive safe integer amount and a 3-letter ISO currency.',
      );
    }
    budget = {
      amount,
      currency: currency.trim(),
    };
  }

  let product_eligibility: SalesAdvisorRequirements['product_eligibility'];
  if (requirements.product_eligibility !== undefined) {
    const rawEligibility = requirements.product_eligibility;
    if (typeof rawEligibility !== 'object' || rawEligibility === null || Array.isArray(rawEligibility)) {
      throw new OrchestratorError(
        'SALES_STRUCTURED_INTENT_INVALID',
        'Sales product eligibility must be an object when provided.',
      );
    }
    const eligibility = rawEligibility as Record<string, unknown>;
    for (const key of Object.keys(eligibility)) {
      if (key !== 'sku' && key !== 'category') {
        throw new OrchestratorError(
          'SALES_STRUCTURED_INTENT_INVALID',
          `Unknown server-stamped Sales eligibility field '${key}'.`,
        );
      }
    }
    const sku = parseBoundedRequirementString(eligibility.sku, 'product eligibility SKU', 128, false);
    const eligibilityCategory = parseBoundedRequirementString(
      eligibility.category,
      'product eligibility category',
      64,
      true,
    );
    product_eligibility = {
      ...(sku === undefined ? {} : { sku }),
      ...(eligibilityCategory === undefined ? {} : { category: eligibilityCategory }),
    };
  }

  return {
    ...(category === undefined ? {} : { category }),
    ...(budget === undefined ? {} : { budget }),
    ...(use_case === undefined ? {} : { use_case }),
    ...(product_eligibility === undefined ? {} : { product_eligibility }),
  };
}

function parseBoundedRequirementString(
  value: unknown,
  label: string,
  maxLength: number,
  lowerCase: boolean,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxLength) {
    throw new OrchestratorError(
      'SALES_STRUCTURED_INTENT_INVALID',
      `Sales advisor ${label} must be a bounded non-empty string.`,
    );
  }
  const trimmed = value.trim();
  return lowerCase ? trimmed.toLocaleLowerCase() : trimmed;
}

function missingAdvisorRequirementLabels(requirements: SalesAdvisorRequirements): readonly string[] {
  const missing: string[] = [];
  if (requirements.category === undefined) missing.push('category');
  if (requirements.budget === undefined) missing.push('budget amount and currency');
  if (requirements.use_case === undefined) missing.push('use case');
  return missing;
}
export type SalesIntent =
  | 'customer_lookup'
  | 'product_search'
  | 'advisor'
  | 'inventory'
  | 'price'
  | 'disabled_price'
  | 'recommend'
  | 'cart_recovery'
  | 'replenishment'
  | 'ambiguous'
  | 'unknown'
  | 'sales:sales';

export interface SalesLexiconMetadata {
  readonly lexicon_source: 'builtin' | 'tenant';
  readonly lexicon_warning?: SalesLexiconWarningCode;
}

export interface SalesHypothesisRecord extends HypothesisRecord {
  readonly metadata?: SalesLexiconMetadata;
}

export interface SalesRoutingDecision extends RoutingDecision {
  readonly metadata?: SalesLexiconMetadata;
}


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
  readonly advisor_requirements?: SalesAdvisorRequirements | undefined;
}

export interface SalesAgentRuntimeOptions {
  readonly registry?: SkillRegistryResolver | undefined;
  readonly now?: (() => Date) | undefined;
  readonly resolvableDependencies?: DependencyReachabilityPredicate | undefined;
  readonly replenishment_policy?: SalesReplenishmentPolicyPort | undefined;
  readonly replenishment_policy_port?: SalesReplenishmentPolicyPort | undefined;
  readonly purchase_evidence?: SalesPurchaseEvidencePort | undefined;
  readonly lexicon?: SalesLexiconPort | undefined;
  readonly advisor_state?: SalesAdvisorExecutionState | undefined;
  readonly advisor_price_floor_bound?: boolean | undefined;
  readonly advisor_quote_signing_bound?: boolean | undefined;
  /**
   * The owner-configured Care onboarding itinerary. Presence is an explicit binding; no itinerary
   * is synthesized when this is absent.
   */
  readonly careOnboardingItinerary?: unknown | undefined;
  /** Tenant-specific owner-input resolver used by production compositions. */
  readonly resolveCareOnboardingItinerary?: ((tenant_id: string) => unknown | Promise<unknown>) | undefined;
}

function hasCareOnboardingItinerary(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.status === 'UNRESOLVED') return false;
    return Object.keys(record).length > 0;
  }
  return false;
}
function isSalesLexiconMetadata(value: unknown): value is SalesLexiconMetadata {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!('lexicon_source' in value)) return false;
  const source = value.lexicon_source;
  return source === 'builtin' || source === 'tenant';
}

function lexiconMetadataFor(hypothesis: HypothesisRecord): SalesLexiconMetadata {
  let metadata: unknown;
  if ('metadata' in hypothesis) {
    metadata = hypothesis.metadata;
  }
  if (!isSalesLexiconMetadata(metadata)) return { lexicon_source: 'builtin' };
  if (metadata.lexicon_warning === 'SALES_LEXICON_READ_FAILED') {
    return {
      lexicon_source: metadata.lexicon_source,
      lexicon_warning: metadata.lexicon_warning,
    };
  }
  return { lexicon_source: metadata.lexicon_source };
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
  private readonly advisor_state?: SalesAdvisorExecutionState | undefined;
  private readonly advisor_price_floor_bound: boolean;
  private readonly advisor_quote_signing_bound: boolean;
  private readonly careOnboardingItinerary: unknown;
  private readonly resolveCareOnboardingItinerary:
    ((tenant_id: string) => unknown | Promise<unknown>) | undefined;
  private readonly retainedRationales = new WeakMap<HypothesisRecord, ParsedSalesRationale>();
  private readonly lexicon?: SalesLexiconPort | undefined;
  private readonly lexiconByRun = new Map<string, Promise<{
    readonly lexicon: SalesLexicon;
    readonly metadata: SalesLexiconMetadata;
  }>>();

  constructor(options: SalesAgentRuntimeOptions = {}) {
    this.registry = options.registry;
    this.now = options.now;
    this.resolvableDependencies = options.resolvableDependencies;
    this.replenishment_policy = options.replenishment_policy ?? options.replenishment_policy_port;
    this.purchase_evidence = options.purchase_evidence;
    this.lexicon = options.lexicon;
    this.advisor_state = options.advisor_state;
    this.advisor_price_floor_bound = options.advisor_price_floor_bound === true;
    this.advisor_quote_signing_bound = options.advisor_quote_signing_bound === true;
    this.careOnboardingItinerary = options.careOnboardingItinerary;
    this.resolveCareOnboardingItinerary = options.resolveCareOnboardingItinerary;
  }

  private resolveSalesLexicon(signal: SignalEnvelope): Promise<{
    readonly lexicon: SalesLexicon;
    readonly metadata: SalesLexiconMetadata;
  }> {
    const key = `${signal.tenant_id}:${signal.correlation_id}`;
    const cached = this.lexiconByRun.get(key);
    if (cached) return cached;

    const resolution = (async () => {
      if (!this.lexicon) {
        return { lexicon: BUILTIN_SALES_LEXICON, metadata: { lexicon_source: 'builtin' as const } };
      }
      try {
        const tenantLexicon = await this.lexicon.read(signal.tenant_id);
        if (tenantLexicon === undefined) {
          return { lexicon: BUILTIN_SALES_LEXICON, metadata: { lexicon_source: 'builtin' as const } };
        }
        return {
          lexicon: mergeSalesLexicon(tenantLexicon),
          metadata: { lexicon_source: 'tenant' as const },
        };
      } catch {
        return {
          lexicon: BUILTIN_SALES_LEXICON,
          metadata: {
            lexicon_source: 'builtin' as const,
            lexicon_warning: 'SALES_LEXICON_READ_FAILED' as const,
          },
        };
      }
    })();
    this.lexiconByRun.set(key, resolution);
    return resolution;
  }

  async deriveHypothesis(signal: SignalEnvelope, context: HydratedContext): Promise<SalesHypothesisRecord> {
    const { lexicon, metadata } = await this.resolveSalesLexicon(signal);
    const handoffTarget = readHandoffTargetDomain(signal);
    if (handoffTarget === 'sales') {
      const handoff_reason = extractSalesHandoffReason(signal);
      const rationale: ParsedSalesRationale = {
        reason: "Routed by the brokered customer journey leg 'sales'.",
        intent: 'sales:sales',
        ...(handoff_reason ? { handoff_reason } : {}),
      };
      const hypothesis: SalesHypothesisRecord = {
        classification: 'HYPOTHESIS',
        intent: 'sales:sales',
        confidence: 1,
        churn_risk_score: 0,
        purchase_propensity: 0,
        reasoning: rationale.reason,
        derived_from_signals: [signal.signal_id],
        metadata,
      };
      this.retainedRationales.set(hypothesis, rationale);
      return hypothesis;
    }

    const text = extractMessageContent(signal);
    const priceRow = lookupRegistryRow(this.registry, 'skill.sales.check_price');
    const isPriceEnabled = priceRow?.enabled === true;

    const hasPrice = isPriceInquiry(text, lexicon);
    const hasRecommend = isRecommendInquiry(text, lexicon);
    const hasInventory = isInventoryInquiry(text, lexicon);
    const hasCustomer = isCustomerLookupInquiry(text, lexicon);
    const hasSearch = isProductSearchInquiry(text, lexicon);

    const cartRecoveryData = extractCartRecoveryData(signal);
    const hasCartRecovery = Boolean(cartRecoveryData) || isCartRecoveryInquiry(text, lexicon);

    const hasReplenish = isReplenishmentSignal(signal, text, lexicon);

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

      const purchaseEvidenceRead = this.purchase_evidence
        ? extractVerifiedPurchases(context, this.purchase_evidence)
        : undefined;

      let purchases: readonly VerifiedPurchaseEvidence[] = [];
      if (purchaseEvidenceRead) {
        try {
          purchases = await purchaseEvidenceRead;
        } catch {
          purchases = [];
        }
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

      const replenishmentPolicyRead = this.replenishment_policy && resolvedSku
        ? Promise.resolve().then(async () => this.replenishment_policy!.read({
            tenant_id: context.tenant_id,
            sku_id: resolvedSku!,
          }))
        : undefined;
      const refusalReason = await evaluateReplenishmentRefusal(signal, context, {
        registry: this.registry,
        resolvableDependencies: this.resolvableDependencies,
        replenishment_policy: this.replenishment_policy,
        purchase_evidence: this.purchase_evidence,
        purchase_evidence_read: purchaseEvidenceRead,
        replenishment_policy_read: replenishmentPolicyRead,
        now: this.now,
      });

      let replenishmentIntervalDays: number | undefined;
      if (replenishmentPolicyRead) {
        try {
          const policy = await replenishmentPolicyRead;
          if (
            policy
            && policy.owner_approved === true
            && typeof policy.replenishment_interval_days === 'number'
            && Number.isFinite(policy.replenishment_interval_days)
            && policy.replenishment_interval_days > 0
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

    const advisorRequirements = readAdvisorRequirements(signal);
    if (advisorRequirements !== undefined) {
      this.advisor_state?.setRequirements(context.tenant_id, context.correlation_id, advisorRequirements);
      intent = 'advisor';
      confidence = 0.95;
      rationaleData = {
        reason: 'Server-stamped Sales advisor requirements/proposals received from API gateway.',
        intent: 'advisor',
        ...(advisorRequirements.use_case === undefined ? {} : { query: advisorRequirements.use_case }),
        advisor_requirements: advisorRequirements,
      };
    }

    const derived_from_signals = [signal.signal_id];
    if (rationaleData.sku) {
      derived_from_signals.push(`sku:${rationaleData.sku}`);
    }

    const hypothesis: SalesHypothesisRecord = {
      classification: 'HYPOTHESIS',
      intent,
      confidence,
      churn_risk_score: 0.0,
      purchase_propensity: context.customer ? 0.75 : 0.25,
      reasoning: rationaleData.reason,
      derived_from_signals,
      metadata,
    };

    this.retainedRationales.set(hypothesis, rationaleData);
    return hypothesis;
  }

  async resolveRouting(
    _signal: SignalEnvelope,
    context: HydratedContext,
    hypothesis: HypothesisRecord,
  ): Promise<SalesRoutingDecision> {
    const rationale = this.retainedRationales.get(hypothesis);
    const intent = rationale?.intent ?? (hypothesis.intent as SalesIntent);
    const metadata = lexiconMetadataFor(hypothesis);
    const route = (decision: RoutingDecision): SalesRoutingDecision => ({ ...decision, metadata });

    switch (intent) {
      case 'sales:sales':
        return route({
          target_agent: 'SAL-02' as PlatformAgentId,
          requires_clarification: false,
          rationalization: hypothesis.reasoning,
        });

      case 'customer_lookup':
        return route({
          target_agent: 'SAL-01' as PlatformAgentId,
          requires_clarification: false,
          rationalization: hypothesis.reasoning,
        });

      case 'advisor': {
        const requirements = rationale?.advisor_requirements;
        const missing = requirements === undefined
          ? ['category', 'budget amount and currency', 'use case']
          : missingAdvisorRequirementLabels(requirements);
        if (missing.length > 0) {
          return route({
            target_agent: 'SAL-02' as PlatformAgentId,
            requires_clarification: true,
            clarification_prompt: `Please provide the missing product requirements: ${missing.join(', ')}.`,
            rationalization: 'Server-stamped advisor requirements are incomplete.',
          });
        }
        return route({
          target_agent: 'SAL-02' as PlatformAgentId,
          requires_clarification: false,
          rationalization: hypothesis.reasoning,
        });
      }

      case 'product_search':
        if (!rationale?.query || rationale.query.trim().length === 0) {
          return route({
            target_agent: 'SAL-02' as PlatformAgentId,
            requires_clarification: true,
            clarification_prompt: 'What product are you looking to search for?',
            rationalization: 'Product search requires a non-empty query.',
          });
        }
        return route({
          target_agent: 'SAL-02' as PlatformAgentId,
          requires_clarification: false,
          rationalization: hypothesis.reasoning,
        });

      case 'inventory':
        if (!rationale?.sku) {
          return route({
            target_agent: 'SAL-02' as PlatformAgentId,
            requires_clarification: true,
            clarification_prompt: 'Please provide the product SKU or code to check stock availability.',
            rationalization: 'Inventory check requires a valid SKU.',
          });
        }
        return route({
          target_agent: 'SAL-02' as PlatformAgentId,
          requires_clarification: false,
          rationalization: hypothesis.reasoning,
        });

      case 'price': {
        const priceRow = lookupRegistryRow(this.registry, 'skill.sales.check_price');
        if (!priceRow || priceRow.enabled === false) {
          return route({
            target_agent: 'SAL-02' as PlatformAgentId,
            requires_clarification: true,
            clarification_prompt:
              'Price quotes and automated discount calculations are currently disabled under platform policy. Please contact sales directly.',
            rationalization: hypothesis.reasoning,
          });
        }
        if (!rationale?.sku) {
          return route({
            target_agent: 'SAL-02' as PlatformAgentId,
            requires_clarification: true,
            clarification_prompt: 'Please provide the product SKU or code to check price.',
            rationalization: 'Price inquiry requires a valid SKU.',
          });
        }
        return route({
          target_agent: 'SAL-02' as PlatformAgentId,
          requires_clarification: false,
          rationalization: hypothesis.reasoning,
        });
      }

      case 'disabled_price':
        return route({
          target_agent: 'SAL-02' as PlatformAgentId,
          requires_clarification: true,
          clarification_prompt:
            'Price quotes and automated discount calculations are currently disabled under platform policy. Please contact sales directly.',
          rationalization: hypothesis.reasoning,
        });

      case 'cart_recovery':
        if (rationale?.refusalReason) {
          return route({
            target_agent: 'SAL-04' as PlatformAgentId,
            requires_clarification: true,
            clarification_prompt: `Cart recovery cannot be scheduled: ${rationale.refusalReason}.`,
            rationalization: hypothesis.reasoning,
          });
        }
        if (!rationale?.cartId && (!rationale?.cartSkus || rationale.cartSkus.length === 0)) {
          return route({
            target_agent: 'SAL-04' as PlatformAgentId,
            requires_clarification: true,
            clarification_prompt: 'Cart recovery requires a cart identifier or items list.',
            rationalization: 'Cart recovery requires an identified cart or SKUs.',
          });
        }
        if (!context.customer) {
          return route({
            target_agent: 'SAL-04' as PlatformAgentId,
            requires_clarification: true,
            clarification_prompt: 'Cart recovery requires verified customer context.',
            rationalization: 'Customer context missing for cart recovery.',
          });
        }
        if (context.customer.consent_marketing !== true) {
          return route({
            target_agent: 'SAL-04' as PlatformAgentId,
            requires_clarification: true,
            clarification_prompt: 'Customer has not consented to marketing communications.',
            rationalization: 'Marketing consent missing or withdrawn for cart recovery.',
          });
        }
        if (context.customer.suppression_active) {
          return route({
            target_agent: 'SAL-04' as PlatformAgentId,
            requires_clarification: true,
            clarification_prompt: 'Customer suppression rule is active.',
            rationalization: 'Customer suppression is active.',
          });
        }
        {
          const consentRow = lookupRegistryRow(this.registry, 'skill.sales.retrieve_customer');
          if (!consentRow || !this.isRowExecutable(consentRow, 'SAL-04') || consentRow.effect_class !== 'READ') {
            return route({
              target_agent: 'SAL-04' as PlatformAgentId,
              requires_clarification: true,
              clarification_prompt:
                'Cart recovery cannot be scheduled: consent authority skill.sales.retrieve_customer unavailable.',
              rationalization:
                'Cart recovery refused: missing consent authority skill.sales.retrieve_customer.',
            });
          }
          const rawChannel = context.working_memory?.last_touch_channel;
          const channel = typeof rawChannel === 'string' && rawChannel.trim().length > 0 ? rawChannel.trim() : null;
          if (!channel) {
            return route({
              target_agent: 'SAL-04' as PlatformAgentId,
              requires_clarification: true,
              clarification_prompt:
                'Cart recovery cannot be scheduled: outbound channel missing.',
              rationalization:
                'Cart recovery refused: missing outbound touch channel.',
            });
          }
        }
        return route({
          target_agent: 'SAL-04' as PlatformAgentId,
          requires_clarification: false,
          rationalization: hypothesis.reasoning,
        });

      case 'replenishment':
        if (rationale?.refusalReason) {
          return route({
            target_agent: 'SAL-05' as PlatformAgentId,
            requires_clarification: true,
            clarification_prompt: `Replenishment cannot be scheduled: ${rationale.refusalReason}.`,
            rationalization: hypothesis.reasoning,
          });
        }
        return route({
          target_agent: 'SAL-05' as PlatformAgentId,
          requires_clarification: false,
          rationalization: hypothesis.reasoning,
        });
      case 'recommend':
        return route({
          target_agent: 'SAL-03' as PlatformAgentId,
          requires_clarification: false,
          rationalization: hypothesis.reasoning,
        });

      case 'ambiguous':
        return route({
          target_agent: 'SAL-01' as PlatformAgentId,
          requires_clarification: true,
          clarification_prompt:
            'Your request contains multiple inquiries. Please clarify whether you would like to search for products, check stock, or receive product recommendations.',
          rationalization: hypothesis.reasoning,
        });

      case 'unknown':
      default:
        return route({
          target_agent: 'SAL-01' as PlatformAgentId,
          requires_clarification: true,
          clarification_prompt:
            'How can I assist you with product catalog searches, inventory checks, or recommendations today?',
          rationalization: hypothesis.reasoning,
        });
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

    const handoffRationale = this.retainedRationales.get(hypothesis);
    const handoffIntent = handoffRationale?.intent ?? (hypothesis.intent as SalesIntent);
    if (handoffIntent === 'sales:sales') {
      const customerId = context.customer?.customer_id;
      const customerRow = lookupRegistryRow(this.registry, 'skill.sales.retrieve_customer');
      const recommendationRow = lookupRegistryRow(this.registry, 'skill.sales.recommend_product');
      // sales → care requires source authority AUTH-1. retrieve_customer is AUTH-0, so it cannot
      // be the sole step of this leg. Prefer the canonical AUTH-1 read that needs only the
      // verified customer.
      const action = customerId && this.isRowExecutable(recommendationRow, 'SAL-02')
        && recommendationRow.effect_class === 'READ'
        && recommendationRow.required_authority === 'AUTH-1'
        ? {
            row: recommendationRow,
            input_parameters: {
              tenant_id: context.tenant_id,
              customer_id: customerId,
              current_cart_skus: [],
              recommendation_type: 'CROSS_SELL',
            },
          }
        : customerId && this.isRowExecutable(customerRow, 'SAL-02')
          && customerRow.effect_class === 'READ'
          && customerRow.required_authority !== 'AUTH-0'
          ? {
              row: customerRow,
              input_parameters: {
                tenant_id: context.tenant_id,
                customer_identifier: customerId,
              },
            }
          : null;

      if (!action) {
        throw new OrchestratorError(
          'SALES_HANDOFF_ITINERARY_UNBOUND',
          'The brokered Sales leg has no canonical enabled SAL-02 action that can run from '
            + 'verified Customer360 alone; it refuses rather than clarifying or inventing a '
            + 'customer message, SKU, price, or quote.',
        );
      }

      const step = this.buildPlannedStep(
        1,
        'SAL-02' as PlatformAgentId,
        action.row,
        action.input_parameters,
        [],
      );

      return {
        plan_id,
        steps: [step],
        fallback_strategy: 'FAIL_CLOSED',
      };
    }

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

    if (intent === 'advisor') {
      const requirements = rationale?.advisor_requirements;
      const customer = context.customer;
      const customerId = customer?.customer_id;
      if (
        requirements === undefined
        || missingAdvisorRequirementLabels(requirements).length > 0
        || customer === null
        || customer === undefined
        || customerId === undefined
        || customer.consent_marketing !== true
        || customer.suppression_active
        || !this.advisor_state
        || !this.advisor_price_floor_bound
        || !this.advisor_quote_signing_bound
      ) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      const searchRow = lookupRegistryRow(this.registry, 'skill.sales.search_product');
      const stockRow = lookupRegistryRow(this.registry, 'skill.sales.check_stock');
      const priceRow = lookupRegistryRow(this.registry, 'skill.sales.check_price');
      if (
        !this.isRowExecutable(searchRow, routing.target_agent)
        || searchRow.effect_class !== 'READ'
        || !this.isRowExecutable(stockRow, routing.target_agent)
        || stockRow.effect_class !== 'READ'
        || !this.isRowExecutable(priceRow, routing.target_agent)
        || priceRow.effect_class !== 'READ'
      ) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      // Eligibility values are API proposals used only to narrow the authoritative catalog search.
      // The returned catalog SKU remains the sole source for stock and quote bindings.
      const searchQuery = requirements.product_eligibility?.sku ?? requirements.use_case!;
      const searchCategory = requirements.product_eligibility?.category ?? requirements.category!;
      const searchStep = this.buildPlannedStep(
        1,
        routing.target_agent,
        searchRow,
        {
          tenant_id: context.tenant_id,
          query: searchQuery,
          category_id: searchCategory,
          limit: 20,
        },
        [],
      );
      const stockStep = {
        ...this.buildPlannedStep(
          2,
          routing.target_agent,
          stockRow,
          { tenant_id: context.tenant_id, sku_id: '' },
          [1],
        ),
        input_bindings: {
          sku_id: { source_step_index: 1, response_path: 'products.0.sku' },
        },
      };
      const priceStep = {
        ...this.buildPlannedStep(
          3,
          routing.target_agent,
          priceRow,
          {
            tenant_id: context.tenant_id,
            sku_id: '',
            customer_id: customerId,
          },
          [2],
        ),
        input_bindings: {
          sku_id: { source_step_index: 2, response_path: 'sku_id' },
        },
      };

      const recommendRow = lookupRegistryRow(this.registry, 'skill.sales.recommend_product');
      if (
        !this.isRowExecutable(recommendRow, routing.target_agent)
        || recommendRow.effect_class !== 'READ'
      ) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      const recommendStep = this.buildPlannedStep(
        4,
        routing.target_agent,
        recommendRow,
        {
          tenant_id: context.tenant_id,
          customer_id: customerId,
          current_cart_skus: [],
        },
        [1, 2, 3],
      );

      return {
        plan_id,
        steps: [searchStep, stockStep, priceStep, recommendStep],
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

  private async withHandoffIntent(
    plan: ExecutionPlan,
    context: HydratedContext,
    rationale: ParsedSalesRationale | undefined,
  ): Promise<ExecutionPlan> {
    if (
      plan.steps.length === 0
      || !context.customer?.customer_id
      || !rationale?.handoff_reason
      || rationale?.intent !== 'sales:sales'
      || !plan.steps.every((step) => step.agent_id.startsWith('SAL-'))
    ) {
      return plan;
    }
    const itinerary = this.resolveCareOnboardingItinerary === undefined
      ? this.careOnboardingItinerary
      : await this.resolveCareOnboardingItinerary(context.tenant_id);
    if (!hasCareOnboardingItinerary(itinerary)) return plan;

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
    return buildPlannedStep(stepIndex, agentId, row, inputParameters, dependsOnSteps);
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
