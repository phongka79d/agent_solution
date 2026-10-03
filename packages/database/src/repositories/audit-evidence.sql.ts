/**
 * Internal SQL statements, projections, row mappers and ledger preparation for audit/evidence
 * repositories and outcome watches.
 *
 * `audit-evidence.ts` remains the public façade and owns the repository classes. Keeping SQL text
 * here makes each ledger operation and watcher transition explicit.
 */

import type { QueryResultRow } from 'pg';

import { canonicalizeJson } from './canonical-json.js';
import { assertIdentifier } from './durable-workflows.js';
import { sha256Hex } from './audit-evidence.chain.js';
import type {
  AgentRunLog,
  AuditRecord,
  AuditRecordInput,
  ImmutableEvidenceRecord,
} from './audit-evidence.js';

export const EXECUTION_STATUSES = [
  'pending',
  'executing',
  'success',
  'failed',
  'denied',
  'aborted',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const AUTHORITY_LEVELS = [
  'AUTH-0',
  'AUTH-1',
  'AUTH-2',
  'AUTH-3',
  'AUTH-4',
  'AUTH-5',
] as const;
export type AuthorityLevel = (typeof AUTHORITY_LEVELS)[number];

/** Schema-qualified tables used by every SQL projection in this module. */
export const EVIDENCE_RECORDS = 'agentos.evidence_records';
const AGENT_RUN_LOGS = 'agentos.agent_run_logs';
export const AUDIT_RECORDS = 'agentos.audit_records';

/**
 * The columns every evidence read publishes, so `SELECT` and `INSERT ... RETURNING` cannot drift
 * apart. `created_at` is a database-generated instant; the chain covers no wall-clock value.
 */
export const EVIDENCE_PROJECTION = `
      evidence_id,
      tenant_id,
      run_id,
      correlation_id,
      step_index,
      effect_key,
      previous_evidence_hash,
      payload_sha256,
      chain_hash,
      signature,
      raw_payload,
      created_at`;

/** The 18 mapped run fields plus the operational `step_index` and the three timestamps. */
export const RUN_LOG_PROJECTION = `
      tenant_id,
      run_id,
      agent_id,
      customer_or_entity_id,
      trigger,
      context,
      skill,
      step_index,
      tool,
      decision,
      authority,
      approval,
      action,
      execution_status,
      evidence,
      outcome,
      latency_ms,
      cost,
      error,
      started_at,
      completed_at,
      created_at`;

/**
 * The columns the chained audit read publishes. `timestamp` is quoted because it is a reserved
 * word, exactly as the migration quotes it.
 */
export const AUDIT_PROJECTION = `
      id,
      run_id,
      tenant_id,
      chain_seq,
      agent_id,
      customer_or_entity_id,
      trigger,
      context,
      skill,
      tool,
      decision,
      authority,
      approval,
      action,
      execution_status,
      evidence,
      outcome,
      latency_ms,
      cost,
      error,
      "timestamp",
      prev_hash,
      chain_hash`;

/**
 * The database-owned audit instant. `clock_timestamp()` is sampled after the tenant lock and
 * truncated to the millisecond rendering covered by the chain hash; callers never supply it.
 */
export const SELECT_AUDIT_SERVER_TIMESTAMP = `SELECT date_trunc('milliseconds', clock_timestamp()) AS server_timestamp`;

/**
 * Serializes every append of one chain scope for the rest of the transaction: the key is derived
 * in-database (`hashtext`) from the table name and the scope identity, so every process — and every
 * language — derives the same lock without sharing a hash function (implement/08 §4.2).
 */
export const LOCK_CHAIN_SCOPE = 'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))';
/** Creates a watcher once per tenant/effect; the table owns its bounded observation deadline. */
export const INSERT_PENDING_OUTCOME_WATCH = `INSERT INTO agentos.pending_outcome_attributions (
      tenant_id,
      run_id,
      effect_key,
      skill_id
    ) VALUES ($1, $2, $3, $4)
    ON CONFLICT (tenant_id, effect_key) DO NOTHING`;

/**
 * Locks an expired batch, records one explicit UNKNOWN_OUTCOME per watch, and links each outcome
 * before marking its watch EXPIRED. Keeping these writes in one statement makes expiry atomic.
 */
export const EXPIRE_PENDING_OUTCOME_WATCHES = `WITH expired AS MATERIALIZED (
  SELECT p.id AS watch_id, p.tenant_id, p.effect_key, agentos.uuid_generate_v7() AS outcome_id
  FROM agentos.pending_outcome_attributions AS p
  WHERE p.tenant_id = $1
    AND p.status = 'OBSERVING'
    AND p.expires_at <= CURRENT_TIMESTAMP
  ORDER BY p.expires_at ASC, p.id ASC
  LIMIT $2::int
  FOR UPDATE OF p SKIP LOCKED
), unknown_outcomes AS (
  INSERT INTO agentos.outcomes (id, tenant_id, conversion_type)
  SELECT expired.outcome_id, expired.tenant_id, 'UNKNOWN_OUTCOME'
  FROM expired
  RETURNING id
), expired_watches AS (
  UPDATE agentos.pending_outcome_attributions AS p
  SET outcome_id = expired.outcome_id,
      status = 'EXPIRED'
  FROM expired
  JOIN unknown_outcomes ON unknown_outcomes.id = expired.outcome_id
  WHERE p.tenant_id = $1
    AND p.id = expired.watch_id
    AND p.status = 'OBSERVING'
  RETURNING p.effect_key
)
SELECT effect_key
FROM expired_watches
ORDER BY effect_key`;


/**
 * `created_at` is omitted so the durable column default (and the audit timestamp sampled by the
 * server) stays the single source of operational instants.
 */
export const INSERT_EVIDENCE_RECORD = `INSERT INTO ${EVIDENCE_RECORDS} (
      evidence_id,
      tenant_id,
      run_id,
      correlation_id,
      step_index,
      effect_key,
      previous_evidence_hash,
      payload_sha256,
      chain_hash,
      signature,
      raw_payload,
      created_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, COALESCE($12::timestamptz, CURRENT_TIMESTAMP)
    )
    RETURNING${EVIDENCE_PROJECTION}`;

export const INSERT_AGENT_RUN_LOG = `INSERT INTO ${AGENT_RUN_LOGS} (
      tenant_id,
      run_id,
      agent_id,
      customer_or_entity_id,
      trigger,
      context,
      skill,
      step_index,
      tool,
      decision,
      authority,
      approval,
      action,
      execution_status,
      evidence,
      outcome,
      latency_ms,
      cost,
      error,
      started_at,
      completed_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13::jsonb, $14, $15::jsonb,
      $16::jsonb, $17, $18::jsonb, $19::jsonb, $20::timestamptz, $21::timestamptz
    )
    RETURNING tenant_id, run_id, skill, step_index`;

export const INSERT_AUDIT_RECORD = `INSERT INTO ${AUDIT_RECORDS} (
      run_id,
      tenant_id,
      agent_id,
      customer_or_entity_id,
      trigger,
      context,
      skill,
      tool,
      decision,
      authority,
      approval,
      action,
      execution_status,
      evidence,
      outcome,
      latency_ms,
      cost,
      error,
      chain_seq,
      "timestamp",
      prev_hash,
      chain_hash
    ) VALUES (
      $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10, $11::jsonb, $12::jsonb, $13, $14::jsonb,
      $15::jsonb, $16, $17::jsonb, $18::jsonb,
      (SELECT COALESCE(MAX(chain_seq), 0) + 1 FROM ${AUDIT_RECORDS} WHERE tenant_id = $2),
      $19::timestamptz, $20, $21
    )
    RETURNING id`;

/**
 * The run's durable chain tail. `step_index` orders the chain and `evidence_id` breaks a tie between
 * two effects of one step, so the predecessor is the greatest link deterministically — no wall
 * clock, and therefore no dependence on two transactions that started in the same millisecond.
 */
export const SELECT_EVIDENCE_TAIL = `SELECT${EVIDENCE_PROJECTION}
  FROM ${EVIDENCE_RECORDS}
  WHERE tenant_id = $1 AND run_id = $2
  ORDER BY step_index DESC, evidence_id DESC
  LIMIT 1`;

export const SELECT_EVIDENCE_BY_RUN = `SELECT${EVIDENCE_PROJECTION}
  FROM ${EVIDENCE_RECORDS}
  WHERE tenant_id = $1 AND run_id = $2
  ORDER BY step_index, evidence_id`;

/**
 * The tenant's durable chain tail. `chain_seq` is assigned under the tenant advisory lock and is the
 * sole ordering authority; caller clocks and event timestamps cannot reorder the predecessor.
 */
export const SELECT_AUDIT_TAIL = `SELECT${AUDIT_PROJECTION}
  FROM ${AUDIT_RECORDS}
  WHERE tenant_id = $1
  ORDER BY chain_seq DESC
  LIMIT 1`;

export const SELECT_AUDIT_BY_TENANT = `SELECT${AUDIT_PROJECTION}
  FROM ${AUDIT_RECORDS}
  WHERE tenant_id = $1
  ORDER BY chain_seq, id`;

export const SELECT_RUN_LOGS_BY_RUN = `SELECT${RUN_LOG_PROJECTION}
  FROM ${AGENT_RUN_LOGS}
  WHERE tenant_id = $1 AND run_id = $2
  ORDER BY step_index, skill`;

export const SELECT_RUN_LOGS_FOR_RUNS = `SELECT${RUN_LOG_PROJECTION}
  FROM ${AGENT_RUN_LOGS}
  WHERE tenant_id = $1 AND run_id = ANY($2::varchar[])
  ORDER BY run_id, step_index, skill`;

export const SELECT_EVIDENCE_BY_EFFECT = `SELECT${EVIDENCE_PROJECTION} FROM ${EVIDENCE_RECORDS}
           WHERE tenant_id = $1 AND run_id = $2 AND effect_key = $3 AND step_index = $4`;

export interface AuditServerTimestampRow extends QueryResultRow {
  server_timestamp: Date;
}

/* ------------------------------------------------------------------------------------------------
 * Persistence: the append-only writers and the chain readers (implement/04 §6.1, implement/08 §4.2)
 * ---------------------------------------------------------------------------------------------- */

/** One `agentos.evidence_records` row exactly as `pg` returns it, before the projection is published. */
export interface EvidenceRecordRow extends QueryResultRow {
  evidence_id: string;
  tenant_id: string;
  run_id: string;
  correlation_id: string;
  step_index: number;
  effect_key: string;
  previous_evidence_hash: string;
  payload_sha256: string;
  chain_hash: string;
  signature: string;
  raw_payload: unknown;
  created_at: Date;
}

/** One `agentos.agent_run_logs` row exactly as `pg` returns it. */
export interface AgentRunLogRow extends QueryResultRow {
  tenant_id: string;
  run_id: string;
  agent_id: string;
  customer_or_entity_id: string;
  trigger: string;
  context: unknown;
  skill: string;
  step_index: number;
  tool: string;
  decision: unknown;
  authority: AuthorityLevel;
  approval: unknown | null;
  action: unknown;
  execution_status: ExecutionStatus;
  evidence: unknown;
  outcome: unknown | null;
  latency_ms: number;
  cost: unknown;
  error: unknown | null;
  started_at: Date;
  completed_at: Date;
  created_at: Date;
}

/** One `agentos.audit_records` row exactly as `pg` returns it. */
export interface AuditRecordRow extends QueryResultRow {
  id: string;
  run_id: string;
  tenant_id: string;
  /** PostgreSQL `bigint` values are strings under the default `pg` type parser. */
  chain_seq: string;
  agent_id: string;
  customer_or_entity_id: string;
  trigger: string;
  context: unknown;
  skill: string;
  tool: string;
  decision: unknown;
  authority: AuthorityLevel;
  approval: unknown | null;
  action: unknown;
  execution_status: ExecutionStatus;
  evidence: unknown;
  outcome: unknown | null;
  latency_ms: number;
  cost: unknown;
  error: unknown | null;
  timestamp: Date;
  prev_hash: string;
  chain_hash: string;
}

/**
 * Publishes one evidence row. `created_at` becomes an ISO-8601 UTC string and the digests are
 * published verbatim, so the record a caller verifies carries exactly the fields the row stores.
 */
export function toEvidenceRecord(row: EvidenceRecordRow): ImmutableEvidenceRecord {
  return {
    evidence_id: row.evidence_id,
    run_id: row.run_id,
    tenant_id: row.tenant_id,
    correlation_id: row.correlation_id,
    step_index: row.step_index,
    effect_key: row.effect_key,
    previous_evidence_hash: row.previous_evidence_hash,
    payload_sha256: row.payload_sha256,
    chain_hash: row.chain_hash,
    signature: row.signature,
    raw_payload: row.raw_payload,
    created_at: row.created_at.toISOString(),
  };
}

/** Publishes one run-log row with its three instants as ISO-8601 UTC strings. */
export function toAgentRunLog(row: AgentRunLogRow): AgentRunLog {
  return {
    tenant_id: row.tenant_id,
    run_id: row.run_id,
    agent_id: row.agent_id,
    customer_or_entity_id: row.customer_or_entity_id,
    trigger: row.trigger,
    context: row.context,
    skill: row.skill,
    step_index: row.step_index,
    tool: row.tool,
    decision: row.decision,
    authority: row.authority,
    approval: row.approval,
    action: row.action,
    execution_status: row.execution_status,
    evidence: row.evidence,
    outcome: row.outcome,
    latency_ms: row.latency_ms,
    cost: row.cost,
    error: row.error,
    started_at: row.started_at.toISOString(),
    completed_at: row.completed_at.toISOString(),
    created_at: row.created_at.toISOString(),
  };
}

/**
 * Publishes one audit row. `timestamp` is rendered as UTC ISO-8601 with milliseconds, the byte
 * contract the chain hash was computed over, so a verifier reading this record back re-hashes the
 * same bytes the writer hashed (implement/08 §4.2).
 */
export function toAuditRecord(row: AuditRecordRow): AuditRecord {
  return {
    id: row.id,
    run_id: row.run_id,
    tenant_id: row.tenant_id,
    chain_seq: row.chain_seq,
    agent_id: row.agent_id,
    customer_or_entity_id: row.customer_or_entity_id,
    trigger: row.trigger,
    context: row.context,
    skill: row.skill,
    tool: row.tool,
    decision: row.decision,
    authority: row.authority,
    approval: row.approval,
    action: row.action,
    execution_status: row.execution_status,
    evidence: row.evidence,
    outcome: row.outcome,
    latency_ms: row.latency_ms,
    cost: row.cost,
    error: row.error,
    timestamp: row.timestamp.toISOString(),
    prev_hash: row.prev_hash,
    chain_hash: row.chain_hash,
  };
}

/**
 * Reads the SQLSTATE of a `pg` driver error, when the failure carries one.
 *
 * Only used to translate a unique violation (`23505`) on an append-only key into the refusal that
 * names the record it collided on. Anything else is rethrown untouched: a connection or driver
 * failure is not an audit outcome.
 */
export function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }

  const { code } = error as { code?: unknown };

  return typeof code === 'string' ? code : undefined;
}

/**
 * The primary key of one evidence record, derived from the run identity exactly as
 * `durability/evidence.ts` derives it (`ev_` and 16 hex characters), so re-appending the same effect
 * addresses the row it would duplicate: the database refuses it instead of the chain growing a
 * second link for one effect (implement/04 §6.1).
 */
export function evidenceIdFor(params: {
  tenant_id: string;
  run_id: string;
  effect_key: string;
  step_index: number;
}): string {
  return `ev_${sha256Hex(
    `${params.tenant_id}|${params.run_id}|${params.effect_key}|${params.step_index}`,
  ).slice(0, 16)}`;
}

/**
 * Canonical text of one JSONB column: the bytes the digest covers, written verbatim so the writer,
 * the stored row and the verifier cannot disagree about them (implement/04 §6.1 step 1).
 *
 * A value JSON cannot represent (an absent member, `NaN`, a `Date`) is refused rather than
 * converted, because the converted bytes would hash to something the caller never saw.
 *
 * @param value Column value as the caller supplied it.
 * @param column Column the value belongs to, for the refusal message.
 * @param code Error code to raise.
 * @returns The canonical JSON text to bind to the statement.
 * @throws Error `<code>` when the value has no canonical form.
 */
function canonicalJsonColumn(value: unknown, column: string, code: string): string {
  try {
    return canonicalizeJson(value);
  } catch (error) {
    throw new Error(
      `${code}: ${column} has no canonical JSON form (` +
        `${error instanceof Error ? error.message : String(error)}); an absent member or a non-JSON ` +
        'value would change the hashed bytes, so it is refused instead of converted ' +
        '(implement/04 §6.1).',
    );
  }
}

/**
 * Canonical text of a nullable JSONB column: `null` and `undefined` both mean SQL NULL, so the
 * column stores nothing rather than a JSON `null` the verifier would have to re-hash.
 */
function nullableJsonColumn(value: unknown, column: string, code: string): string | null {
  return value === undefined || value === null ? null : canonicalJsonColumn(value, column, code);
}

/**
 * Validates an operational instant against the `TIMESTAMPTZ` column it will land in.
 *
 * The column is not hashed, so any instant PostgreSQL can store is accepted and refused here only
 * when it cannot be one at all: a value the server would reject with `22007` names no column.
 */
export function assertInstant(value: unknown, column: string, code: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(
      `${code}: ${column} must be an ISO-8601 instant so the operational log carries the step's own ` +
        `clock rather than the server's; received ${String(value)} (implement/04 §6.1).`,
    );
  }

  return value;
}

/**
 * Validates `execution_status` against the migration's closed six-value vocabulary.
 *
 * @param value Candidate status.
 * @param code Error code to raise.
 * @throws Error `<code>` for anything outside {@link EXECUTION_STATUSES}; there is no seventh status,
 * and a timeout-UNKNOWN attempt is `failed` with `error.outcome = 'UNKNOWN'`.
 */
function assertExecutionStatus(value: unknown, code: string): asserts value is ExecutionStatus {
  if (typeof value !== 'string' || !EXECUTION_STATUSES.includes(value as ExecutionStatus)) {
    throw new Error(
      `${code}: execution_status ${String(value)} is not one of ${EXECUTION_STATUSES.join(', ')}; ` +
        'the append-only vocabulary is closed, so an unknown status is refused rather than stored ' +
        '(implement/03 §1 DOMAIN 5).',
    );
  }
}

/**
 * Validates `authority` against the SRS §12 taxonomy (`AUTH-0` .. `AUTH-5`, no seventh level).
 *
 * @param value Candidate authority.
 * @param code Error code to raise.
 * @throws Error `<code>` for anything outside {@link AUTHORITY_LEVELS}.
 */
function assertAuthority(value: unknown, code: string): asserts value is AuthorityLevel {
  if (typeof value !== 'string' || !AUTHORITY_LEVELS.includes(value as AuthorityLevel)) {
    throw new Error(
      `${code}: authority ${String(value)} is not one of ${AUTHORITY_LEVELS.join(', ')}; the ` +
        'taxonomy is closed, and AUTH-5 is never approvable (SRS §12).',
    );
  }
}

/**
 * The 18 mapped run fields validated and rendered for storage: identities bounded to the `VARCHAR`
 * columns they will land in, each JSONB column as its canonical text, and the two closed value sets
 * checked against the migration's vocabulary.
 *
 * Both append-only ledgers store this shape — `audit_records` and `agent_run_logs` carry the same 18
 * fields — so one preparation serves both and neither can drift into accepting a status or a length
 * the other refuses.
 */
export interface PreparedLedgerRecord {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly agent_id: string;
  readonly customer_or_entity_id: string;
  readonly trigger: string;
  readonly skill: string;
  readonly tool: string;
  readonly context: string;
  readonly decision: string;
  readonly approval: string | null;
  readonly action: string;
  readonly evidence: string;
  readonly outcome: string | null;
  readonly cost: string;
  readonly error: string | null;
  readonly latency_ms: number;
  readonly execution_status: ExecutionStatus;
  readonly authority: AuthorityLevel;
}

/**
 * Validates one canonical run record and renders it for storage.
 *
 * @param record The 18-field run record (SRS §17) to be appended.
 * @param code Error code every refusal of this preparation raises.
 * @returns The validated record with its JSONB columns as canonical text.
 * @throws Error `<code>` when a field cannot be stored in the column that owns it.
 */
export function prepareLedgerRecord(record: AuditRecordInput, code: string): PreparedLedgerRecord {
  assertIdentifier(record.tenant_id, 'tenant_id', 36, code);
  assertIdentifier(record.run_id, 'run_id', 64, code);
  assertIdentifier(record.agent_id, 'agent_id', 32, code);
  assertIdentifier(record.customer_or_entity_id, 'customer_or_entity_id', 64, code);
  assertIdentifier(record.trigger, 'trigger', 128, code);
  assertIdentifier(record.skill, 'skill', 64, code);
  assertIdentifier(record.tool, 'tool', 64, code);
  assertExecutionStatus(record.execution_status, code);
  assertAuthority(record.authority, code);

  if (
    typeof record.latency_ms !== 'number' ||
    !Number.isInteger(record.latency_ms) ||
    record.latency_ms < 0
  ) {
    throw new Error(
      `${code}: latency_ms must be a non-negative integer; a step whose duration was not measured ` +
        `stores 0 rather than a fabricated duration (implement/04 §6.1).`,
    );
  }

  return {
    tenant_id: record.tenant_id,
    run_id: record.run_id,
    agent_id: record.agent_id,
    customer_or_entity_id: record.customer_or_entity_id,
    trigger: record.trigger,
    skill: record.skill,
    tool: record.tool,
    context: canonicalJsonColumn(record.context, 'context', code),
    decision: canonicalJsonColumn(record.decision, 'decision', code),
    approval: nullableJsonColumn(record.approval, 'approval', code),
    action: canonicalJsonColumn(record.action, 'action', code),
    evidence: canonicalJsonColumn(record.evidence, 'evidence', code),
    outcome: nullableJsonColumn(record.outcome, 'outcome', code),
    cost: canonicalJsonColumn(record.cost, 'cost', code),
    error: nullableJsonColumn(record.error, 'error', code),
    latency_ms: record.latency_ms,
    execution_status: record.execution_status,
    authority: record.authority,
  };
}
