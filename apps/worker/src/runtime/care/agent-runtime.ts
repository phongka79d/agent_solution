/**
 * @file Customer Care intent routing (implement/04 §3.2, implement/06 §8.1).
 *
 * Intent recognition accepts the API's server-stamped, bounded Care intent when one is present.
 * The runtime never trusts a browser-authored skill, customer, authority, source, or receipt field:
 * only `care_intent` and `care_requirements` are consumed, and only after closed validation.
 * Deterministic classification remains available for scheduled/offline signals and compatibility
 * with existing callers.
 *
 * Dispatch remains narrower: only approved-knowledge retrieval, server-verified order reads, and
 * human escalation are routed to their canonical skills. Unsupported transactional capabilities
 * never fall back to an invented answer or an unregistered skill.
 */

import { renderResponseTemplate } from '@agentos/core-engine';
import { randomUUID } from 'node:crypto';
import { OrchestratorError } from '@agentos/core-engine/contracts';
import type {
  AuthorityLevel,
  ExecutionPlan,
  HandoffIntent,
  HydratedContext,
  HypothesisRecord,
  IAgentRuntime,
  PlannedStep,
  RoutingDecision,
  SignalEnvelope,
} from '@agentos/core-engine/contracts';
import { effectPolicyOf, plannedSkillMetadata, type SkillEffectClass, type SkillGate } from '@agentos/skills';

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
  return effectPolicyOf({ effect_class: effectClass, tool_binding: '' });
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
  readonly tool_binding?: string | undefined;
  readonly audit_spec?: { readonly mask_pii_fields?: readonly string[] } | undefined;
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
 * `hydrateContext`. The reference is carried by the checkpointed `HydratedContext`, not a local cache.
 */
export interface VerificationReferenceResolver {
  verificationReference?(correlation_id: string, tenant_id: string, context: HydratedContext): string | null | undefined;
  verificationReferenceFor?(tenant_id: string, correlation_id: string, context: HydratedContext): string | null | undefined;
}

export type VerificationReferencePort =
  | VerificationReferenceResolver
  | ((correlation_id: string, tenant_id: string, context: HydratedContext) => string | null | undefined);

function resolveVerificationReference(
  resolver: VerificationReferencePort | undefined,
  correlation_id: string,
  tenant_id: string,
  context: HydratedContext,
): string | null {
  if (!resolver) return null;
  if (typeof resolver === 'function') {
    return resolver(correlation_id, tenant_id, context) ?? null;
  }
  if (typeof resolver.verificationReference === 'function') {
    return resolver.verificationReference(correlation_id, tenant_id, context) ?? null;
  }
  if (typeof resolver.verificationReferenceFor === 'function') {
    return resolver.verificationReferenceFor(tenant_id, correlation_id, context) ?? null;
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

/** Normalizes Vietnamese accents for deterministic bilingual intent matching. */
function normalizeIntentText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}


const BARE_GREETING = /^(?:hi(?: there)?|hello(?: there)?|hey(?: there)?|good morning|good afternoon|good evening|xin chao|chao|alo)[.!?,\s]*$/;



type CareIntent =
  | 'product_info'
  | 'price'
  | 'stock'
  | 'order_status'
  | 'shipping'
  | 'return_refund'
  | 'payment'
  | 'complaint'
  | 'usage'
  | 'human_escalation'
  | 'requires_clarification';

/**
 * The only provider-derived fields accepted by the Care worker. The API stamps these fields after
 * validating the gateway proposal; a browser payload is never allowed to set them directly.
 *
 * `order_lookup` is accepted as the explicit structured spelling and is normalized to the
 * server-side `order_status` intent before identity/receipt planning.
 */
export const CARE_STRUCTURED_INTENTS = Object.freeze([
  'faq_search',
  'order_status',
  'order_lookup',
  'shipping',
  'return_refund',
  'payment',
  'product_info',
  'price',
  'stock',
  'usage',
  'complaint',
  'human_escalation',
  'requires_clarification',
] as const);

export type CareStructuredIntent = (typeof CARE_STRUCTURED_INTENTS)[number];

export interface CareStructuredRequirements {
  readonly order_reference?: string;
  readonly question?: string;
}

export interface CareStructuredProposal {
  readonly intent: CareStructuredIntent;
  readonly requirements: CareStructuredRequirements;
}

type ParsedCareIntent = CareIntent | 'faq_search' | 'order_lookup';



/**
 * Reads only the server-stamped structured proposal fields. Presence of any structured field
 * makes the proposal mandatory: malformed/unknown provider output refuses rather than falling
 * back to text matching, which could turn an invalid provider response into an unintended action.
 */
function readStructuredProposal(signal: SignalEnvelope): CareStructuredProposal | null {
  const rawPayload = signal.payload;
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    throw new OrchestratorError(
      'CARE_STRUCTURED_INTENT_INVALID',
      'Care signal payload must be an object.',
    );
  }
  const payload = rawPayload as Record<string, unknown>;
  const hasStructuredFields = Object.hasOwn(payload, 'care_intent')
    || Object.hasOwn(payload, 'care_requirements');
  if (!hasStructuredFields) return null;

  const rawIntent = payload['care_intent'];
  const rawRequirements = payload['care_requirements'];
  if (
    typeof rawIntent !== 'string'
    || !CARE_STRUCTURED_INTENTS.includes(rawIntent as CareStructuredIntent)
    || typeof rawRequirements !== 'object'
    || rawRequirements === null
    || Array.isArray(rawRequirements)
  ) {
    throw new OrchestratorError(
      'CARE_STRUCTURED_INTENT_INVALID',
      'Server-stamped Care intent requires a known intent and requirements object.',
    );
  }

  const requirements: { order_reference?: string; question?: string } = {};
  const structuredRequirements = rawRequirements as Record<string, unknown>;
  for (const key of Object.keys(structuredRequirements)) {
    if (key !== 'order_reference' && key !== 'question') {
      throw new OrchestratorError(
        'CARE_STRUCTURED_INTENT_INVALID',
        `Unknown server-stamped Care requirement '${key}'.`,
      );
    }
  }
  const orderReference = structuredRequirements['order_reference'];
  if (orderReference !== undefined) {
    if (typeof orderReference !== 'string' || orderReference.trim().length === 0 || orderReference.length > 128) {
      throw new OrchestratorError(
        'CARE_STRUCTURED_INTENT_INVALID',
        'Care order_reference must be a non-empty string no longer than 128 characters.',
      );
    }
    requirements.order_reference = orderReference.trim();
  }
  const question = structuredRequirements['question'];
  if (question !== undefined) {
    if (typeof question !== 'string' || question.trim().length === 0 || question.length > 2000) {
      throw new OrchestratorError(
        'CARE_STRUCTURED_INTENT_INVALID',
        'Care question must be a non-empty string no longer than 2000 characters.',
      );
    }
    requirements.question = question.trim();
  }

  return {
    intent: rawIntent as CareStructuredIntent,
    requirements,
  };
}

/**
 * The journey leg an admitted handoff run is for, or `null` for an ordinary customer signal.
 *
 * The package is written by the broker into the target run's own signal; nothing a customer sends
 * can place it there, and a malformed one is treated as absent so the run is planned as the
 * ordinary Care turn it then is.
 */
function readHandoffTargetDomain(signal: SignalEnvelope): string | null {
  // Only the orchestrator writes this channel. A delivery that merely carries a `handoff` payload
  // over a customer-facing channel is not a brokered handoff, and honouring one would let a caller
  // declare its own journey leg.
  if (signal.source_channel !== 'ORCHESTRATOR_HANDOFF') return null;
  const handoff = signal.payload['handoff'];
  if (typeof handoff !== 'object' || handoff === null || Array.isArray(handoff)) return null;
  const target = (handoff as Record<string, unknown>)['target_domain'];
  return typeof target === 'string' ? target : null;
}

/** Specific and high-risk intent patterns precede broad FAQ/question detection. */
function classifyCareIntent(text: string): CareIntent {
  const normalized = normalizeIntentText(text);
  const matches = (...patterns: RegExp[]): boolean => patterns.some((pattern) => pattern.test(normalized));

  if (matches(/\b(human|real person|live agent|representative|speak to (a )?person|talk to (a )?human)\b/, /\b(nguoi that|nhan vien|gap nguoi|tu van vien)\b/)) {
    return 'human_escalation';
  }
  if (matches(/\b(complain|complaint|damaged|broken|unacceptable|angry|terrible service|very upset|not happy)\b/, /\b(khieu nai|hu hong|vo|buc minh|khong hai long|thai do te|rat te)\b/)) {
    return 'complaint';
  }
  if (matches(/\b(double charged|charged twice|payment (failed|issue|problem)|paid twice|cash on delivery|cod)\b/, /\b(thanh toan|tru tien|bi tru tien|chua nhan tien|thanh toan loi)\b/)) {
    return 'payment';
  }
  if (matches(/\b(return|refund|exchange|money back|send (it|this) back)\b/, /\b(doi tra|tra hang|hoan tien|doi hang)\b/)) {
    return 'return_refund';
  }

  const orderRef = extractOrderReference(text);
  if (matches(/\b(order status|where is my order|track my order|order tracking|delivery status)\b/, /\b(don hang.*(dau|nao|toi dau)|tinh trang don|don cua toi)\b/)) {
    return 'order_status';
  }
  if (matches(/\b(shipping|shipment|delivery|parcel|pickup point|carrier|tracking number)\b/, /\b(giao hang|van chuyen|van don|diem nhan|buu kien)\b/)) {
    return 'shipping';
  }
  if (orderRef) {
    return 'order_status';
  }
  if (matches(/\b(in stock|stock availability|available stock|availability|restock)\b/, /\b(con hang|het hang|ton kho|hang hoa)\b/)) {
    return 'stock';
  }
  if (matches(/\b(price|how much|cost|pricing|promotion|discount)\b/, /\b(gia|bao nhieu|khuyen mai|giam gia)\b/)) {
    return 'price';
  }
  if (matches(/\b(product|features?|specifications?|waterproof|product information)\b/, /\b(san pham|tinh nang|cong dung|chong nuoc|thong so)\b/)) {
    return 'product_info';
  }
  if (matches(/\b(warranty|how to use|how do i|setup|activate|troubleshoot|instructions)\b/, /\b(bao hanh|su dung|kich hoat|huong dan|cach dung|khac phuc)\b/)) {
    return 'usage';
  }
  return 'requires_clarification';
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
  readonly careIntent?: ParsedCareIntent;
  /** The journey leg this run was admitted for, when it arrived through a brokered handoff. */
  readonly handoffTarget?: string;
}

export interface CareAgentRuntimeOptions {
  readonly registry?: SkillRegistryResolver | undefined;
  readonly gate?: SkillGate | undefined;
  readonly verificationResolver?: VerificationReferencePort | undefined;
  readonly verificationReference?: VerificationReferencePort | undefined;
  readonly now?: (() => Date) | undefined;
}

export class CareAgentRuntime implements IAgentRuntime {
  public readonly now?: (() => Date) | undefined;
  private readonly registry?: SkillRegistryResolver | undefined;
  private readonly verificationResolver?: VerificationReferencePort | undefined;
  private readonly gate?: SkillGate | undefined;
  private readonly retainedRationales = new WeakMap<HypothesisRecord, ParsedRationale>();

  constructor(options: CareAgentRuntimeOptions = {}) {
    this.registry = options.registry;
    this.verificationResolver = options.verificationResolver ?? options.verificationReference;
    this.gate = options.gate;
    this.now = options.now;
  }

  async deriveHypothesis(signal: SignalEnvelope, context: HydratedContext): Promise<HypothesisRecord> {
    const handoffTarget = readHandoffTargetDomain(signal);

    // A run admitted by a handoff is not a customer message: it is a leg of the journey the
    // orchestrator brokered, so it is classified by its leg rather than by message text. The leg is
    // recorded in the intent, which is what planning branches on.
    if (handoffTarget !== null) {
      return {
        classification: 'HYPOTHESIS',
        intent: `care:${handoffTarget}`,
        confidence: 1,
        churn_risk_score: 0,
        purchase_propensity: 0,
        reasoning: `Routed by the brokered customer journey leg '${handoffTarget}' `
          + '(implement/09 §1.1 Gate P4, plans/customer-lifecycle.md §3).',
        derived_from_signals: [signal.signal_id],
      };
    }

    const structured = readStructuredProposal(signal);
    const text = extractMessageContent(signal);
    const deterministicIntent = classifyCareIntent(text);
    const bareGreeting = BARE_GREETING.test(normalizeIntentText(text).trim());
    const careIntent: ParsedCareIntent = bareGreeting
      ? 'requires_clarification'
      : structured?.intent ?? deterministicIntent;
    const structuredOrderRef =
      careIntent === 'order_status' || careIntent === 'shipping' || careIntent === 'order_lookup'
        ? structured?.requirements.order_reference
        : undefined;
    const orderRef = structured === null
      ? (structuredOrderRef ?? ((careIntent === 'order_status' || careIntent === 'shipping' || careIntent === 'order_lookup')
        ? extractOrderReference(text)
        : null))
      : (structuredOrderRef ?? null);
    let intent: CareIntent | 'order_lookup' | 'order_lookup_unverified' | 'faq_search' = careIntent;
    if (
      careIntent === 'return_refund'
      && !structured
      && /\b(policy|how do i|what is|what are|when can)\b/i.test(normalizeIntentText(text))
    ) {
      intent = 'faq_search';
    }
    let confidence = careIntent === 'requires_clarification' ? 0.3 : 0.9;
    let reason = bareGreeting
      ? 'Bare greeting requires an open-ended clarification.'
      : structured
        ? `Server-stamped Customer Care intent: ${careIntent}.`
        : `Deterministic Customer Care classification: ${careIntent}.`;
    const rationaleData: ParsedRationale = {
      reason,
      careIntent,
      ...(structured?.requirements.question
        ? { faqQuery: structured.requirements.question }
        : (careIntent === 'product_info' || careIntent === 'price' || careIntent === 'stock'
          || careIntent === 'return_refund' || careIntent === 'usage'
          ? { faqQuery: text }
          : {})),
      // An anonymous order request is retained only as an identity refusal. Do not carry the
      // caller's order reference into durable hypothesis metadata or a later refusal response.
      ...(orderRef && context.customer ? { orderRef } : {}),
      ...(handoffTarget === null ? {} : { handoffTarget }),
    };

    if ((careIntent === 'order_status' || careIntent === 'order_lookup') && !context.customer) {
      intent = 'order_lookup_unverified';
      reason = 'Order status request requires a server-verified customer binding.';
      confidence = 0.5;
    } else if ((careIntent === 'order_status' || careIntent === 'order_lookup') && !orderRef) {
      reason = 'Order status request without an extractable order reference requires clarification.';
      confidence = 0.3;
    } else if ((careIntent === 'order_status' || careIntent === 'order_lookup') && orderRef) {
      intent = 'order_lookup';
      reason = structured
        ? `Server-stamped order lookup for '${orderRef}' with server-bound customer context.`
        : `Order status request with extracted order ref '${orderRef}' and server-bound customer context.`;
      confidence = 0.95;
    } else if (orderRef) {
      reason = `Order-related Care request with extracted reference '${orderRef}'.`;
      confidence = 0.95;
    }

    const hypothesis: HypothesisRecord = {
      classification: 'HYPOTHESIS',
      intent,
      confidence,
      churn_risk_score: 0.0,
      purchase_propensity: 0.0,
      reasoning: reason,
      // Never retain an anonymous caller's order reference as a signal-derived fact.
      derived_from_signals: orderRef && context.customer
        ? [signal.signal_id, `order:${orderRef}`]
        : [signal.signal_id],
    };

    this.retainedRationales.set(hypothesis, { ...rationaleData, reason });
    return hypothesis;

  }

  async resolveRouting(
    _signal: SignalEnvelope,
    context: HydratedContext,
    hypothesis: HypothesisRecord,
  ): Promise<RoutingDecision> {
    const retained = this.retainedRationales.get(hypothesis);
    const intent = retained?.careIntent ?? hypothesis.intent;

    if (intent === 'human_escalation' || intent === 'complaint') {
      return {
        target_agent: 'HUMAN_HANDOFF',
        domain: 'support',
        requires_clarification: false,
        rationalization: hypothesis.reasoning,
      };
    }

    if (intent === 'care:care') {
      return {
        target_agent: 'CS-01',
        domain: 'support',
        requires_clarification: false,
        rationalization: hypothesis.reasoning,
      };
    }

    if (intent === 'care:retention') {
      return {
        target_agent: 'CS-02',
        domain: 'support',
        requires_clarification: false,
        rationalization: hypothesis.reasoning,
      };
    }

    if (intent === 'order_status' && hypothesis.intent === 'order_lookup' && context.customer) {
      return {
        target_agent: 'CS-01',
        domain: 'support',
        requires_clarification: false,
        rationalization: hypothesis.reasoning,
      };
    }

    if (intent === 'order_lookup_unverified' || hypothesis.intent === 'order_lookup_unverified') {
      return {
        target_agent: 'CS-01',
        domain: 'support',
        requires_clarification: false,
        clarification_template_key: 'care.identity_required',
        clarification_reason_code: 'IDENTITY_UNVERIFIED',
        rationalization: 'Order status requires a server-verified customer binding.',
      };
    }

    if (intent === 'order_status') {
      return {
        target_agent: 'CS-01',
        domain: 'support',
        requires_clarification: true,
        clarification_template_key: 'care.need_order_reference',
        clarification_reason_code: 'CARE_ORDER_REFERENCE_MISSING',
        clarification_prompt: 'Please provide your order reference number (for example, ORD-12345).',
        rationalization: hypothesis.reasoning,
      };
    }

    if (intent === 'order_lookup' && context.customer) {
      return {
        target_agent: 'CS-01',
        requires_clarification: false,
        domain: 'support',
        rationalization: hypothesis.reasoning,
      };
    }
    if (intent === 'faq_search' || intent === 'product_info' || intent === 'price' || intent === 'stock'
      || intent === 'shipping' || intent === 'return_refund' || intent === 'payment' || intent === 'usage') {
      return {
        target_agent: 'CS-01',
        domain: 'support',
        requires_clarification: false,
        rationalization: `${hypothesis.reasoning} Route only to approved Care knowledge; related live data and actions remain unavailable unless explicitly bound.`,
      };
    }

    return {
      target_agent: 'CS-01',
      domain: 'support',
      clarification_template_key: intent === 'requires_clarification'
        ? 'care.need_more_detail'
        : context.customer === null
          ? 'care.identity_required'
          : 'care.need_order_reference',
      ...(intent === 'requires_clarification' ? { clarification_reason_code: 'CARE_INTENT_UNCLEAR' } : {}),
      requires_clarification: true,
      clarification_prompt: 'How can I assist you with your order or questions today?',
      rationalization: hypothesis.reasoning,
    };
  }

  async formulatePlan(
    routing: RoutingDecision,
    context: HydratedContext,
    hypothesis: HypothesisRecord,
  ): Promise<ExecutionPlan> {
    const plan = await this.composePlan(routing, context, hypothesis);
    const withIntent = this.withRetentionIntent(plan, context, hypothesis);
    const gated = await this.applyAvailabilityGate(withIntent, context);
    return { ...gated, domain: 'support' };
  }

  private async applyAvailabilityGate(
    plan: ExecutionPlan,
    context: HydratedContext,
  ): Promise<ExecutionPlan> {
    const gate = this.gate;
    if (gate === undefined || plan.steps.length === 0) return plan;

    const verdicts = await Promise.all(
      plan.steps.map(async (step) => ({
        step,
        verdict: await gate.available(context.tenant_id, step.skill_id),
      })),
    );
    const refused = new Set(
      verdicts.filter((entry) => !entry.verdict.available).map((entry) => entry.step.step_index),
    );
    if (refused.size === 0) return plan;

    let kept = plan.steps.filter((step) => !refused.has(step.step_index));
    for (;;) {
      const keptIndexes = new Set(kept.map((step) => step.step_index));
      const next = kept.filter((step) =>
        (step.depends_on_steps ?? []).every((dependency) => keptIndexes.has(dependency)));
      if (next.length === kept.length) break;
      kept = next;
    }

    if (kept.length === 0) {
      const unavailable = verdicts.find((entry) => !entry.verdict.available);
      if (unavailable === undefined) return plan;
      const rendered = renderResponseTemplate('core.skill_unavailable');
      const refusal: ExecutionPlan = {
        ...plan,
        steps: [],
        terminal_response: {
          response_kind: 'REFUSAL',
          ...rendered,
          reason_code: unavailable.verdict.reason,
          sources: [],
        },
      };
      Reflect.deleteProperty(refusal, 'handoff_intent');
      return refusal;
    }

    const indexMap = new Map<number, number>();
    kept.forEach((step, index) => indexMap.set(step.step_index, index + 1));
    return {
      ...plan,
      steps: kept.map((step, index) => ({
        ...step,
        step_index: index + 1,
        depends_on_steps: (step.depends_on_steps ?? [])
          .map((dependency) => indexMap.get(dependency))
          .filter((dependency): dependency is number => dependency !== undefined),
      })),
    };
  }

  /**
   * The next leg: a Care run admitted for the onboarding leg hands the verified customer to the
   * retention leg (implement/09 §1.1 Gate P4, plans/customer-lifecycle.md §3).
   *
   * The intent is attached only to a handoff-admitted care run that actually planned a step, so an
   * empty plan never brokers a handoff on the strength of nothing. The customer is the run's own
   * verified subject; the reason states the leg, and neither is read from the inbound payload.
   */
  private withRetentionIntent(
    plan: ExecutionPlan,
    context: HydratedContext,
    hypothesis: HypothesisRecord,
  ): ExecutionPlan {
    if (hypothesis.intent !== 'care:care' || plan.steps.length === 0) return plan;
    if (!context.customer?.customer_id) return plan;

    const handoff_intent: HandoffIntent = {
      source_domain: 'care',
      target_domain: 'retention',
      target_agent: 'CS-02',
      reason: 'Care onboarding leg completed for a verified customer; retention is the next leg',
    };

    return { ...plan, handoff_intent };
  }

  private async composePlan(
    routing: RoutingDecision,
    context: HydratedContext,
    hypothesis: HypothesisRecord,
  ): Promise<ExecutionPlan> {

    if (context.working_memory.takeover_active) {
      throw new OrchestratorError(
        'CONVERSATION_LOCKED',
        'Customer Care automation is paused while a human operator owns this conversation.',
      );
    }
    const plan_id = `plan_${randomUUID().slice(0, 8)}`;

    // A run admitted for the Care ONBOARDING leg has no message to classify: its itinerary is a
    // prerequisite this deployment does not bind yet (see `blocked.md`). It refuses with a named
    // code instead of returning the empty plan below, because an empty plan completes with zero
    // steps and would report a journey leg as done that never did anything.
    if (hypothesis.intent === 'care:care') {
      throw new OrchestratorError(
        'CARE_ONBOARDING_ITINERARY_UNBOUND',
        'The Customer Care onboarding leg of the customer journey has no bound itinerary: no '
          + 'canonical CS-01 action is configured for a handoff-admitted onboarding run, so the '
          + 'leg refuses rather than completing with nothing (implement/09 §1.1 Gate P4).',
      );
    }

    // The retention leg is planned from its own canonical CS-02 row. Its authoritative ports
    // (`Customer360.AnalyticsLayer` for the churn hypothesis) are not bound by every deployment, in
    // which case the dispatch boundary refuses with `AUTHORITATIVE_SOURCE_UNAVAILABLE` — no churn
    // score and no retention offer is ever synthesized in their place (implement/05 §6 row 22-23).
    if (hypothesis.intent === 'care:retention') {
      const row = lookupRegistryRow(this.registry, 'skill.care.analyze_churn_risk');
      if (!row) return { plan_id, steps: [], fallback_strategy: 'FAIL_CLOSED' };
      const policy = effectPolicyOf({
        effect_class: row.effect_class,
        tool_binding: row.tool_binding ?? '',
      });
      const metadata = plannedSkillMetadata(row.skill_id);
      const customer_id = context.customer?.customer_id;

      return {
        plan_id,
        steps: [{
          step_index: 1,
          agent_id: 'CS-02',
          skill_id: 'skill.care.analyze_churn_risk',
          adapter_target: row.guarded_dependency,
          input_parameters: {
            tenant_id: context.tenant_id,
            ...(customer_id === undefined ? {} : { customer_id }),
          },
          required_authority: row.required_authority,
          mutating: policy.mutating,
          price_bearing: policy.price_bearing,
          idempotent: policy.idempotent,
          timeout_ms: row.timeout_ms,
          ...(metadata === undefined ? {} : { dispatch_timeout_ms: metadata.dispatch_timeout_ms }),
          completion: metadata?.completion ?? 'SYNC',
          ...(metadata?.idempotency_input_field === undefined
            ? {}
            : { idempotency_input_field: metadata.idempotency_input_field }),
          ...(row.audit_spec === undefined ? {} : { audit_spec: row.audit_spec }),
          depends_on_steps: [],
        }],
        fallback_strategy: 'FAIL_CLOSED',
      };
    }
    if (hypothesis.intent === 'order_lookup_unverified') {
      const rendered = renderResponseTemplate('care.identity_required');
      return {
        plan_id,
        steps: [],
        fallback_strategy: 'FAIL_CLOSED',
        response_agent_id: 'CS-01',
        terminal_response: {
          response_kind: 'CLARIFICATION',
          ...rendered,
          reason_code: 'IDENTITY_UNVERIFIED',
          sources: [],
        },
      };
    }


    if (routing.requires_clarification) {
      return { plan_id, steps: [], fallback_strategy: 'FAIL_CLOSED' };
    }

    const retained = this.retainedRationales.get(hypothesis);
    const intent = retained?.careIntent ?? hypothesis.intent;

    if ((intent === 'human_escalation' || intent === 'complaint') && routing.target_agent === 'HUMAN_HANDOFF') {
      const session_id = context.working_memory.session_id;
      const conversation_id = context.working_memory.conversation_id;
      if (context.tenant_id.length === 0 || session_id.length === 0 || !conversation_id) {
        return { plan_id, steps: [], fallback_strategy: 'FAIL_CLOSED' };
      }
      const row = lookupRegistryRow(this.registry, 'skill.care.escalate_to_human');
      if (!row) return { plan_id, steps: [], fallback_strategy: 'FAIL_CLOSED' };
      const policy = effectPolicyOf({
        effect_class: row.effect_class,
        tool_binding: row.tool_binding ?? '',
      });
      const metadata = plannedSkillMetadata(row.skill_id);
      const step: PlannedStep = {
        step_index: 1,
        agent_id: 'CS-01',
        skill_id: 'skill.care.escalate_to_human',
        adapter_target: row.guarded_dependency,
        input_parameters: {
          tenant_id: context.tenant_id,
          session_id,
          conversation_id,
          ...(context.customer ? { customer_id: context.customer.customer_id } : {}),
          escalation_reason: intent === 'complaint' ? 'customer_complaint' : 'customer_requested_human',
          summary_context: hypothesis.reasoning,
        },
        required_authority: row.required_authority,
        mutating: policy.mutating,
        price_bearing: policy.price_bearing,
        idempotent: policy.idempotent,
        timeout_ms: row.timeout_ms,
        ...(metadata === undefined ? {} : { dispatch_timeout_ms: metadata.dispatch_timeout_ms }),
        completion: metadata?.completion ?? 'SYNC',
        ...(metadata?.idempotency_input_field === undefined
          ? {}
          : { idempotency_input_field: metadata.idempotency_input_field }),
        ...(row.audit_spec === undefined ? {} : { audit_spec: row.audit_spec }),
        depends_on_steps: [],
      };
      return { plan_id, steps: [step], fallback_strategy: 'ESCALATE_HUMAN' };
    }

    if (
      (intent === 'order_status' || intent === 'order_lookup')
      && hypothesis.intent === 'order_lookup'
    ) {
      const customer_id = context.customer?.customer_id;
      const orderRef = this.extractOrderRef(hypothesis);
      const verification_reference = resolveVerificationReference(
        this.verificationResolver,
        context.correlation_id,
        context.tenant_id,
        context,
      );
      if (!orderRef || !customer_id || !verification_reference) {
        return { plan_id, steps: [], fallback_strategy: 'FAIL_CLOSED' };
      }
      const row = lookupRegistryRow(this.registry, 'skill.care.lookup_order');
      if (!row) return { plan_id, steps: [], fallback_strategy: 'FAIL_CLOSED' };
      const policy = effectPolicyOf({
        effect_class: row.effect_class,
        tool_binding: row.tool_binding ?? '',
      });
      const metadata = plannedSkillMetadata(row.skill_id);
      const step: PlannedStep = {
        step_index: 1,
        agent_id: 'CS-01',
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
        ...(metadata === undefined ? {} : { dispatch_timeout_ms: metadata.dispatch_timeout_ms }),
        completion: metadata?.completion ?? 'SYNC',
        ...(metadata?.idempotency_input_field === undefined
          ? {}
          : { idempotency_input_field: metadata.idempotency_input_field }),
        ...(row.audit_spec === undefined ? {} : { audit_spec: row.audit_spec }),
        depends_on_steps: [],
      };
      return { plan_id, steps: [step], fallback_strategy: 'FAIL_CLOSED' };
    }

    if (intent === 'faq_search' || intent === 'product_info' || intent === 'price' || intent === 'stock' || intent === 'shipping'
      || intent === 'return_refund' || intent === 'payment' || intent === 'usage') {
      const query = this.extractFaqQuery(hypothesis);
      const row = lookupRegistryRow(this.registry, 'skill.care.search_faq');
      if (!row) return { plan_id, steps: [], fallback_strategy: 'FAIL_CLOSED' };
      const policy = effectPolicyOf({
        effect_class: row.effect_class,
        tool_binding: row.tool_binding ?? '',
      });
      const metadata = plannedSkillMetadata(row.skill_id);
      const step: PlannedStep = {
        step_index: 1,
        agent_id: 'CS-01',
        skill_id: 'skill.care.search_faq',
        adapter_target: row.guarded_dependency,
        input_parameters: { query_text: query },
        required_authority: row.required_authority,
        mutating: policy.mutating,
        price_bearing: policy.price_bearing,
        idempotent: policy.idempotent,
        completion: metadata?.completion ?? 'SYNC',
        ...(metadata?.idempotency_input_field === undefined
          ? {}
          : { idempotency_input_field: metadata.idempotency_input_field }),
        timeout_ms: row.timeout_ms,
        ...(metadata === undefined ? {} : { dispatch_timeout_ms: metadata.dispatch_timeout_ms }),
        ...(row.audit_spec === undefined ? {} : { audit_spec: row.audit_spec }),
        depends_on_steps: [],
      };
      return { plan_id, steps: [step], fallback_strategy: 'FAIL_CLOSED' };
    }

    return { plan_id, steps: [], fallback_strategy: 'FAIL_CLOSED' };
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
