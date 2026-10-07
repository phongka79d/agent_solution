import type { QueryResultRow } from 'pg';

import { withTenantContext } from '../rls.js';
import { assertIdentifier } from './durable-workflows.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

const AUTONOMY_POLICIES = 'agentos.autonomy_policies';
const AUTONOMY_POLICY_EVENTS = 'agentos.autonomy_policy_events';
const AUTONOMY_CONTROLS = 'agentos.tenant_autonomy_controls';
const TOKEN_COST_RECORDS = 'agentos.token_cost_records';

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
  rollback_policy_version, rollback_state, audit_ref, evidence_ref`;

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

const INSERT_POLICY = `INSERT INTO ${AUTONOMY_POLICIES} (
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
    evidence_ref = EXCLUDED.evidence_ref
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

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toPolicy(row: AutonomyPolicyRow): AutonomyPolicyRecord {
  return { ...row, effective_at: iso(row.effective_at) };
}

function toPolicyEvent(row: AutonomyPolicyEventRow): AutonomyPolicyEventRecord {
  return { ...row, occurred_at: iso(row.occurred_at) };
}

function toControl(row: TenantAutonomyControlRow): TenantAutonomyControlRecord {
  return { ...row, effective_at: iso(row.effective_at) };
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
      ]);
      const row = result.rows[0];
      if (row === undefined) throw new Error('P5_AUTONOMY_COMMIT_EMPTY: policy write returned no row.');
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

  getPolicy(tenant_id: string, skill_id: string, policy_version: string): Promise<AutonomyPolicyRecord | null> {
    return this.get(tenant_id, skill_id, policy_version);
  }

  listPolicies(tenant_id: string, skill_id?: string): Promise<readonly AutonomyPolicyRecord[]> {
    return this.list(tenant_id, skill_id);
  }
}

export { P5AutonomyRepository as AutonomyRepository };
