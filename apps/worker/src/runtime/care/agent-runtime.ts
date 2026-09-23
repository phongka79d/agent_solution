/**
 * @file Care Agent Runtime (implement/04 §3.2, implement/06 §8.1).
 *
 * Invariant:
 * The Customer Care agent runtime is entirely DETERMINISTIC with NO LLM calls.
 * It resolves exactly two intents:
 *   1. Order-status message with extractable order reference -> `skill.care.lookup_order`
 *      where customer identity fields (`customer_id`, `verification_reference`, `verification_status`)
 *      are resolved SERVER-SIDE from the verified customer context, NEVER echoed from untrusted messages.
 *      If the session has no verified customer binding or missing verification reference, the order intent
 *      fails closed with NO plan.
 *   2. General question with no order reference -> `skill.care.search_faq`.
 *
 * Anything else (unsupported intent, missing reference, gibberish) produces `requires_clarification: true`
 * with a deterministic clarification prompt, and an empty plan (`steps: []`, `fallback_strategy: 'FAIL_CLOSED'`).
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
 * Effect policy derivation matrix transcribed from implement/05-skill-system-specifications.md §6.5:
 *
 * Section 6.5 contract:
 * "One row per registered skill. `Class` describes effect behaviour, not clearance:
 *  - `READ` produces no external effect and no durable platform mutation;
 *  - `INTERNAL` writes platform-owned records;
 *  - `EFFECT` produces an external side effect in a SoR or provider;
 *  - `APPROVAL` is an `AUTH-4` row whose effect exists only after the human decision.
 *  Only a mutating action is reserved in effect_reservations and reconciled by key;
 *  a read-only action carries no external effect, is dispatched unreserved, and stays freely retryable."
 *
 * §6.5 Effect-Class to Policy Flags Matrix:
 * | Class    | mutating | idempotent | price_bearing | Notes                                              |
 * |----------|----------|------------|---------------|----------------------------------------------------|
 * | READ     | false    | true       | false         | No external mutation; unreserved; idempotent read  |
 * | INTERNAL | true     | false      | false         | Writes platform-owned records; non-idempotent FSM  |
 * | EFFECT   | true     | false      | false         | External side effect; reserved by effect_key       |
 * | APPROVAL | true     | false      | false         | AUTH-4 human approval required before execution    |
 *
 * Note: Both Care skills (`skill.care.lookup_order` and `skill.care.search_faq`) declare `effect_class: 'READ'`
 * and are non-price-bearing.
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
 * Injected resolver for server-resolved customer verification references (implement/04 §3.2, implement/06 §8.1).
 *
 * Resolves the id of the verified `customer_identities` row the context aggregator bound during
 * `hydrateContext`. Canonical HydratedContext has no slot for verification_reference, so the
 * aggregator hands it over by correlation id (e.g. CareContextAggregator.verificationReferenceFor(correlation_id)).
 */
export interface VerificationReferenceResolver {
  verificationReference?(correlation_id: string): string | null | undefined;
  verificationReferenceFor?(correlation_id: string): string | null | undefined;
}

export type VerificationReferencePort =
  | VerificationReferenceResolver
  | ((correlation_id: string) => string | null | undefined);

function resolveVerificationReference(
  resolver: VerificationReferencePort | undefined,
  correlation_id: string,
): string | null {
  if (!resolver) return null;
  if (typeof resolver === 'function') {
    return resolver(correlation_id) ?? null;
  }
  if (typeof resolver.verificationReference === 'function') {
    return resolver.verificationReference(correlation_id) ?? null;
  }
  if (typeof resolver.verificationReferenceFor === 'function') {
    return resolver.verificationReferenceFor(correlation_id) ?? null;
  }
  return null;
}

/**
 * Extracts raw textual message from signal payload.
 */
function extractMessageContent(signal: SignalEnvelope): string {
  const p = signal.payload as Record<string, unknown> | null | undefined;
  if (!p || typeof p !== 'object') return '';
  if (typeof p.message === 'string') return p.message.trim();
  if (typeof p.content === 'string') return p.content.trim();
  if (typeof p.text === 'string') return p.text.trim();
  return '';
}

/**
 * Extracts order reference from message text.
 * Matches:
 *  - ORD-12345, SO-9988
 *  - order #12345, order 12345, order: 12345
 *  - #12345
 */
export function extractOrderReference(text: string): string | null {
  if (!text) return null;

  // 1. Prefixed canonical IDs: ORD-XXXX, SO-XXXX
  const prefixMatch = text.match(/\b((?:ORD|SO)-[A-Za-z0-9_-]+)\b/i);
  if (prefixMatch && prefixMatch[1]) return prefixMatch[1];

  // 2. Keyword followed by identifier
  const keywordMatch = text.match(/\b(?:order|tracking|package|shipment)\s*(?:#|id|number|no\.?|num)?\s*[:#]?\s*([A-Za-z0-9_-]{3,})/i);
  if (keywordMatch && keywordMatch[1]) {
    const candidate = keywordMatch[1].trim();
    if (!/^(status|details|update|information|info|number|id|my|the|is)$/i.test(candidate)) {
      return candidate;
    }
  }

  // 3. Hash followed by identifier
  const hashMatch = text.match(/#([A-Za-z0-9_-]{3,})/);
  if (hashMatch && hashMatch[1]) return hashMatch[1];

  return null;
}

/**
 * Checks if the text indicates an order status inquiry.
 */
export function isOrderStatusMessage(text: string): boolean {
  if (!text) return false;
  return /\b(order|status|track|tracking|shipment|delivery|package|parcel|where is my)\b/i.test(text);
}

/**
 * Checks if the text is a question/FAQ inquiry.
 */
export function isQuestionMessage(text: string): boolean {
  if (!text) return false;
  if (text.includes('?')) return true;
  return /\b(how|what|why|when|where|who|which|can|could|do|does|is|are|policy|refund|return|shipping|faq|help)\b/i.test(text);
}

export interface ParsedRationale {
  readonly reason: string;
  readonly orderRef?: string;
  readonly faqQuery?: string;
}

export interface CareAgentRuntimeOptions {
  readonly registry?: SkillRegistryResolver | undefined;
  readonly verificationResolver?: VerificationReferencePort | undefined;
  readonly verificationReference?: VerificationReferencePort | undefined;
  readonly now?: (() => Date) | undefined;
}

export class CareAgentRuntime implements IAgentRuntime {
  public readonly now?: (() => Date) | undefined;
  private readonly registry?: SkillRegistryResolver | undefined;
  private readonly verificationResolver?: VerificationReferencePort | undefined;
  private readonly retainedRationales = new WeakMap<HypothesisRecord, ParsedRationale>();

  constructor(options: CareAgentRuntimeOptions = {}) {
    this.registry = options.registry;
    this.verificationResolver = options.verificationResolver ?? options.verificationReference;
    this.now = options.now;
  }

  async deriveHypothesis(signal: SignalEnvelope, context: HydratedContext): Promise<HypothesisRecord> {
    const text = extractMessageContent(signal);
    const hasOrderIntent = isOrderStatusMessage(text);
    const orderRef = hasOrderIntent ? extractOrderReference(text) : null;

    let intent = 'requires_clarification';
    let rationaleData: ParsedRationale = {
      reason: 'Message could not be deterministically mapped to a supported Care intent.',
    };
    let confidence = 0.0;

    if (hasOrderIntent) {
      if (orderRef) {
        if (context.customer) {
          intent = 'order_lookup';
          rationaleData = {
            reason: `Order status request with extracted order ref '${orderRef}' and verified customer '${context.customer.customer_id}'.`,
            orderRef,
          };
          confidence = 0.95;
        } else {
          intent = 'order_lookup_unverified';
          rationaleData = {
            reason: `Order status request with extracted order ref '${orderRef}', but session has no verified customer binding.`,
            orderRef,
          };
          confidence = 0.5;
        }
      } else {
        intent = 'requires_clarification';
        rationaleData = {
          reason: 'Order status request without extractable order reference requires clarification.',
        };
        confidence = 0.3;
      }
    } else if (isQuestionMessage(text)) {
      intent = 'faq_search';
      rationaleData = {
        reason: `General inquiry routed to FAQ search: '${text}'.`,
        faqQuery: text,
      };
      confidence = 0.9;
    }

    const derived_from_signals = orderRef
      ? [signal.signal_id, `order:${orderRef}`]
      : [signal.signal_id];

    const hypothesis: HypothesisRecord = {
      classification: 'HYPOTHESIS',
      intent,
      confidence,
      churn_risk_score: 0.0,
      purchase_propensity: 0.0,
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
    if (hypothesis.intent === 'order_lookup' && context.customer) {
      return {
        target_agent: 'CS-01' as PlatformAgentId,
        requires_clarification: false,
        rationalization: hypothesis.reasoning,
      };
    }

    if (hypothesis.intent === 'faq_search') {
      return {
        target_agent: 'CS-01' as PlatformAgentId,
        requires_clarification: false,
        rationalization: hypothesis.reasoning,
      };
    }

    // Anything unmapped or missing binding requires clarification
    let clarification_prompt = 'How can I assist you with your order or questions today?';
    if (hypothesis.intent === 'order_lookup_unverified') {
      clarification_prompt = 'Please verify your customer account so we can retrieve your order status.';
    } else if (isOrderStatusMessage(hypothesis.reasoning)) {
      clarification_prompt = 'Please provide your order reference number (for example, ORD-12345).';
    }

    return {
      target_agent: 'CS-01' as PlatformAgentId,
      requires_clarification: true,
      clarification_prompt,
      rationalization: hypothesis.reasoning,
    };
  }

  async formulatePlan(
    routing: RoutingDecision,
    context: HydratedContext,
    hypothesis: HypothesisRecord,
  ): Promise<ExecutionPlan> {
    const plan_id = `plan_${randomUUID().slice(0, 8)}`;

    // Clarification-required routing emits an empty plan; the orchestrator handles clarification action
    if (routing.requires_clarification) {
      return {
        plan_id,
        steps: [],
        fallback_strategy: 'FAIL_CLOSED',
      };
    }

    if (hypothesis.intent === 'order_lookup') {
      const orderRef = this.extractOrderRef(hypothesis);
      const customer_id = context.customer?.customer_id;
      const verification_reference = resolveVerificationReference(
        this.verificationResolver,
        context.correlation_id,
      );

      // customer_id and verification_reference are SERVER-RESOLVED:
      // When either value is absent ⇒ NO plan, fallback_strategy: 'FAIL_CLOSED'
      if (!orderRef || !customer_id || !verification_reference) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      const row = lookupRegistryRow(this.registry, 'skill.care.lookup_order');
      // Missing registry row ⇒ NO plan (FAIL_CLOSED), never a default
      if (!row) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      const policy = deriveEffectPolicy(row.effect_class);

      const step: PlannedStep = {
        step_index: 1,
        agent_id: 'CS-01' as PlatformAgentId,
        skill_id: 'skill.care.lookup_order',
        adapter_target: row.guarded_dependency,
        input_parameters: {
          order_identifier: orderRef,
          customer_id,
          verification_reference,
          verification_status: 'VERIFIED',
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

    if (hypothesis.intent === 'faq_search') {
      const query = this.extractFaqQuery(hypothesis);
      const row = lookupRegistryRow(this.registry, 'skill.care.search_faq');
      // Missing registry row ⇒ NO plan (FAIL_CLOSED), never a default
      if (!row) {
        return {
          plan_id,
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        };
      }

      const policy = deriveEffectPolicy(row.effect_class);

      const step: PlannedStep = {
        step_index: 1,
        agent_id: 'CS-01' as PlatformAgentId,
        skill_id: 'skill.care.search_faq',
        adapter_target: row.guarded_dependency,
        input_parameters: {
          query_text: query,
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

    // Anything else: no plan
    return {
      plan_id,
      steps: [],
      fallback_strategy: 'FAIL_CLOSED',
    };
  }

  private extractOrderRef(hypothesis: HypothesisRecord): string | null {
    const retained = this.retainedRationales.get(hypothesis);
    if (retained?.orderRef) return retained.orderRef;

    for (const signalRef of hypothesis.derived_from_signals) {
      if (signalRef.startsWith('order:')) {
        return signalRef.slice(6);
      }
    }

    try {
      const parsed = JSON.parse(hypothesis.reasoning) as Record<string, unknown>;
      if (typeof parsed.orderRef === 'string') return parsed.orderRef;
      if (typeof parsed.order_reference === 'string') return parsed.order_reference;
    } catch {
      // reasoning is plain string
    }

    const match = hypothesis.reasoning.match(/order ref '([^']+)'/i);
    if (match && match[1]) return match[1];

    return null;
  }

  private extractFaqQuery(hypothesis: HypothesisRecord): string {
    const retained = this.retainedRationales.get(hypothesis);
    if (retained?.faqQuery) return retained.faqQuery;

    try {
      const parsed = JSON.parse(hypothesis.reasoning) as Record<string, unknown>;
      if (typeof parsed.faqQuery === 'string') return parsed.faqQuery;
    } catch {
      // reasoning is plain string
    }

    const match = hypothesis.reasoning.match(/routed to FAQ search: '([^']+)'/i);
    if (match && match[1]) return match[1];

    return hypothesis.reasoning;
  }
}
