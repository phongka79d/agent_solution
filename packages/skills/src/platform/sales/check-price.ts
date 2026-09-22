/**
 * @file Row `skill.sales.check_price` — list price, eligible tier discounts, and the mathematical
 * floor-price invariant (BR-001, BR-002). Transcribed from
 * `implement/05-skill-system-specifications.md` §4.2 skill 10 (lines 1261-1327); its effect class
 * and circuit-breaker key come from the §6.5 matrix, its baseline case outcomes from the §6.6 table.
 */

import { definePlatformRow, type PlatformRowSpec } from '../row.js';
import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';

/** Input of `skill.sales.check_price` (§4.2 skill 10). */
export interface InputSalesCheckPrice {
  tenant_id: string;
  sku_id: string;
  customer_id: string;
  requested_discount_percent?: number;
}

/** Output of `skill.sales.check_price` (§4.2 skill 10). */
export interface OutputSalesCheckPrice {
  sku_id: string;
  list_price: number;
  final_price: number;
  p_floor: number;
  discount_allowed: boolean;
  currency: string;
  quote_token: string;
  quote_expires_at: string;
}

/** Immutable identifier of this row (§4.2 skill 10). */
export const SALES_CHECK_PRICE_SKILL_ID = 'skill.sales.check_price';

/** Strict input schema of §4.2 skill 10, verbatim. */
const input_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['tenant_id', 'sku_id', 'customer_id'],
  properties: {
    tenant_id: { type: 'string' },
    sku_id: { type: 'string' },
    customer_id: { type: 'string' },
    requested_discount_percent: { type: 'number', minimum: 0, maximum: 100 },
  },
  additionalProperties: false,
};

/** Output schema of §4.2 skill 10, verbatim. */
const output_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: [
    'sku_id',
    'list_price',
    'final_price',
    'p_floor',
    'discount_allowed',
    'currency',
    'quote_token',
    'quote_expires_at',
  ],
  properties: {
    sku_id: { type: 'string' },
    list_price: { type: 'number' },
    final_price: { type: 'number' },
    p_floor: { type: 'number' },
    discount_allowed: { type: 'boolean' },
    currency: { type: 'string' },
    quote_token: { type: 'string' },
    quote_expires_at: { type: 'string', format: 'date-time' },
  },
};

/** The declarative half of the row; `skill_id` is supplied by the factory (§4.2 skill 10). */
const spec: Omit<PlatformRowSpec, 'skill_id'> = {
  purpose:
    'Evaluates official list price, eligible tier discounts, and enforces mathematical floor price $P_{floor}$ (BR-001, BR-002).',
  effect_class: 'READ',
  guarded_dependency: 'API-001.PricingEngine',
  input_schema,
  output_schema,
  allowed_agents: ['SAL-02', 'SAL-04'],
  required_authority: 'AUTH-3',
  tool_binding: 'API-001.PricingEngine',
  validation_rules: [
    'final_price >= p_floor invariant must hold 100%',
    'customer tier must be validated',
    'quote_token must be HMAC-SHA256 signed with secret',
  ],
  retry_policy: {
    max_retries: 3,
    initial_interval_ms: 400,
    backoff_multiplier: 1.5,
    retry_on_timeout: true,
    non_retryable_errors: ['INVALID_SKU'],
  },
  timeout_ms: 2000,
  audit_spec: {
    log_level: 'INFO',
    mask_pii_fields: ['customer_id'],
    evidence_card: 'EV_PRICE_CALCULATION',
    record_latency: true,
  },
  test_cases: [
    {
      test_id: 'TC-SKILL-01',
      category: 'HAPPY_PATH',
      scenario:
        '`SAL-02` at `AUTH-3` requests a price for a `sku_id`/`customer_id` pair whose owner-approved floor decision is present.',
      expected_outcome:
        'Owner-approved floor decision present → `final_price ≥ p_floor`, signed quote token',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02',
      category: 'AUTHORITY',
      scenario:
        'A quote is requested with the floor decision missing or unapproved, then with a discount that breaches the floor; a later run holds only `AUTH-2`.',
      expected_outcome:
        "Floor missing/unapproved → `P_FLOOR_UNAVAILABLE` (no quote); floor breach → `discount_allowed=false` / `ERR_FLOOR_PRICE_VIOLATION`; `AUTH-2` → `INSUFFICIENT_AUTHORITY`; above the tenant's approved autonomous discount ceiling → AUTH-4 route, never a floor bypass",
      required: true,
    },
    {
      test_id: 'TC-SKILL-03',
      category: 'SCHEMA_INVALIDATION',
      scenario:
        '`requested_discount_percent` outside [0,100] is submitted, and a payload misses `sku_id` or `customer_id`.',
      expected_outcome:
        'Percentage outside [0,100] or missing SKU/customer → `SCHEMA_VALIDATION_ERROR`; [0,100] is a percentage domain, not an approved policy limit',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04',
      category: 'TIMEOUT',
      scenario:
        'API-001.PricingEngine does not answer within the row timeout of 2000ms.',
      expected_outcome:
        '`AUTHORITATIVE_SOURCE_UNAVAILABLE` after ≤3; exhaustion issues no quote rather than a cached price',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05',
      category: 'IDEMPOTENCY',
      scenario:
        'The identical price request (same payload and key) is replayed while the signed quote is valid.',
      expected_outcome:
        'Same payload/key returns original signed result while valid; expiration requires source/policy revalidation, not a second purchase effect',
      required: true,
    },
    {
      test_id: 'TC-SKILL-10-06',
      category: 'VALIDATION',
      scenario:
        '`requested_discount_percent` that would push `final_price` below `p_floor`.',
      expected_outcome:
        '`final_price >= p_floor` holds in every response: the floor-breach attempt yields `discount_allowed = false`, never a discounted price (BR-001, BR-002).',
      required: true,
    },
    {
      test_id: 'TC-SKILL-10-07',
      category: 'SECURITY',
      scenario:
        "`quote_token` tampered with, or signed under another tenant's secret.",
      expected_outcome:
        'Signature verification fails and the quote is refused; the order step never accepts the token.',
      required: true,
    },
  ],
};

/**
 * Builds the `skill.sales.check_price` row (§4.2 skill 10).
 *
 * @param deps Injected tool port and clock; the row holds no ambient dependency.
 * @returns The row, with `validateInput` normalizing through its `input_schema` and `execute`
 *   dispatching `API-001.PricingEngine` through the tool port.
 */
export function createSalesCheckPrice(
  deps: PlatformSkillDependencies,
): PlatformSkillRow<InputSalesCheckPrice, OutputSalesCheckPrice> {
  return definePlatformRow<InputSalesCheckPrice, OutputSalesCheckPrice>(deps, {
    ...spec,
    skill_id: SALES_CHECK_PRICE_SKILL_ID,
  });
}
