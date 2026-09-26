/**
 * @file Sales Policy Engine Adapter (implement/04 §3.2, implement/05 §4.2, implement/08 §1.2, §7.1).
 *
 * Invariant:
 * 1. Derives from DomainPolicyEngine using the canonical 8 Sales skills and strictly declared payload fields.
 * 2. Resolves trusted owner-approved floor metadata at the action boundary for discount-sensitive actions.
 * 3. Never computes, defaults, or rounds a price floor locally; throws P_FLOOR_UNAVAILABLE when unbound,
 *    refused, or unprovenanced.
 */

import type {
  ActionDraft,
  AssignableAuthority,
  HydratedContext,
  IAuditTrail,
  IPolicyEngine,
} from '@agentos/core-engine/contracts';
import { OrchestratorError } from '@agentos/core-engine/contracts';
import {
  type ApprovalQueuePort,
  type ConsentSource,
  type ConsentState,
  type PolicyEnforcementOptions,
  type PolicyEnforcementPoint,
  type PolicyRegistrySkill,
} from '@agentos/core-engine';
import type { AuditRepository } from '@agentos/database';

import { DomainPolicyEngine } from '../shared/policy-engine.js';
import { createPolicyAuditSink } from '../shared/policy-audit.js';
import type {
  SalesAggregatePriceFloorQuery,
  SalesConsentPort,
  SalesPriceFloorDecision,
  SalesPriceFloorPort,
} from './skills/types.js';

/** Allowed fields in action payloads per Sales skill, using static Record lookup */
export const SALES_ALLOWED_PAYLOAD_FIELDS: Readonly<Record<string, Readonly<Record<string, true>>>> = Object.freeze({
  'skill.sales.search_product': Object.freeze({
    tenant_id: true,
    query: true,
    category_id: true,
    limit: true,
    effect_key: true,
  }),
  'skill.sales.check_stock': Object.freeze({
    tenant_id: true,
    sku_id: true,
    warehouse_id: true,
    effect_key: true,
  }),
  'skill.sales.check_price': Object.freeze({
    tenant_id: true,
    sku_id: true,
    customer_id: true,
    requested_discount_percent: true,
    effect_key: true,
  }),
  'skill.sales.retrieve_customer': Object.freeze({
    tenant_id: true,
    customer_identifier: true,
    effect_key: true,
  }),
  'skill.sales.recommend_product': Object.freeze({
    tenant_id: true,
    customer_id: true,
    current_cart_skus: true,
    recommendation_type: true,
    effect_key: true,
  }),
  'skill.sales.create_cart': Object.freeze({
    tenant_id: true,
    session_id: true,
    customer_id: true,
    items: true,
    idempotency_key: true,
    offer_id: true,
    discount_amount: true,
    discount_percent: true,
    effect_key: true,
  }),
  'skill.sales.create_order': Object.freeze({
    tenant_id: true,
    cart_id: true,
    customer_id: true,
    shipping_address: true,
    payment_method: true,
    effect_key: true,
  }),
  'skill.sales.send_message': Object.freeze({
    tenant_id: true,
    recipient_id: true,
    channel: true,
    message_content: true,
    effect_key: true,
  }),
});

/** Canonical skill definitions for Sales from packages/skills/src/platform/sales/*.ts and implement/05 §6.2 */
export const SALES_SKILLS: Readonly<Record<string, PolicyRegistrySkill>> = Object.freeze({
  'skill.sales.search_product': {
    skill_id: 'skill.sales.search_product',
    allowed_agents: Object.freeze(['SAL-02', 'SAL-03']),
    required_authority: 'AUTH-0',
    mutating: false,
    price_bearing: false,
    idempotent: true,
    epistemic_class: 'FACT',
    write_target: 'HYPOTHESIS',
    requires_consent: false,
    requires_verified_identity: false,
    timeout_ms: 1500,
  },
  'skill.sales.check_stock': {
    skill_id: 'skill.sales.check_stock',
    allowed_agents: Object.freeze(['SAL-02', 'SAL-03', 'SAL-04', 'SAL-05']),
    required_authority: 'AUTH-0',
    mutating: false,
    price_bearing: false,
    idempotent: true,
    epistemic_class: 'FACT',
    write_target: 'HYPOTHESIS',
    requires_consent: false,
    requires_verified_identity: false,
    timeout_ms: 3000,
  },
  'skill.sales.check_price': {
    skill_id: 'skill.sales.check_price',
    allowed_agents: Object.freeze(['SAL-02', 'SAL-03', 'SAL-04']),
    required_authority: 'AUTH-3',
    mutating: false,
    price_bearing: false,
    idempotent: true,
    epistemic_class: 'FACT',
    write_target: 'HYPOTHESIS',
    requires_consent: false,
    requires_verified_identity: false,
    timeout_ms: 2000,
  },
  'skill.sales.retrieve_customer': {
    skill_id: 'skill.sales.retrieve_customer',
    allowed_agents: Object.freeze(['SAL-01', 'SAL-02', 'SAL-03', 'SAL-04', 'SAL-05']),
    required_authority: 'AUTH-0',
    mutating: false,
    price_bearing: false,
    idempotent: true,
    epistemic_class: 'FACT',
    write_target: 'HYPOTHESIS',
    requires_consent: false,
    requires_verified_identity: true,
    timeout_ms: 1500,
  },
  'skill.sales.recommend_product': {
    skill_id: 'skill.sales.recommend_product',
    allowed_agents: Object.freeze(['SAL-03']),
    required_authority: 'AUTH-1',
    mutating: false,
    price_bearing: false,
    idempotent: true,
    epistemic_class: 'HYPOTHESIS',
    write_target: 'HYPOTHESIS',
    requires_consent: true,
    requires_verified_identity: true,
    timeout_ms: 2500,
  },
  'skill.sales.create_cart': {
    skill_id: 'skill.sales.create_cart',
    allowed_agents: Object.freeze(['SAL-02', 'SAL-04']),
    required_authority: 'AUTH-3',
    mutating: true,
    price_bearing: false,
    idempotent: false,
    epistemic_class: 'FACT',
    write_target: 'FACT',
    requires_consent: false,
    requires_verified_identity: false,
    timeout_ms: 2000,
  },
  'skill.sales.create_order': {
    skill_id: 'skill.sales.create_order',
    allowed_agents: Object.freeze(['SAL-02']),
    required_authority: 'AUTH-3',
    mutating: true,
    price_bearing: false,
    idempotent: false,
    epistemic_class: 'FACT',
    write_target: 'FACT',
    requires_consent: false,
    requires_verified_identity: false,
    timeout_ms: 4000,
  },
  'skill.sales.send_message': {
    skill_id: 'skill.sales.send_message',
    allowed_agents: Object.freeze(['SAL-02', 'SAL-04', 'SAL-05']),
    required_authority: 'AUTH-3',
    mutating: true,
    price_bearing: false,
    idempotent: false,
    epistemic_class: 'FACT',
    write_target: 'FACT',
    requires_consent: true,
    requires_verified_identity: false,
    timeout_ms: 3000,
  },
});

function defaultSalesGrant(agent_id: string): AssignableAuthority | null {
  if (agent_id === 'SAL-01') return 'AUTH-0';
  if (agent_id === 'SAL-02') return 'AUTH-3';
  if (agent_id === 'SAL-03') return 'AUTH-1';
  if (agent_id === 'SAL-04') return 'AUTH-3';
  if (agent_id === 'SAL-05') return 'AUTH-3';
  return null;
}
interface FloorDecisionCandidate {
  readonly owner_approved?: unknown;
  readonly floor_source?: unknown;
  readonly p_floor?: unknown;
  readonly reason?: unknown;
  readonly list_price?: unknown;
}

function hasSkuId(item: unknown): item is { sku_id: string } {
  return typeof item === 'object' && item !== null && 'sku_id' in item && typeof item.sku_id === 'string' && item.sku_id.trim().length > 0;
}

export interface SalesPolicyEngineOptions {
  readonly price_floor?: SalesPriceFloorPort | null | undefined;
  readonly consent?: SalesConsentPort | null | undefined;
  readonly pep?: PolicyEnforcementPoint | undefined;
  readonly resolveGrant?: ((tenant_id: string, agent_id: string) => Promise<AssignableAuthority | null>) | undefined;
  readonly approvals?: ApprovalQueuePort | undefined;
  readonly auditSecret?: string | undefined;
  readonly audit?: PolicyEnforcementOptions['audit'] | null | undefined;
  readonly now?: (() => Date) | undefined;
}

/**
 * Builds a core-engine ConsentSource over an authoritative SalesConsentPort.
 * Reads customer-level consent for server-verified customer id only.
 * Never reads from action payload, never defaults missing records to consented,
 * and returns undefined when read fails or tenant/customer is unbound.
 */
function buildSalesConsentSource(port: SalesConsentPort): ConsentSource {
  return {
    async getConsent(input: {
      readonly tenant_id: string;
      readonly customer_id: string;
    }): Promise<ConsentState | undefined> {
      const tenantId = input?.tenant_id?.trim();
      const customerId = input?.customer_id?.trim();
      if (!tenantId || !customerId) {
        return undefined;
      }
      try {
        const state = await port.getConsent({
          tenant_id: tenantId,
          customer_id: customerId,
        });
        if (!state || typeof state !== 'object') {
          return undefined;
        }
        if (typeof state.consent_marketing !== 'boolean' || typeof state.suppression_active !== 'boolean') {
          return undefined;
        }
        return {
          consent_marketing: state.consent_marketing,
          suppression_active: state.suppression_active,
        };
      } catch {
        return undefined;
      }
    },
  };
}

export interface CreateSalesPolicyEngineOptions extends SalesPolicyEngineOptions {
  readonly auditTrail?: IAuditTrail | undefined;
  readonly auditRepository?: AuditRepository | undefined;
}
export class SalesPolicyEngine extends DomainPolicyEngine implements IPolicyEngine {
  private readonly priceFloorPort: SalesPriceFloorPort | undefined;

  constructor(options: SalesPolicyEngineOptions = {}) {
    const consentPort = options.consent ?? undefined;
    const consentSource = consentPort ? buildSalesConsentSource(consentPort) : undefined;

    super({
      skills: SALES_SKILLS,
      allowed_payload_fields: SALES_ALLOWED_PAYLOAD_FIELDS,
      ...(options.pep ? { pep: options.pep } : {}),
      ...(options.resolveGrant ? { resolveGrant: options.resolveGrant } : {}),
      defaultGrant: defaultSalesGrant,
      ...(options.approvals ? { approvals: options.approvals } : {}),
      ...(consentSource ? { consent: consentSource } : {}),
      ...(options.auditSecret ? { auditSecret: options.auditSecret } : {}),
      ...(options.audit ? { audit: options.audit } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    this.priceFloorPort = options.price_floor ?? undefined;
  }

  override async validateAction(action: ActionDraft, context: HydratedContext): Promise<ActionDraft> {
    const validated = await super.validateAction(action, context);
    const payload = validated.payload ?? {};

    const isDiscountSensitive =
      payload.offer_id !== undefined ||
      payload.discount_amount !== undefined ||
      payload.discount_percent !== undefined ||
      payload.proposed_price !== undefined ||
      validated.proposed_price !== undefined;

    if (!isDiscountSensitive) {
      return validated;
    }

    if (!this.priceFloorPort) {
      throw new OrchestratorError(
        'P_FLOOR_UNAVAILABLE',
        `P_FLOOR_UNAVAILABLE: discount-sensitive action '${validated.skill_id}' requires a bound owner-approved price floor port.`,
      );
    }

    let isAmbiguous = false;
    const itemsList: unknown[] = [];
    const itemSkus: string[] = [];

    if ('items' in payload && payload.items !== undefined) {
      if (!Array.isArray(payload.items)) {
        isAmbiguous = true;
      } else {
        for (const item of payload.items) {
          itemsList.push(item);
          if (hasSkuId(item)) {
            itemSkus.push(item.sku_id);
          } else {
            isAmbiguous = true;
          }
        }
      }
    }

    const hasDirectSku = typeof payload.sku_id === 'string' && payload.sku_id.trim().length > 0;
    if ('sku_id' in payload && payload.sku_id !== undefined && !hasDirectSku) {
      isAmbiguous = true;
    }

    const allSkus = new Set<string>();
    if (hasDirectSku) {
      allSkus.add((payload.sku_id as string).trim());
    }
    for (const s of itemSkus) {
      allSkus.add(s.trim());
    }

    if (allSkus.size === 0) {
      throw new OrchestratorError(
        'P_FLOOR_UNAVAILABLE',
        `P_FLOOR_UNAVAILABLE: discount-sensitive action '${validated.skill_id}' lacks resolvable SKU for floor evaluation.`,
      );
    }

    if (!isAmbiguous && allSkus.size === 1) {
      const [singleSku] = allSkus;
      if (!singleSku) {
        throw new OrchestratorError(
          'P_FLOOR_UNAVAILABLE',
          `P_FLOOR_UNAVAILABLE: discount-sensitive action '${validated.skill_id}' lacks resolvable SKU for floor evaluation.`,
        );
      }
      let decision: SalesPriceFloorDecision | undefined;
      try {
        decision = await this.priceFloorPort.read({
          tenant_id: validated.tenant_id,
          sku_id: singleSku,
        });
      } catch (err) {
        throw new OrchestratorError(
          'P_FLOOR_UNAVAILABLE',
          `P_FLOOR_UNAVAILABLE: failed to read floor decision for SKU '${singleSku}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!decision || typeof decision !== 'object') {
        throw new OrchestratorError(
          'P_FLOOR_UNAVAILABLE',
          `P_FLOOR_UNAVAILABLE: empty or invalid floor decision for SKU '${singleSku}'.`,
        );
      }

      const d: FloorDecisionCandidate = decision as unknown as FloorDecisionCandidate;
      const isOwnerApproved = d.owner_approved === true;
      const hasFloor = typeof d.p_floor === 'number' && Number.isFinite(d.p_floor);
      const hasProvenance = typeof d.floor_source === 'string' && d.floor_source.trim().length > 0;

      if (!isOwnerApproved || !hasFloor || !hasProvenance) {
        const reason =
          typeof d.reason === 'string' && d.reason.trim().length > 0
            ? d.reason
            : 'decision is not owner-approved with provenance';
        throw new OrchestratorError(
          'P_FLOOR_UNAVAILABLE',
          `P_FLOOR_UNAVAILABLE: owner-approved floor provenance is unavailable for SKU '${singleSku}': ${reason}`,
        );
      }

      return {
        ...validated,
        computed_price_floor: d.p_floor as number,
        floor_source: d.floor_source as string,
        ...(validated.proposed_price === undefined && typeof payload.proposed_price === 'number'
          ? { proposed_price: payload.proposed_price }
          : {}),
      };
    }

    const readAggregateFn =
      typeof this.priceFloorPort.readAggregate === 'function'
        ? this.priceFloorPort.readAggregate.bind(this.priceFloorPort)
        : undefined;

    if (!readAggregateFn) {
      throw new OrchestratorError(
        'P_FLOOR_UNAVAILABLE',
        `P_FLOOR_UNAVAILABLE: discount-sensitive multi-SKU action '${validated.skill_id}' requires an authoritative aggregate floor decision, but price floor port offers no aggregate decision.`,
      );
    }

    const aggregateQuery: SalesAggregatePriceFloorQuery = {
      tenant_id: validated.tenant_id,
      items: itemsList.length > 0
        ? itemsList.map((item) => {
            if (typeof item === 'object' && item !== null) {
              const r = item as Record<string, unknown>;
              return {
                sku_id: typeof r.sku_id === 'string' ? r.sku_id : '',
                ...(typeof r.quantity === 'number' ? { quantity: r.quantity } : {}),
                ...(typeof r.proposed_price === 'number' ? { proposed_price: r.proposed_price } : {}),
                ...(typeof r.price === 'number' && typeof r.proposed_price !== 'number' ? { proposed_price: r.price } : {}),
                ...(typeof r.list_price === 'number' ? { list_price: r.list_price } : {}),
              };
            }
            return { sku_id: '' };
          })
        : Array.from(allSkus).map((skuId) => ({ sku_id: skuId })),
      ...(typeof payload.offer_id === 'string' ? { offer_id: payload.offer_id } : {}),
      ...(typeof payload.discount_amount === 'number' ? { discount_amount: payload.discount_amount } : {}),
      ...(typeof payload.discount_percent === 'number' ? { discount_percent: payload.discount_percent } : {}),
      ...(typeof validated.proposed_price === 'number'
        ? { proposed_price: validated.proposed_price }
        : typeof payload.proposed_price === 'number'
          ? { proposed_price: payload.proposed_price }
          : {}),
    };

    let aggregateDecision: SalesPriceFloorDecision | undefined;
    try {
      aggregateDecision = await readAggregateFn(aggregateQuery);
    } catch (err) {
      throw new OrchestratorError(
        'P_FLOOR_UNAVAILABLE',
        `P_FLOOR_UNAVAILABLE: failed to read aggregate floor decision for action '${validated.skill_id}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!aggregateDecision || typeof aggregateDecision !== 'object') {
      throw new OrchestratorError(
        'P_FLOOR_UNAVAILABLE',
        `P_FLOOR_UNAVAILABLE: empty or invalid aggregate floor decision for action '${validated.skill_id}'.`,
      );
    }

    const aggD: FloorDecisionCandidate = aggregateDecision as unknown as FloorDecisionCandidate;
    const isAggOwnerApproved = aggD.owner_approved === true;
    const hasAggFloor = typeof aggD.p_floor === 'number' && Number.isFinite(aggD.p_floor);
    const hasAggProvenance = typeof aggD.floor_source === 'string' && aggD.floor_source.trim().length > 0;

    if (!isAggOwnerApproved || !hasAggFloor || !hasAggProvenance) {
      const reason =
        typeof aggD.reason === 'string' && aggD.reason.trim().length > 0
          ? aggD.reason
          : 'decision is not owner-approved with provenance';
      throw new OrchestratorError(
        'P_FLOOR_UNAVAILABLE',
        `P_FLOOR_UNAVAILABLE: owner-approved aggregate floor provenance is unavailable for action '${validated.skill_id}': ${reason}`,
      );
    }

    if (isAmbiguous) {
      throw new OrchestratorError(
        'P_FLOOR_UNAVAILABLE',
        `P_FLOOR_UNAVAILABLE: member SKU floor cannot be resolved due to ambiguous item payload for action '${validated.skill_id}'.`,
      );
    }

    interface MemberToCheck {
      readonly skuId: string;
      readonly proposedPrice?: number | undefined;
      readonly price?: number | undefined;
      readonly discountPercent?: number | undefined;
    }

    const membersToCheck: MemberToCheck[] = [];
    if (Array.isArray(payload.items) && payload.items.length > 0) {
      for (const item of payload.items) {
        if (!hasSkuId(item)) {
          throw new OrchestratorError(
            'P_FLOOR_UNAVAILABLE',
            `P_FLOOR_UNAVAILABLE: member SKU floor cannot be resolved due to missing sku_id in item.`,
          );
        }
        const r = item as Record<string, unknown>;
        membersToCheck.push({
          skuId: item.sku_id.trim(),
          ...(typeof r.proposed_price === 'number' && Number.isFinite(r.proposed_price)
            ? { proposedPrice: r.proposed_price }
            : {}),
          ...(typeof r.price === 'number' && Number.isFinite(r.price)
            ? { price: r.price }
            : {}),
          ...(typeof r.discount_percent === 'number' && Number.isFinite(r.discount_percent)
            ? { discountPercent: r.discount_percent }
            : {}),
        });
      }
    } else {
      for (const sku of allSkus) {
        membersToCheck.push({ skuId: sku });
      }
    }

    for (const member of membersToCheck) {
      const skuId = member.skuId;
      let memberDecision: SalesPriceFloorDecision | undefined;
      try {
        memberDecision = await this.priceFloorPort.read({
          tenant_id: validated.tenant_id,
          sku_id: skuId,
        });
      } catch (err) {
        throw new OrchestratorError(
          'P_FLOOR_UNAVAILABLE',
          `P_FLOOR_UNAVAILABLE: failed to read floor decision for member SKU '${skuId}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!memberDecision || typeof memberDecision !== 'object') {
        throw new OrchestratorError(
          'P_FLOOR_UNAVAILABLE',
          `P_FLOOR_UNAVAILABLE: empty or invalid floor decision for member SKU '${skuId}'.`,
        );
      }

      const memD: FloorDecisionCandidate = memberDecision as unknown as FloorDecisionCandidate;
      const isMemOwnerApproved = memD.owner_approved === true;
      const hasMemFloor = typeof memD.p_floor === 'number' && Number.isFinite(memD.p_floor);
      const hasMemProvenance = typeof memD.floor_source === 'string' && memD.floor_source.trim().length > 0;

      if (!isMemOwnerApproved || !hasMemFloor || !hasMemProvenance) {
        const reason =
          typeof memD.reason === 'string' && memD.reason.trim().length > 0
            ? memD.reason
            : 'decision is not owner-approved with provenance';
        throw new OrchestratorError(
          'P_FLOOR_UNAVAILABLE',
          `P_FLOOR_UNAVAILABLE: owner-approved floor provenance is unavailable for member SKU '${skuId}': ${reason}`,
        );
      }

      const memberFloor = memD.p_floor as number;

      // 1. Check item-specific explicit price
      const itemExplicitPrice = member.proposedPrice ?? member.price;
      if (itemExplicitPrice !== undefined && itemExplicitPrice < memberFloor) {
        throw new OrchestratorError(
          'P_FLOOR_UNAVAILABLE',
          `P_FLOOR_UNAVAILABLE: proposed price ${itemExplicitPrice} falls below owner-approved floor ${memberFloor} for member SKU '${skuId}'.`,
        );
      }

      // 2. Check item-specific or payload-level discount percent against member SKU list_price
      const discountPercent =
        member.discountPercent ??
        (typeof payload.discount_percent === 'number' ? payload.discount_percent : undefined);
      const memberListPrice = memD.list_price;
      if (
        itemExplicitPrice === undefined &&
        typeof discountPercent === 'number' &&
        typeof memberListPrice === 'number' &&
        Number.isFinite(memberListPrice)
      ) {
        const discountedPrice = memberListPrice * (1 - discountPercent / 100);
        if (discountedPrice < memberFloor) {
          throw new OrchestratorError(
            'P_FLOOR_UNAVAILABLE',
            `P_FLOOR_UNAVAILABLE: discounted price ${discountedPrice} falls below owner-approved floor ${memberFloor} for member SKU '${skuId}'.`,
          );
        }
      }

      // 3. Check action-level proposed_price
      const actionProposedPrice =
        typeof validated.proposed_price === 'number' && Number.isFinite(validated.proposed_price)
          ? validated.proposed_price
          : typeof payload.proposed_price === 'number' && Number.isFinite(payload.proposed_price)
            ? payload.proposed_price
            : undefined;

      if (actionProposedPrice !== undefined && actionProposedPrice < memberFloor) {
        throw new OrchestratorError(
          'P_FLOOR_UNAVAILABLE',
          `P_FLOOR_UNAVAILABLE: action proposed price ${actionProposedPrice} falls below owner-approved floor ${memberFloor} for member SKU '${skuId}'.`,
        );
      }
    }

    return {
      ...validated,
      computed_price_floor: aggD.p_floor as number,
      floor_source: aggD.floor_source as string,
      ...(validated.proposed_price === undefined && typeof payload.proposed_price === 'number'
        ? { proposed_price: payload.proposed_price }
        : {}),
    };
  }
}

/**
 * Creates a Sales policy engine bound to the Sales policy registry, floor port, and durable audit boundary.
 */
export function createSalesPolicyEngine(options: CreateSalesPolicyEngineOptions = {}): SalesPolicyEngine {
  const durableAuditTarget = options.auditTrail ?? options.auditRepository;
  const policyAuditSink =
    options.audit === null
      ? undefined
      : options.audit ?? (durableAuditTarget ? createPolicyAuditSink(durableAuditTarget) : undefined);

  return new SalesPolicyEngine({
    ...options,
    ...(policyAuditSink ? { audit: policyAuditSink } : {}),
  });
}
