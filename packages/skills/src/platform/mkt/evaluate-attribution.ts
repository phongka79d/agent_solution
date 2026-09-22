/**
 * @file `skill.mkt.evaluate_attribution` — Marketing row 7 of the platform registry, transcribed
 * verbatim from `implement/05` §4.1 (lines 1067-1128), with the effect class and guarded dependency
 * of the §6.5 matrix and this row's baseline outcomes from §6.6.
 *
 * The module is data plus its factory call: `definePlatformRow` supplies the single normalization
 * and the single dispatch route, so this row cannot validate less than its schema declares or reach
 * an adapter by another path. Enablement is deliberately absent — the gate decides it.
 */

import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';
import { definePlatformRow, type PlatformRowSpec } from '../row.js';

/** §4.1 field 3 `Input*` of the row, normalized: no property carries a JSON-Schema `default`. */
export interface InputMktEvaluateAttribution {
  tenant_id: string;
  campaign_id: string;
  attribution_model: 'FIRST_TOUCH' | 'LAST_TOUCH' | 'LINEAR' | 'DATA_DRIVEN';
}

/**
 * §4.1 field 4 `Output*` of the row. `cac` is optional because the JSON-Schema block lists it
 * outside `required`; an unavailable denominator yields no figure rather than a substituted one.
 */
export interface OutputMktEvaluateAttribution {
  campaign_id: string;
  attributed_revenue: number;
  attributed_orders: number;
  roas: number;
  cac?: number;
  calculated_at: string;
}

/** Canonical id of §4.1 skill 7: the immutable key every dispatch envelope resolves by. */
export const EVALUATE_ATTRIBUTION_SKILL_ID = 'skill.mkt.evaluate_attribution';

/** The §4.1 row without its id; {@link EVALUATE_ATTRIBUTION_SKILL_ID} is bound at construction. */
const spec: Omit<
  PlatformRowSpec,
  'skill_id'
> = {
  purpose: 'Calculates campaign conversion attribution, CAC, and ROAS.',
  effect_class: 'READ',
  guarded_dependency: 'PostgreSQL.AnalyticsStore',
  input_schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['tenant_id', 'campaign_id', 'attribution_model'],
    properties: {
      tenant_id: { type: 'string' },
      campaign_id: { type: 'string' },
      attribution_model: {
        type: 'string',
        enum: ['FIRST_TOUCH', 'LAST_TOUCH', 'LINEAR', 'DATA_DRIVEN'],
      },
    },
    additionalProperties: false,
  },
  output_schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['campaign_id', 'attributed_revenue', 'attributed_orders', 'roas', 'calculated_at'],
    properties: {
      campaign_id: { type: 'string' },
      attributed_revenue: { type: 'number' },
      attributed_orders: { type: 'integer' },
      roas: { type: 'number' },
      cac: { type: 'number' },
      calculated_at: { type: 'string', format: 'date-time' },
    },
  },
  allowed_agents: ['MKT-06'],
  required_authority: 'AUTH-1',
  tool_binding: 'PostgreSQL.AnalyticsStore',
  validation_rules: ['campaign_id must exist in campaigns table'],
  retry_policy: {
    max_retries: 2,
    initial_interval_ms: 1000,
    backoff_multiplier: 1.5,
    retry_on_timeout: true,
    non_retryable_errors: ['CAMPAIGN_NOT_FOUND'],
  },
  timeout_ms: 4000,
  audit_spec: {
    log_level: 'INFO',
    mask_pii_fields: [],
    evidence_card: 'EV_MKT_ATTRIBUTION',
    record_latency: true,
  },
  test_cases: [
    {
      test_id: 'TC-SKILL-01',
      category: 'HAPPY_PATH',
      scenario:
        'Valid input payload submitted by MKT-06 holding an AUTH-1 grant for an existing tenant campaign; the analytics query answers inside the declared deadline.',
      expected_outcome: 'Existing tenant campaign → ROAS/CAC figures',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02',
      category: 'AUTHORITY',
      scenario:
        'An `AUTH-0` grant is presented against the `AUTH-1` requirement, or the campaign belongs to another tenant.',
      expected_outcome:
        '`AUTH-0` → `INSUFFICIENT_AUTHORITY`; other-tenant campaign → `CAMPAIGN_NOT_FOUND` with 0 rows',
      required: true,
    },
    {
      test_id: 'TC-SKILL-03',
      category: 'SCHEMA_INVALIDATION',
      scenario:
        'Input missing `campaign_id` or `attribution_model`, or carrying an illegal extra property.',
      expected_outcome:
        'Unknown `attribution_model` → `SCHEMA_VALIDATION_ERROR` pre-query',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04',
      category: 'TIMEOUT',
      scenario: 'The bound `PostgreSQL.AnalyticsStore` query hangs past `timeout_ms` of 4000ms.',
      expected_outcome: 'Query error ≤2; exhaustion returns no partial metrics',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05',
      category: 'IDEMPOTENCY',
      scenario: 'The identical attribution request is submitted twice.',
      expected_outcome: 'Read-only: identical figures; no duplicated metric row',
      required: true,
    },
    {
      test_id: 'TC-SKILL-07-06',
      category: 'VALIDATION',
      scenario: '`campaign_id` unknown to the tenant.',
      expected_outcome:
        '`CAMPAIGN_NOT_FOUND` (non-retryable); no attribution figures are returned.',
      required: true,
    },
    {
      test_id: 'TC-SKILL-07-07',
      category: 'BOUNDARY',
      scenario: '`attribution_model` outside the declared enum.',
      expected_outcome: '`SCHEMA_VALIDATION_ERROR` before the analytics query; no partial metrics.',
      required: true,
    },
  ],
};

/**
 * Builds the §4.1 skill 7 row.
 *
 * @param deps The injected tool port and clock; the row holds no ambient dependency.
 * @returns The `skill.mkt.evaluate_attribution` row, without an `enabled` flag — the gate owns that.
 */
export function createMktEvaluateAttribution(
  deps: PlatformSkillDependencies,
): PlatformSkillRow<InputMktEvaluateAttribution, OutputMktEvaluateAttribution> {
  return definePlatformRow<InputMktEvaluateAttribution, OutputMktEvaluateAttribution>(deps, {
    ...spec,
    skill_id: EVALUATE_ATTRIBUTION_SKILL_ID,
  });
}
