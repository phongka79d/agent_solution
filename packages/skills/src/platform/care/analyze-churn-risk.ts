/**
 * @file Row `skill.care.analyze_churn_risk` — churn scoring whose every output stays tagged
 * `HYPOTHESIS`. Transcribed from `implement/05-skill-system-specifications.md` §4.3 skill 22 (lines
 * 2196-2254); its effect class and circuit-breaker key come from the §6.5 matrix, its baseline case
 * outcomes from the §6.6 table.
 */

import { definePlatformRow, type PlatformRowSpec } from '../row.js';
import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';

/** Input of `skill.care.analyze_churn_risk` (§4.3 skill 22). */
export interface InputCareAnalyzeChurnRisk {
  tenant_id: string;
  customer_id: string;
  recent_message_snippets?: string[];
}

/** Output of `skill.care.analyze_churn_risk` (§4.3 skill 22). */
export interface OutputCareAnalyzeChurnRisk {
  customer_id: string;
  churn_probability: number;
  risk_tier: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
  primary_risk_factors: string[];
  classification: 'HYPOTHESIS';
}

/** Immutable identifier of this row (§4.3 skill 22). */
export const CARE_ANALYZE_CHURN_RISK_SKILL_ID = 'skill.care.analyze_churn_risk';

/** Strict input schema of §4.3 skill 22, verbatim. */
const input_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['tenant_id', 'customer_id'],
  properties: {
    tenant_id: { type: 'string' },
    customer_id: { type: 'string' },
    recent_message_snippets: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
};

/** Output schema of §4.3 skill 22, verbatim. */
const output_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: [
    'customer_id',
    'churn_probability',
    'risk_tier',
    'primary_risk_factors',
    'classification',
  ],
  properties: {
    customer_id: { type: 'string' },
    churn_probability: { type: 'number', minimum: 0, maximum: 1 },
    risk_tier: { type: 'string', enum: ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'] },
    primary_risk_factors: { type: 'array', items: { type: 'string' } },
    classification: { type: 'string', const: 'HYPOTHESIS' },
  },
};

/** The declarative half of the row; `skill_id` is supplied by the factory (§4.3 skill 22). */
const spec: Omit<
  PlatformRowSpec,
  'skill_id'
> = {
  purpose:
    'Evaluates customer sentiment and inactivity frequency to score churn risk (Tagged strictly as HYPOTHESIS).',
  effect_class: 'READ',
  guarded_dependency: 'Customer360.AnalyticsLayer',
  input_schema,
  output_schema,
  allowed_agents: ['CS-02'],
  required_authority: 'AUTH-1',
  tool_binding: 'Customer360.AnalyticsLayer',
  validation_rules: [
    'result MUST be tagged with classification: HYPOTHESIS',
    'cannot overwrite FACT',
  ],
  retry_policy: {
    max_retries: 2,
    initial_interval_ms: 500,
    backoff_multiplier: 1.5,
    retry_on_timeout: true,
    non_retryable_errors: ['MODEL_OFFLINE'],
  },
  timeout_ms: 2500,
  audit_spec: {
    log_level: 'INFO',
    mask_pii_fields: ['customer_id'],
    evidence_card: 'EV_CHURN_ANALYSIS',
    record_latency: true,
  },
  test_cases: [
    {
      test_id: 'TC-SKILL-01',
      category: 'HAPPY_PATH',
      scenario:
        '`CS-02` at `AUTH-1` scores a tenant-scoped `customer_id` and the analytics layer answers.',
      expected_outcome: 'Score + tier with `classification: HYPOTHESIS`; no FACT write',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02',
      category: 'AUTHORITY',
      scenario: 'An `AUTH-0` caller requests a score, and a cross-tenant `customer_id` is scored.',
      expected_outcome:
        '`AUTH-0` → `INSUFFICIENT_AUTHORITY`; cross-tenant customer → refused, 0 rows',
      required: true,
    },
    {
      test_id: 'TC-SKILL-03',
      category: 'SCHEMA_INVALIDATION',
      scenario: 'A scoring payload without `customer_id` is submitted.',
      expected_outcome: 'Missing `customer_id` → `SCHEMA_VALIDATION_ERROR`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04',
      category: 'TIMEOUT',
      scenario:
        'The scoring model does not answer within the row timeout of 2500ms across the ≤2 retry budget.',
      expected_outcome: '`MODEL_OFFLINE` after ≤2; no default tier and no `LOW` default',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05',
      category: 'IDEMPOTENCY',
      scenario: 'The identical `(customer_id, inputs)` scoring request is submitted twice.',
      expected_outcome:
        'Stable score for identical inputs; nothing promoted to FACT or Organizational Knowledge',
      required: true,
    },
    {
      test_id: 'TC-SKILL-22-06',
      category: 'VALIDATION',
      scenario: 'Any result produced by the analytics layer.',
      expected_outcome:
        '`classification = HYPOTHESIS` in every response, with no write to a FACT store (FR-C360-003).',
      required: true,
    },
    {
      test_id: 'TC-SKILL-22-07',
      category: 'RESILIENCE',
      scenario: 'Scoring model offline.',
      expected_outcome:
        '`MODEL_OFFLINE` (non-retryable); no default risk tier and no `LOW` churn probability are returned.',
      required: true,
    },
  ],
};

/**
 * Builds the `skill.care.analyze_churn_risk` row (§4.3 skill 22).
 *
 * @param deps Injected tool port and clock; the row holds no ambient dependency.
 * @returns The row, with `validateInput` normalizing through its `input_schema` and `execute`
 *   dispatching `Customer360.AnalyticsLayer` through the tool port.
 */
export function createCareAnalyzeChurnRisk(
  deps: PlatformSkillDependencies,
): PlatformSkillRow<InputCareAnalyzeChurnRisk, OutputCareAnalyzeChurnRisk> {
  return definePlatformRow<InputCareAnalyzeChurnRisk, OutputCareAnalyzeChurnRisk>(deps, {
    ...spec,
    skill_id: CARE_ANALYZE_CHURN_RISK_SKILL_ID,
  });
}
