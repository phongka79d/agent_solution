/**
 * @file Row `skill.care.escalate_to_human` — SCR-005 human handoff that releases bot control and
 * transfers context to a human inbox. Transcribed from `implement/05-skill-system-specifications.md`
 * §4.3 skill 21 (lines 2132-2194); its effect class and circuit-breaker key come from the §6.5
 * matrix, its baseline case outcomes from the §6.6 table.
 */

import { definePlatformRow, type PlatformRowSpec } from '../row.js';
import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';

/** Input of `skill.care.escalate_to_human` (§4.3 skill 21). */
export interface InputCareEscalateHuman {
  tenant_id: string;
  session_id: string;
  conversation_id: string;
  customer_id?: string;
  escalation_reason: string;
  summary_context?: string;
}

/** Output of `skill.care.escalate_to_human` (§4.3 skill 21). */
export interface OutputCareEscalateHuman {
  handoff_id: string;
  queue_position: number;
  status: 'ENQUEUED' | 'ASSIGNED';
  escalated_at: string;
}

/** Immutable identifier of this row (§4.3 skill 21). */
export const CARE_ESCALATE_TO_HUMAN_SKILL_ID = 'skill.care.escalate_to_human';

/** Strict input schema of §4.3 skill 21, verbatim. */
const input_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['tenant_id', 'session_id', 'conversation_id', 'escalation_reason'],
  properties: {
    tenant_id: { type: 'string' },
    session_id: { type: 'string' },
    conversation_id: { type: 'string' },
    customer_id: { type: 'string' },
    escalation_reason: { type: 'string' },
    summary_context: { type: 'string' },
  },
  additionalProperties: false,
};

/** Output schema of §4.3 skill 21, verbatim. */
const output_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['handoff_id', 'queue_position', 'status', 'escalated_at'],
  properties: {
    handoff_id: { type: 'string' },
    queue_position: { type: 'integer' },
    status: { type: 'string', enum: ['ENQUEUED', 'ASSIGNED'] },
    escalated_at: { type: 'string', format: 'date-time' },
  },
};

/** The declarative half of the row; `skill_id` is supplied by the factory (§4.3 skill 21). */
const spec: Omit<PlatformRowSpec, 'skill_id'> = {
  purpose:
    'Triggers human handoff (`SCR-005`), releasing bot control and transferring context to human inbox.',
  effect_class: 'INTERNAL',
  guarded_dependency: 'Orchestrator.HandoffBus',
  input_schema,
  output_schema,
  allowed_agents: ['CS-01', 'CS-02'],
  required_authority: 'AUTH-3',
  tool_binding: 'Orchestrator.HandoffBus',
  validation_rules: ['locks bot session mutex immediately', 'session state set to awaiting_human'],
  retry_policy: {
    max_retries: 2,
    initial_interval_ms: 300,
    backoff_multiplier: 1.5,
    retry_on_timeout: false,
    non_retryable_errors: ['QUEUE_DOWN'],
  },
  timeout_ms: 1000,
  audit_spec: {
    log_level: 'INFO',
    mask_pii_fields: ['customer_id'],
    evidence_card: 'EV_HUMAN_HANDOFF',
    record_latency: true,
  },
  test_cases: [
    {
      test_id: 'TC-SKILL-01',
      category: 'HAPPY_PATH',
      scenario:
        '`CS-01` at `AUTH-3` escalates a live conversation whose bot mutex is free, and the handoff queue accepts the enqueue.',
      expected_outcome: 'One handoff enqueued, bot mutex released once, SCR-005 shows human-held',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02',
      category: 'AUTHORITY',
      scenario:
        'An escalation arrives while a human already holds the session mutex, and an unlisted agent attempts the same escalation.',
      expected_outcome:
        'Human already holds the mutex → no double release; unlisted agent → `UNAUTHORIZED_AGENT`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-03',
      category: 'SCHEMA_INVALIDATION',
      scenario: 'An escalation payload without `escalation_reason` is submitted.',
      expected_outcome: 'Missing `escalation_reason` → `SCHEMA_VALIDATION_ERROR`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04',
      category: 'TIMEOUT',
      scenario:
        'The handoff queue is down and does not answer within the row timeout of 1000ms across the ≤2 retry budget.',
      expected_outcome:
        'Queue down → `QUEUE_DOWN`; handoff and mutex release commit together or not at all',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05',
      category: 'IDEMPOTENCY',
      scenario: 'The same conversation is escalated twice.',
      expected_outcome:
        'Repeat escalation on the same conversation yields exactly one handoff and one release (`REPLAY`)',
      required: true,
    },
    {
      test_id: 'TC-SKILL-21-06',
      category: 'VALIDATION',
      scenario: 'Escalation requested while a human already holds the session mutex.',
      expected_outcome:
        'Exactly one handoff is produced and the bot session is released once (no double release, no conflicting takeover state, SCR-005).',
      required: true,
    },
    {
      test_id: 'TC-SKILL-21-07',
      category: 'RESILIENCE',
      scenario: 'Handoff queue unavailable.',
      expected_outcome:
        '`QUEUE_DOWN`, and the session is never left half-released: the mutex release and the handoff commit together or not at all.',
      required: true,
    },
  ],
};

/**
 * Builds the `skill.care.escalate_to_human` row (§4.3 skill 21).
 *
 * @param deps Injected tool port and clock; the row holds no ambient dependency.
 * @returns The row, with `validateInput` normalizing through its `input_schema` and `execute`
 *   dispatching `Orchestrator.HandoffBus` through the tool port.
 */
export function createCareEscalateToHuman(
  deps: PlatformSkillDependencies,
): PlatformSkillRow<InputCareEscalateHuman, OutputCareEscalateHuman> {
  return definePlatformRow<InputCareEscalateHuman, OutputCareEscalateHuman>(deps, {
    ...spec,
    skill_id: CARE_ESCALATE_TO_HUMAN_SKILL_ID,
  });
}
