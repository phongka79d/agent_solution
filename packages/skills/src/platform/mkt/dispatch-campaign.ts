/**
 * @file `skill.mkt.dispatch_campaign` — Marketing row 6 of the platform registry, transcribed
 * verbatim from `implement/05` §4.1 (lines 999-1065), with the effect class and guarded dependency
 * of the §6.5 matrix and this row's baseline outcomes from §6.6.
 *
 * This is the one effect-bearing Marketing row: `required_authority` is `AUTH-4`, so the run is
 * prepared and pauses at the SCR-003 human gate — an approval is never a clearance and never raises
 * the caller's authority. The module is data plus its factory call; enablement is decided by the gate.
 */

import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';
import { definePlatformRow, type PlatformRowSpec } from '../row.js';

/**
 * §4.1 field 3 `Input*` of the row. `approval_signature` is part of the payload, but the approval
 * itself is verified against the approvals gate — a signature field is evidence to check, never a
 * grant to trust.
 */
export interface InputMktDispatchCampaign {
  tenant_id: string;
  campaign_id: string;
  segment_id: string;
  channel: 'LINE' | 'WHATSAPP' | 'EMAIL' | 'SMS' | 'ZALO' | 'TIKTOK' | 'MESSENGER' | 'INSTAGRAM';
  approved_content_id: string;
  approval_signature: string;
}

/** §4.1 field 4 `Output*` of the row. */
export interface OutputMktDispatchCampaign {
  dispatch_id: string;
  recipient_count: number;
  status: 'ENQUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  dispatched_at: string;
}

/** Canonical id of §4.1 skill 6: the immutable key every dispatch envelope resolves by. */
export const DISPATCH_CAMPAIGN_SKILL_ID = 'skill.mkt.dispatch_campaign';

/** The §4.1 row without its id; {@link DISPATCH_CAMPAIGN_SKILL_ID} is bound at construction. */
const spec: Omit<PlatformRowSpec, 'skill_id'> = {
  purpose: 'Dispatches marketing broadcast to authorized segments (Enforces human approval AUTH-4).',
  effect_class: 'APPROVAL',
  guarded_dependency: 'API-003.CommunicationConnector',
  input_schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: [
      'tenant_id',
      'campaign_id',
      'segment_id',
      'channel',
      'approved_content_id',
      'approval_signature',
    ],
    properties: {
      tenant_id: { type: 'string' },
      campaign_id: { type: 'string' },
      segment_id: { type: 'string' },
      channel: {
        type: 'string',
        enum: ['LINE', 'WHATSAPP', 'EMAIL', 'SMS', 'ZALO', 'TIKTOK', 'MESSENGER', 'INSTAGRAM'],
      },
      approved_content_id: { type: 'string' },
      approval_signature: { type: 'string' },
      offer_id: { type: 'string' },
      discount_amount: { type: 'number', minimum: 0 },
      discount_percent: { type: 'number', minimum: 0, maximum: 100 },
      proposed_price: { type: 'number', exclusiveMinimum: 0 },
    },
    additionalProperties: false,
  },
  output_schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['dispatch_id', 'recipient_count', 'status', 'dispatched_at'],
    properties: {
      dispatch_id: { type: 'string' },
      recipient_count: { type: 'integer' },
      status: { type: 'string', enum: ['ENQUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'] },
      dispatched_at: { type: 'string', format: 'date-time' },
    },
  },
  allowed_agents: ['MKT-05'],
  required_authority: 'AUTH-4',
  tool_binding: 'API-003.CommunicationConnector',
  validation_rules: [
    "approval_signature must be verified against the approvals gate (SCR-003): the approval must exist, be bound to this run's effect_key, and authorize exactly one dispatch (BR-007)",
    "an approval is never treated as a clearance grant and never raises the caller's authority",
    'channel quota must be available',
  ],
  retry_policy: {
    max_retries: 0,
    initial_interval_ms: 0,
    backoff_multiplier: 1.0,
    retry_on_timeout: false,
    non_retryable_errors: ['AUTH_DENIED', 'CAMPAIGN_ALREADY_SENT'],
  },
  timeout_ms: 5000,
  audit_spec: {
    log_level: 'INFO',
    mask_pii_fields: [],
    evidence_card: 'EV_CAMPAIGN_DISPATCH',
    record_latency: true,
  },
  test_cases: [
    {
      test_id: 'TC-SKILL-01',
      category: 'HAPPY_PATH',
      scenario:
        'Valid input payload submitted by MKT-05 with a bound `approval_id` whose payload digest matches the dispatch and a free channel quota.',
      expected_outcome:
        'Bound `approval_id` + matching digest → dispatch accepted, status `ENQUEUED`, `EV_CAMPAIGN_DISPATCH`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02',
      category: 'AUTHORITY',
      scenario:
        'The invocation carries no bound `approval_id`, its approval digest does not match the payload, or the run presents `AUTH-5`.',
      expected_outcome:
        'No approval → `REQUIRE_HUMAN_APPROVAL`/`APPROVAL_REQUIRED`; digest mismatch → `APPROVAL_PAYLOAD_MISMATCH`; `AUTH-5` attempt → `PROHIBITED_ACTION` with no queued row; 0 recipients contacted',
      required: true,
    },
    {
      test_id: 'TC-SKILL-03',
      category: 'SCHEMA_INVALIDATION',
      scenario:
        'Input missing `approved_content_id` or `approval_signature`, or carrying an illegal extra property.',
      expected_outcome:
        'Missing `approved_content_id` or `approval_signature` → `SCHEMA_VALIDATION_ERROR`; 0 recipients',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04',
      category: 'TIMEOUT',
      scenario: 'The bound `API-003.CommunicationConnector` call hangs past `timeout_ms` of 5000ms.',
      expected_outcome:
        '`EFFECT_UNKNOWN` (never re-dispatched); the approval is consumed once; reconcile by `effect_key`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05',
      category: 'IDEMPOTENCY',
      scenario:
        'The same campaign/segment dispatch is submitted twice with the same `effect_key`.',
      expected_outcome:
        'Second submission of the same campaign/segment → `CAMPAIGN_ALREADY_SENT`; recipient count unchanged',
      required: true,
    },
    {
      test_id: 'TC-SKILL-06-06',
      category: 'AUTHORITY',
      scenario:
        'Invocation with no bound `approval_id`, an unverifiable `approval_signature`, or an approval bound to a different `effect_key`.',
      expected_outcome:
        '`APPROVAL_REQUIRED`: exactly one PENDING approval row exists for the run and zero recipients are contacted; no rank comparison takes place.',
      required: true,
    },
    {
      test_id: 'TC-SKILL-06-07',
      category: 'IDEMPOTENCY',
      scenario: 'The same campaign/segment dispatch is submitted twice.',
      expected_outcome:
        '`CAMPAIGN_ALREADY_SENT` (non-retryable, `max_retries: 0`); the recipient count is unchanged by the second call.',
      required: true,
    },
  ],
};

/**
 * Builds the §4.1 skill 6 row.
 *
 * @param deps The injected tool port and clock; the row holds no ambient dependency.
 * @returns The `skill.mkt.dispatch_campaign` row, without an `enabled` flag — the gate owns that.
 */
export function createMktDispatchCampaign(
  deps: PlatformSkillDependencies,
): PlatformSkillRow<InputMktDispatchCampaign, OutputMktDispatchCampaign> {
  return definePlatformRow<InputMktDispatchCampaign, OutputMktDispatchCampaign>(deps, {
    ...spec,
    skill_id: DISPATCH_CAMPAIGN_SKILL_ID,
  });
}
