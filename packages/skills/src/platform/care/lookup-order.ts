/**
 * @file Row `skill.care.lookup_order` — order history, fulfillment status and items for support
 * inquiries, released only after a server-resolved identity check. Transcribed from
 * `implement/05-skill-system-specifications.md` §4.3 skill 17 (lines 1802-1891); its effect class and
 * circuit-breaker key come from the §6.5 matrix, its baseline case outcomes from the §6.6 table.
 */

import { definePlatformRow, type PlatformRowSpec } from '../row.js';
import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';

/** One order line item of `skill.care.lookup_order` (§4.3 skill 17). */
export interface OrderLineItemRecord {
  sku_id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  currency: string;
}

/** Input of `skill.care.lookup_order` (§4.3 skill 17). */
export interface InputCareLookupOrder {
  tenant_id: string;
  order_identifier: string;
  /** Server-resolved from the authenticated session; never caller-asserted. */
  customer_id: string;
  /** Resolved server-side to the identity-verification record; never trusted from the caller. */
  verification_reference: string;
  verification_status: 'VERIFIED';
}

/** Output of `skill.care.lookup_order` (§4.3 skill 17). */
export interface OutputCareLookupOrder {
  order_id: string;
  status: 'PENDING' | 'PROCESSING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'RETURNED';
  line_items: OrderLineItemRecord[];
  total_price: number;
  currency: string;
  tracking_number: string | null;
  order_date: string;
}

/** Immutable identifier of this row (§4.3 skill 17). */
export const CARE_LOOKUP_ORDER_SKILL_ID = 'skill.care.lookup_order';

/** Strict input schema of §4.3 skill 17, verbatim. */
const input_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: [
    'tenant_id',
    'order_identifier',
    'customer_id',
    'verification_reference',
    'verification_status',
  ],
  properties: {
    tenant_id: { type: 'string' },
    order_identifier: { type: 'string' },
    customer_id: {
      type: 'string',
      description:
        'Server-resolved from the authenticated customer session (§04); never caller-asserted (BR-003, NFR-008)',
    },
    verification_reference: {
      type: 'string',
      description:
        'Reference to the server-side identity-verification record for this session; resolved by the server, never trusted from the caller',
    },
    verification_status: {
      type: 'string',
      enum: ['VERIFIED'],
      description: 'Server-verified status; absent or non-VERIFIED fails closed',
    },
  },
  additionalProperties: false,
};

/** Output schema of §4.3 skill 17, verbatim. */
const output_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['order_id', 'status', 'line_items', 'total_price', 'currency', 'order_date'],
  properties: {
    order_id: { type: 'string' },
    status: {
      type: 'string',
      enum: ['PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED'],
    },
    line_items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['sku_id', 'product_name', 'quantity', 'unit_price', 'currency'],
        properties: {
          sku_id: { type: 'string' },
          product_name: { type: 'string' },
          quantity: { type: 'integer' },
          unit_price: { type: 'number' },
          currency: { type: 'string' },
        },
      },
    },
    total_price: { type: 'number' },
    currency: { type: 'string' },
    tracking_number: { type: ['string', 'null'] },
    order_date: { type: 'string', format: 'date-time' },
  },
};

/** The declarative half of the row; `skill_id` is supplied by the factory (§4.3 skill 17). */
const spec: Omit<PlatformRowSpec, 'skill_id'> = {
  purpose:
    'Looks up order history, fulfillment status, and items for customer support inquiries.',
  effect_class: 'READ',
  guarded_dependency: 'API-001.OrderConnector',
  input_schema,
  output_schema,
  allowed_agents: ['CS-01'],
  required_authority: 'AUTH-0',
  tool_binding: 'API-001.OrderConnector',
  validation_rules: [
    'customer_id must be server-resolved from the authenticated session and must match the order owner; a caller-supplied identity or verification claim is never accepted as a binding input (BR-003, NFR-008)',
    'verification_reference must resolve server-side to a verification record for this tenant/customer and verification_status must be VERIFIED; a missing, unresolvable, or non-VERIFIED reference fails closed with IDENTITY_UNVERIFIED and releases no order FACT',
  ],
  retry_policy: {
    max_retries: 3,
    initial_interval_ms: 400,
    backoff_multiplier: 1.5,
    retry_on_timeout: true,
    non_retryable_errors: ['ORDER_NOT_FOUND'],
  },
  timeout_ms: 2000,
  audit_spec: {
    log_level: 'INFO',
    mask_pii_fields: ['customer_id'],
    evidence_card: 'EV_ORDER_LOOKUP',
    record_latency: true,
  },
  test_cases: [
    {
      test_id: 'TC-SKILL-01',
      category: 'HAPPY_PATH',
      scenario:
        '`CS-01` at `AUTH-0` presents a server-resolved `customer_id` and a `verification_reference` that resolves to VERIFIED for the order owner.',
      expected_outcome: 'Verified identity → order, line items, tracking',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02',
      category: 'AUTHORITY',
      scenario:
        "A caller asserts another customer's order with a self-supplied identifier, and a `verification_reference` that does not resolve to VERIFIED is presented.",
      expected_outcome:
        'Caller-asserted identity or non-VERIFIED reference → `IDENTITY_UNVERIFIED`/`ORDER_OWNER_MISMATCH`; 0 order FACTs',
      required: true,
    },
    {
      test_id: 'TC-SKILL-03',
      category: 'SCHEMA_INVALIDATION',
      scenario: 'A lookup payload without `verification_status` is submitted.',
      expected_outcome: 'Missing `verification_status` → `SCHEMA_VALIDATION_ERROR`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04',
      category: 'TIMEOUT',
      scenario:
        'API-001.OrderConnector does not answer within the row timeout of 2000ms across the ≤3 retry budget.',
      expected_outcome:
        'Connector error ≤3 → `AUTHORITATIVE_SOURCE_UNAVAILABLE`; exhaustion refuses, never a partial order',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05',
      category: 'IDEMPOTENCY',
      scenario: 'The identical `(tenant_id, order_identifier, customer_id)` read is invoked twice.',
      expected_outcome: 'Read-only: identical result; no order mutation',
      required: true,
    },
    {
      test_id: 'TC-SKILL-17-06',
      category: 'SECURITY',
      scenario:
        "Caller asserts ownership of another customer's order, supplies a caller-asserted phone/email/identifier as proof, or presents a `verification_reference`/`verification_status` that does not resolve server-side to VERIFIED for the session's server-resolved `customer_id`.",
      expected_outcome:
        '`IDENTITY_UNVERIFIED` / `ORDER_OWNER_MISMATCH` before any `API-001.OrderConnector` call; zero order FACTs are released (BR-003, NFR-006). An unverified or caller-asserted identity never authorizes a lookup.',
      required: true,
    },
    {
      test_id: 'TC-SKILL-17-07',
      category: 'BOUNDARY',
      scenario: '`order_identifier` unknown to the tenant, or owned by a different customer.',
      expected_outcome:
        '`ORDER_NOT_FOUND`; the response never distinguishes "does not exist" from "not yours".',
      required: true,
    },
  ],
};

/**
 * Builds the `skill.care.lookup_order` row (§4.3 skill 17).
 *
 * @param deps Injected tool port and clock; the row holds no ambient dependency.
 * @returns The row, with `validateInput` normalizing through its `input_schema` and `execute`
 *   dispatching `API-001.OrderConnector` through the tool port.
 */
export function createCareLookupOrder(
  deps: PlatformSkillDependencies,
): PlatformSkillRow<InputCareLookupOrder, OutputCareLookupOrder> {
  return definePlatformRow<InputCareLookupOrder, OutputCareLookupOrder>(deps, {
    ...spec,
    skill_id: CARE_LOOKUP_ORDER_SKILL_ID,
  });
}
