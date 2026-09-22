/**
 * @file `skill.mkt.check_consent` — Marketing row 3 of the platform registry, transcribed verbatim
 * from `implement/05` §4.1 (lines 773-827), with the effect class and guarded dependency of the
 * §6.5 matrix and this row's baseline outcomes from §6.6.
 *
 * The module is data plus its factory call: `definePlatformRow` supplies the single normalization
 * and the single dispatch route, so this row cannot validate less than its schema declares or reach
 * an adapter by another path. Enablement is deliberately absent — the gate decides it.
 */

import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';
import { definePlatformRow, type PlatformRowSpec } from '../row.js';

/** §4.1 field 3 `Input*` of the row, normalized: no property carries a JSON-Schema `default`. */
export interface InputMktCheckConsent {
  tenant_id: string;
  customer_id: string;
  channel: 'LINE' | 'WHATSAPP' | 'SMS' | 'EMAIL' | 'ZALO' | 'TIKTOK' | 'MESSENGER' | 'INSTAGRAM';
}

/**
 * §4.1 field 4 `Output*` of the row. Both nullable fields are required, so an unconsented or
 * suppressed customer cannot be answered by omission: `allowed = false` with an explicit reason is
 * the only refusal shape, and silence is never a default-allow (BR-004).
 */
export interface OutputMktCheckConsent {
  allowed: boolean;
  consent_timestamp: string | null;
  suppression_reason: string | null;
}

/** Canonical id of §4.1 skill 3: the immutable key every dispatch envelope resolves by. */
export const CHECK_CONSENT_SKILL_ID = 'skill.mkt.check_consent';

/** The §4.1 row without its id; {@link CHECK_CONSENT_SKILL_ID} is bound at construction. */
const spec: Omit<PlatformRowSpec, 'skill_id'> = {
  purpose: 'Verifies opt-in consent and suppression status for marketing channels (BR-004).',
  effect_class: 'READ',
  guarded_dependency: 'API-002.ConsentStore',
  input_schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['tenant_id', 'customer_id', 'channel'],
    properties: {
      tenant_id: { type: 'string' },
      customer_id: { type: 'string' },
      channel: {
        type: 'string',
        enum: ['LINE', 'WHATSAPP', 'SMS', 'EMAIL', 'ZALO', 'TIKTOK', 'MESSENGER', 'INSTAGRAM'],
      },
    },
    additionalProperties: false,
  },
  output_schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['allowed', 'consent_timestamp', 'suppression_reason'],
    properties: {
      allowed: { type: 'boolean' },
      consent_timestamp: { type: ['string', 'null'], format: 'date-time' },
      suppression_reason: { type: ['string', 'null'] },
    },
  },
  allowed_agents: ['MKT-02', 'MKT-05', 'SAL-04'],
  required_authority: 'AUTH-3',
  tool_binding: 'API-002.ConsentStore',
  validation_rules: [
    'customer_id must be valid uuid/cuid',
    'channel must be configured in tenant settings',
  ],
  retry_policy: {
    max_retries: 3,
    initial_interval_ms: 300,
    backoff_multiplier: 2.0,
    retry_on_timeout: true,
    non_retryable_errors: ['CUSTOMER_NOT_FOUND'],
  },
  timeout_ms: 1000,
  audit_spec: {
    log_level: 'INFO',
    mask_pii_fields: ['customer_id'],
    evidence_card: 'EV_CONSENT_VERIFICATION',
    record_latency: true,
  },
  test_cases: [
    {
      test_id: 'TC-SKILL-01',
      category: 'HAPPY_PATH',
      scenario:
        'Valid input payload submitted by MKT-02, MKT-05 or SAL-04 holding an AUTH-3 grant; the consent store answers inside the declared deadline.',
      expected_outcome: 'Consented `(channel, consent_type)` → `allowed=true` + timestamp',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02',
      category: 'AUTHORITY',
      scenario: 'A grant below `AUTH-3` is presented against the `AUTH-3` requirement.',
      expected_outcome:
        'Opt-out, expired, or wildcard row → `allowed=false` + `suppression_reason`; downstream send refused (`CONSENT_REQUIRED`)',
      required: true,
    },
    {
      test_id: 'TC-SKILL-03',
      category: 'SCHEMA_INVALIDATION',
      scenario:
        'Input missing `customer_id` or `channel`, or carrying an illegal extra property against the declared `input_schema`.',
      expected_outcome: 'Unknown channel → `SCHEMA_VALIDATION_ERROR` before the store read',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04',
      category: 'TIMEOUT',
      scenario: 'The bound `API-002.ConsentStore` read hangs past `timeout_ms` of 1000ms.',
      expected_outcome: 'Store error ≤3; exhaustion fails closed — never default-allow',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05',
      category: 'IDEMPOTENCY',
      scenario: 'The identical consent question for the same `(customer_id, channel)` is asked twice.',
      expected_outcome: 'Read-only: same verdict, no consent row mutated',
      required: true,
    },
    {
      test_id: 'TC-SKILL-03-06',
      category: 'VALIDATION',
      scenario: 'Customer has an active marketing suppression, or no consent row at all.',
      expected_outcome:
        '`allowed = false` with a `suppression_reason`; the downstream outreach skill is refused (BR-004).',
      required: true,
    },
    {
      test_id: 'TC-SKILL-03-07',
      category: 'BOUNDARY',
      scenario: '`customer_id` unknown to the tenant.',
      expected_outcome:
        '`CUSTOMER_NOT_FOUND` (non-retryable); no consent FACT is released and no default-allow is returned.',
      required: true,
    },
  ],
};

/**
 * Builds the §4.1 skill 3 row.
 *
 * @param deps The injected tool port and clock; the row holds no ambient dependency.
 * @returns The `skill.mkt.check_consent` row, without an `enabled` flag — the gate owns that.
 */
export function createMktCheckConsent(
  deps: PlatformSkillDependencies,
): PlatformSkillRow<InputMktCheckConsent, OutputMktCheckConsent> {
  return definePlatformRow<InputMktCheckConsent, OutputMktCheckConsent>(deps, {
    ...spec,
    skill_id: CHECK_CONSENT_SKILL_ID,
  });
}
