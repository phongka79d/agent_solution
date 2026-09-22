/**
 * @file Row `skill.sales.recommend_product` — cross-sell/upsell/substitute/bundle suggestions
 * conforming to the 7-field contract of FR-SAL-003. Transcribed from
 * `implement/05-skill-system-specifications.md` §4.2 skill 12 (lines 1389-1499); its effect class
 * and circuit-breaker key come from the §6.5 matrix, its baseline case outcomes from the §6.6 table.
 */

import { definePlatformRow, type PlatformRowSpec } from '../row.js';
import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';

/** Evidence half of a recommendation (§4.2 skill 12). */
export interface RecommendationEvidence {
  verified_timeline_event_ids: string[];
  verified_model: string;
  historical_spend?: number;
  category_affinity?: string;
}

/** Eligibility half of a recommendation (§4.2 skill 12). */
export interface RecommendationEligibility {
  stock_available: boolean;
  consent_verified: boolean;
  suppression_cleared: boolean;
}

/** Input of `skill.sales.recommend_product` (§4.2 skill 12). */
export interface InputSalesRecommendProduct {
  tenant_id: string;
  customer_id: string;
  current_cart_skus: string[];
  recommendation_type?: 'CROSS_SELL' | 'UPSELL' | 'SUBSTITUTE' | 'BUNDLE' | 'REPLENISHMENT';
}

/** Output of `skill.sales.recommend_product` (§4.2 skill 12), the FR-SAL-003 seven fields. */
export interface OutputSalesRecommendProduct {
  customer: string;
  product: { sku: string; name: string; price: number };
  reason: string;
  evidence: RecommendationEvidence;
  eligibility: RecommendationEligibility;
  confidence: number;
  expected_outcome: {
    conversion_probability: number;
    expected_revenue: number;
    currency: string;
  };
}

/** Immutable identifier of this row (§4.2 skill 12). */
export const SALES_RECOMMEND_PRODUCT_SKILL_ID = 'skill.sales.recommend_product';

/** Strict input schema of §4.2 skill 12, verbatim. */
const input_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['tenant_id', 'customer_id', 'current_cart_skus'],
  properties: {
    tenant_id: { type: 'string' },
    customer_id: { type: 'string' },
    current_cart_skus: { type: 'array', items: { type: 'string' } },
    recommendation_type: {
      type: 'string',
      enum: ['CROSS_SELL', 'UPSELL', 'SUBSTITUTE', 'BUNDLE', 'REPLENISHMENT'],
      default: 'CROSS_SELL',
    },
  },
  additionalProperties: false,
};

/** Output schema of §4.2 skill 12, verbatim (the FR-SAL-003 seven fields). */
const output_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: [
    'customer',
    'product',
    'reason',
    'evidence',
    'eligibility',
    'confidence',
    'expected_outcome',
  ],
  properties: {
    customer: { type: 'string' },
    product: {
      type: 'object',
      required: ['sku', 'name', 'price'],
      properties: {
        sku: { type: 'string' },
        name: { type: 'string' },
        price: { type: 'number' },
      },
    },
    reason: { type: 'string' },
    evidence: {
      type: 'object',
      required: ['verified_timeline_event_ids', 'verified_model'],
      properties: {
        verified_timeline_event_ids: { type: 'array', items: { type: 'string' } },
        verified_model: { type: 'string' },
        historical_spend: { type: 'number' },
        category_affinity: { type: 'string' },
      },
    },
    eligibility: {
      type: 'object',
      required: ['stock_available', 'consent_verified', 'suppression_cleared'],
      properties: {
        stock_available: { type: 'boolean' },
        consent_verified: { type: 'boolean' },
        suppression_cleared: { type: 'boolean' },
      },
    },
    confidence: { type: 'number', minimum: 0.0, maximum: 1.0 },
    expected_outcome: {
      type: 'object',
      required: ['conversion_probability', 'expected_revenue', 'currency'],
      properties: {
        conversion_probability: { type: 'number' },
        expected_revenue: { type: 'number' },
        currency: { type: 'string' },
      },
    },
  },
};

/** The declarative half of the row; `skill_id` is supplied by the factory (§4.2 skill 12). */
const spec: Omit<
  PlatformRowSpec,
  'skill_id'
> = {
  purpose:
    'Generates cross-sell/upsell/substitute/bundle suggestions conforming strictly to the 7-field contract of FR-SAL-003.',
  effect_class: 'READ',
  guarded_dependency: 'Core.RecommendationEngine',
  input_schema,
  output_schema,
  allowed_agents: ['SAL-02', 'SAL-03'],
  required_authority: 'AUTH-1',
  tool_binding: 'Core.RecommendationEngine',
  validation_rules: [
    'confidence score >= 0.65 threshold required to yield recommendation',
    'stock eligibility must be verified',
    'evidence must contain at least 1 verified timeline event ID from Customer 360 (FR-C360-002)',
  ],
  retry_policy: {
    max_retries: 2,
    initial_interval_ms: 500,
    backoff_multiplier: 1.5,
    retry_on_timeout: true,
    non_retryable_errors: ['EMPTY_CATALOG'],
  },
  timeout_ms: 2500,
  audit_spec: {
    log_level: 'INFO',
    mask_pii_fields: ['customer'],
    evidence_card: 'EV_SALES_RECOMMENDATION',
    record_latency: true,
  },
  test_cases: [
    {
      test_id: 'TC-SKILL-01',
      category: 'HAPPY_PATH',
      scenario:
        '`SAL-03` at `AUTH-1` requests a recommendation for a cart whose candidates are stock/consent eligible and carry at least one verified timeline id.',
      expected_outcome:
        'All 7 FR-SAL-003 fields, ≥1 verified timeline id, stock/consent eligible',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02',
      category: 'AUTHORITY',
      scenario:
        'The best candidate scores below the 0.65 threshold, and a second run has consent or eligibility unmet.',
      expected_outcome:
        'Score below threshold → explicit refusal, not a product; missing consent/eligibility → rejected before presentation',
      required: true,
    },
    {
      test_id: 'TC-SKILL-03',
      category: 'SCHEMA_INVALIDATION',
      scenario:
        'A payload missing `current_cart_skus` and a payload carrying an unknown `recommendation_type` are submitted.',
      expected_outcome:
        'Missing `current_cart_skus` or bad `recommendation_type` → `SCHEMA_VALIDATION_ERROR`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04',
      category: 'TIMEOUT',
      scenario:
        'Core.RecommendationEngine does not answer within the row timeout of 2500ms.',
      expected_outcome:
        'Engine error ≤2; exhaustion returns no recommendation (never a low-confidence substitute)',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05',
      category: 'IDEMPOTENCY',
      scenario:
        'The same `(customer_id, current_cart_skus, recommendation_type)` request is invoked twice.',
      expected_outcome:
        'Same cart/context → same candidate-set digest; nothing persisted as FACT',
      required: true,
    },
    {
      test_id: 'TC-SKILL-12-06',
      category: 'VALIDATION',
      scenario: 'Best candidate scores below the 0.65 confidence threshold.',
      expected_outcome:
        'No recommendation is returned (explicit refusal), not a low-confidence product.',
      required: true,
    },
    {
      test_id: 'TC-SKILL-12-07',
      category: 'VALIDATION',
      scenario:
        'Evidence lacks a verified Customer 360 timeline event id, or `consent_verified`/`suppression_cleared` is false.',
      expected_outcome:
        'The recommendation is rejected before presentation (FR-C360-002).',
      required: true,
    },
  ],
};

/**
 * Builds the `skill.sales.recommend_product` row (§4.2 skill 12).
 *
 * @param deps Injected tool port and clock; the row holds no ambient dependency.
 * @returns The row, with `validateInput` normalizing through its `input_schema` and `execute`
 *   dispatching `Core.RecommendationEngine` through the tool port.
 */
export function createSalesRecommendProduct(
  deps: PlatformSkillDependencies,
): PlatformSkillRow<InputSalesRecommendProduct, OutputSalesRecommendProduct> {
  return definePlatformRow<InputSalesRecommendProduct, OutputSalesRecommendProduct>(deps, {
    ...spec,
    skill_id: SALES_RECOMMEND_PRODUCT_SKILL_ID,
  });
}
