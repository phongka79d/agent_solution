/**
 * @file Row `skill.care.manage_case` — creates, transitions and persists support cases on the SRS §8
 * canonical 7-state FSM. Transcribed from `implement/05-skill-system-specifications.md` §4.3 skill 19
 * (lines 1962-2066); its effect class and circuit-breaker key come from the §6.5 matrix, its baseline
 * case outcomes from the §6.6 table.
 */

import { definePlatformRow, type PlatformRowSpec } from '../row.js';
import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';

/** Input of `skill.care.manage_case` (§4.3 skill 19). */
export interface InputCareManageCase {
  tenant_id: string;
  case_id?: string;
  customer_id: string;
  intent: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  conversation_id: string;
  related_order_id?: string | null;
  evidence_refs?: string[];
  action_type: 'CREATE' | 'TRANSITION_STATE' | 'ASSIGN' | 'RESOLVE' | 'REOPEN' | 'CLOSE';
  target_status?: 'NEW' | 'CLASSIFIED' | 'ASSIGNED' | 'IN_PROGRESS' | 'WAITING_CUSTOMER' | 'RESOLVED' | 'CLOSED';
  assigned_owner?: string | null;
  notes?: string;
}

/** Output of `skill.care.manage_case` (§4.3 skill 19). */
export interface OutputCareManageCase {
  case_id: string;
  customer_id: string;
  intent: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  status: 'NEW' | 'CLASSIFIED' | 'ASSIGNED' | 'IN_PROGRESS' | 'WAITING_CUSTOMER' | 'RESOLVED' | 'CLOSED';
  conversation_id: string;
  related_order_id: string | null;
  evidence_refs: string[];
  assigned_owner: string | null;
  sla_target_hours: number;
  updated_at: string;
}

/** Immutable identifier of this row (§4.3 skill 19). */
export const CARE_MANAGE_CASE_SKILL_ID = 'skill.care.manage_case';

/** Strict input schema of §4.3 skill 19, verbatim. */
const input_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['tenant_id', 'customer_id', 'intent', 'priority', 'conversation_id', 'action_type'],
  properties: {
    tenant_id: { type: 'string' },
    case_id: { type: 'string' },
    customer_id: { type: 'string' },
    intent: { type: 'string' },
    priority: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4'] },
    conversation_id: { type: 'string' },
    related_order_id: { type: ['string', 'null'] },
    evidence_refs: { type: 'array', items: { type: 'string' } },
    action_type: {
      type: 'string',
      enum: ['CREATE', 'TRANSITION_STATE', 'ASSIGN', 'RESOLVE', 'REOPEN', 'CLOSE'],
    },
    target_status: {
      type: 'string',
      enum: [
        'NEW',
        'CLASSIFIED',
        'ASSIGNED',
        'IN_PROGRESS',
        'WAITING_CUSTOMER',
        'RESOLVED',
        'CLOSED',
      ],
    },
    assigned_owner: { type: ['string', 'null'] },
    notes: { type: 'string' },
  },
  additionalProperties: false,
};

/** Output schema of §4.3 skill 19, verbatim. */
const output_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: [
    'case_id',
    'customer_id',
    'intent',
    'priority',
    'status',
    'conversation_id',
    'related_order_id',
    'evidence_refs',
    'assigned_owner',
    'sla_target_hours',
    'updated_at',
  ],
  properties: {
    case_id: { type: 'string' },
    customer_id: { type: 'string' },
    intent: { type: 'string' },
    priority: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4'] },
    status: {
      type: 'string',
      enum: [
        'NEW',
        'CLASSIFIED',
        'ASSIGNED',
        'IN_PROGRESS',
        'WAITING_CUSTOMER',
        'RESOLVED',
        'CLOSED',
      ],
    },
    conversation_id: { type: 'string' },
    related_order_id: { type: ['string', 'null'] },
    evidence_refs: { type: 'array', items: { type: 'string' } },
    assigned_owner: { type: ['string', 'null'] },
    sla_target_hours: { type: 'integer' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

/** The declarative half of the row; `skill_id` is supplied by the factory (§4.3 skill 19). */
const spec: Omit<PlatformRowSpec, 'skill_id'> = {
  purpose:
    'Creates, transitions, and persists Customer Support support cases following the SRS §8 canonical 7-state FSM (`NEW` -> `CLASSIFIED` -> `ASSIGNED` -> `IN_PROGRESS` -> `WAITING_CUSTOMER` -> `RESOLVED` -> `CLOSED`), shared verbatim with §03 Entity 18 and the SCR-002 case UI.',
  effect_class: 'INTERNAL',
  guarded_dependency: 'PostgreSQL.CaseManagementStore',
  input_schema,
  output_schema,
  allowed_agents: ['CS-01'],
  required_authority: 'AUTH-3',
  tool_binding: 'PostgreSQL.CaseManagementStore',
  validation_rules: [
    'if action_type is TRANSITION_STATE/ASSIGN/RESOLVE, case_id is mandatory',
    'status transitions must strictly follow the SRS §8 7-state FSM matrix; an illegal transition is INVALID_FSM_TRANSITION and leaves the case untouched',
    'REOPEN is an action, not a state: it transitions RESOLVED | CLOSED -> IN_PROGRESS while preserving case_number, SLA history, and evidence; no REOPENED state exists (§03 Entity 18)',
    'priority must be one of P1..P4 (P1 urgent ... P4 low), the single vocabulary shared by DB, skill, and UI',
    'a timeout is never retried blind: this skill declares retry_on_timeout: false, so an unconfirmed outcome is reconciled by re-reading the case for (tenant_id, case_id) before any retry',
  ],
  retry_policy: {
    max_retries: 3,
    initial_interval_ms: 300,
    backoff_multiplier: 1.5,
    retry_on_timeout: false,
    non_retryable_errors: ['CASE_NOT_FOUND', 'INVALID_FSM_TRANSITION'],
  },
  timeout_ms: 2000,
  audit_spec: {
    log_level: 'INFO',
    mask_pii_fields: ['customer_id'],
    evidence_card: 'EV_SUPPORT_CASE',
    record_latency: true,
  },
  test_cases: [
    {
      test_id: 'TC-SKILL-01',
      category: 'HAPPY_PATH',
      scenario:
        '`CS-01` at `AUTH-3` submits an FSM-legal action with the required `case_id` and the store accepts the write.',
      expected_outcome: 'Legal transition persisted once with status, SLA, evidence refs',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02',
      category: 'AUTHORITY',
      scenario:
        'An FSM-illegal transition is requested, and an `AUTH-2` caller attempts the same write.',
      expected_outcome:
        'Illegal transition → `INVALID_FSM_TRANSITION`, case unchanged; `AUTH-2` → `INSUFFICIENT_AUTHORITY`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-03',
      category: 'SCHEMA_INVALIDATION',
      scenario: 'A `TRANSITION_STATE` payload without `case_id` is submitted.',
      expected_outcome: 'Missing `case_id` for `TRANSITION_STATE` → `SCHEMA_VALIDATION_ERROR`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04',
      category: 'TIMEOUT',
      scenario:
        'PostgreSQL.CaseManagementStore does not answer within the row timeout of 2000ms.',
      expected_outcome:
        '`retry_on_timeout:false` → re-read by `(tenant_id, case_id)` before any retry; no double transition',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05',
      category: 'IDEMPOTENCY',
      scenario:
        'The same transition is submitted twice with the same payload, and a `REOPEN` is replayed on a `CLOSED` case.',
      expected_outcome:
        'Replayed transition absorbed by the optimistic version; `REOPEN` returns `IN_PROGRESS` once, preserving `case_number`, SLA history, evidence',
      required: true,
    },
    {
      test_id: 'TC-SKILL-19-06',
      category: 'VALIDATION',
      scenario: 'Illegal FSM transition, e.g. `NEW` -> `RESOLVED`.',
      expected_outcome:
        '`INVALID_FSM_TRANSITION` (non-retryable); the case keeps its previous state and no partial write occurs.',
      required: true,
    },
    {
      test_id: 'TC-SKILL-19-07',
      category: 'VALIDATION',
      scenario: '`REOPEN` on a `RESOLVED`/`CLOSED` case.',
      expected_outcome:
        'The case returns to `IN_PROGRESS` preserving `case_number`, SLA history, and evidence; no `REOPENED` state is ever stored (SRS §8, §03 Entity 18).',
      required: true,
    },
  ],
};

/**
 * Builds the `skill.care.manage_case` row (§4.3 skill 19).
 *
 * @param deps Injected tool port and clock; the row holds no ambient dependency.
 * @returns The row, with `validateInput` normalizing through its `input_schema` and `execute`
 *   dispatching `PostgreSQL.CaseManagementStore` through the tool port.
 */
export function createCareManageCase(
  deps: PlatformSkillDependencies,
): PlatformSkillRow<InputCareManageCase, OutputCareManageCase> {
  return definePlatformRow<InputCareManageCase, OutputCareManageCase>(deps, {
    ...spec,
    skill_id: CARE_MANAGE_CASE_SKILL_ID,
  });
}
