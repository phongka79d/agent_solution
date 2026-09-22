/**
 * @file `skill.mkt.segment_audience` — Marketing row 2 of the platform registry, transcribed
 * verbatim from `implement/05` §4.1 (lines 713-771), with the effect class and guarded dependency
 * of the §6.5 matrix and this row's baseline outcomes from §6.6.
 *
 * The module is data plus its factory call: `definePlatformRow` supplies the single normalization
 * and the single dispatch route, so this row cannot validate less than its schema declares or reach
 * an adapter by another path. Enablement is deliberately absent — the gate decides it.
 */

import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';
import { definePlatformRow, type PlatformRowSpec } from '../row.js';

/**
 * §4.1 field 3 `Input*` of the row, normalized: `max_segment_size` carries a JSON-Schema `default`
 * and is therefore optional — an absent value is defaulted by the schema, never invented here.
 */
export interface InputMktSegmentAudience {
  tenant_id: string;
  rfm_criteria: 'CHAMPIONS' | 'LOYAL' | 'POTENTIAL_LOYALIST' | 'AT_RISK' | 'HIBERNATING';
  min_days_inactive: number;
  max_segment_size?: number;
}

/** §4.1 field 4 `Output*` of the row. */
export interface OutputMktSegmentAudience {
  segment_id: string;
  matched_customer_count: number;
  customer_ids: string[];
  generated_at: string;
}

/** Canonical id of §4.1 skill 2: the immutable key every dispatch envelope resolves by. */
export const SEGMENT_AUDIENCE_SKILL_ID = 'skill.mkt.segment_audience';

/** The §4.1 row without its id; {@link SEGMENT_AUDIENCE_SKILL_ID} is bound at construction. */
const spec: Omit<PlatformRowSpec, 'skill_id'> = {
  purpose: 'Segments customer cohort by RFM profile, purchase recency, and brand affinity.',
  effect_class: 'INTERNAL',
  guarded_dependency: 'PostgreSQL.Customer360Store',
  input_schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['tenant_id', 'rfm_criteria', 'min_days_inactive'],
    properties: {
      tenant_id: { type: 'string' },
      rfm_criteria: {
        type: 'string',
        enum: ['CHAMPIONS', 'LOYAL', 'POTENTIAL_LOYALIST', 'AT_RISK', 'HIBERNATING'],
      },
      min_days_inactive: { type: 'integer', minimum: 0 },
      max_segment_size: { type: 'integer', default: 5000 },
    },
    additionalProperties: false,
  },
  output_schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['segment_id', 'matched_customer_count', 'customer_ids', 'generated_at'],
    properties: {
      segment_id: { type: 'string' },
      matched_customer_count: { type: 'integer' },
      customer_ids: { type: 'array', items: { type: 'string' } },
      generated_at: { type: 'string', format: 'date-time' },
    },
  },
  allowed_agents: ['MKT-02', 'MKT-05'],
  required_authority: 'AUTH-1',
  tool_binding: 'PostgreSQL.Customer360Store',
  validation_rules: [
    'max_segment_size cannot exceed 50000',
    'min_days_inactive must be non-negative',
  ],
  retry_policy: {
    max_retries: 2,
    initial_interval_ms: 1000,
    backoff_multiplier: 1.5,
    retry_on_timeout: true,
    non_retryable_errors: ['QUERY_TIMEOUT', 'INVALID_RFM'],
  },
  timeout_ms: 2500,
  audit_spec: {
    log_level: 'INFO',
    mask_pii_fields: ['customer_ids'],
    evidence_card: 'EV_MKT_AUDIENCE_SEGMENT',
    record_latency: true,
  },
  test_cases: [
    {
      test_id: 'TC-SKILL-01',
      category: 'HAPPY_PATH',
      scenario:
        'Valid input payload submitted by MKT-02 or MKT-05 holding an AUTH-1 grant; the cohort query answers inside the declared deadline.',
      expected_outcome:
        'One tenant-scoped segment; `matched_customer_count` equals the returned `customer_ids`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02',
      category: 'AUTHORITY',
      scenario:
        'An `AUTH-0` grant is presented against the `AUTH-1` requirement, or the cohort criteria match customers owned by another tenant.',
      expected_outcome:
        '`AUTH-0` → `INSUFFICIENT_AUTHORITY`; cross-tenant cohort → 0 rows',
      required: true,
    },
    {
      test_id: 'TC-SKILL-03',
      category: 'SCHEMA_INVALIDATION',
      scenario:
        'Input missing a required field, carrying an `rfm_criteria` value outside the enum, or an illegal extra property.',
      expected_outcome:
        '`max_segment_size` 50001 or bad RFM → validation failure pre-query',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04',
      category: 'TIMEOUT',
      scenario: 'The bound `PostgreSQL.Customer360Store` cohort query hangs past `timeout_ms` of 2500ms.',
      expected_outcome: '`QUERY_TIMEOUT` after ≤2; no partial segment persisted',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05',
      category: 'IDEMPOTENCY',
      scenario: 'The identical cohort criteria are submitted twice.',
      expected_outcome:
        'Same criteria → same cohort digest; re-running adds no duplicate rows, `REPLAY` where a stored segment exists',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02-06',
      category: 'VALIDATION',
      scenario: '`max_segment_size` = 50001.',
      expected_outcome:
        'Validation failure before the cohort query; no `segment_id` and no `customer_ids` are returned.',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02-07',
      category: 'SECURITY',
      scenario: 'Cohort query whose matching customers belong to another tenant.',
      expected_outcome:
        'RLS returns 0 rows; the audit record masks `customer_ids`; no customer identifier leaves the tenant boundary (NFR-006).',
      required: true,
    },
  ],
};

/**
 * Builds the §4.1 skill 2 row.
 *
 * @param deps The injected tool port and clock; the row holds no ambient dependency.
 * @returns The `skill.mkt.segment_audience` row, without an `enabled` flag — the gate owns that.
 */
export function createMktSegmentAudience(
  deps: PlatformSkillDependencies,
): PlatformSkillRow<InputMktSegmentAudience, OutputMktSegmentAudience> {
  return definePlatformRow<InputMktSegmentAudience, OutputMktSegmentAudience>(deps, {
    ...spec,
    skill_id: SEGMENT_AUDIENCE_SKILL_ID,
  });
}
