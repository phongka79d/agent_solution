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
  type AutonomyAdmissionPort,
  type ConsentSource,
  type ConsentState,
  type PolicyEnforcementOptions,
  type PolicyEnforcementPoint,
} from '@agentos/core-engine';
import {
  PLATFORM_SKILL_ROWS,
  payloadFieldsForRows,
  policyRegistryForRows,
} from '@agentos/skills';
import type { AuditRepository } from '@agentos/database';

import { DomainPolicyEngine } from '../shared/policy-engine.js';
import { createPolicyAuditSink } from '../shared/policy-audit.js';
import type {
  SalesAggregatePriceFloorQuery,
  SalesConsentPort,
  SalesPriceFloorDecision,
  SalesPriceFloorPort,
} from './skills/types.js';

const SALES_POLICY_ROWS = PLATFORM_SKILL_ROWS.filter((row) => row.domain === 'sales');
export const SALES_ALLOWED_PAYLOAD_FIELDS = payloadFieldsForRows(SALES_POLICY_ROWS);
export const SALES_SKILLS = policyRegistryForRows(SALES_POLICY_ROWS);

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
  readonly autonomy?: AutonomyAdmissionPort | undefined;
  readonly resolveGrant?: ((tenant_id: string, agent_id: string) => Promise<AssignableAuthority | null>) | undefined;
  readonly approvals?: ApprovalQueuePort | undefined;
  readonly auditSecret?: string | undefined;
  readonly audit?: PolicyEnforcementOptions['audit'] | null | undefined;
  readonly now?: (() => Date) | undefined;
  readonly normalizeActionInput?: IPolicyEngine['normalizeActionInput'];
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
      ...(options.normalizeActionInput === undefined ? {} : { normalizeActionInput: options.normalizeActionInput }),
      ...(options.pep ? { pep: options.pep } : {}),
      ...(options.resolveGrant ? { resolveGrant: options.resolveGrant } : {}),
      defaultGrant: defaultSalesGrant,
      ...(options.approvals ? { approvals: options.approvals } : {}),
      ...(options.autonomy ? { autonomy: options.autonomy } : {}),
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

    const hasItemPrice =
      Array.isArray(payload.items) &&
      payload.items.some((item) =>
        typeof item === 'object' &&
        item !== null &&
        (
          'proposed_price' in item ||
          'price' in item ||
          'discount_percent' in item
        ));
    const isDiscountSensitive =
      payload.offer_id !== undefined ||
      payload.discount_amount !== undefined ||
      payload.discount_percent !== undefined ||
      payload.proposed_price !== undefined ||
      hasItemPrice ||
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
    const actionProposedPrice =
      typeof validated.proposed_price === 'number' && Number.isFinite(validated.proposed_price)
        ? validated.proposed_price
        : typeof payload.proposed_price === 'number' && Number.isFinite(payload.proposed_price)
          ? payload.proposed_price
          : undefined;

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

      if (actionProposedPrice !== undefined && actionProposedPrice < d.p_floor) {
        throw new OrchestratorError(
          'P_FLOOR_UNAVAILABLE',
          `P_FLOOR_UNAVAILABLE: proposed price ${actionProposedPrice} falls below owner-approved floor ${d.p_floor} for SKU '${singleSku}'.`,
        );
      }

      if (Array.isArray(payload.items)) {
        for (const item of payload.items) {
          if (typeof item !== 'object' || item === null) continue;
          const line = item as Record<string, unknown>;
          const linePrice =
            typeof line.proposed_price === 'number' && Number.isFinite(line.proposed_price)
              ? line.proposed_price
              : typeof line.price === 'number' && Number.isFinite(line.price)
                ? line.price
                : undefined;
          if (linePrice !== undefined && linePrice < d.p_floor) {
            throw new OrchestratorError(
              'P_FLOOR_UNAVAILABLE',
              `P_FLOOR_UNAVAILABLE: proposed price ${linePrice} falls below owner-approved floor ${d.p_floor} for SKU '${singleSku}'.`,
            );
          }
        }
      }

      const discountPercent =
        typeof payload.discount_percent === 'number' && Number.isFinite(payload.discount_percent)
          ? payload.discount_percent
          : undefined;
      if (
        actionProposedPrice === undefined &&
        typeof discountPercent === 'number' &&
        typeof d.list_price === 'number' &&
        Number.isFinite(d.list_price) &&
        d.list_price * (1 - discountPercent / 100) < d.p_floor
      ) {
        throw new OrchestratorError(
          'P_FLOOR_UNAVAILABLE',
          `P_FLOOR_UNAVAILABLE: discounted price falls below owner-approved floor ${d.p_floor} for SKU '${singleSku}'.`,
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
