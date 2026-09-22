/**
 * @file Row `skill.care.initiate_return` — reverse-logistics RMA preparation behind the SCR-003 human
 * gate. Transcribed from `implement/05-skill-system-specifications.md` §4.3 skill 20 (lines
 * 2068-2130); its effect class and circuit-breaker key come from the §6.5 matrix, its baseline case
 * outcomes from the §6.6 table.
 */

import { definePlatformRow, type PlatformRowSpec } from '../row.js';
import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';

/** Input of `skill.care.initiate_return` (§4.3 skill 20). */
export interface InputCareInitiateReturn {
  tenant_id: string;
  order_id: string;
  sku_id: string;
  return_reason: string;
  evidence_images: string[];
  effect_key: string;
}

/** Output of `skill.care.initiate_return` (§4.3 skill 20). */
export interface OutputCareInitiateReturn {
  rma_number: string;
  status: 'AWAITING_APPROVAL' | 'APPROVED' | 'REJECTED';
  return_shipping_label_url: string | null;
  initiated_at: string;
}

/** Immutable identifier of this row (§4.3 skill 20). */
export const CARE_INITIATE_RETURN_SKILL_ID = 'skill.care.initiate_return';

/** Strict input schema of §4.3 skill 20, verbatim. */
const input_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['tenant_id', 'order_id', 'sku_id', 'return_reason', 'evidence_images', 'effect_key'],
  properties: {
    tenant_id: { type: 'string' },
    order_id: { type: 'string' },
    sku_id: { type: 'string' },
    return_reason: { type: 'string' },
    evidence_images: { type: 'array', items: { type: 'string' } },
    effect_key: { type: 'string' },
  },
  additionalProperties: false,
};

/** Output schema of §4.3 skill 20, verbatim. */
const output_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['rma_number', 'status', 'return_shipping_label_url', 'initiated_at'],
  properties: {
    rma_number: { type: 'string' },
    status: { type: 'string', enum: ['AWAITING_APPROVAL', 'APPROVED', 'REJECTED'] },
    return_shipping_label_url: { type: ['string', 'null'] },
    initiated_at: { type: 'string', format: 'date-time' },
  },
};

/** The declarative half of the row; `skill_id` is supplied by the factory (§4.3 skill 20). */
const spec: Omit<PlatformRowSpec, 'skill_id'> = {
  purpose:
    'Generates reverse logistics return authorization (RMA) requiring human approval (AUTH-4) for refunds.',
  effect_class: 'APPROVAL',
  guarded_dependency: 'ReverseLogisticsConnector',
  input_schema,
  output_schema,
  allowed_agents: ['CS-01'],
  required_authority: 'AUTH-4',
  tool_binding: 'ReverseLogisticsConnector',
  validation_rules: [
    'order must be within return window (e.g. 7 days for TW)',
    "must be approved in SCR-003: the approval row must be bound to this run's effect_key and authorize exactly one RMA (BR-007)",
    'an approval is never treated as a clearance grant',
  ],
  retry_policy: {
    max_retries: 1,
    initial_interval_ms: 1000,
    backoff_multiplier: 1.0,
    retry_on_timeout: false,
    non_retryable_errors: ['RETURN_WINDOW_EXPIRED'],
  },
  timeout_ms: 3500,
  audit_spec: {
    log_level: 'INFO',
    mask_pii_fields: ['evidence_images'],
    evidence_card: 'EV_RMA_INITIATION',
    record_latency: true,
  },
  test_cases: [
    {
      test_id: 'TC-SKILL-01',
      category: 'HAPPY_PATH',
      scenario:
        '`CS-01` submits an in-window return carrying the `approval_id` bound to this run `(tenant_id, run_id, effect_key)` and a matching payload digest.',
      expected_outcome: 'Approved RMA with label URL; `EV_RMA_INITIATION`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02',
      category: 'AUTHORITY',
      scenario:
        'A return with no bound approval, with a mismatched approval digest, and one outside the return window.',
      expected_outcome:
        'No bound approval → `REQUIRE_HUMAN_APPROVAL`/`APPROVAL_REQUIRED`; digest mismatch → `APPROVAL_PAYLOAD_MISMATCH`; outside window → `RETURN_WINDOW_EXPIRED`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-03',
      category: 'SCHEMA_INVALIDATION',
      scenario: 'A return payload missing `effect_key` and `evidence_images` is submitted.',
      expected_outcome:
        'Missing `effect_key`/images → `SCHEMA_VALIDATION_ERROR` / `EFFECT_KEY_REQUIRED`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04',
      category: 'TIMEOUT',
      scenario:
        'ReverseLogisticsConnector accepts the RMA but the response is lost past the row timeout of 3500ms.',
      expected_outcome:
        'Provider accepted, response lost → `EFFECT_UNKNOWN`; reconcile by `effect_key`; no second RMA',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05',
      category: 'IDEMPOTENCY',
      scenario:
        'Identical `effect_key` with an identical payload is replayed after the RMA was produced.',
      expected_outcome: 'Same key + same payload → `REPLAY` with the same RMA; no duplicate label',
      required: true,
    },
    {
      test_id: 'TC-SKILL-20-06',
      category: 'AUTHORITY',
      scenario: "No SCR-003 approval bound to this run's `effect_key`.",
      expected_outcome:
        '`APPROVAL_REQUIRED`; no RMA number and no shipping label are produced.',
      required: true,
    },
    {
      test_id: 'TC-SKILL-20-07',
      category: 'TIMEOUT',
      scenario: 'Provider accepts the RMA but the response is lost past `timeout_ms`.',
      expected_outcome:
        '`EFFECT_UNKNOWN` (never a re-dispatched request): the reservation stays RESERVED, reconciliation by `effect_key` finds the existing RMA, and no second return authorization exists for that key.',
      required: true,
    },
  ],
};

/**
 * Builds the `skill.care.initiate_return` row (§4.3 skill 20).
 *
 * @param deps Injected tool port and clock; the row holds no ambient dependency.
 * @returns The row, with `validateInput` normalizing through its `input_schema` and `execute`
 *   dispatching `ReverseLogisticsConnector` through the tool port.
 */
export function createCareInitiateReturn(
  deps: PlatformSkillDependencies,
): PlatformSkillRow<InputCareInitiateReturn, OutputCareInitiateReturn> {
  return definePlatformRow<InputCareInitiateReturn, OutputCareInitiateReturn>(deps, {
    ...spec,
    skill_id: CARE_INITIATE_RETURN_SKILL_ID,
  });
}
