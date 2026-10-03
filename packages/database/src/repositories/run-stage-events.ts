import type { QueryResultRow } from 'pg';

import { withTenantContext } from '../rls.js';
import { canonicalizeJson } from './canonical-json.js';
import { assertIdentifier, serializeJsonb } from './durable-workflows.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

/** The closed eleven-stage lifecycle persisted by the stage trace. */
export const RUN_STAGES = [
  'SIGNAL',
  'CONTEXT',
  'HYPOTHESIS',
  'DECISION',
  'PLAN',
  'ACTION',
  'APPROVAL',
  'EXECUTION',
  'EVIDENCE',
  'OUTCOME',
  'LEARNING',
] as const;

export type RunStage = (typeof RUN_STAGES)[number];

export interface RunStageEventRecord {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly attempt_ordinal: number;
  readonly step_index: number;
  readonly stage: RunStage;
  readonly detail: unknown;
  readonly evidence_refs: unknown;
  readonly entered_at: string;
}

export type RunStageResultStatus = 'completed' | 'failed' | 'refused' | 'awaiting_human';

export interface RunStageResultRecord {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly attempt_ordinal: number;
  readonly step_index: number;
  readonly stage: RunStage;
  readonly status: RunStageResultStatus;
  readonly started_at: string;
  readonly completed_at: string;
  readonly duration_ms: number;
  readonly agent_code: string | null;
  readonly skill_id: string | null;
  readonly summary_key: string | null;
  readonly refusal_code: string | null;
  readonly error_class: string | null;
  readonly input_digest: string | null;
  readonly output_digest: string | null;
  readonly detail: unknown;
  readonly evidence_refs: unknown;
}

export interface AppendRunStageResultInput {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly attempt_ordinal: number;
  readonly step_index: number;
  readonly stage: RunStage;
  readonly status: RunStageResultStatus;
  readonly started_at: string;
  readonly completed_at: string;
  readonly duration_ms: number;
  readonly agent_code?: string | null;
  readonly skill_id?: string | null;
  readonly summary_key?: string | null;
  readonly refusal_code?: string | null;
  readonly error_class?: string | null;
  readonly input_digest?: string | null;
  readonly output_digest?: string | null;
  readonly detail?: unknown;
  readonly evidence_refs?: unknown;
}

interface RunStageResultRow extends QueryResultRow {
  tenant_id: string;
  run_id: string;
  attempt_ordinal: number;
  step_index: number;
  stage: RunStage;
  status: RunStageResultStatus;
  started_at: Date | string;
  completed_at: Date | string;
  duration_ms: number;
  agent_code: string | null;
  skill_id: string | null;
  summary_key: string | null;
  refusal_code: string | null;
  error_class: string | null;
  input_digest: string | null;
  output_digest: string | null;
  detail: unknown;
  evidence_refs: unknown;
}

const RUN_STAGE_RESULTS = 'agentos.run_stage_results';
const STAGE_RESULT_COLUMNS = `
  tenant_id, run_id, attempt_ordinal, step_index, stage, status, started_at, completed_at,
  duration_ms, agent_code, skill_id, summary_key, refusal_code, error_class, input_digest,
  output_digest, detail, evidence_refs`;
const INSERT_STAGE_RESULT = `INSERT INTO ${RUN_STAGE_RESULTS} (
    tenant_id, run_id, attempt_ordinal, step_index, stage, status, started_at, completed_at,
    duration_ms, agent_code, skill_id, summary_key, refusal_code, error_class, input_digest,
    output_digest, detail, evidence_refs
  ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9,
    $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18::jsonb)
  ON CONFLICT (tenant_id, run_id, attempt_ordinal, step_index, stage) DO NOTHING
  RETURNING${STAGE_RESULT_COLUMNS}`;
const SELECT_STAGE_RESULT = `SELECT${STAGE_RESULT_COLUMNS}
  FROM ${RUN_STAGE_RESULTS}
  WHERE tenant_id = $1 AND run_id = $2 AND attempt_ordinal = $3 AND step_index = $4 AND stage = $5`;

const SELECT_STAGE_RESULTS = `SELECT${STAGE_RESULT_COLUMNS}
  FROM ${RUN_STAGE_RESULTS}
  WHERE tenant_id = $1 AND run_id = $2
  ORDER BY attempt_ordinal ASC, started_at ASC, step_index ASC, stage ASC`;

export interface AppendRunStageEventInput {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly attempt_ordinal: number;
  readonly step_index: number;
  readonly stage: RunStage;
  readonly detail?: unknown;
  readonly evidence_refs?: unknown;
  /** The caller-observed stage entry instant; it is part of the immutable event. */
  readonly entered_at: string;
}

export type ProviderCallObservedStatus = string;

export interface ProviderCallLedgerRecord {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly step_index: number;
  readonly stage: RunStage;
  readonly call_index: number;
  readonly provider: string;
  readonly model: string;
  readonly observed_status: ProviderCallObservedStatus;
  readonly latency_ms: number | null;
  readonly prompt_tokens: number | null;
  readonly completion_tokens: number | null;
  readonly cached_tokens: number | null;
  readonly estimated_cost_amount: string | null;
  readonly currency: string | null;
  readonly cost_status: string | null;
  readonly recorded_at: string;
}

export interface AppendProviderCallInput {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly step_index: number;
  readonly stage: RunStage;
  readonly call_index: number;
  readonly provider: string;
  readonly model: string;
  /** Required observed value. No success/default status is synthesized by this repository. */
  readonly observed_status: ProviderCallObservedStatus;
  readonly latency_ms?: number | null;
  readonly prompt_tokens?: number | null;
  readonly completion_tokens?: number | null;
  readonly cached_tokens?: number | null;
  /** Provider/owner-observed cost only; this repository never derives it from token counts. */
  readonly estimated_cost_amount?: string | number | null;
  readonly currency?: string | null;
  readonly cost_status?: string | null;
  /** Optional source timestamp. The database timestamp is used when it is not supplied. */
  readonly recorded_at?: string;
}

interface RunStageEventRow extends QueryResultRow {
  tenant_id: string;
  run_id: string;
  attempt_ordinal: number;
  step_index: number;
  stage: RunStage;
  detail: unknown;
  evidence_refs: unknown;
  entered_at: Date | string;
}

interface ProviderCallLedgerRow extends QueryResultRow {
  tenant_id: string;
  run_id: string;
  step_index: number;
  stage: RunStage;
  call_index: number;
  provider: string;
  model: string;
  observed_status: string;
  latency_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  estimated_cost_amount: string | null;
  currency: string | null;
  cost_status: string | null;
  recorded_at: Date | string;
}

const RUN_STAGE_EVENTS = 'agentos.run_stage_events';
const PROVIDER_CALL_LEDGER = 'agentos.provider_call_ledger';
const CODE_OWNER = 'run-stage-events repository / migration 0010';

const STAGE_COLUMNS = `
  tenant_id, run_id, attempt_ordinal, step_index, stage, detail, evidence_refs, entered_at`;
const PROVIDER_COLUMNS = `
  tenant_id, run_id, step_index, stage, call_index, provider, model, observed_status,
  latency_ms, prompt_tokens, completion_tokens, cached_tokens, estimated_cost_amount,
  currency, cost_status, recorded_at`;

const INSERT_STAGE = `INSERT INTO ${RUN_STAGE_EVENTS} (
    tenant_id, run_id, attempt_ordinal, step_index, stage, detail, evidence_refs, entered_at
  ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::timestamptz)
  ON CONFLICT (tenant_id, run_id, attempt_ordinal, step_index, stage) DO NOTHING
  RETURNING${STAGE_COLUMNS}`;

const SELECT_STAGE = `SELECT${STAGE_COLUMNS}
  FROM ${RUN_STAGE_EVENTS}
  WHERE tenant_id = $1 AND run_id = $2 AND attempt_ordinal = $3 AND step_index = $4 AND stage = $5`;

const SELECT_STAGES = `SELECT${STAGE_COLUMNS}
  FROM ${RUN_STAGE_EVENTS}
  WHERE tenant_id = $1 AND run_id = $2
  ORDER BY attempt_ordinal ASC, entered_at ASC, step_index ASC, stage ASC`;

const INSERT_PROVIDER_CALL = `INSERT INTO ${PROVIDER_CALL_LEDGER} (
    tenant_id, run_id, step_index, stage, call_index, provider, model, observed_status,
    latency_ms, prompt_tokens, completion_tokens, cached_tokens, estimated_cost_amount,
    currency, cost_status, recorded_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
    COALESCE($16::timestamptz, CURRENT_TIMESTAMP))
  ON CONFLICT (tenant_id, run_id, step_index, stage, call_index) DO NOTHING
  RETURNING${PROVIDER_COLUMNS}`;

const SELECT_PROVIDER_CALL = `SELECT${PROVIDER_COLUMNS}
  FROM ${PROVIDER_CALL_LEDGER}
  WHERE tenant_id = $1 AND run_id = $2 AND step_index = $3 AND stage = $4 AND call_index = $5`;

const SELECT_PROVIDER_CALLS = `SELECT${PROVIDER_COLUMNS}
  FROM ${PROVIDER_CALL_LEDGER}
  WHERE tenant_id = $1 AND run_id = $2
  ORDER BY step_index ASC, stage ASC, call_index ASC, recorded_at ASC`;

const SELECT_PROVIDER_CALLS_FOR_RUNS = `SELECT${PROVIDER_COLUMNS}
  FROM ${PROVIDER_CALL_LEDGER}
  WHERE tenant_id = $1 AND run_id = ANY($2::varchar[])
  ORDER BY run_id, step_index ASC, stage ASC, call_index ASC, recorded_at ASC`;

function assertNonNegativeInteger(value: unknown, field: string, code: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${code}: ${field} must be a safe integer >= 0 (${CODE_OWNER}).`);
  }
}

function assertPositiveInteger(value: unknown, field: string, code: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${code}: ${field} must be a safe integer >= 1 (${CODE_OWNER}).`);
  }
}

function assertBoundedText(value: unknown, field: string, maxLength: number, code: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${code}: ${field} must be non-empty and at most ${maxLength} characters (${CODE_OWNER}).`);
  }
  return value;
}

function assertRunStage(value: unknown, code: string): RunStage {
  if (typeof value !== 'string' || !RUN_STAGES.includes(value as RunStage)) {
    throw new Error(`${code}: stage must be one of ${RUN_STAGES.join(', ')} (${CODE_OWNER}).`);
  }
  return value as RunStage;
}

function normalizeInstant(value: unknown, field: string, code: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${code}: ${field} must be an ISO-8601 instant (${CODE_OWNER}).`);
  }
  return new Date(value).toISOString();
}

function readInstant(value: Date | string, field: string): string {
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`RUN_STAGE_READ_INVALID: ${field} is not a valid timestamp (${CODE_OWNER}).`);
  }
  return instant.toISOString();
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  try {
    return canonicalizeJson(left) === canonicalizeJson(right);
  } catch {
    return false;
  }
}

function assertNullableNonNegativeInteger(value: unknown, field: string, code: string): void {
  if (value === undefined || value === null) return;
  assertNonNegativeInteger(value, field, code);
}

function canonicalDecimal(value: string | number): string | null {
  const text = typeof value === 'number' ? String(value) : value;
  if (!/^\d+(?:\.\d{1,8})?$/.test(text) || text.length > 32) return null;

  const decimalPoint = text.indexOf('.');
  const integer = decimalPoint === -1 ? text : text.slice(0, decimalPoint);
  const fraction = decimalPoint === -1 ? '' : text.slice(decimalPoint + 1);
  const canonicalInteger = integer.replace(/^0+(?=\d)/, '');
  const canonicalFraction = fraction.replace(/0+$/, '');

  return canonicalFraction.length === 0
    ? canonicalInteger
    : `${canonicalInteger}.${canonicalFraction}`;
}

function sameDecimal(left: string | number | null, right: string | number | null): boolean {
  if (left === null || right === null) return left === right;
  const canonicalLeft = canonicalDecimal(left);
  const canonicalRight = canonicalDecimal(right);
  return canonicalLeft !== null && canonicalLeft === canonicalRight;
}

function assertCost(value: unknown, code: string): string | null {
  if (value === undefined || value === null) return null;
  const normalized = typeof value === 'number' ? String(value) : value;
  const canonical = typeof normalized === 'string' ? canonicalDecimal(normalized) : null;
  if (canonical === null) {
    throw new Error(`${code}: estimated_cost_amount must be a non-negative decimal (${CODE_OWNER}).`);
  }
  return canonical;
}

function toStageRecord(row: RunStageEventRow): RunStageEventRecord {
  return {
    tenant_id: row.tenant_id,
    run_id: row.run_id,
    attempt_ordinal: row.attempt_ordinal,
    step_index: row.step_index,
    stage: row.stage,
    detail: row.detail,
    evidence_refs: row.evidence_refs,
    entered_at: readInstant(row.entered_at, 'entered_at'),
  };
}

function toStageResultRecord(row: RunStageResultRow): RunStageResultRecord {
  return {
    tenant_id: row.tenant_id,
    run_id: row.run_id,
    attempt_ordinal: row.attempt_ordinal,
    step_index: row.step_index,
    stage: row.stage,
    status: row.status,
    started_at: readInstant(row.started_at, 'started_at'),
    completed_at: readInstant(row.completed_at, 'completed_at'),
    duration_ms: row.duration_ms,
    agent_code: row.agent_code,
    skill_id: row.skill_id,
    summary_key: row.summary_key,
    refusal_code: row.refusal_code,
    error_class: row.error_class,
    input_digest: row.input_digest,
    output_digest: row.output_digest,
    detail: row.detail,
    evidence_refs: row.evidence_refs,
  };
}

function nullableBoundedText(value: unknown, field: string, maxLength: number): string | null {
  return value === undefined || value === null
    ? null
    : assertBoundedText(value, field, maxLength, 'RUN_STAGE_RESULT_INPUT_INVALID');
}

function nullableDigest(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`RUN_STAGE_RESULT_INPUT_INVALID: ${field} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function toProviderCallRecord(row: ProviderCallLedgerRow): ProviderCallLedgerRecord {
  return {
    tenant_id: row.tenant_id,
    run_id: row.run_id,
    step_index: row.step_index,
    stage: row.stage,
    call_index: row.call_index,
    provider: row.provider,
    model: row.model,
    observed_status: row.observed_status,
    latency_ms: row.latency_ms,
    prompt_tokens: row.prompt_tokens,
    completion_tokens: row.completion_tokens,
    cached_tokens: row.cached_tokens,
    estimated_cost_amount: row.estimated_cost_amount,
    currency: row.currency,
    cost_status: row.cost_status,
    recorded_at: readInstant(row.recorded_at, 'recorded_at'),
  };
}

function assertStageReplayMatches(
  existing: RunStageEventRecord,
  input: AppendRunStageEventInput,
  detail: string,
  evidence_refs: string,
  entered_at: string,
): void {
  if (
    !sameJsonValue(existing.detail, JSON.parse(detail)) ||
    !sameJsonValue(existing.evidence_refs, JSON.parse(evidence_refs)) ||
    existing.entered_at !== entered_at
  ) {
    throw new Error(
      `RUN_STAGE_EVENT_CONFLICT: stage event ${input.run_id}/${input.attempt_ordinal}/${input.step_index}/${input.stage} ` +
        'already exists with different immutable content; refusing to overwrite it.',
    );
  }
}

function assertProviderReplayMatches(
  existing: ProviderCallLedgerRecord,
  input: AppendProviderCallInput,
  estimated_cost_amount: string | null,
): void {
  const recordedAt = input.recorded_at === undefined
    ? true
    : existing.recorded_at === normalizeInstant(input.recorded_at, 'recorded_at', 'PROVIDER_CALL_INPUT_INVALID');

  if (
    existing.provider !== input.provider ||
    existing.model !== input.model ||
    existing.observed_status !== input.observed_status ||
    existing.latency_ms !== (input.latency_ms ?? null) ||
    existing.prompt_tokens !== (input.prompt_tokens ?? null) ||
    existing.completion_tokens !== (input.completion_tokens ?? null) ||
    existing.cached_tokens !== (input.cached_tokens ?? null) ||
    !sameDecimal(existing.estimated_cost_amount, estimated_cost_amount) ||
    existing.currency !== (input.currency ?? null) ||
    existing.cost_status !== (input.cost_status ?? null) ||
    !recordedAt
  ) {
    throw new Error(
      `PROVIDER_CALL_CONFLICT: provider call ${input.run_id}/${input.step_index}/${input.stage}/${input.call_index} ` +
        'already exists with different immutable observed data; refusing to overwrite it.',
    );
  }
}

function requireRow<T>(row: T | undefined, message: string): T {
  if (row === undefined) throw new Error(message);
  return row;
}

/**
 * Tenant-scoped append/read repository for the lifecycle stage and provider-call ledgers.
 *
 * Both append methods use the immutable primary key as a concurrency fence. A duplicate key is
 * accepted only when every observed field matches; a changed replay is refused and no update path
 * exists. In particular, provider status and cost values are always supplied by the caller and are
 * never defaulted to a fabricated success or calculated cost.
 */
export class RunStageEventsRepository {
  private readonly runInTenantTransaction: TenantTransactionRunner;

  constructor(runInTenantTransaction: TenantTransactionRunner = withTenantContext) {
    this.runInTenantTransaction = runInTenantTransaction;
  }

  /** Allocates from a durable per-run cursor, seeded from committed events on its first use. */
  async nextAttemptOrdinal(tenant_id: string, run_id: string): Promise<number> {
    assertIdentifier(tenant_id, 'tenant_id', 36, 'RUN_STAGE_EVENT_TENANT_ID_REQUIRED');
    assertIdentifier(run_id, 'run_id', 64, 'RUN_STAGE_EVENT_RUN_ID_REQUIRED');
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const task = await client.query<{ readonly task_id: string }>(
        `SELECT task_id
           FROM agentos.platform_durable_tasks
          WHERE tenant_id = $1 AND run_id = $2
          FOR UPDATE`,
        [tenant_id, run_id],
      );
      if (task.rowCount !== 1) {
        throw new Error(
          `RUN_STAGE_EVENT_RUN_NOT_FOUND: run ${run_id} does not belong to tenant ${tenant_id} (${CODE_OWNER}).`,
        );
      }

      const result = await client.query<{ attempt_ordinal: number }>(
        `WITH current_ordinal AS (
           SELECT COALESCE(MAX(attempt_ordinal), 0)::int + 1 AS ordinal
             FROM ${RUN_STAGE_EVENTS}
            WHERE tenant_id = $1 AND run_id = $2
         )
         INSERT INTO agentos.run_attempt_ordinals AS allocation (tenant_id, run_id, last_ordinal)
         SELECT $1, $2, ordinal
           FROM current_ordinal
         ON CONFLICT (tenant_id, run_id) DO UPDATE
           SET last_ordinal = allocation.last_ordinal + 1
         RETURNING last_ordinal AS attempt_ordinal`,
        [tenant_id, run_id],
      );
      return result.rows[0]!.attempt_ordinal;
    });
  }

  async appendStageEvent(input: AppendRunStageEventInput): Promise<RunStageEventRecord> {
    assertIdentifier(input.tenant_id, 'tenant_id', 36, 'RUN_STAGE_EVENT_TENANT_ID_REQUIRED');
    assertIdentifier(input.run_id, 'run_id', 64, 'RUN_STAGE_EVENT_RUN_ID_REQUIRED');
    assertPositiveInteger(input.attempt_ordinal, 'attempt_ordinal', 'RUN_STAGE_EVENT_ATTEMPT_INVALID');
    assertNonNegativeInteger(input.step_index, 'step_index', 'RUN_STAGE_EVENT_STEP_INVALID');
    const stage = assertRunStage(input.stage, 'RUN_STAGE_EVENT_STAGE_INVALID');
    const detail = serializeJsonb(input.detail ?? {}, 'RUN_STAGE_EVENT_DETAIL_INVALID');
    const evidence_refs = serializeJsonb(input.evidence_refs ?? [], 'RUN_STAGE_EVENT_EVIDENCE_REFS_INVALID');
    const entered_at = normalizeInstant(input.entered_at, 'entered_at', 'RUN_STAGE_EVENT_ENTERED_AT_INVALID');

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const inserted = await client.query<RunStageEventRow>(INSERT_STAGE, [
        input.tenant_id,
        input.run_id,
        input.attempt_ordinal,
        input.step_index,
        stage,
        detail,
        evidence_refs,
        entered_at,
      ]);
      const insertedRow = inserted.rows[0];
      if (insertedRow !== undefined) return toStageRecord(insertedRow);

      const existing = await client.query<RunStageEventRow>(SELECT_STAGE, [
        input.tenant_id,
        input.run_id,
        input.attempt_ordinal,
        input.step_index,
        stage,
      ]);
      const existingRow = requireRow(
        existing.rows[0],
        `RUN_STAGE_EVENT_UNSTABLE: key conflict for ${input.run_id} returned no visible row (${CODE_OWNER}).`,
      );
      const existingRecord = toStageRecord(existingRow);
      assertStageReplayMatches(existingRecord, input, detail, evidence_refs, entered_at);
      return existingRecord;
    });
  }

  async appendStageResult(input: AppendRunStageResultInput): Promise<RunStageResultRecord> {
    assertIdentifier(input.tenant_id, 'tenant_id', 36, 'RUN_STAGE_RESULT_TENANT_ID_REQUIRED');
    assertIdentifier(input.run_id, 'run_id', 64, 'RUN_STAGE_RESULT_RUN_ID_REQUIRED');
    assertPositiveInteger(input.attempt_ordinal, 'attempt_ordinal', 'RUN_STAGE_RESULT_ATTEMPT_INVALID');
    assertNonNegativeInteger(input.step_index, 'step_index', 'RUN_STAGE_RESULT_STEP_INVALID');
    const stage = assertRunStage(input.stage, 'RUN_STAGE_RESULT_STAGE_INVALID');
    if (!['completed', 'failed', 'refused', 'awaiting_human'].includes(input.status)) {
      throw new Error('RUN_STAGE_RESULT_STATUS_INVALID: unsupported stage result status.');
    }
    const started_at = normalizeInstant(input.started_at, 'started_at', 'RUN_STAGE_RESULT_INPUT_INVALID');
    const completed_at = normalizeInstant(input.completed_at, 'completed_at', 'RUN_STAGE_RESULT_INPUT_INVALID');
    const duration_ms = input.duration_ms;
    assertNonNegativeInteger(duration_ms, 'duration_ms', 'RUN_STAGE_RESULT_INPUT_INVALID');
    if (duration_ms > 2_147_483_647 || Date.parse(completed_at) < Date.parse(started_at)) {
      throw new Error('RUN_STAGE_RESULT_INPUT_INVALID: duration or completion timestamp is out of range.');
    }
    const agent_code = nullableBoundedText(input.agent_code, 'agent_code', 32);
    const skill_id = nullableBoundedText(input.skill_id, 'skill_id', 128);
    const summary_key = nullableBoundedText(input.summary_key, 'summary_key', 128);
    const refusal_code = nullableBoundedText(input.refusal_code, 'refusal_code', 64);
    const error_class = nullableBoundedText(input.error_class, 'error_class', 32);
    const input_digest = nullableDigest(input.input_digest, 'input_digest');
    const output_digest = nullableDigest(input.output_digest, 'output_digest');
    const detail = serializeJsonb(input.detail ?? {}, 'RUN_STAGE_RESULT_DETAIL_INVALID');
    const evidence_refs = serializeJsonb(input.evidence_refs ?? [], 'RUN_STAGE_RESULT_EVIDENCE_REFS_INVALID');

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const args = [
        input.tenant_id,
        input.run_id,
        input.attempt_ordinal,
        input.step_index,
        stage,
        input.status,
        started_at,
        completed_at,
        duration_ms,
        agent_code,
        skill_id,
        summary_key,
        refusal_code,
        error_class,
        input_digest,
        output_digest,
        detail,
        evidence_refs,
      ];
      const inserted = await client.query<RunStageResultRow>(INSERT_STAGE_RESULT, args);
      const insertedRow = inserted.rows[0];
      if (insertedRow !== undefined) return toStageResultRecord(insertedRow);

      const existing = await client.query<RunStageResultRow>(SELECT_STAGE_RESULT, args.slice(0, 5));
      const existingRow = requireRow(
        existing.rows[0],
        `RUN_STAGE_RESULT_UNSTABLE: key conflict for ${input.run_id} returned no visible row (${CODE_OWNER}).`,
      );
      const record = toStageResultRecord(existingRow);
      if (
        record.status !== input.status
        || record.started_at !== started_at
        || record.completed_at !== completed_at
        || record.duration_ms !== duration_ms
        || record.agent_code !== agent_code
        || record.skill_id !== skill_id
        || record.summary_key !== summary_key
        || record.refusal_code !== refusal_code
        || record.error_class !== error_class
        || record.input_digest !== input_digest
        || record.output_digest !== output_digest
        || !sameJsonValue(record.detail, JSON.parse(detail))
        || !sameJsonValue(record.evidence_refs, JSON.parse(evidence_refs))
      ) {
        throw new Error(
          `RUN_STAGE_RESULT_CONFLICT: stage result ${input.run_id}/${input.attempt_ordinal}/${input.step_index}/${stage} ` +
            'already exists with different immutable content; refusing to overwrite it.',
        );
      }
      return record;
    });
  }

  async listStageEvents(tenant_id: string, run_id: string): Promise<readonly RunStageEventRecord[]> {
    assertIdentifier(tenant_id, 'tenant_id', 36, 'RUN_STAGE_EVENT_TENANT_ID_REQUIRED');
    assertIdentifier(run_id, 'run_id', 64, 'RUN_STAGE_EVENT_RUN_ID_REQUIRED');

    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<RunStageEventRow>(SELECT_STAGES, [tenant_id, run_id]);
      return result.rows.map(toStageRecord);
    });
  }

  async listStageResults(tenant_id: string, run_id: string): Promise<readonly RunStageResultRecord[]> {
    assertIdentifier(tenant_id, 'tenant_id', 36, 'RUN_STAGE_RESULT_TENANT_ID_REQUIRED');
    assertIdentifier(run_id, 'run_id', 64, 'RUN_STAGE_RESULT_RUN_ID_REQUIRED');
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<RunStageResultRow>(SELECT_STAGE_RESULTS, [tenant_id, run_id]);
      return result.rows.map(toStageResultRecord);
    });
  }

  async appendProviderCall(input: AppendProviderCallInput): Promise<ProviderCallLedgerRecord> {
    assertIdentifier(input.tenant_id, 'tenant_id', 36, 'PROVIDER_CALL_TENANT_ID_REQUIRED');
    assertIdentifier(input.run_id, 'run_id', 64, 'PROVIDER_CALL_RUN_ID_REQUIRED');
    assertNonNegativeInteger(input.step_index, 'step_index', 'PROVIDER_CALL_STEP_INVALID');
    const stage = assertRunStage(input.stage, 'PROVIDER_CALL_STAGE_INVALID');
    assertNonNegativeInteger(input.call_index, 'call_index', 'PROVIDER_CALL_INDEX_INVALID');
    const provider = assertBoundedText(input.provider, 'provider', 128, 'PROVIDER_CALL_INPUT_INVALID');
    const model = assertBoundedText(input.model, 'model', 256, 'PROVIDER_CALL_INPUT_INVALID');
    const observed_status = assertBoundedText(
      input.observed_status,
      'observed_status',
      64,
      'PROVIDER_CALL_STATUS_INVALID',
    );
    assertNullableNonNegativeInteger(input.latency_ms, 'latency_ms', 'PROVIDER_CALL_INPUT_INVALID');
    assertNullableNonNegativeInteger(input.prompt_tokens, 'prompt_tokens', 'PROVIDER_CALL_INPUT_INVALID');
    assertNullableNonNegativeInteger(input.completion_tokens, 'completion_tokens', 'PROVIDER_CALL_INPUT_INVALID');
    assertNullableNonNegativeInteger(input.cached_tokens, 'cached_tokens', 'PROVIDER_CALL_INPUT_INVALID');
    const estimated_cost_amount = assertCost(input.estimated_cost_amount, 'PROVIDER_CALL_INPUT_INVALID');
    const currency = input.currency === undefined || input.currency === null
      ? null
      : assertBoundedText(input.currency, 'currency', 8, 'PROVIDER_CALL_INPUT_INVALID');
    const cost_status = input.cost_status === undefined || input.cost_status === null
      ? null
      : assertBoundedText(input.cost_status, 'cost_status', 32, 'PROVIDER_CALL_INPUT_INVALID');
    const recorded_at = input.recorded_at === undefined
      ? null
      : normalizeInstant(input.recorded_at, 'recorded_at', 'PROVIDER_CALL_INPUT_INVALID');

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const inserted = await client.query<ProviderCallLedgerRow>(INSERT_PROVIDER_CALL, [
        input.tenant_id,
        input.run_id,
        input.step_index,
        stage,
        input.call_index,
        provider,
        model,
        observed_status,
        input.latency_ms ?? null,
        input.prompt_tokens ?? null,
        input.completion_tokens ?? null,
        input.cached_tokens ?? null,
        estimated_cost_amount,
        currency,
        cost_status,
        recorded_at,
      ]);
      const insertedRow = inserted.rows[0];
      if (insertedRow !== undefined) return toProviderCallRecord(insertedRow);

      const existing = await client.query<ProviderCallLedgerRow>(SELECT_PROVIDER_CALL, [
        input.tenant_id,
        input.run_id,
        input.step_index,
        stage,
        input.call_index,
      ]);
      const existingRow = requireRow(
        existing.rows[0],
        `PROVIDER_CALL_UNSTABLE: key conflict for ${input.run_id} returned no visible row (${CODE_OWNER}).`,
      );
      const existingRecord = toProviderCallRecord(existingRow);
      assertProviderReplayMatches(existingRecord, { ...input, provider, model, observed_status }, estimated_cost_amount);
      return existingRecord;
    });
  }

  async listProviderCalls(tenant_id: string, run_id: string): Promise<readonly ProviderCallLedgerRecord[]> {
    assertIdentifier(tenant_id, 'tenant_id', 36, 'PROVIDER_CALL_TENANT_ID_REQUIRED');
    assertIdentifier(run_id, 'run_id', 64, 'PROVIDER_CALL_RUN_ID_REQUIRED');

    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<ProviderCallLedgerRow>(SELECT_PROVIDER_CALLS, [tenant_id, run_id]);
      return result.rows.map(toProviderCallRecord);
    });
  }

  async listProviderCallsForRuns(tenant_id: string, run_ids: readonly string[]): Promise<readonly ProviderCallLedgerRecord[]> {
    assertIdentifier(tenant_id, 'tenant_id', 36, 'PROVIDER_CALL_TENANT_ID_REQUIRED');
    if (run_ids.length === 0) return [];
    for (const run_id of run_ids) assertIdentifier(run_id, 'run_id', 64, 'PROVIDER_CALL_TENANT_ID_REQUIRED');
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<ProviderCallLedgerRow>(SELECT_PROVIDER_CALLS_FOR_RUNS, [tenant_id, run_ids]);
      return result.rows.map(toProviderCallRecord);
    });
  }

  /** Short aliases used by callers that treat the tables as one run trace. */
  appendStage(input: AppendRunStageEventInput): Promise<RunStageEventRecord> {
    return this.appendStageEvent(input);
  }

  listStages(tenant_id: string, run_id: string): Promise<readonly RunStageEventRecord[]> {
    return this.listStageEvents(tenant_id, run_id);
  }
}

/** Compatibility names for consumers that address one ledger by its table name. */
export class RunStageEventRepository extends RunStageEventsRepository {}
export class ProviderCallLedgerRepository extends RunStageEventsRepository {}
