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
 *       Disabled price query -> Clarifies (P2 floor price / dynamic pricing evaluation disabled)
 *   - SAL-03 (Recommendation Agent):
 *       Product recommendations / cross-sell -> `skill.sales.recommend_product`
 *       Requires hydrated verified customer context; fails closed if absent.
 *
 * Safe Execution Plan Formulate Invariant:
 *   - Only executable, enabled READ skill rows present in the injected registry resolver are planned.
 *   - Mutation skills and price skills (e.g. check_price, create_cart, create_order, send_message) are NEVER planned.
 *   - Unauthorized rows, disabled rows, or non-READ effect classes fail closed with an empty plan.
 */

import { randomUUID } from 'node:crypto';
import type {
  AuthorityLevel,
  ExecutionPlan,
  HydratedContext,
  HypothesisRecord,
  IAgentRuntime,
  PlannedStep,
  PlatformAgentId,
  RoutingDecision,
  SignalEnvelope,
} from '@agentos/core-engine/contracts';
import type { SkillEffectClass } from '@agentos/skills';

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
    if (!/^(status|details|update|info|is|the|my|available|stock|price|check|search|in|out)$/i.test(candidate)) {
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

export type SalesIntent =
  | 'customer_lookup'
  | 'product_search'
  | 'inventory'
  | 'disabled_price'
  | 'recommend'
  | 'ambiguous'
  | 'unknown';

export interface ParsedSalesRationale {
  readonly reason: string;
  readonly intent: SalesIntent;
  readonly sku?: string | undefined;
  readonly query?: string | undefined;
  readonly cartSkus?: readonly string[] | undefined;
}

export interface SalesAgentRuntimeOptions {
  readonly registry?: SkillRegistryResolver | undefined;
  readonly now?: (() => Date) | undefined;
}

/**
 * SalesAgentRuntime implements deterministic sales reasoning across SAL-01, SAL-02, and SAL-03.
 */
export class SalesAgentRuntime implements IAgentRuntime {
  public readonly now?: (() => Date) | undefined;
  private readonly registry?: SkillRegistryResolver | undefined;
  private readonly retainedRationales = new WeakMap<HypothesisRecord, ParsedSalesRationale>();

  constructor(options: SalesAgentRuntimeOptions = {}) {
    this.registry = options.registry;
    this.now = options.now;
  }

  async deriveHypothesis(signal: SignalEnvelope, context: HydratedContext): Promise<HypothesisRecord> {
    const text = extractMessageContent(signal);

    const hasPrice = isPriceInquiry(text);
    const hasRecommend = isRecommendInquiry(text);
    const hasInventory = isInventoryInquiry(text);
    const hasCustomer = isCustomerLookupInquiry(text);
    const hasSearch = isProductSearchInquiry(text);

    // Count how many distinct strong categories matched
    const matchesCount = [hasPrice, hasRecommend, hasInventory, hasCustomer, hasSearch].filter(Boolean).length;

    let intent: SalesIntent = 'unknown';
    let confidence = 0.0;
    let rationaleData: ParsedSalesRationale = {
      reason: 'Message could not be deterministically mapped to a supported Sales intent.',
      intent: 'unknown',
    };

    if (matchesCount > 1 && !hasPrice) {
      // Multiple conflicting non-price intents -> ambiguous
      intent = 'ambiguous';
      confidence = 0.3;
      rationaleData = {
        reason: 'Ambiguous request with multiple conflicting sales intents.',
        intent: 'ambiguous',
      };
    } else if (hasPrice) {
      // Price inquiry takes precedence to ensure fail-closed clarification under P2 policy
      intent = 'disabled_price';
      confidence = 0.95;
      rationaleData = {
        reason: `Price inquiry detected: '${text}'. Dynamic pricing and quotes are disabled under P2 policy.`,
        intent: 'disabled_price',
      };
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

      case 'disabled_price':
        return {
          target_agent: 'SAL-02' as PlatformAgentId,
          requires_clarification: true,
          clarification_prompt:
            'Price quotes and automated discount calculations are currently disabled under platform policy. Please contact sales directly.',
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
      if (!this.isRowExecutable(row, routing.target_agent)) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      const policy = deriveEffectPolicy(row.effect_class);
      const step: PlannedStep = {
        step_index: 1,
        agent_id: routing.target_agent,
        skill_id: row.skill_id,
        adapter_target: row.guarded_dependency,
        input_parameters: {
          tenant_id: context.tenant_id,
          customer_identifier: customerId,
        },
        required_authority: row.required_authority,
        mutating: policy.mutating,
        price_bearing: policy.price_bearing,
        idempotent: policy.idempotent,
        timeout_ms: row.timeout_ms,
        depends_on_steps: [],
      };

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
      if (!this.isRowExecutable(row, routing.target_agent)) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      const policy = deriveEffectPolicy(row.effect_class);
      const step: PlannedStep = {
        step_index: 1,
        agent_id: routing.target_agent,
        skill_id: row.skill_id,
        adapter_target: row.guarded_dependency,
        input_parameters: {
          tenant_id: context.tenant_id,
          query,
        },
        required_authority: row.required_authority,
        mutating: policy.mutating,
        price_bearing: policy.price_bearing,
        idempotent: policy.idempotent,
        timeout_ms: row.timeout_ms,
        depends_on_steps: [],
      };

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
      if (!this.isRowExecutable(row, routing.target_agent)) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      const policy = deriveEffectPolicy(row.effect_class);
      const step: PlannedStep = {
        step_index: 1,
        agent_id: routing.target_agent,
        skill_id: row.skill_id,
        adapter_target: row.guarded_dependency,
        input_parameters: {
          tenant_id: context.tenant_id,
          sku_id: sku,
        },
        required_authority: row.required_authority,
        mutating: policy.mutating,
        price_bearing: policy.price_bearing,
        idempotent: policy.idempotent,
        timeout_ms: row.timeout_ms,
        depends_on_steps: [],
      };

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
      if (!this.isRowExecutable(row, routing.target_agent)) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      const cartSkus = rationale?.cartSkus ? [...rationale.cartSkus] : [];
      const policy = deriveEffectPolicy(row.effect_class);
      const step: PlannedStep = {
        step_index: 1,
        agent_id: routing.target_agent,
        skill_id: row.skill_id,
        adapter_target: row.guarded_dependency,
        input_parameters: {
          tenant_id: context.tenant_id,
          customer_id: customerId,
          current_cart_skus: cartSkus,
          recommendation_type: 'CROSS_SELL',
        },
        required_authority: row.required_authority,
        mutating: policy.mutating,
        price_bearing: policy.price_bearing,
        idempotent: policy.idempotent,
        timeout_ms: row.timeout_ms,
        depends_on_steps: [],
      };

      return {
        plan_id,
        steps: [step],
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

  /**
   * Validates that a registry row exists, is enabled, has effect_class === 'READ',
   * is not a price skill, and is authorized for the target agent.
   */
  private isRowExecutable(row: SkillRegistryRowMetadata | null, targetAgent: PlatformAgentId): row is SkillRegistryRowMetadata {
    if (!row) return false;
    if (row.enabled === false) return false;
    // Strictly READ only; no mutation or price-bearing skills
    if (row.effect_class !== 'READ') return false;
    // Explicitly disallow check_price skill in plan
    if (row.skill_id === 'skill.sales.check_price') return false;
    // If allowed_agents specified, target agent must be included
    if (row.allowed_agents && !row.allowed_agents.includes(targetAgent)) {
      return false;
    }
    return true;
  }
}
