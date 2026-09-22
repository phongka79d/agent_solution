/**
 * @file Row `skill.care.track_shipping` — live carrier status across Black Cat, HCT and CVS
 * logistics. Transcribed from `implement/05-skill-system-specifications.md` §4.3 skill 18 (lines
 * 1893-1960); its effect class and circuit-breaker key come from the §6.5 matrix, its baseline case
 * outcomes from the §6.6 table.
 */

import { definePlatformRow, type PlatformRowSpec } from '../row.js';
import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';

/** Input of `skill.care.track_shipping` (§4.3 skill 18). */
export interface InputCareTrackShipping {
  tenant_id: string;
  tracking_number: string;
  carrier: 'BLACK_CAT' | 'HCT' | 'SEVEN_ELEVEN_CVS' | 'FAMILY_MART_CVS' | 'FEDEX' | 'DHL';
}

/** Output of `skill.care.track_shipping` (§4.3 skill 18). */
export interface OutputCareTrackShipping {
  tracking_number: string;
  carrier: string;
  shipping_status: 'PICKED_UP' | 'IN_TRANSIT' | 'AT_CVS_STORE' | 'DELIVERED' | 'RETURNED';
  events: Array<{ status_text: string; location: string; timestamp: string }>;
}

/** Immutable identifier of this row (§4.3 skill 18). */
export const CARE_TRACK_SHIPPING_SKILL_ID = 'skill.care.track_shipping';

/** Strict input schema of §4.3 skill 18, verbatim. */
const input_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['tenant_id', 'tracking_number', 'carrier'],
  properties: {
    tenant_id: { type: 'string' },
    tracking_number: { type: 'string' },
    carrier: {
      type: 'string',
      enum: ['BLACK_CAT', 'HCT', 'SEVEN_ELEVEN_CVS', 'FAMILY_MART_CVS', 'FEDEX', 'DHL'],
    },
  },
  additionalProperties: false,
};

/** Output schema of §4.3 skill 18, verbatim. */
const output_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['tracking_number', 'carrier', 'shipping_status', 'events'],
  properties: {
    tracking_number: { type: 'string' },
    carrier: { type: 'string' },
    shipping_status: {
      type: 'string',
      enum: ['PICKED_UP', 'IN_TRANSIT', 'AT_CVS_STORE', 'DELIVERED', 'RETURNED'],
    },
    events: {
      type: 'array',
      items: {
        type: 'object',
        required: ['status_text', 'location', 'timestamp'],
        properties: {
          status_text: { type: 'string' },
          location: { type: 'string' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
};

/** The declarative half of the row; `skill_id` is supplied by the factory (§4.3 skill 18). */
const spec: Omit<PlatformRowSpec, 'skill_id'> = {
  purpose:
    'Tracks live carrier status (Black Cat, HCT, 7-Eleven / FamilyMart CVS logistics via ADPT-TW-001).',
  effect_class: 'READ',
  guarded_dependency: 'LogisticsConnector',
  input_schema,
  output_schema,
  allowed_agents: ['CS-01'],
  required_authority: 'AUTH-0',
  tool_binding: 'LogisticsConnector',
  validation_rules: ['tracking_number must match carrier checksum rules'],
  retry_policy: {
    max_retries: 3,
    initial_interval_ms: 500,
    backoff_multiplier: 1.5,
    retry_on_timeout: true,
    non_retryable_errors: ['CARRIER_TRACKING_NOT_FOUND'],
  },
  timeout_ms: 2500,
  audit_spec: {
    log_level: 'INFO',
    mask_pii_fields: [],
    evidence_card: 'EV_SHIPPING_TRACK',
    record_latency: true,
  },
  test_cases: [
    {
      test_id: 'TC-SKILL-01',
      category: 'HAPPY_PATH',
      scenario:
        '`CS-01` at `AUTH-0` submits a checksum-valid `tracking_number` for a supported `carrier` and the carrier answers.',
      expected_outcome: 'Carrier scan events for a valid tracking number',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02',
      category: 'AUTHORITY',
      scenario:
        'A `tracking_number` that fails the carrier checksum, and a carrier reporting an unknown number, are submitted.',
      expected_outcome:
        'Checksum failure/unsupported carrier → validation failure; unknown number → `CARRIER_TRACKING_NOT_FOUND`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-03',
      category: 'SCHEMA_INVALIDATION',
      scenario: 'A payload missing `carrier` and `tracking_number` is submitted.',
      expected_outcome: 'Missing `carrier`/`tracking_number` → `SCHEMA_VALIDATION_ERROR`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04',
      category: 'TIMEOUT',
      scenario:
        'The carrier adapter does not answer within the row timeout of 2500ms across the ≤3 retry budget.',
      expected_outcome: 'Carrier error ≤3; exhaustion fabricates no scan events',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05',
      category: 'IDEMPOTENCY',
      scenario: 'The identical `(carrier, tracking_number)` read is submitted twice.',
      expected_outcome: 'Read-only: identical result; no event written',
      required: true,
    },
    {
      test_id: 'TC-SKILL-18-06',
      category: 'VALIDATION',
      scenario: '`tracking_number` that fails the carrier checksum, or an unsupported `carrier`.',
      expected_outcome:
        'Validation failure before the carrier call; no shipping status is returned.',
      required: true,
    },
    {
      test_id: 'TC-SKILL-18-07',
      category: 'RESILIENCE',
      scenario: 'Carrier reports the number as unknown.',
      expected_outcome:
        '`CARRIER_TRACKING_NOT_FOUND` (non-retryable); no scan events are fabricated.',
      required: true,
    },
  ],
};

/**
 * Builds the `skill.care.track_shipping` row (§4.3 skill 18).
 *
 * @param deps Injected tool port and clock; the row holds no ambient dependency.
 * @returns The row, with `validateInput` normalizing through its `input_schema` and `execute`
 *   dispatching `LogisticsConnector` through the tool port.
 */
export function createCareTrackShipping(
  deps: PlatformSkillDependencies,
): PlatformSkillRow<InputCareTrackShipping, OutputCareTrackShipping> {
  return definePlatformRow<InputCareTrackShipping, OutputCareTrackShipping>(deps, {
    ...spec,
    skill_id: CARE_TRACK_SHIPPING_SKILL_ID,
  });
}
