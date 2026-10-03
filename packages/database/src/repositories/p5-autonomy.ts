import type { QueryResultRow } from 'pg';

import { withTenantContext } from '../rls.js';
import { assertIdentifier } from './durable-workflows.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

const AUTONOMY_POLICIES = 'agentos.autonomy_policies';
const AUTONOMY_POLICY_EVENTS = 'agentos.autonomy_policy_events';
const AUTONOMY_CONTROLS = 'agentos.tenant_autonomy_controls';
const TOKEN_COST_RECORDS = 'agentos.token_cost_records';
const LLM_TENANT_TOKEN_BUDGET_USAGE = 'agentos.llm_tenant_token_budget_usage';
const LLM_RUN_TOKEN_BUDGET_USAGE = 'agentos.llm_run_token_budget_usage';
const LLM_TOKEN_BUDGET_RESERVATIONS = 'agentos.llm_token_budget_reservations';

export type AutonomyPolicyState = 'MINIMUM' | 'PROMOTED' | 'PAUSED' | 'DEMOTED';

export interface AutonomyPolicyRecord {
  readonly tenant_id: string;
  readonly skill_id: string;
  readonly policy_version: string;
  readonly policy_id: string;
  readonly state: AutonomyPolicyState;
  readonly previous_approved_state: AutonomyPolicyState;
  readonly evidence_window_ref: string | null;
  readonly approver_id: string | null;
  readonly reason: string;
  readonly parameters: Record<string, unknown>;
  readonly provenance: Record<string, unknown>;
  readonly effective_at: string;
  readonly rollback_policy_version: string;
  readonly rollback_state: AutonomyPolicyState;
  readonly audit_ref: string | null;
  readonly evidence_ref: string | null;
  readonly policy_revision: number;
}

export interface CommitAutonomyPolicyEventInput {
  readonly trigger: string;
  readonly from_state: AutonomyPolicyState;
  readonly to_state: AutonomyPolicyState;
  readonly actor: string;
  readonly reason: string;
  readonly audit_ref: string | null;
  readonly snapshot: Record<string, unknown>;
  readonly occurred_at: string;
}

export interface CommitAutonomyPolicyInput {
  readonly tenant_id: string;
  readonly skill_id: string;
  readonly policy_version: string;
  readonly policy_id: string;
  readonly state: AutonomyPolicyState;
  readonly previous_approved_state: AutonomyPolicyState;
  readonly evidence_window_ref: string | null;
  readonly approver_id: string | null;
  readonly reason: string;
  readonly parameters: Record<string, unknown>;
  readonly provenance: Record<string, unknown>;
  readonly effective_at: string;
  readonly rollback_policy_version: string;
  readonly rollback_state: AutonomyPolicyState;
  readonly audit_ref: string | null;
  readonly evidence_ref: string | null;
  readonly expected_revision?: number;
  readonly policy_event?: CommitAutonomyPolicyEventInput;
}

export interface AutonomyPolicyEventRecord {
  readonly event_id: string;
  readonly tenant_id: string;
  readonly skill_id: string;
  readonly policy_version: string;
  readonly trigger: string;
  readonly from_state: AutonomyPolicyState;
  readonly to_state: AutonomyPolicyState;
  readonly actor: string;
  readonly reason: string;
  readonly audit_ref: string | null;
  readonly occurred_at: string;
}

export interface AppendAutonomyPolicyEventInput {
  readonly event_id?: string;
  readonly tenant_id: string;
  readonly skill_id: string;
  readonly policy_version: string;
  readonly trigger: string;
  readonly from_state: AutonomyPolicyState;
  readonly to_state: AutonomyPolicyState;
  readonly actor: string;
  readonly reason: string;
  readonly audit_ref: string | null;
  readonly snapshot: Record<string, unknown>;
  readonly occurred_at: string;
}

export type AutonomyPromotionRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/** Server-computed evidence window the caller feeds to `evaluatePromotionRequest`. */
export interface AutonomyPromotionEvidenceWindowRecord {
  readonly window_ref: string;
  readonly authority_violations: number;
  readonly duplicate_effects: number;
  readonly audit_complete: boolean;
  readonly evidence_complete: boolean;
  readonly cost?: { readonly amount: number; readonly currency: string } | null;
  readonly cost_provenance_ref?: string;
  readonly latency_ms?: number | null;
  readonly latency_provenance_ref?: string;
}

export interface AutonomyPromotionRequestRecord {
  readonly request_id: string;
  readonly tenant_id: string;
  readonly skill_id: string;
  readonly policy_version: string;
  readonly required_authority: string;
  readonly requester_id: string;
  readonly approver_id: string | null;
  readonly status: AutonomyPromotionRequestStatus;
  readonly code: string;
  readonly reason: string;
  readonly evidence_window: AutonomyPromotionEvidenceWindowRecord;
  readonly evidence_window_ref: string;
  readonly expected_revision: number | null;
  readonly policy_revision: number | null;
  readonly created_at: string;
  readonly decided_at: string | null;
}

export interface CreateAutonomyPromotionRequestInput {
  readonly tenant_id: string;
  readonly skill_id: string;
  readonly policy_version: string;
  readonly required_authority: string;
  readonly requester_id: string;
  readonly approver_id: string | null;
  readonly status: AutonomyPromotionRequestStatus;
  readonly code: string;
  readonly reason: string;
  readonly evidence_window: AutonomyPromotionEvidenceWindowRecord;
  readonly evidence_window_ref: string;
  readonly expected_revision?: number;
}

export interface DecideAutonomyPromotionRequestInput {
  readonly tenant_id: string;
  readonly request_id: string;
  readonly status: AutonomyPromotionRequestStatus;
  readonly code: string;
  readonly reason: string;
  readonly approver_id: string | null;
  readonly policy_revision: number | null;
  readonly decided_at: string;
}

export interface TenantAutonomyControlRecord {
  readonly tenant_id: string;
  readonly paused: boolean;
  readonly kill_switch: boolean;
  readonly actor: string | null;
  readonly reason: string | null;
  readonly effective_at: string;
}

export interface CommitTenantAutonomyControlInput {
  readonly tenant_id: string;
  readonly paused: boolean;
  readonly kill_switch: boolean;
  readonly actor: string | null;
  readonly reason: string | null;
  readonly effective_at: string;
}

export interface TokenCostRecord {
  readonly tenant_id: string;
  readonly record_id: string;
  readonly idempotency_key: string;
  readonly run_id: string;
  readonly correlation_id: string;
  readonly model: string | null;
  readonly provider: string | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cached_tokens: number | null;
  readonly estimated_cost_amount: string | null;
  readonly currency: string | null;
  readonly cost_status: 'RECORDED' | 'UNAVAILABLE';
  readonly provenance: Record<string, unknown>;
  readonly recorded_at: string;
}

export interface AppendTokenCostRecordInput {
  readonly tenant_id: string;
  readonly record_id: string;
  /** Stable producer key used to make retries a no-op; record_id is the compatibility fallback. */
  readonly idempotency_key?: string;
  readonly run_id: string;
  readonly correlation_id: string;
  readonly model: string | null;
  readonly provider: string | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cached_tokens: number | null;
  readonly estimated_cost_amount: string | number | null;
  readonly currency: string | null;
  readonly cost_status: 'RECORDED' | 'UNAVAILABLE';
  readonly provenance: Record<string, unknown>;
  readonly recorded_at: string;
}

export interface ReserveLlmTokenBudgetInput {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly reservation_id: string;
  readonly estimated_tokens: number;
  readonly tenant_token_budget: number | null;
  readonly run_token_budget: number | null;
}

interface AutonomyPolicyRow extends QueryResultRow {
  tenant_id: string;
  skill_id: string;
  policy_version: string;
  policy_id: string;
  state: AutonomyPolicyState;
  previous_approved_state: AutonomyPolicyState;
  evidence_window_ref: string | null;
  approver_id: string | null;
  reason: string;
  parameters: Record<string, unknown>;
  provenance: Record<string, unknown>;
  effective_at: Date | string;
  rollback_policy_version: string;
  rollback_state: AutonomyPolicyState;
  audit_ref: string | null;
  evidence_ref: string | null;
  policy_revision: number | string;
}

interface AutonomyPolicyEventRow extends QueryResultRow {
  event_id: string;
  tenant_id: string;
  skill_id: string;
  policy_version: string;
  trigger: string;
  from_state: AutonomyPolicyState;
  to_state: AutonomyPolicyState;
  actor: string;
  reason: string;
  audit_ref: string | null;
  occurred_at: Date | string;
}

interface AutonomyPromotionRequestRow extends QueryResultRow {
  request_id: string;
  tenant_id: string;
  skill_id: string;
  policy_version: string;
  required_authority: string;
  requester_id: string;
  approver_id: string | null;
  status: AutonomyPromotionRequestStatus;
  code: string;
  reason: string;
  evidence_window: AutonomyPromotionEvidenceWindowRecord;
  evidence_window_ref: string;
  expected_revision: number | string | null;
  policy_revision: number | string | null;
  created_at: Date | string;
  decided_at: Date | string | null;
}

interface PromotionEvidenceRow extends QueryResultRow {
  authority_violations: number | string;
  duplicate_effects: number | string;
  observations: number | string;
  evidence_gaps: number | string;
  audit_gaps: number | string;
  latency_p95_ms: number | string | null;
  cost_amount: number | string | null;
  cost_currency: string | null;
}

interface TenantAutonomyControlRow extends QueryResultRow {
  tenant_id: string;
  paused: boolean;
  kill_switch: boolean;
  actor: string | null;
  reason: string | null;
  effective_at: Date | string;
}

interface TokenCostRow extends QueryResultRow {
  tenant_id: string;
  record_id: string;
  idempotency_key: string;
  run_id: string;
  correlation_id: string;
  model: string | null;
  provider: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  estimated_cost_amount: string | null;
  currency: string | null;
  cost_status: 'RECORDED' | 'UNAVAILABLE';
  provenance: Record<string, unknown>;
  recorded_at: Date | string;
}

const POLICY_COLUMNS = `
  tenant_id, skill_id, policy_version, policy_id, state, previous_approved_state,
  evidence_window_ref, approver_id, reason, parameters, provenance, effective_at,
  rollback_policy_version, rollback_state, audit_ref, evidence_ref, policy_revision`;

const EVENT_COLUMNS = `
  event_id, tenant_id, skill_id, policy_version, trigger, from_state, to_state,
  actor, reason, audit_ref, occurred_at, snapshot`;

const CONTROL_COLUMNS = `
  tenant_id, paused, kill_switch, actor, reason, effective_at`;

const COST_COLUMNS = `
  tenant_id, record_id, idempotency_key, run_id, correlation_id, model, provider, input_tokens,
  output_tokens, cached_tokens, estimated_cost_amount, currency, cost_status,
  provenance, recorded_at`;

const SELECT_POLICY = `SELECT ${POLICY_COLUMNS}
  FROM ${AUTONOMY_POLICIES}
  WHERE tenant_id = $1 AND skill_id = $2 AND policy_version = $3`;

const SELECT_POLICIES = `SELECT ${POLICY_COLUMNS}
  FROM ${AUTONOMY_POLICIES}
  WHERE tenant_id = $1
  ORDER BY skill_id ASC, policy_version ASC`;

const SELECT_POLICIES_BY_SKILL = `SELECT ${POLICY_COLUMNS}
  FROM ${AUTONOMY_POLICIES}
  WHERE tenant_id = $1 AND skill_id = $2
  ORDER BY skill_id ASC, policy_version ASC`;

const SELECT_POLICY_EVENTS = `SELECT ${EVENT_COLUMNS}
  FROM ${AUTONOMY_POLICY_EVENTS}
  WHERE tenant_id = $1
  ORDER BY occurred_at ASC, event_id ASC`;

const SELECT_CONTROL = `SELECT ${CONTROL_COLUMNS}
  FROM ${AUTONOMY_CONTROLS}
  WHERE tenant_id = $1`;

const INSERT_POLICY = `INSERT INTO ${AUTONOMY_POLICIES} AS current_policy (
    tenant_id, skill_id, policy_version, policy_id, state, previous_approved_state,
    evidence_window_ref, approver_id, reason, parameters, provenance, effective_at,
    rollback_policy_version, rollback_state, audit_ref, evidence_ref
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::timestamptz,
    $13, $14, $15, $16)
  ON CONFLICT (tenant_id, skill_id, policy_version) DO UPDATE SET
    policy_id = EXCLUDED.policy_id,
    state = EXCLUDED.state,
    previous_approved_state = EXCLUDED.previous_approved_state,
    evidence_window_ref = EXCLUDED.evidence_window_ref,
    approver_id = EXCLUDED.approver_id,
    reason = EXCLUDED.reason,
    parameters = EXCLUDED.parameters,
    provenance = EXCLUDED.provenance,
    effective_at = EXCLUDED.effective_at,
    rollback_policy_version = EXCLUDED.rollback_policy_version,
    rollback_state = EXCLUDED.rollback_state,
    audit_ref = EXCLUDED.audit_ref,
    evidence_ref = EXCLUDED.evidence_ref,
    policy_revision = current_policy.policy_revision + 1
  WHERE $17::bigint IS NULL OR current_policy.policy_revision = $17::bigint
  RETURNING ${POLICY_COLUMNS}`;

const INSERT_POLICY_EVENT = `INSERT INTO ${AUTONOMY_POLICY_EVENTS} (
    event_id, tenant_id, skill_id, policy_version, trigger, from_state, to_state,
    actor, reason, audit_ref, snapshot, occurred_at
  ) VALUES (COALESCE($1::uuid, agentos.uuid_generate_v7()), $2, $3, $4, $5, $6, $7, $8, $9, $10,
    $11::jsonb, $12::timestamptz)
  RETURNING ${EVENT_COLUMNS}`;

const INSERT_CONTROL_EVENT = `INSERT INTO agentos.autonomy_control_events (
    tenant_id, event_type, actor, reason, skill_id, policy_version, occurred_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
  RETURNING event_id, tenant_id, event_type, actor, reason, skill_id, policy_version, occurred_at`;

const SELECT_CONTROL_EVENTS = `SELECT event_id, tenant_id, event_type, actor, reason, skill_id,
    policy_version, occurred_at
  FROM agentos.autonomy_control_events
  WHERE tenant_id = $1
  ORDER BY occurred_at ASC, event_id ASC`;

const SELECT_POLICY_SNAPSHOTS = `SELECT snapshot
  FROM ${AUTONOMY_POLICY_EVENTS}
  WHERE tenant_id = $1
  ORDER BY occurred_at ASC, event_id ASC`;

const UPSERT_CONTROL = `INSERT INTO ${AUTONOMY_CONTROLS} (
    tenant_id, paused, kill_switch, actor, reason, effective_at
  ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
  ON CONFLICT (tenant_id) DO UPDATE SET
    paused = EXCLUDED.paused,
    kill_switch = EXCLUDED.kill_switch,
    actor = EXCLUDED.actor,
    reason = EXCLUDED.reason,
    effective_at = EXCLUDED.effective_at
  RETURNING ${CONTROL_COLUMNS}`;

const INSERT_COST = `INSERT INTO ${TOKEN_COST_RECORDS} (
    tenant_id, record_id, idempotency_key, run_id, correlation_id, model, provider, input_tokens,
    output_tokens, cached_tokens, estimated_cost_amount, currency, cost_status,
    provenance, recorded_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::timestamptz)
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
  RETURNING ${COST_COLUMNS}`;

const SELECT_COST_BY_IDEMPOTENCY = `SELECT ${COST_COLUMNS}
  FROM ${TOKEN_COST_RECORDS}
  WHERE tenant_id = $1 AND idempotency_key = $2`;

const SELECT_COSTS = `SELECT ${COST_COLUMNS}
  FROM ${TOKEN_COST_RECORDS}
  WHERE tenant_id = $1
  ORDER BY recorded_at ASC, record_id ASC`;

const SELECT_COSTS_BY_RUN = `SELECT ${COST_COLUMNS}
  FROM ${TOKEN_COST_RECORDS}
  WHERE tenant_id = $1 AND run_id = $2
  ORDER BY recorded_at ASC, record_id ASC`;
const SELECT_COST_USAGE_TOTAL = `SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0)::BIGINT AS total_tokens
  FROM ${TOKEN_COST_RECORDS}
  WHERE tenant_id = $1`;

const INSERT_TENANT_TOKEN_BUDGET = `INSERT INTO ${LLM_TENANT_TOKEN_BUDGET_USAGE} (
    tenant_id, used_tokens, reserved_tokens
  )
  SELECT $1::uuid, COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0), 0
    FROM ${TOKEN_COST_RECORDS}
   WHERE tenant_id = $1::uuid
  ON CONFLICT (tenant_id) DO NOTHING`;
const INSERT_RUN_TOKEN_BUDGET = `INSERT INTO ${LLM_RUN_TOKEN_BUDGET_USAGE} (
    tenant_id, run_id, used_tokens, reserved_tokens
  )
  SELECT $1::uuid, $2::varchar, COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0), 0
    FROM ${TOKEN_COST_RECORDS}
   WHERE tenant_id = $1::uuid AND run_id = $2::varchar
  ON CONFLICT (tenant_id, run_id) DO NOTHING`;
const SELECT_TENANT_TOKEN_BUDGET = `SELECT used_tokens, reserved_tokens
  FROM ${LLM_TENANT_TOKEN_BUDGET_USAGE}
  WHERE tenant_id = $1
  FOR UPDATE`;
const SELECT_RUN_TOKEN_BUDGET = `SELECT used_tokens, reserved_tokens
  FROM ${LLM_RUN_TOKEN_BUDGET_USAGE}
  WHERE tenant_id = $1 AND run_id = $2
  FOR UPDATE`;
const SELECT_LLM_TOKEN_RESERVATION = `SELECT estimated_tokens, state
  FROM ${LLM_TOKEN_BUDGET_RESERVATIONS}
  WHERE tenant_id = $1 AND run_id = $2 AND reservation_id = $3
  FOR UPDATE`;
const INSERT_LLM_TOKEN_RESERVATION = `INSERT INTO ${LLM_TOKEN_BUDGET_RESERVATIONS} (
    tenant_id, run_id, reservation_id, estimated_tokens, state
  ) VALUES ($1, $2, $3, $4, 'RESERVED')
  ON CONFLICT (tenant_id, run_id, reservation_id) DO NOTHING
  RETURNING reservation_id`;
const INCREMENT_TENANT_RESERVED_TOKENS = `UPDATE ${LLM_TENANT_TOKEN_BUDGET_USAGE}
  SET reserved_tokens = reserved_tokens + $2
  WHERE tenant_id = $1`;
const INCREMENT_RUN_RESERVED_TOKENS = `UPDATE ${LLM_RUN_TOKEN_BUDGET_USAGE}
  SET reserved_tokens = reserved_tokens + $3
  WHERE tenant_id = $1 AND run_id = $2`;
const SETTLE_LLM_TOKEN_RESERVATION = `UPDATE ${LLM_TOKEN_BUDGET_RESERVATIONS}
  SET state = 'SETTLED', actual_tokens = COALESCE($4, estimated_tokens), settled_at = clock_timestamp()
  WHERE tenant_id = $1 AND run_id = $2 AND reservation_id = $3 AND state = 'RESERVED'
  RETURNING estimated_tokens`;
const DELETE_LLM_TOKEN_RESERVATION = `DELETE FROM ${LLM_TOKEN_BUDGET_RESERVATIONS}
  WHERE tenant_id = $1 AND run_id = $2 AND reservation_id = $3 AND state = 'RESERVED'
  RETURNING estimated_tokens`;
const SETTLE_TENANT_TOKEN_BUDGET = `UPDATE ${LLM_TENANT_TOKEN_BUDGET_USAGE}
  SET reserved_tokens = reserved_tokens - $2, used_tokens = used_tokens + $3
  WHERE tenant_id = $1`;
const SETTLE_RUN_TOKEN_BUDGET = `UPDATE ${LLM_RUN_TOKEN_BUDGET_USAGE}
  SET reserved_tokens = reserved_tokens - $3, used_tokens = used_tokens + $4
  WHERE tenant_id = $1 AND run_id = $2`;
const RELEASE_TENANT_TOKEN_BUDGET = `UPDATE ${LLM_TENANT_TOKEN_BUDGET_USAGE}
  SET reserved_tokens = reserved_tokens - $2
  WHERE tenant_id = $1`;
const RELEASE_RUN_TOKEN_BUDGET = `UPDATE ${LLM_RUN_TOKEN_BUDGET_USAGE}
  SET reserved_tokens = reserved_tokens - $3
  WHERE tenant_id = $1 AND run_id = $2`;

const PROMOTION_REQUEST_COLUMNS = `
  request_id, tenant_id, skill_id, policy_version, required_authority, requester_id, approver_id,
  status, code, reason, evidence_window, evidence_window_ref, expected_revision, policy_revision,
  created_at, decided_at`;

const INSERT_PROMOTION_REQUEST = `INSERT INTO agentos.autonomy_promotion_requests (
    tenant_id, skill_id, policy_version, required_authority, requester_id, approver_id,
    status, code, reason, evidence_window, evidence_window_ref, expected_revision
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::bigint)
  RETURNING ${PROMOTION_REQUEST_COLUMNS}`;

const SELECT_PROMOTION_REQUEST = `SELECT ${PROMOTION_REQUEST_COLUMNS}
  FROM agentos.autonomy_promotion_requests
  WHERE tenant_id = $1 AND request_id = $2`;

const SELECT_PROMOTION_REQUESTS = `SELECT ${PROMOTION_REQUEST_COLUMNS}
  FROM agentos.autonomy_promotion_requests
  WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2::text)
  ORDER BY created_at DESC, request_id DESC`;

const UPDATE_PROMOTION_REQUEST = `UPDATE agentos.autonomy_promotion_requests
  SET status = $3, code = $4, reason = $5, approver_id = $6, policy_revision = $7::bigint,
    decided_at = $8::timestamptz
  WHERE tenant_id = $1 AND request_id = $2
  RETURNING ${PROMOTION_REQUEST_COLUMNS}`;

/**
 * Server-computed promotion evidence over the last `days` days. Violations, refusals, duplicate
 * effect keys, p95 latency and cost are read from durable stage results, effect reservations and
 * the cost ledger; audit coverage comes from the compliance ledger, never a stage-detail claim.
 *
 * Only steps that entered EXECUTION require an execution audit; PLAN and parked pre-dispatch
 * stages are not executed effects. Terminal audits carry action.step_index. Policy audits
 * carry action.effect_key instead, bound to this exact step by its immutable evidence record.
 * Neither a stage-detail claim nor an effect reservation alone establishes audit coverage.
 */
const SELECT_PROMOTION_EVIDENCE = `SELECT
  (SELECT COUNT(*) FROM agentos.run_stage_results r
    WHERE r.tenant_id = $1 AND ($2::text IS NULL OR r.skill_id = $2::text)
      AND r.started_at >= $3::timestamptz AND r.status IN ('refused', 'failed')
      AND (COALESCE(r.refusal_code, '') ILIKE '%AUTHORITY%' OR COALESCE(r.error_class, '') ILIKE '%AUTHORITY%'
        OR COALESCE(r.refusal_code, '') ILIKE '%VIOLATION%' OR COALESCE(r.error_class, '') ILIKE '%VIOLATION%')
  )::int AS authority_violations,
  (SELECT COUNT(*) FROM (
    SELECT er.request_fingerprint FROM agentos.effect_reservations er
    WHERE er.tenant_id = $1 AND ($2::text IS NULL OR er.skill_id = $2::text)
      AND er.reserved_at >= $3::timestamptz
    GROUP BY er.request_fingerprint HAVING COUNT(DISTINCT er.effect_key) > 1
  ) AS duplicates)::int AS duplicate_effects,
  (SELECT COUNT(*) FROM agentos.run_stage_results r
    WHERE r.tenant_id = $1 AND ($2::text IS NULL OR r.skill_id = $2::text) AND r.started_at >= $3::timestamptz
  )::int AS observations,
  (SELECT COUNT(*) FROM agentos.run_stage_results r
    WHERE r.tenant_id = $1 AND ($2::text IS NULL OR r.skill_id = $2::text) AND r.started_at >= $3::timestamptz
      AND (r.summary_key IS NULL OR r.input_digest IS NULL OR r.output_digest IS NULL)
  )::int AS evidence_gaps,
  (SELECT COUNT(*) FROM agentos.run_stage_results r
    WHERE r.tenant_id = $1 AND ($2::text IS NULL OR r.skill_id = $2::text) AND r.started_at >= $3::timestamptz
      AND r.skill_id IS NOT NULL
      AND r.stage = 'EXECUTION'
      AND NOT EXISTS (
        SELECT 1 FROM agentos.audit_records a
        WHERE a.tenant_id = r.tenant_id AND a.run_id = r.run_id AND a.skill = r.skill_id
          AND (
            a.action->>'step_index' = r.step_index::text
            OR (
              a.action->>'step_index' IS NULL
              AND EXISTS (
                SELECT 1 FROM agentos.evidence_records e
                WHERE e.tenant_id = r.tenant_id AND e.run_id = r.run_id AND e.step_index = r.step_index
                  AND e.raw_payload#>>'{action,skill_id}' = r.skill_id
                  AND e.effect_key = a.action->>'effect_key'
              )
            )
          )
      )
  )::int AS audit_gaps,
  (SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY r.duration_ms) FROM agentos.run_stage_results r
    WHERE r.tenant_id = $1 AND ($2::text IS NULL OR r.skill_id = $2::text) AND r.started_at >= $3::timestamptz
  )::int AS latency_p95_ms,
  (SELECT COALESCE(SUM(c.estimated_cost_amount), 0) FROM agentos.token_cost_records c
    WHERE c.tenant_id = $1 AND c.recorded_at >= $3::timestamptz
  ) AS cost_amount,
  (SELECT MAX(c.currency) FROM agentos.token_cost_records c
    WHERE c.tenant_id = $1 AND c.recorded_at >= $3::timestamptz
  ) AS cost_currency`;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toPolicy(row: AutonomyPolicyRow): AutonomyPolicyRecord {
  const policy_revision = Number(row.policy_revision);
  if (!Number.isSafeInteger(policy_revision) || policy_revision < 1) {
    throw new Error('P5_AUTONOMY_REVISION_INVALID: stored policy revision is invalid.');
  }
  return { ...row, policy_revision, effective_at: iso(row.effective_at) };
}

function toPolicyEvent(row: AutonomyPolicyEventRow): AutonomyPolicyEventRecord {
  return { ...row, occurred_at: iso(row.occurred_at) };
}

function toControl(row: TenantAutonomyControlRow): TenantAutonomyControlRecord {
  return { ...row, effective_at: iso(row.effective_at) };
}

function optionalRevision(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

const EMPTY_EVIDENCE = {
  authority_violations: 0,
  duplicate_effects: 0,
  audit_complete: false,
  evidence_complete: false,
} as const;

function toPromotionRequest(row: AutonomyPromotionRequestRow): AutonomyPromotionRequestRecord {
  return {
    ...row,
    evidence_window: row.evidence_window ?? { window_ref: row.evidence_window_ref, ...EMPTY_EVIDENCE },
    expected_revision: optionalRevision(row.expected_revision),
    policy_revision: optionalRevision(row.policy_revision),
    created_at: iso(row.created_at),
    decided_at: row.decided_at === null ? null : iso(row.decided_at),
  };
}

function toCost(row: TokenCostRow): TokenCostRecord {
  return { ...row, recorded_at: iso(row.recorded_at) };
}

function requireText(value: unknown, field: string, code: string, maxLength: number): string {
  assertIdentifier(value, field, maxLength, code);
  return value as string;
}

function requireInstant(value: unknown, field: string, code: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${code}: ${field} must be an ISO-8601 timestamp.`);
  }
  return value;
}

export class P5AutonomyRepository {
  constructor(private readonly runInTenantTransaction: TenantTransactionRunner = withTenantContext) {}

  async get(tenant_id: string, skill_id: string, policy_version: string): Promise<AutonomyPolicyRecord | null> {
    requireText(tenant_id, 'tenant_id', 'P5_AUTONOMY_TENANT_REQUIRED', 36);
    requireText(skill_id, 'skill_id', 'P5_AUTONOMY_SKILL_REQUIRED', 128);
    requireText(policy_version, 'policy_version', 'P5_AUTONOMY_VERSION_REQUIRED', 64);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<AutonomyPolicyRow>(SELECT_POLICY, [tenant_id, skill_id, policy_version]);
      const row = result.rows[0];
      return row === undefined ? null : toPolicy(row);
    });
  }

  async list(tenant_id: string, skill_id?: string): Promise<readonly AutonomyPolicyRecord[]> {
    requireText(tenant_id, 'tenant_id', 'P5_AUTONOMY_TENANT_REQUIRED', 36);
    if (skill_id !== undefined) requireText(skill_id, 'skill_id', 'P5_AUTONOMY_SKILL_REQUIRED', 128);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = skill_id === undefined
        ? await client.query<AutonomyPolicyRow>(SELECT_POLICIES, [tenant_id])
        : await client.query<AutonomyPolicyRow>(SELECT_POLICIES_BY_SKILL, [tenant_id, skill_id]);
      return result.rows.map(toPolicy);
    });
  }

  async commit(input: CommitAutonomyPolicyInput): Promise<AutonomyPolicyRecord> {
    return this.commitPolicy(input);
  }

  async commitPolicy(input: CommitAutonomyPolicyInput): Promise<AutonomyPolicyRecord> {
    requireText(input.tenant_id, 'tenant_id', 'P5_AUTONOMY_TENANT_REQUIRED', 36);
    requireText(input.skill_id, 'skill_id', 'P5_AUTONOMY_SKILL_REQUIRED', 128);
    requireText(input.policy_version, 'policy_version', 'P5_AUTONOMY_VERSION_REQUIRED', 64);
    requireText(input.policy_id, 'policy_id', 'P5_AUTONOMY_POLICY_ID_REQUIRED', 36);
    requireText(input.reason, 'reason', 'P5_AUTONOMY_REASON_REQUIRED', 4096);
    requireInstant(input.effective_at, 'effective_at', 'P5_AUTONOMY_EFFECTIVE_AT_REQUIRED');
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<AutonomyPolicyRow>(INSERT_POLICY, [
        input.tenant_id,
        input.skill_id,
        input.policy_version,
        input.policy_id,
        input.state,
        input.previous_approved_state,
        input.evidence_window_ref,
        input.approver_id,
        input.reason,
        JSON.stringify(input.parameters),
        JSON.stringify(input.provenance),
        input.effective_at,
        input.rollback_policy_version,
        input.rollback_state,
        input.audit_ref,
        input.evidence_ref,
        input.expected_revision ?? null,
      ]);
      const row = result.rows[0];
      if (row === undefined) {
        if (input.expected_revision !== undefined) {
          throw new Error('P5_AUTONOMY_REVISION_CONFLICT: the policy changed since it was read.');
        }
        throw new Error('P5_AUTONOMY_COMMIT_EMPTY: policy write returned no row.');
      }
      const event = input.policy_event;
      if (event !== undefined) {
        // The policy transition and its event share one transaction, so a reader never observes a
        // committed state change without its audit event.
        await client.query<AutonomyPolicyEventRow>(INSERT_POLICY_EVENT, [
          null,
          input.tenant_id,
          input.skill_id,
          input.policy_version,
          event.trigger,
          event.from_state,
          event.to_state,
          event.actor,
          event.reason,
          event.audit_ref,
          JSON.stringify(event.snapshot),
          event.occurred_at,
        ]);
      }
      return toPolicy(row);
    });
  }

  async append(input: AppendAutonomyPolicyEventInput): Promise<AutonomyPolicyEventRecord> {
    return this.appendPolicyEvent(input);
  }

  async appendPolicyEvent(input: AppendAutonomyPolicyEventInput): Promise<AutonomyPolicyEventRecord> {
    requireText(input.tenant_id, 'tenant_id', 'P5_AUTONOMY_TENANT_REQUIRED', 36);
    requireText(input.skill_id, 'skill_id', 'P5_AUTONOMY_SKILL_REQUIRED', 128);
    requireText(input.policy_version, 'policy_version', 'P5_AUTONOMY_VERSION_REQUIRED', 64);
    requireText(input.trigger, 'trigger', 'P5_AUTONOMY_TRIGGER_REQUIRED', 128);
    requireText(input.actor, 'actor', 'P5_AUTONOMY_ACTOR_REQUIRED', 128);
    requireText(input.reason, 'reason', 'P5_AUTONOMY_REASON_REQUIRED', 4096);
    requireInstant(input.occurred_at, 'occurred_at', 'P5_AUTONOMY_OCCURRED_AT_REQUIRED');
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<AutonomyPolicyEventRow>(INSERT_POLICY_EVENT, [
        input.event_id ?? null,
        input.tenant_id,
        input.skill_id,
        input.policy_version,
        input.trigger,
        input.from_state,
        input.to_state,
        input.actor,
        input.reason,
        input.audit_ref,
        input.snapshot,
        input.occurred_at,
      ]);
      const row = result.rows[0];
      if (row === undefined) throw new Error('P5_AUTONOMY_EVENT_EMPTY: event write returned no row.');
      return toPolicyEvent(row);
    });
  }

  async listPolicyEvents(tenant_id: string): Promise<readonly AutonomyPolicyEventRecord[]> {
    requireText(tenant_id, 'tenant_id', 'P5_AUTONOMY_TENANT_REQUIRED', 36);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<AutonomyPolicyEventRow>(SELECT_POLICY_EVENTS, [tenant_id]);
      return result.rows.map(toPolicyEvent);
    });
  }

  async listPolicySnapshots(tenant_id: string): Promise<readonly unknown[]> {
    requireText(tenant_id, 'tenant_id', 'P5_AUTONOMY_TENANT_REQUIRED', 36);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<{ snapshot: unknown }>(SELECT_POLICY_SNAPSHOTS, [tenant_id]);
      return result.rows.map((row) => row.snapshot);
    });
  }

  async appendControlEvent(input: {
    readonly tenant_id: string;
    readonly event_type: string;
    readonly actor: string;
    readonly reason: string;
    readonly skill_id: string | null;
    readonly policy_version: string | null;
    readonly occurred_at: string;
  }): Promise<void> {
    requireText(input.tenant_id, 'tenant_id', 'P5_AUTONOMY_TENANT_REQUIRED', 36);
    requireText(input.event_type, 'event_type', 'P5_AUTONOMY_TRIGGER_REQUIRED', 128);
    requireText(input.actor, 'actor', 'P5_AUTONOMY_ACTOR_REQUIRED', 128);
    requireText(input.reason, 'reason', 'P5_AUTONOMY_REASON_REQUIRED', 4096);
    requireInstant(input.occurred_at, 'occurred_at', 'P5_AUTONOMY_OCCURRED_AT_REQUIRED');
    await this.runInTenantTransaction(input.tenant_id, async (client) => {
      await client.query(INSERT_CONTROL_EVENT, [
        input.tenant_id,
        input.event_type,
        input.actor,
        input.reason,
        input.skill_id,
        input.policy_version,
        input.occurred_at,
      ]);
    });
  }

  async listControlEvents(tenant_id: string): Promise<readonly {
    readonly event_id: string;
    readonly tenant_id: string;
    readonly event_type: string;
    readonly actor: string;
    readonly reason: string;
    readonly skill_id: string | null;
    readonly policy_version: string | null;
    readonly occurred_at: string;
  }[]> {
    requireText(tenant_id, 'tenant_id', 'P5_AUTONOMY_TENANT_REQUIRED', 36);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<{
        event_id: string;
        tenant_id: string;
        event_type: string;
        actor: string;
        reason: string;
        skill_id: string | null;
        policy_version: string | null;
        occurred_at: Date | string;
      }>(SELECT_CONTROL_EVENTS, [tenant_id]);
      return result.rows.map((row) => ({
        ...row,
        occurred_at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
      }));
    });
  }

  async getControls(tenant_id: string): Promise<TenantAutonomyControlRecord | null> {
    requireText(tenant_id, 'tenant_id', 'P5_AUTONOMY_TENANT_REQUIRED', 36);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<TenantAutonomyControlRow>(SELECT_CONTROL, [tenant_id]);
      const row = result.rows[0];
      return row === undefined ? null : toControl(row);
    });
  }

  async commitControls(input: CommitTenantAutonomyControlInput): Promise<TenantAutonomyControlRecord> {
    requireText(input.tenant_id, 'tenant_id', 'P5_AUTONOMY_TENANT_REQUIRED', 36);
    requireInstant(input.effective_at, 'effective_at', 'P5_AUTONOMY_EFFECTIVE_AT_REQUIRED');
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<TenantAutonomyControlRow>(UPSERT_CONTROL, [
        input.tenant_id,
        input.paused,
        input.kill_switch,
        input.actor,
        input.reason,
        input.effective_at,
      ]);
      const row = result.rows[0];
      if (row === undefined) throw new Error('P5_AUTONOMY_CONTROL_EMPTY: control write returned no row.');
      return toControl(row);
    });
  }

  async reserveTokenBudget(input: ReserveLlmTokenBudgetInput): Promise<boolean> {
    requireText(input.tenant_id, 'tenant_id', 'P5_COST_TENANT_REQUIRED', 36);
    requireText(input.run_id, 'run_id', 'P5_COST_RUN_REQUIRED', 128);
    requireText(input.reservation_id, 'reservation_id', 'P5_COST_RESERVATION_REQUIRED', 128);
    if (!Number.isSafeInteger(input.estimated_tokens) || input.estimated_tokens <= 0) {
      throw new Error('P5_COST_RESERVATION_INVALID: estimated_tokens must be a positive safe integer.');
    }
    for (const [field, value] of [
      ['tenant_token_budget', input.tenant_token_budget],
      ['run_token_budget', input.run_token_budget],
    ] as const) {
      if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new Error(`P5_COST_BUDGET_INVALID: ${field} must be null or a positive safe integer.`);
      }
    }

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      await client.query(INSERT_TENANT_TOKEN_BUDGET, [input.tenant_id]);
      await client.query(INSERT_RUN_TOKEN_BUDGET, [input.tenant_id, input.run_id]);
      const tenantResult = await client.query<{
        used_tokens: number | string;
        reserved_tokens: number | string;
      }>(SELECT_TENANT_TOKEN_BUDGET, [input.tenant_id]);
      const runResult = await client.query<{
        used_tokens: number | string;
        reserved_tokens: number | string;
      }>(SELECT_RUN_TOKEN_BUDGET, [input.tenant_id, input.run_id]);
      const tenantUsage = tenantResult.rows[0];
      const runUsage = runResult.rows[0];
      if (tenantUsage === undefined || runUsage === undefined) {
        throw new Error('P5_COST_BUDGET_UNAVAILABLE: token budget state could not be locked.');
      }
      const existing = await client.query(SELECT_LLM_TOKEN_RESERVATION, [
        input.tenant_id,
        input.run_id,
        input.reservation_id,
      ]);
      if (existing.rows[0] !== undefined) return false;

      const tenantTotal = Number(tenantUsage.used_tokens) + Number(tenantUsage.reserved_tokens);
      const runTotal = Number(runUsage.used_tokens) + Number(runUsage.reserved_tokens);
      if (!Number.isSafeInteger(tenantTotal) || !Number.isSafeInteger(runTotal)) {
        throw new Error('P5_COST_BUDGET_INVALID: stored token totals are not safe integers.');
      }
      const requestedTenantTotal = tenantTotal + input.estimated_tokens;
      const requestedRunTotal = runTotal + input.estimated_tokens;
      if (!Number.isSafeInteger(requestedTenantTotal) || !Number.isSafeInteger(requestedRunTotal)) {
        throw new Error('P5_COST_BUDGET_INVALID: requested token totals overflow safe integer limits.');
      }
      if (
        (input.tenant_token_budget !== null && requestedTenantTotal > input.tenant_token_budget)
        || (input.run_token_budget !== null && requestedRunTotal > input.run_token_budget)
      ) {
        return false;
      }

      const inserted = await client.query(INSERT_LLM_TOKEN_RESERVATION, [
        input.tenant_id,
        input.run_id,
        input.reservation_id,
        input.estimated_tokens,
      ]);
      if (inserted.rows[0] === undefined) return false;
      await client.query(INCREMENT_TENANT_RESERVED_TOKENS, [input.tenant_id, input.estimated_tokens]);
      await client.query(INCREMENT_RUN_RESERVED_TOKENS, [
        input.tenant_id,
        input.run_id,
        input.estimated_tokens,
      ]);
      return true;
    });
  }

  async settleTokenBudget(input: {
    readonly tenant_id: string;
    readonly run_id: string;
    readonly reservation_id: string;
    readonly actual_tokens: number | null;
  }): Promise<void> {
    requireText(input.tenant_id, 'tenant_id', 'P5_COST_TENANT_REQUIRED', 36);
    requireText(input.run_id, 'run_id', 'P5_COST_RUN_REQUIRED', 128);
    requireText(input.reservation_id, 'reservation_id', 'P5_COST_RESERVATION_REQUIRED', 128);
    if (input.actual_tokens !== null && (!Number.isSafeInteger(input.actual_tokens) || input.actual_tokens < 0)) {
      throw new Error('P5_COST_USAGE_INVALID: actual_tokens must be null or a non-negative safe integer.');
    }
    await this.runInTenantTransaction(input.tenant_id, async (client) => {
      await client.query(SELECT_TENANT_TOKEN_BUDGET, [input.tenant_id]);
      await client.query(SELECT_RUN_TOKEN_BUDGET, [input.tenant_id, input.run_id]);
      const reservation = await client.query<{ estimated_tokens: number | string }>(
        SETTLE_LLM_TOKEN_RESERVATION,
        [input.tenant_id, input.run_id, input.reservation_id, input.actual_tokens],
      );
      const row = reservation.rows[0];
      if (row === undefined) return;
      const reserved_tokens = Number(row.estimated_tokens);
      const actual_tokens = input.actual_tokens ?? reserved_tokens;
      if (!Number.isSafeInteger(reserved_tokens) || reserved_tokens <= 0 ||
        !Number.isSafeInteger(actual_tokens) || actual_tokens < 0) {
        throw new Error('P5_COST_USAGE_INVALID: reservation token totals are invalid.');
      }
      await client.query(SETTLE_TENANT_TOKEN_BUDGET, [input.tenant_id, reserved_tokens, actual_tokens]);
      await client.query(SETTLE_RUN_TOKEN_BUDGET, [
        input.tenant_id,
        input.run_id,
        reserved_tokens,
        actual_tokens,
      ]);
    });
  }

  async releaseTokenBudget(input: {
    readonly tenant_id: string;
    readonly run_id: string;
    readonly reservation_id: string;
  }): Promise<void> {
    requireText(input.tenant_id, 'tenant_id', 'P5_COST_TENANT_REQUIRED', 36);
    requireText(input.run_id, 'run_id', 'P5_COST_RUN_REQUIRED', 128);
    requireText(input.reservation_id, 'reservation_id', 'P5_COST_RESERVATION_REQUIRED', 128);
    await this.runInTenantTransaction(input.tenant_id, async (client) => {
      await client.query(SELECT_TENANT_TOKEN_BUDGET, [input.tenant_id]);
      await client.query(SELECT_RUN_TOKEN_BUDGET, [input.tenant_id, input.run_id]);
      const reservation = await client.query<{ estimated_tokens: number | string }>(
        DELETE_LLM_TOKEN_RESERVATION,
        [input.tenant_id, input.run_id, input.reservation_id],
      );
      const row = reservation.rows[0];
      if (row === undefined) return;
      const reserved_tokens = Number(row.estimated_tokens);
      if (!Number.isSafeInteger(reserved_tokens) || reserved_tokens <= 0) {
        throw new Error('P5_COST_RESERVATION_INVALID: stored reserved_tokens are invalid.');
      }
      await client.query(RELEASE_TENANT_TOKEN_BUDGET, [input.tenant_id, reserved_tokens]);
      await client.query(RELEASE_RUN_TOKEN_BUDGET, [input.tenant_id, input.run_id, reserved_tokens]);
    });
  }

  async appendTokenCost(input: AppendTokenCostRecordInput): Promise<TokenCostRecord> {
    requireText(input.tenant_id, 'tenant_id', 'P5_COST_TENANT_REQUIRED', 36);
    requireText(input.record_id, 'record_id', 'P5_COST_RECORD_REQUIRED', 36);
    const idempotency_key = requireText(
      input.idempotency_key ?? input.record_id,
      'idempotency_key',
      'P5_COST_IDEMPOTENCY_REQUIRED',
      128,
    );
    requireText(input.run_id, 'run_id', 'P5_COST_RUN_REQUIRED', 128);
    requireText(input.correlation_id, 'correlation_id', 'P5_COST_CORRELATION_REQUIRED', 128);
    requireInstant(input.recorded_at, 'recorded_at', 'P5_COST_RECORDED_AT_REQUIRED');
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<TokenCostRow>(INSERT_COST, [
        input.tenant_id,
        input.record_id,
        idempotency_key,
        input.run_id,
        input.correlation_id,
        input.model,
        input.provider,
        input.input_tokens,
        input.output_tokens,
        input.cached_tokens,
        input.estimated_cost_amount,
        input.currency,
        input.cost_status,
        JSON.stringify(input.provenance),
        input.recorded_at,
      ]);
      const row = result.rows[0];
      if (row !== undefined) return toCost(row);

      const existing = await client.query<TokenCostRow>(SELECT_COST_BY_IDEMPOTENCY, [
        input.tenant_id,
        idempotency_key,
      ]);
      const existingRow = existing.rows[0];
      if (existingRow === undefined) {
        throw new Error('P5_COST_UNSTABLE: idempotency conflict returned no visible cost row.');
      }
      return toCost(existingRow);
    });
  }

  async listTokenCosts(tenant_id: string, run_id?: string): Promise<readonly TokenCostRecord[]> {
    requireText(tenant_id, 'tenant_id', 'P5_COST_TENANT_REQUIRED', 36);
    if (run_id !== undefined) requireText(run_id, 'run_id', 'P5_COST_RUN_REQUIRED', 128);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = run_id === undefined
        ? await client.query<TokenCostRow>(SELECT_COSTS, [tenant_id])
        : await client.query<TokenCostRow>(SELECT_COSTS_BY_RUN, [tenant_id, run_id]);
      return result.rows.map(toCost);
    });
  }
  async totalTokenUsage(tenant_id: string): Promise<number> {
    requireText(tenant_id, 'tenant_id', 'P5_COST_TENANT_REQUIRED', 36);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<{ total_tokens: number | string }>(SELECT_COST_USAGE_TOTAL, [tenant_id]);
      const total = result.rows[0]?.total_tokens;
      const parsed = typeof total === 'number' ? total : Number(total);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error('P5_COST_USAGE_INVALID: aggregate token usage is not a safe non-negative integer.');
      }
      return parsed;
    });
  }

  /**
   * Server-computed evidence window for a draft-gated skill: authority violations and refusals,
   * duplicate effect keys, p95 latency and cost over the last `window_days` days. Every field is
   * derived from durable run stage results, the compliance audit ledger, effect reservations and
   * the cost ledger.
   */
  async readPromotionEvidence(
    tenant_id: string,
    skill_id: string | null,
    window_days = 30,
  ): Promise<AutonomyPromotionEvidenceWindowRecord> {
    requireText(tenant_id, 'tenant_id', 'P5_AUTONOMY_TENANT_REQUIRED', 36);
    if (skill_id !== null) requireText(skill_id, 'skill_id', 'P5_AUTONOMY_SKILL_REQUIRED', 128);
    if (!Number.isSafeInteger(window_days) || window_days < 1 || window_days > 365) {
      throw new Error('P5_AUTONOMY_WINDOW_INVALID: window_days must be between 1 and 365.');
    }
    const since = new Date(Date.now() - window_days * 86_400_000).toISOString();
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<PromotionEvidenceRow>(SELECT_PROMOTION_EVIDENCE, [tenant_id, skill_id, since]);
      const row = result.rows[0];
      if (row === undefined) throw new Error('P5_AUTONOMY_EVIDENCE_EMPTY: evidence query returned no row.');
      const observations = Number(row.observations);
      const audit_gaps = Number(row.audit_gaps);
      const evidence_gaps = Number(row.evidence_gaps);
      const latency = row.latency_p95_ms === null ? null : Number(row.latency_p95_ms);
      const cost_amount = Number(row.cost_amount);
      const window_ref = `run_stage_results:${tenant_id}:${skill_id ?? '*'}:${window_days}d`;
      return {
        window_ref,
        authority_violations: Number(row.authority_violations),
        duplicate_effects: Number(row.duplicate_effects),
        audit_complete: observations > 0 && audit_gaps === 0,
        evidence_complete: observations > 0 && evidence_gaps === 0,
        ...(cost_amount > 0
          ? {
            cost: { amount: cost_amount, currency: row.cost_currency ?? 'VND' },
            cost_provenance_ref: `token_cost_records:${tenant_id}:${window_ref}`,
          }
          : {}),
        ...(latency === null || observations === 0
          ? {}
          : {
            latency_ms: latency,
            latency_provenance_ref: `run_stage_results:${tenant_id}:p95:${window_days}d`,
          }),
      };
    });
  }

  async createPromotionRequest(
    input: CreateAutonomyPromotionRequestInput,
  ): Promise<AutonomyPromotionRequestRecord> {
    requireText(input.tenant_id, 'tenant_id', 'P5_AUTONOMY_TENANT_REQUIRED', 36);
    requireText(input.skill_id, 'skill_id', 'P5_AUTONOMY_SKILL_REQUIRED', 128);
    requireText(input.policy_version, 'policy_version', 'P5_AUTONOMY_VERSION_REQUIRED', 64);
    requireText(input.required_authority, 'required_authority', 'P5_AUTONOMY_AUTHORITY_REQUIRED', 16);
    requireText(input.requester_id, 'requester_id', 'P5_AUTONOMY_REQUESTER_REQUIRED', 128);
    requireText(input.code, 'code', 'P5_AUTONOMY_CODE_REQUIRED', 64);
    requireText(input.reason, 'reason', 'P5_AUTONOMY_REASON_REQUIRED', 4096);
    requireText(input.evidence_window_ref, 'evidence_window_ref', 'P5_AUTONOMY_EVIDENCE_REQUIRED', 256);
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<AutonomyPromotionRequestRow>(INSERT_PROMOTION_REQUEST, [
        input.tenant_id,
        input.skill_id,
        input.policy_version,
        input.required_authority,
        input.requester_id,
        input.approver_id,
        input.status,
        input.code,
        input.reason,
        JSON.stringify(input.evidence_window),
        input.evidence_window_ref,
        input.expected_revision ?? null,
      ]);
      const row = result.rows[0];
      if (row === undefined) throw new Error('P5_AUTONOMY_REQUEST_EMPTY: promotion request write returned no row.');
      return toPromotionRequest(row);
    });
  }

  async getPromotionRequest(tenant_id: string, request_id: string): Promise<AutonomyPromotionRequestRecord | null> {
    requireText(tenant_id, 'tenant_id', 'P5_AUTONOMY_TENANT_REQUIRED', 36);
    requireText(request_id, 'request_id', 'P5_AUTONOMY_REQUEST_ID_REQUIRED', 36);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<AutonomyPromotionRequestRow>(SELECT_PROMOTION_REQUEST, [tenant_id, request_id]);
      const row = result.rows[0];
      return row === undefined ? null : toPromotionRequest(row);
    });
  }

  async listPromotionRequests(
    tenant_id: string,
    status: AutonomyPromotionRequestStatus | null = null,
  ): Promise<readonly AutonomyPromotionRequestRecord[]> {
    requireText(tenant_id, 'tenant_id', 'P5_AUTONOMY_TENANT_REQUIRED', 36);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<AutonomyPromotionRequestRow>(SELECT_PROMOTION_REQUESTS, [tenant_id, status]);
      return result.rows.map(toPromotionRequest);
    });
  }

  /** Records the decision on an existing PENDING request; the caller commits the policy separately. */
  async decidePromotionRequest(
    input: DecideAutonomyPromotionRequestInput,
  ): Promise<AutonomyPromotionRequestRecord> {
    requireText(input.tenant_id, 'tenant_id', 'P5_AUTONOMY_TENANT_REQUIRED', 36);
    requireText(input.request_id, 'request_id', 'P5_AUTONOMY_REQUEST_ID_REQUIRED', 36);
    requireText(input.code, 'code', 'P5_AUTONOMY_CODE_REQUIRED', 64);
    requireText(input.reason, 'reason', 'P5_AUTONOMY_REASON_REQUIRED', 4096);
    requireInstant(input.decided_at, 'decided_at', 'P5_AUTONOMY_DECIDED_AT_REQUIRED');
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<AutonomyPromotionRequestRow>(UPDATE_PROMOTION_REQUEST, [
        input.tenant_id,
        input.request_id,
        input.status,
        input.code,
        input.reason,
        input.approver_id,
        input.policy_revision,
        input.decided_at,
      ]);
      const row = result.rows[0];
      if (row === undefined) throw new Error('P5_AUTONOMY_REQUEST_MISSING: promotion request was not found.');
      return toPromotionRequest(row);
    });
  }

  getPolicy(tenant_id: string, skill_id: string, policy_version: string): Promise<AutonomyPolicyRecord | null> {
    return this.get(tenant_id, skill_id, policy_version);
  }

  listPolicies(tenant_id: string, skill_id?: string): Promise<readonly AutonomyPolicyRecord[]> {
    return this.list(tenant_id, skill_id);
  }
}

export { P5AutonomyRepository as AutonomyRepository };
