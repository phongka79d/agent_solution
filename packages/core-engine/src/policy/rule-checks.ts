/**
 * @file Trusted-input policy checks used by the PolicyEnforcementPoint façade.
 *
 * These helpers have no evaluator state of their own. Ports and server-bound values are explicit
 * inputs, which keeps each check fail-closed and keeps the façade's stage ordering visible.
 */

import type {
  AuthoritativeCatalogRecord,
  AuthoritativeSourcePort,
  FloorDecision,
  PolicyActionProposal,
  PolicyRegistryPort,
  PolicyRuleId,
  PolicySecurityContext,
  PriceFloorSource,
  TenantPolicySource,
} from './types.js';
import {
  AUTONOMY_LIMITS,
  CATALOG_REFERENCE_FIELDS,
  CUSTOMER_ASSERTION_FIELDS,
  EFFECTIVE_PRICE_FIELDS,
  TENANT_ASSERTION_FIELDS,
  TARGET_AGENT_FIELDS,
  deny,
  readNumberField,
  readStringField,
  stringValue,
} from './payload-readers.js';
import type { PolicyDenial } from './payload-readers.js';

export interface ApprovalRouteRequest {
  readonly kind: 'ROUTE';
  readonly decisionCode: 'REQUIRE_HUMAN_APPROVAL' | 'LIMIT_EXCEEDED';
  readonly ruleId: PolicyRuleId;
  readonly reason: string;
}

/**
 * Refuses any payload-asserted identity and any direct agent-to-agent target. Trusted identity
 * arrives only through `PolicySecurityContext`; a payload that names a tenant or customer can
 * neither widen nor replace it (SRS §19, NFR-006, BR-003).
 *
 * @param context - Server-bound context.
 * @param proposal - Proposal whose payload may carry assertions.
 * @param registry - Server registry used for peer-agent topology checks.
 * @returns A refusal, or `null` when the payload asserts nothing contradictory.
 */
export function checkBinding(
  context: PolicySecurityContext,
  proposal: PolicyActionProposal,
  registry: PolicyRegistryPort,
): PolicyDenial | null {
  const tenantAssertion = readStringField(proposal.payload, TENANT_ASSERTION_FIELDS);

  if (
    tenantAssertion.state === 'INVALID'
    || (tenantAssertion.state === 'VALID' && tenantAssertion.value !== context.tenant_id.trim())
  ) {
    return deny(
      'PEP-BINDING',
      'CROSS_TENANT_ASSERTION',
      'CROSS_TENANT_ASSERTION: the payload asserts a tenant that is not the bound tenant; the '
        + 'server-resolved binding is the only identity and never a payload value (NFR-006).',
    );
  }

  const customerAssertion = readStringField(proposal.payload, CUSTOMER_ASSERTION_FIELDS);

  if (customerAssertion.state !== 'ABSENT') {
    const bound = context.verified_customer_id?.trim() ?? '';

    if (customerAssertion.state === 'INVALID' || customerAssertion.value !== bound) {
      return deny(
        'PEP-BINDING',
        'CROSS_CUSTOMER_ASSERTION',
        'CROSS_CUSTOMER_ASSERTION: the payload asserts a customer the session is not '
          + 'server-verified as; a claimed identifier or flag is never an identity (BR-003, '
          + 'NFR-006).',
      );
    }
  }

  const target = proposal.target_agent_id?.trim()
    ?? stringValue(proposal.payload, TARGET_AGENT_FIELDS)
    ?? '';

  if (
    target.length > 0
    && target !== context.agent_id.trim()
    && registry.getAgent(target, context.tenant_id) !== undefined
  ) {
    return deny(
      'PEP-TOPOLOGY',
      'AGENT_TO_AGENT_FORBIDDEN',
      `AGENT_TO_AGENT_FORBIDDEN: '${target}' is a registered peer agent and peer invocation is a `
        + 'topology violation; routing belongs to the supervisor (`02` §2).',
    );
  }

  return null;
}

/**
 * Applies BR-001..BR-003 to a price-bearing action: the price must be traceable to an
 * authenticated catalog reference that resolves in the System of Record, the floor decision must
 * be owner-approved and provenance-bearing, and the effective price must respect that floor.
 *
 * @param params - Bound tenant, skill id, payload and trusted price ports.
 * @returns A refusal, or `null` when the price intent is fully traceable and within the floor.
 */
export async function checkPrice(params: {
  readonly tenant_id: string;
  readonly skill_id: string;
  readonly mutating: boolean;
  readonly payload: Record<string, unknown>;
  readonly authoritativeSource: AuthoritativeSourcePort | undefined;
  readonly priceFloor: PriceFloorSource | undefined;
}): Promise<PolicyDenial | null> {
  const reference = readStringField(params.payload, CATALOG_REFERENCE_FIELDS);

  if (reference.state !== 'VALID') {
    return deny(
      'BR-001',
      'ERR_ARBITRARY_PRICING',
      `ERR_ARBITRARY_PRICING: price-bearing skill ${params.skill_id} carries no usable catalog `
        + 'reference id, and a price that is not traceable to the catalog is never invented '
        + '(BR-001, SRS §13).',
    );
  }
  const effective = readNumberField(params.payload, EFFECTIVE_PRICE_FIELDS);

  if (params.mutating && effective.state === 'ABSENT') {
    return deny(
      'BR-001',
      'ERR_ARBITRARY_PRICING',
      `ERR_ARBITRARY_PRICING: mutating price-bearing skill ${params.skill_id} carries no effective `
        + 'price, so the price intent cannot be traced to an approved floor (BR-001, SRS §13).',
    );
  }

  if (params.authoritativeSource === undefined) {
    return deny(
      'BR-003',
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'AUTHORITATIVE_SOURCE_UNAVAILABLE: no System-of-Record reader is injected, so the catalog '
        + 'reference cannot be authenticated and the price is refused rather than assumed '
        + '(BR-003).',
    );
  }

  let record: AuthoritativeCatalogRecord | undefined;

  try {
    record = await params.authoritativeSource.resolveCatalogReference({
      tenant_id: params.tenant_id,
      catalog_ref_id: reference.value,
    });
  } catch {
    return deny(
      'BR-003',
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'AUTHORITATIVE_SOURCE_UNAVAILABLE: the System of Record could not be reached, so no price '
        + 'or stock may be claimed and no cached value may stand in for it (BR-003, NFR-008).',
    );
  }

  if (record === undefined || record.catalog_ref_id !== reference.value) {
    return deny(
      'BR-001',
      'ERR_ARBITRARY_PRICING',
      `ERR_ARBITRARY_PRICING: catalog reference '${reference.value}' does not resolve in the `
        + 'System of Record; a well-formed but unknown reference is treated exactly like a '
        + 'missing one (BR-001).',
    );
  }

  if (params.priceFloor === undefined) {
    return deny(
      'BR-001',
      'P_FLOOR_UNAVAILABLE',
      `P_FLOOR_UNAVAILABLE: no owner-approved floor source is available for `
        + `${reference.value}, and a price-bearing action never dispatches without a floor `
        + 'decision (BR-001, §7.3).',
    );
  }

  let floor: FloorDecision | undefined;

  try {
    floor = await params.priceFloor.getFloorDecision({
      tenant_id: params.tenant_id,
      catalog_ref_id: reference.value,
    });
  } catch {
    floor = undefined;
  }

  if (
    floor === undefined
    || floor.owner_approved !== true
    || floor.floor_source.trim().length === 0
    || !Number.isFinite(floor.floor_price)
  ) {
    return deny(
      'BR-001',
      'P_FLOOR_UNAVAILABLE',
      `P_FLOOR_UNAVAILABLE: the floor decision for ${reference.value} is missing, unapproved or `
        + 'carries no provenance; an owner decision is required and no local computation or '
        + 'approval can substitute for it (BR-001, §7.3).',
    );
  }


  if (effective.state === 'INVALID') {
    return deny(
      'BR-002',
      'POLICY_INPUT_INVALID',
      'POLICY_INPUT_INVALID: the effective price must be a finite number; a malformed price is '
        + 'never rounded, defaulted or dropped from the floor check (BR-002).',
    );
  }

  if (effective.state === 'VALID' && effective.value < floor.floor_price) {
    return deny(
      'BR-002',
      'ERR_FLOOR_PRICE_VIOLATION',
      `ERR_FLOOR_PRICE_VIOLATION: the effective price ${effective.value} is below the approved `
        + `floor ${floor.floor_price} for ${reference.value}; the floor is immutable and human `
        + 'approval cannot waive it (BR-002).',
    );
  }

  return null;
}

/**
 * Applies BR-007 to the payload's governed members: an action above an approved autonomy limit
 * routes to the approval gate, and an action whose governing limit the owner has not approved
 * routes there too — an unset limit is not "unlimited" (implement/08 §1.1, §7.3).
 *
 * @param params - Bound tenant, payload and owner-approved autonomy source.
 * @returns An approval route request, or `null` when every present governed member is within an
 *   approved limit.
 */
export function checkAutonomyLimits(params: {
  readonly tenant_id: string;
  readonly payload: Record<string, unknown>;
  readonly tenantPolicy: TenantPolicySource | undefined;
}): ApprovalRouteRequest | null {
  const parameters = params.tenantPolicy?.get(params.tenant_id);

  for (const limit of AUTONOMY_LIMITS) {
    const governed = readNumberField(params.payload, limit.fields);

    if (governed.state === 'ABSENT') {
      continue;
    }

    if (governed.state === 'INVALID') {
      return {
        kind: 'ROUTE',
        decisionCode: 'REQUIRE_HUMAN_APPROVAL',
        ruleId: 'BR-007',
        reason: `REQUIRE_HUMAN_APPROVAL: the governed member ${limit.fields[0]} is present but not `
          + 'a finite number, so no autonomy limit can bound the action; it is routed to a human '
          + 'instead of being interpreted or defaulted (BR-007, NFR-008).',
      };
    }

    const approved = parameters?.[limit.parameter];

    if (approved === undefined || !Number.isFinite(approved)) {
      return {
        kind: 'ROUTE',
        decisionCode: 'REQUIRE_HUMAN_APPROVAL',
        ruleId: 'BR-007',
        reason: `REQUIRE_HUMAN_APPROVAL: the tenant has approved no ${limit.parameter} value, and `
          + 'an unset autonomy limit is not unlimited — the action is routed to the approval gate '
          + 'rather than executed (BR-007, NFR-008).',
      };
    }

    if (governed.value > approved) {
      return {
        kind: 'ROUTE',
        decisionCode: 'LIMIT_EXCEEDED',
        ruleId: 'BR-007',
        reason: `LIMIT_EXCEEDED: ${limit.fields[0]}=${governed.value} exceeds the approved `
          + `${limit.parameter}=${approved}; the action is prepared for human approval instead of `
          + 'being executed autonomously (BR-007).',
      };
    }
  }

  return null;
}
