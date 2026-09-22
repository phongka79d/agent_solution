/**
 * @file `skill.mkt.audit_brand_compliance` — Marketing row 5 of the platform registry, transcribed
 * verbatim from `implement/05` §4.1 (lines 931-997), with the effect class and guarded dependency
 * of the §6.5 matrix and this row's baseline outcomes from §6.6.
 *
 * The module is data plus its factory call: `definePlatformRow` supplies the single normalization
 * and the single dispatch route, so this row cannot validate less than its schema declares or reach
 * an adapter by another path. Enablement is deliberately absent — the gate decides it.
 */

import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';
import { definePlatformRow, type PlatformRowSpec } from '../row.js';

/** §4.1 field 3 `Input*` of the row, normalized: no property carries a JSON-Schema `default`. */
export interface InputMktAuditBrand {
  tenant_id: string;
  draft_text: string;
  channel: string;
}

/**
 * §4.1 field 4 `Output*` of the row. The verdict is always explicit: `compliant` is a required
 * boolean, so a failed or unavailable guard is never reported as compliance.
 */
export interface OutputMktAuditBrand {
  compliant: boolean;
  violations: Array<{ rule_id: string; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKING'; snippet: string; suggestion: string }>;
  confidence_score: number;
}

/** Canonical id of §4.1 skill 5: the immutable key every dispatch envelope resolves by. */
export const AUDIT_BRAND_COMPLIANCE_SKILL_ID = 'skill.mkt.audit_brand_compliance';

/** The §4.1 row without its id; {@link AUDIT_BRAND_COMPLIANCE_SKILL_ID} is bound at construction. */
const spec: Omit<PlatformRowSpec, 'skill_id'> = {
  purpose:
    'Evaluates draft copy against prohibited claims, brand tone guidelines, and regulatory constraints.',
  effect_class: 'READ',
  guarded_dependency: 'SecondBrain.BrandGuard',
  input_schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['tenant_id', 'draft_text', 'channel'],
    properties: {
      tenant_id: { type: 'string' },
      draft_text: { type: 'string' },
      channel: { type: 'string' },
    },
    additionalProperties: false,
  },
  output_schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['compliant', 'violations', 'confidence_score'],
    properties: {
      compliant: { type: 'boolean' },
      violations: {
        type: 'array',
        items: {
          type: 'object',
          required: ['rule_id', 'severity', 'snippet', 'suggestion'],
          properties: {
            rule_id: { type: 'string' },
            severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'BLOCKING'] },
            snippet: { type: 'string' },
            suggestion: { type: 'string' },
          },
        },
      },
      confidence_score: { type: 'number', minimum: 0, maximum: 1 },
    },
  },
  allowed_agents: ['MKT-04'],
  required_authority: 'AUTH-1',
  tool_binding: 'SecondBrain.BrandGuard',
  validation_rules: ['draft_text length must be > 0 and < 10000 chars'],
  retry_policy: {
    max_retries: 2,
    initial_interval_ms: 500,
    backoff_multiplier: 1.5,
    retry_on_timeout: true,
    non_retryable_errors: ['MALFORMED_INPUT'],
  },
  timeout_ms: 2000,
  audit_spec: {
    log_level: 'INFO',
    mask_pii_fields: [],
    evidence_card: 'EV_MKT_BRAND_AUDIT',
    record_latency: true,
  },
  test_cases: [
    {
      test_id: 'TC-SKILL-01',
      category: 'HAPPY_PATH',
      scenario:
        'Valid input payload submitted by MKT-04 holding an AUTH-1 grant; SecondBrain.BrandGuard answers inside the declared deadline.',
      expected_outcome: 'Approved copy → `compliant=true`, empty violations',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02',
      category: 'AUTHORITY',
      scenario: 'A run presents a grant below `AUTH-1` against the `AUTH-1` requirement.',
      expected_outcome:
        'Prohibited claim → `compliant=false` with a `BLOCKING` violation; dispatch refuses the draft',
      required: true,
    },
    {
      test_id: 'TC-SKILL-03',
      category: 'SCHEMA_INVALIDATION',
      scenario:
        'Input missing `draft_text` or `channel`, or carrying an illegal extra property against the declared `input_schema`.',
      expected_outcome: 'Empty or ≥10000-char text → `MALFORMED_INPUT` before the guard',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04',
      category: 'TIMEOUT',
      scenario: 'The bound `SecondBrain.BrandGuard` call hangs past `timeout_ms` of 2000ms.',
      expected_outcome: 'Guard error ≤2; exhaustion never reports "compliant"',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05',
      category: 'IDEMPOTENCY',
      scenario: 'The identical draft text is audited twice.',
      expected_outcome: 'Identical text → identical verdict; nothing written',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05-06',
      category: 'VALIDATION',
      scenario: 'Draft text containing a prohibited claim.',
      expected_outcome:
        '`compliant = false` with the matching `BLOCKING` violation; the dispatch step refuses the draft.',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05-07',
      category: 'BOUNDARY',
      scenario: '`draft_text` empty or >= 10000 characters.',
      expected_outcome:
        '`MALFORMED_INPUT` (non-retryable); `compliant` is never defaulted to true.',
      required: true,
    },
  ],
};

/**
 * Builds the §4.1 skill 5 row.
 *
 * @param deps The injected tool port and clock; the row holds no ambient dependency.
 * @returns The `skill.mkt.audit_brand_compliance` row, without an `enabled` flag — the gate owns that.
 */
export function createMktAuditBrand(
  deps: PlatformSkillDependencies,
): PlatformSkillRow<InputMktAuditBrand, OutputMktAuditBrand> {
  return definePlatformRow<InputMktAuditBrand, OutputMktAuditBrand>(deps, {
    ...spec,
    skill_id: AUDIT_BRAND_COMPLIANCE_SKILL_ID,
  });
}
