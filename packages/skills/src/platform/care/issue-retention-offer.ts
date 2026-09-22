/**
 * @file Row `skill.care.issue_retention_offer` — retention voucher or ECN-004 price-protection
 * payout behind the `PromotionEngine.FloorPriceGuard`. Transcribed from
 * `implement/05-skill-system-specifications.md` §4.3 skill 23 (lines 2256-2358); its effect class and
 * circuit-breaker key come from the §6.5 matrix, its baseline case outcomes from the §6.6 table.
 */

import { definePlatformRow, type PlatformRowSpec } from '../row.js';
import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';

/** Price-protection input block of `skill.care.issue_retention_offer` (§4.3 skill 23). */
export interface PriceProtectionDetails {
  original_order_id: string;
  eligible_sku: string;
  historical_price: number;
  new_price: number;
}

/** Input of `skill.care.issue_retention_offer` (§4.3 skill 23). */
export interface InputCareIssueRetentionOffer {
  tenant_id: string;
  customer_id: string;
  offer_scenario: 'CART_RETENTION_VOUCHER' | 'PRICE_PROTECTION_14D_ECN_004';
  target_cart_id?: string;
  max_discount_value?: number;
  price_protection_details?: PriceProtectionDetails;
  effect_key: string;
}

/** Output of `skill.care.issue_retention_offer` (§4.3 skill 23). */
export interface OutputCareIssueRetentionOffer {
  offer_id: string;
  offer_scenario: 'CART_RETENTION_VOUCHER' | 'PRICE_PROTECTION_14D_ECN_004';
  voucher_code: string;
  compensation_amount: number;
  price_protection_payout?: {
    original_order_id: string;
    eligible_sku: string;
    price_difference: number;
    payout_method: 'STORE_CREDIT' | 'REFUND_TO_CARD' | 'COMPENSATION_VOUCHER';
  };
  currency: string;
  expires_at: string;
  effect_key: string;
}

/** Immutable identifier of this row (§4.3 skill 23). */
export const CARE_ISSUE_RETENTION_OFFER_SKILL_ID = 'skill.care.issue_retention_offer';

/** Strict input schema of §4.3 skill 23, verbatim. */
const input_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['tenant_id', 'customer_id', 'offer_scenario', 'effect_key'],
  properties: {
    tenant_id: { type: 'string' },
    customer_id: { type: 'string' },
    offer_scenario: {
      type: 'string',
      enum: ['CART_RETENTION_VOUCHER', 'PRICE_PROTECTION_14D_ECN_004'],
    },
    target_cart_id: { type: 'string' },
    max_discount_value: { type: 'number', minimum: 1 },
    price_protection_details: {
      type: 'object',
      required: ['original_order_id', 'eligible_sku', 'historical_price', 'new_price'],
      properties: {
        original_order_id: { type: 'string' },
        eligible_sku: { type: 'string' },
        historical_price: { type: 'number' },
        new_price: { type: 'number' },
      },
    },
    effect_key: { type: 'string' },
  },
  additionalProperties: false,
};

/** Output schema of §4.3 skill 23, verbatim. */
const output_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: [
    'offer_id',
    'offer_scenario',
    'voucher_code',
    'compensation_amount',
    'currency',
    'expires_at',
    'effect_key',
  ],
  properties: {
    offer_id: { type: 'string' },
    offer_scenario: {
      type: 'string',
      enum: ['CART_RETENTION_VOUCHER', 'PRICE_PROTECTION_14D_ECN_004'],
    },
    voucher_code: { type: 'string' },
    compensation_amount: { type: 'number' },
    price_protection_payout: {
      type: 'object',
      properties: {
        original_order_id: { type: 'string' },
        eligible_sku: { type: 'string' },
        price_difference: { type: 'number' },
        payout_method: {
          type: 'string',
          enum: ['STORE_CREDIT', 'REFUND_TO_CARD', 'COMPENSATION_VOUCHER'],
        },
      },
    },
    currency: { type: 'string' },
    expires_at: { type: 'string', format: 'date-time' },
    effect_key: { type: 'string' },
  },
};

/** The declarative half of the row; `skill_id` is supplied by the factory (§4.3 skill 23). */
const spec: Omit<
  PlatformRowSpec,
  'skill_id'
> = {
  purpose:
    'Generates automated retention voucher within authorized tenant budget, or issues 14-day price protection compensation (ECN-004).',
  effect_class: 'EFFECT',
  guarded_dependency: 'PromotionEngine.FloorPriceGuard',
  input_schema,
  output_schema,
  allowed_agents: ['CS-02'],
  required_authority: 'AUTH-3',
  tool_binding: 'PromotionEngine.FloorPriceGuard',
  validation_rules: [
    'voucher must not reduce cart subtotal below P_floor (BR-001, BR-002)',
    'customer cannot receive > 1 retention offer per 30 days',
    'for PRICE_PROTECTION_14D_ECN_004 original_order_id must be within 14 days and historical_price > new_price',
  ],
  retry_policy: {
    max_retries: 1,
    initial_interval_ms: 1000,
    backoff_multiplier: 1.0,
    retry_on_timeout: false,
    non_retryable_errors: [
      'RETENTION_QUOTA_EXCEEDED',
      'ERR_FLOOR_PRICE_VIOLATION',
      'ORDER_OUTSIDE_14D_WINDOW',
    ],
  },
  timeout_ms: 3000,
  audit_spec: {
    log_level: 'INFO',
    mask_pii_fields: ['customer_id'],
    evidence_card: 'EV_RETENTION_VOUCHER',
    record_latency: true,
  },
  test_cases: [
    {
      test_id: 'TC-SKILL-01',
      category: 'HAPPY_PATH',
      scenario:
        '`CS-02` at `AUTH-3` requests a voucher with an owner-approved, provenance-bearing floor decision present and the 30-day quota unspent.',
      expected_outcome: 'One voucher under an owner-approved floor decision; quota consumed once',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02',
      category: 'AUTHORITY',
      scenario:
        'One request below the floor, one with no floor decision, and one that is the second offer inside 30 days.',
      expected_outcome:
        'Below floor → `ERR_FLOOR_PRICE_VIOLATION`; floor decision missing → `P_FLOOR_UNAVAILABLE`; second offer inside 30 days → `RETENTION_QUOTA_EXCEEDED`; 0 vouchers',
      required: true,
    },
    {
      test_id: 'TC-SKILL-03',
      category: 'SCHEMA_INVALIDATION',
      scenario: 'A payload with a bad `offer_scenario` and a negative `max_discount_value`.',
      expected_outcome:
        'Bad `offer_scenario` or negative `max_discount_value` → `SCHEMA_VALIDATION_ERROR` / `EFFECT_KEY_REQUIRED`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04',
      category: 'TIMEOUT',
      scenario:
        'PromotionEngine.FloorPriceGuard accepts the issue but the response is lost past the row timeout of 3000ms.',
      expected_outcome:
        '`EFFECT_UNKNOWN`; reconcile by `effect_key`; the quota is not double-consumed',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05',
      category: 'IDEMPOTENCY',
      scenario:
        'Identical `effect_key` with an identical payload is replayed after the offer was issued.',
      expected_outcome:
        'Same key + same payload → `REPLAY` with the same `offer_id`/`voucher_code`; quota consumed exactly once',
      required: true,
    },
    {
      test_id: 'TC-SKILL-23-06',
      category: 'VALIDATION',
      scenario:
        'Voucher that would take the cart subtotal below `P_floor`, or a second offer inside the 30-day quota.',
      expected_outcome:
        '`ERR_FLOOR_PRICE_VIOLATION` / `RETENTION_QUOTA_EXCEEDED` (non-retryable); no voucher is issued (BR-001, BR-002).',
      required: true,
    },
    {
      test_id: 'TC-SKILL-23-07',
      category: 'IDEMPOTENCY',
      scenario: 'Identical `effect_key` replayed after the offer was issued.',
      expected_outcome:
        'The same `offer_id`/`voucher_code` is returned and the 30-day quota is consumed exactly once.',
      required: true,
    },
  ],
};

/**
 * Builds the `skill.care.issue_retention_offer` row (§4.3 skill 23).
 *
 * @param deps Injected tool port and clock; the row holds no ambient dependency.
 * @returns The row, with `validateInput` normalizing through its `input_schema` and `execute`
 *   dispatching `PromotionEngine.FloorPriceGuard` through the tool port.
 */
export function createCareIssueRetentionOffer(
  deps: PlatformSkillDependencies,
): PlatformSkillRow<InputCareIssueRetentionOffer, OutputCareIssueRetentionOffer> {
  return definePlatformRow<InputCareIssueRetentionOffer, OutputCareIssueRetentionOffer>(deps, {
    ...spec,
    skill_id: CARE_ISSUE_RETENTION_OFFER_SKILL_ID,
  });
}
