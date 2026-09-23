import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

import { withTenantContext } from '../rls.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

/**
 * Durable workflow state on PostgreSQL (`agentos.platform_durable_tasks`, implement/03 §1 DOMAIN 5).
 *
 * The row is the schedule of record for resume/recovery: it survives a worker crash, a lease is
 * bounded by `lease_expires_at`, and every write is either an optimistic `task_version` update or a
 * no-op (implement/04 §4.2). This module owns the task table only; the AUTH-4 pause and the human
 * decision — which write `approvals`/`actions` in the same transaction — live in
 * `repositories/approvals.ts` (`ApprovalRepository.pauseForApproval` / `claimApprovalAndResume`).
 *
 * Three rules shape every method below:
 *
 *  * **Tenant-scoped by construction.** Each call opens exactly one `withTenantContext()`
 *    transaction, so the transaction-local `app.current_tenant_id` binding and the `tenant_id`
 *    predicate always agree and RLS (NFR-006) denies an unbound read or write.
 *  * **`task_version` compare-and-increment.** The row is locked (`SELECT ... FOR UPDATE`) and every
 *    `UPDATE` restates `task_version = <base>` and increments it, so a stale writer matches 0 rows
 *    instead of overwriting a newer checkpoint (implement/04 §4.2, INT-FR-ORC-OPTIMISTIC-CAS). The
 *    increment is unconditional and monotonic: no caller can write a version back.
 *  * **Fail closed.** A state outside the closed lifecycle, a persisted error class outside
 *    `RETRYABLE`/`FATAL`, and a `waiting`/`awaiting_human` row without a complete checkpoint are all
 *    refused before anything is written (§4.2, §4.4). `UNKNOWN` is a reconciliation state owned by
 *    the effect reservation, never a task state and never `last_error_class`.
 */

/**
 * The closed lifecycle of `agentos.task_lifecycle_state` (implement/03 §1 DOMAIN 5). `UNKNOWN` is
 * deliberately absent: it is an effect/reconciliation outcome, not a task state.
 */
export type DurableTaskState =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'awaiting_human'
  | 'completed'
  | 'stopped'
  | 'failed';

/** The error classes `platform_durable_tasks.last_error_class` accepts (implement/04 §3.2.4). */
export type PersistedErrorClass = 'RETRYABLE' | 'FATAL';

/**
 * A failure classification as `classifyFailure()` produces it (§3.3). `UNKNOWN` is representable
 * only so the persistence layer can refuse it loudly: an indeterminate external outcome parks the
 * task in `waiting` and is reconciled by `effect_key` (§4.4), it is never stored as an error class.
 */
export type FailureClass = PersistedErrorClass | 'UNKNOWN';

/**
 * One durable task row. The three `TIMESTAMPTZ` columns are published as ISO-8601 UTC strings so
 * the checkpoint survives serialization into a worker or an API projection unchanged, and
 * `error_details` / `state_payload` stay `unknown` because only the caller may narrow them.
 */
export interface DurableTaskRecord {
  readonly task_id: string;
  readonly tenant_id: string;
  readonly run_id: string;
  readonly correlation_id: string;
  readonly current_step: number;
  readonly state: DurableTaskState;
  readonly task_version: number;
  readonly lease_owner: string | null;
  readonly lease_expires_at: string | null;
  readonly retry_count: number;
  readonly max_retries: number;
  readonly last_error_class: PersistedErrorClass | null;
  readonly paused_for_approval_id: string | null;
  readonly state_payload: unknown;
  readonly error_details: unknown;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * The read shape of `IStatefulWorkflowEngine.getTask()` (implement/04 §3.3): the four fields the
 * resume path decides from. `DurableTaskRecord` is a superset, so either can be published.
 */
export type DurableTaskSnapshot = Pick<
  DurableTaskRecord,
  'task_version' | 'state' | 'correlation_id' | 'state_payload'
>;

/** Input of `createTask()`; `current_step`/`state` default to the durable column defaults. */
export interface CreateDurableTaskInput {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly correlation_id: string;
  readonly current_step?: number;
  readonly state?: DurableTaskState;
  readonly max_retries?: number;
  readonly state_payload?: unknown;
}

/**
 * The optimistic guard of implement/04 §4.2, passed by a caller that read the task earlier.
 *
 * `expected_task_version` is required: without it a write is only atomic (the locked version is the
 * compare-and-increment base), never optimistic, and a slow writer would silently overlay a newer
 * checkpoint. `lease_owner` is optional because a console-issued write has no worker lease; when it
 * is supplied the row must hold a live lease for that owner (§4.2 statement 2).
 */
export interface DurableTaskGuard {
  readonly expected_task_version: number;
  readonly lease_owner?: string;
}

/** Input of `recordFailure()` (§4.4 durable recovery). */
export interface RecordTaskFailureInput {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly error_class: FailureClass;
  readonly error_details: Record<string, unknown>;
  /** Optional optimistic guard; see `DurableTaskGuard`. */
  readonly expected_task_version?: number;
}

/** Outcome of `recordFailure()`: whether the task was re-queued, and the row it left behind. */
export interface TaskFailureOutcome {
  /** `true` when the task returned to `queued` with `retry_count + 1`; `false` when it terminated. */
  readonly requeued: boolean;
  readonly state: DurableTaskState;
  readonly retry_count: number;
  readonly task_version: number;
}

/**
 * Input of `listTasks()`: the tenant, the optional filters, the page size and the resume cursor.
 *
 * `agent_id` is not a column of `platform_durable_tasks`: a run is bound to the agents that acted in
 * it by `agentos.agent_run_logs`, one row per resolved step, so the filter is an EXISTS over that
 * ledger for a step row of THIS tenant, this run and this agent.
 */
export interface DurableTaskListInput {
  readonly tenant_id: string;
  readonly state?: DurableTaskState;
  readonly agent_id?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * One page of durable tasks, newest first: at most `limit` rows and the cursor of the following page
 * (`null` at the end of the tenant's tasks for the filters asked for).
 *
 * The items are the published `DurableTaskRecord`s — the same projection `getTask()` returns — so a
 * read model built from a page cannot drift from the row a resume reads back.
 */
export interface DurableTaskPage {
  readonly items: readonly DurableTaskRecord[];
  readonly next_cursor: string | null;
}

/**
 * Input of `requeueFailed()`: the tenant, the run, why the operator re-enters it, and the
 * optional optimistic guard.
 *
 * `reason` is required because a requeue is an operator decision about a failed run, and the audit
 * trail must be able to explain it; P0 stores no transition history on the task row, so the reason
 * is validated here and belongs to the append-only `audit_records` row the caller writes (§4.1).
 */
export interface RequeueFailedTaskInput {
  readonly tenant_id: string;
  readonly run_id: string;
  /** Why the operator re-enters the failed run; required, and echoed in every refusal. */
  readonly reason: string;
  /** Optional optimistic guard; see `DurableTaskGuard`. */
  readonly expected_task_version?: number;
}

/**
 * `agentos` is not on the connection `search_path`, so every statement is schema-qualified.
 *
 * Exported for `ApprovalRepository`, whose pause and human-decision transactions write the same
 * table and must not spell the name a second time.
 */
export const PLATFORM_DURABLE_TASKS = 'agentos.platform_durable_tasks';

/** Every state the enum accepts, in declaration order. */
const DURABLE_TASK_STATES: readonly DurableTaskState[] = [
  'queued',
  'running',
  'waiting',
  'awaiting_human',
  'completed',
  'stopped',
  'failed',
];

/** States a task never leaves: a terminal row is closed, and a new attempt needs a new run. */
const TERMINAL_STATES: readonly DurableTaskState[] = ['completed', 'stopped', 'failed'];

/**
 * States whose `state_payload` must be a COMPLETE `DurableTaskCheckpoint` (implement/04 §4.2). The
 * resume path re-enters the plan from this blob and fails closed with `CHECKPOINT_INCOMPLETE`
 * rather than re-deciding anything, so an incomplete checkpoint must never reach the column.
 */
const PARKED_STATES: readonly DurableTaskState[] = ['waiting', 'awaiting_human'];

/**
 * States that own their progress: a queued, running or waiting task may checkpoint and may record a
 * classified failure. `awaiting_human` is excluded on purpose — a parked task is moved only by the
 * human decision (`claimApprovalAndResume`), so a progress write there would bypass the gate.
 */
const OPEN_STATES: readonly DurableTaskState[] = ['queued', 'running', 'waiting'];

/**
 * Members a complete `DurableTaskCheckpoint` carries (implement/04 §3.3): the plan, the cursor, the
 * drafted action, the hydrated context, the evidence-chain cursor and the immutable inbound
 * identity the resumed step derives its `effect_key` from.
 */
const CHECKPOINT_MEMBERS: readonly string[] = [
  'plan',
  'current_step',
  'pending_action',
  'context',
  'previous_evidence_hash',
  'request_id',
];

/** Bare lowercase hex SHA-256, the only accepted encoding of a chain cursor. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Separator of the `<created_at>|<run_id>` keyset cursor `listTasks()` publishes and accepts. */
const CURSOR_SEPARATOR = '|';

/** Default page size of `listTasks()`, and the largest page it accepts. */
const DEFAULT_TASK_LIST_LIMIT = 50;
const MAX_TASK_LIST_LIMIT = 200;

/**
 * The step ledger that binds a run to the agents that acted in it (`agent_run_logs`: one row per
 * executed pipeline step, the 18-field execution audit contract of implement/04 §6.1). Read-only
 * here: `listTasks()` filters the task page through it by `(tenant_id, run_id, agent_id)`, while the
 * row itself is appended by `EvidenceRepository.logAgentRun()`.
 */
const AGENT_RUN_LOGS = 'agentos.agent_run_logs';

/**
 * The columns every read publishes, in the order `toDurableTaskRecord` expects them.
 *
 * Exported so `ApprovalRepository` returns the parked or resumed task from its own `RETURNING`
 * clause through the same projector and the same column list — a second projection would silently
 * drift from the record it publishes.
 */
export const TASK_PROJECTION = `
    task_id,
    tenant_id,
    run_id,
    correlation_id,
    current_step,
    state,
    task_version,
    lease_owner,
    lease_expires_at,
    retry_count,
    max_retries,
    last_error_class,
    paused_for_approval_id,
    state_payload,
    error_details,
    created_at,
    updated_at`;

const INSERT_TASK = `INSERT INTO ${PLATFORM_DURABLE_TASKS} (
    tenant_id,
    run_id,
    correlation_id,
    current_step,
    state,
    max_retries,
    state_payload
  )
  VALUES ($1, $2, $3, $4, $5::agentos.task_lifecycle_state, $6, $7::jsonb)
  RETURNING${TASK_PROJECTION}`;

const SELECT_TASK = `SELECT${TASK_PROJECTION}
  FROM ${PLATFORM_DURABLE_TASKS}
  WHERE tenant_id = $1 AND run_id = $2`;

/**
 * The locking read every write path starts with. `FOR UPDATE` serializes two writers of the same run
 * and lets this module report *why* a guard failed (missing row, closed state, stale version)
 * instead of inferring it from an update that matched nothing.
 */
const SELECT_TASK_FOR_UPDATE = `${SELECT_TASK}
  FOR UPDATE`;

/**
 * One page of the tenant's durable tasks, newest first (implement/04 §4.1, the R16 read model).
 *
 * The page is ordered and paged by `(created_at, run_id)` — the instant the row was created, never
 * `updated_at`, so a task a worker keeps writing does not move under the cursor and a page can
 * neither repeat nor skip a run. Every optional predicate is part of the one statement, so the page
 * is a single seek:
 *
 *  * `state` narrows the closed lifecycle enum (an absent filter binds SQL `NULL`);
 *  * `from` / `to` are inclusive bounds on the creation instant;
 *  * `agent_id` is bound through `agentos.agent_run_logs`: the EXISTS makes the task visible only
 *    when THIS tenant holds a step row of THIS run for that agent, so the ledger is read
 *    tenant-scoped by construction and a run the agent never acted in is out of scope;
 *  * the cursor resumes strictly after `(created_at, run_id)`, the durable ordering key of the page.
 *
 * `t` is the task row being paged; `log` is correlated to it by tenant and run, so no other tenant's
 * ledger row and no other run's can satisfy the filter.
 */
const SELECT_TASK_PAGE = `SELECT${TASK_PROJECTION}
  FROM ${PLATFORM_DURABLE_TASKS} AS t
  WHERE t.tenant_id = $1
    AND ($2::agentos.task_lifecycle_state IS NULL OR t.state = $2::agentos.task_lifecycle_state)
    AND ($3::timestamptz IS NULL OR t.created_at >= $3::timestamptz)
    AND ($4::timestamptz IS NULL OR t.created_at <= $4::timestamptz)
    AND ($5::varchar IS NULL OR EXISTS (
      SELECT 1
        FROM ${AGENT_RUN_LOGS} AS log
        WHERE log.tenant_id = t.tenant_id
          AND log.run_id = t.run_id
          AND log.agent_id = $5::varchar
    ))
    AND ($6::timestamptz IS NULL OR (t.created_at, t.run_id) < ($6::timestamptz, $7::varchar))
  ORDER BY t.created_at DESC, t.run_id DESC
  LIMIT $8`;

/** Progress checkpoint (§4.2 statement 2): merge the blob, advance the cursor, bump the version. */
const UPDATE_TASK_PROGRESS = `UPDATE ${PLATFORM_DURABLE_TASKS}
  SET current_step = $3,
      state_payload = state_payload || $4::jsonb,
      task_version = task_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND run_id = $2 AND task_version = $5
  RETURNING${TASK_PROJECTION}`;

/** State transition that does not touch `state_payload` (§4.1 transition table). */
const UPDATE_TASK_STATE = `UPDATE ${PLATFORM_DURABLE_TASKS}
  SET state = $3::agentos.task_lifecycle_state,
      task_version = task_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND run_id = $2 AND task_version = $4
  RETURNING${TASK_PROJECTION}`;

/** Park transition: `state_payload` is REPLACED by the complete checkpoint, never merged. */
const UPDATE_TASK_STATE_REPLACE_PAYLOAD = `UPDATE ${PLATFORM_DURABLE_TASKS}
  SET state = $3::agentos.task_lifecycle_state,
      state_payload = $4::jsonb,
      task_version = task_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND run_id = $2 AND task_version = $5
  RETURNING${TASK_PROJECTION}`;

/** Transition carrying a progress payload: the blob is merged so an existing cursor is not lost. */
const UPDATE_TASK_STATE_MERGE_PAYLOAD = `UPDATE ${PLATFORM_DURABLE_TASKS}
  SET state = $3::agentos.task_lifecycle_state,
      state_payload = state_payload || $4::jsonb,
      task_version = task_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND run_id = $2 AND task_version = $5
  RETURNING${TASK_PROJECTION}`;

/**
 * `RETRYABLE` failure inside the retry budget (§4.4): re-queue with `retry_count + 1` and release
 * the lease, because the worker that failed is done with the task and a dead lease must not hold the
 * next attempt back for its full TTL.
 */
const UPDATE_TASK_FAILURE_REQUEUE = `UPDATE ${PLATFORM_DURABLE_TASKS}
  SET state = 'queued',
      retry_count = retry_count + 1,
      last_error_class = $3,
      error_details = $4::jsonb,
      lease_owner = NULL,
      lease_expires_at = NULL,
      task_version = task_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND run_id = $2 AND task_version = $5
  RETURNING${TASK_PROJECTION}`;

/**
 * `FATAL` failure, or `RETRYABLE` with the budget spent (§4.4): terminate fail-closed.
 * `retry_count` records the attempts that were made and is left as it is.
 */
const UPDATE_TASK_FAILURE_TERMINAL = `UPDATE ${PLATFORM_DURABLE_TASKS}
  SET state = 'failed',
      last_error_class = $3,
      error_details = $4::jsonb,
      task_version = task_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND run_id = $2 AND task_version = $5
  RETURNING${TASK_PROJECTION}`;

/**
 * The explicit operator requeue of a failed run (§4.4 recovery, the R13 re-entry).
 *
 * Only a `failed` row reaches this statement: the state is verified on the locked row, and the lock
 * is held until the transaction commits, so no terminal state but `failed` can be re-entered by it.
 * The statement writes the transition and nothing else — `state_payload` (the plan, the cursor, the
 * drafted action and the immutable `request_id` the resumed step derives the SAME `effect_key`
 * from), `current_step`, `retry_count`, `max_retries` and `correlation_id` are all left as the
 * failed attempt left them, so the re-entered run resumes from the same verified cursor under its
 * original effect identity. `last_error_class` / `error_details` are cleared because the row is
 * queued again rather than failed, and the lease is released so a dead worker's lease cannot hold
 * the next attempt back for its full TTL.
 */
const UPDATE_TASK_OPERATOR_REQUEUE = `UPDATE ${PLATFORM_DURABLE_TASKS}
  SET state = 'queued',
      last_error_class = NULL,
      error_details = NULL,
      lease_owner = NULL,
      lease_expires_at = NULL,
      task_version = task_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND run_id = $2 AND task_version = $3
  RETURNING${TASK_PROJECTION}`;

/**
 * One task row exactly as `pg` returns it, before the projection is published.
 *
 * Exported so `ApprovalRepository` can type its own task writes and hand their rows to
 * `toDurableTaskRecord` without redeclaring the columns.
 */
export interface DurableTaskRow extends QueryResultRow {
  task_id: string;
  tenant_id: string;
  run_id: string;
  correlation_id: string;
  current_step: number;
  state: DurableTaskState;
  task_version: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  retry_count: number;
  max_retries: number;
  last_error_class: PersistedErrorClass | null;
  paused_for_approval_id: string | null;
  state_payload: unknown;
  error_details: unknown;
  created_at: Date;
  updated_at: Date;
}

/**
 * Publishes one row with its timestamps as ISO-8601 UTC strings, so a leased task survives
 * serialization into a worker message or an API response unchanged.
 */
export function toDurableTaskRecord(row: DurableTaskRow): DurableTaskRecord {
  return {
    task_id: row.task_id,
    tenant_id: row.tenant_id,
    run_id: row.run_id,
    correlation_id: row.correlation_id,
    current_step: row.current_step,
    state: row.state,
    task_version: row.task_version,
    lease_owner: row.lease_owner,
    lease_expires_at: row.lease_expires_at === null ? null : row.lease_expires_at.toISOString(),
    retry_count: row.retry_count,
    max_retries: row.max_retries,
    last_error_class: row.last_error_class,
    paused_for_approval_id: row.paused_for_approval_id,
    state_payload: row.state_payload,
    error_details: row.error_details,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/**
 * Locks the run's durable task and publishes it.
 *
 * Exported for the approval lifecycle, which must lock the task in the same transaction that writes
 * `actions`/`approvals` (implement/04 §4.2 statements 3 and 4). Both entry points take the task lock
 * first and only then touch `actions`/`approvals`, so the lock order is uniform and two workers of
 * the same run serialize instead of deadlocking.
 *
 * @param client Client of a tenant-scoped transaction.
 * @param tenant_id Tenant that owns the run; also enforced by row-level security.
 * @param run_id Durable run identifier.
 * @returns The locked row, or `null` when this tenant holds no task for the run.
 */
export async function lockDurableTask(
  client: PoolClient,
  tenant_id: string,
  run_id: string,
): Promise<DurableTaskRecord | null> {
  const result = await client.query<DurableTaskRow>(SELECT_TASK_FOR_UPDATE, [tenant_id, run_id]);

  return result.rows[0] === undefined ? null : toDurableTaskRecord(result.rows[0]);
}

/**
 * Serializes a value that is about to be written into a `jsonb` column.
 *
 * A value JSON cannot represent is refused instead of being silently dropped (an `undefined` member
 * simply disappears from the stored blob, which would let a checkpoint claim a member it does not
 * actually carry).
 *
 * @param value Value to store.
 * @param code Error code to raise for an unrepresentable value.
 * @returns JSON text, cast to `jsonb` by the statement.
 * @throws Error `<code>` when the value cannot be serialized.
 */
export function serializeJsonb(value: unknown, code: string): string {
  let serialized: string | undefined;

  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${code}: the payload is not JSON-serializable.`, { cause: error });
  }

  if (serialized === undefined) {
    throw new Error(
      `${code}: the payload is not JSON-serializable (a value JSON has no member for it).`,
    );
  }

  return serialized;
}

/**
 * Refuses anything that is not a complete `DurableTaskCheckpoint` (implement/04 §4.2).
 *
 * Completeness is checked member by member against the port's checkpoint contract: a member whose
 * value is `undefined` counts as absent because JSON would drop it, and the evidence-chain cursor
 * must be a bare SHA-256 so the resumed step continues the same hash chain (`GENESIS_HASH` is the
 * 64-zero digest and satisfies this).
 *
 * @param checkpoint Candidate `state_payload` of a task parked in `waiting` / `awaiting_human`.
 * @throws Error `CHECKPOINT_INCOMPLETE` when a member is missing or cannot be a checkpoint.
 */
export function assertCompleteCheckpoint(checkpoint: unknown): asserts checkpoint is Record<string, unknown> {
  if (!isPlainObject(checkpoint)) {
    throw new Error(
      'CHECKPOINT_INCOMPLETE: a task parked in waiting or awaiting_human requires a complete ' +
        'DurableTaskCheckpoint object; refusing to store this state_payload (implement/04 §4.2).',
    );
  }

  const missing = CHECKPOINT_MEMBERS.filter((member) => checkpoint[member] === undefined);

  if (missing.length > 0) {
    throw new Error(
      `CHECKPOINT_INCOMPLETE: the checkpoint is missing ${missing.join(', ')}; the resume path ` +
        're-enters the plan from these members and never re-decides them (implement/04 §4.2).',
    );
  }

  const { current_step, pending_action, previous_evidence_hash, request_id, plan, context } =
    checkpoint;

  if (!Number.isInteger(current_step) || (current_step as number) < 1) {
    throw new Error(
      'CHECKPOINT_INCOMPLETE: current_step must be a positive integer, the step the resumed run ' +
        'continues from (implement/04 §4.2).',
    );
  }

  if (!isPlainObject(plan) || !isPlainObject(context)) {
    throw new Error(
      'CHECKPOINT_INCOMPLETE: plan and context must be JSON objects; the resumed run hydrates its ' +
        'next step from them (implement/04 §4.2).',
    );
  }

  if (pending_action !== null && !isPlainObject(pending_action)) {
    throw new Error(
      'CHECKPOINT_INCOMPLETE: pending_action must be the drafted action or null (implement/04 §4.2).',
    );
  }

  if (typeof previous_evidence_hash !== 'string' || !SHA256_HEX.test(previous_evidence_hash)) {
    throw new Error(
      'CHECKPOINT_INCOMPLETE: previous_evidence_hash must be the bare lowercase 64-character hex ' +
        'SHA-256 of the predecessor evidence record (the 64-zero genesis digest for the first ' +
        'step); the resumed step continues that chain (implement/04 §4.2).',
    );
  }

  if (typeof request_id !== 'string' || request_id.trim().length === 0) {
    throw new Error(
      'CHECKPOINT_INCOMPLETE: request_id must be the immutable inbound identity the resumed step ' +
        'derives the SAME effect_key from (implement/04 §4.2).',
    );
  }
}

/** Reports whether a value is a plain JSON object (never an array, `null`, or a class instance). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

/** Validates a lifecycle state against the closed enum (`UNKNOWN` is not a member). */
function assertTaskState(state: unknown): asserts state is DurableTaskState {
  if (typeof state !== 'string' || !DURABLE_TASK_STATES.includes(state as DurableTaskState)) {
    throw new Error(
      `TASK_STATE_INVALID: ${String(state)} is not a lifecycle state; the closed set is ` +
        `${DURABLE_TASK_STATES.join(', ')} and UNKNOWN is an effect/reconciliation outcome, never ` +
        'a task state or a task error class (implement/03 §1 DOMAIN 5, implement/04 §3.2.4).',
    );
  }
}

/**
 * Validates a non-empty bounded identifier against a `VARCHAR(n)` column.
 *
 * Exported for `ApprovalRepository`, which addresses the same run by `tenant_id` and `run_id` and
 * must refuse a blank identity the same way rather than let the database truncate or reject it.
 */
export function assertIdentifier(value: unknown, column: string, max_length: number, code: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${code}: the durable task is addressed by tenant_id and ${column} (${CODE_OWNER}).`);
  }

  if (value.length > max_length) {
    throw new Error(
      `${code}: ${column} is longer than the ${max_length} characters the column accepts; ` +
        'refusing to let the database truncate a durable identity (NFR-004).',
    );
  }
}

/** The owning document of every refusal this module raises. */
const CODE_OWNER = 'implement/03 §1 DOMAIN 5, implement/04 §4.2';

/**
 * Validates a positive integer column value (`current_step`, `task_version`, `step_index`).
 *
 * Exported for `ApprovalRepository`, whose writes restate the same `task_version` CAS base and the
 * same `actions.action_revision` column contract.
 */
export function assertPositiveInteger(value: unknown, column: string, code: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${code}: ${column} must be an integer >= 1 (${CODE_OWNER}).`);
  }
}

/**
 * Validates a lease guard against the locked row (implement/04 §4.2 statement 2).
 *
 * Only used when the caller supplied `lease_owner`: the console-issued writes have no worker lease,
 * and inventing one would turn a real precondition into decoration. `ApprovalRepository` follows the
 * same rule for its pause, because no caller of `pauseForApproval` carries a worker identity.
 *
 * Exported so both modules refuse a write by a worker that does not hold the run's lease with one
 * message instead of two slightly different ones.
 */
export function assertLeaseHeld(state: DurableTaskState, lease_owner: string | undefined): void {
  if (lease_owner === undefined) {
    return;
  }

  if (lease_owner.trim().length === 0) {
    throw new Error(
      'TASK_LEASE_OWNER_REQUIRED: lease_owner must be a non-empty worker identity when supplied.',
    );
  }

  if (state !== 'running') {
    throw new Error(
      `TASK_LEASE_NOT_HELD: lease_owner ${lease_owner} cannot write a task in state ${state}; ` +
        'only a running task is owned by a worker lease (implement/04 §4.2).',
    );
  }
}

/**
 * Validates an ISO-8601 instant bound into a `TIMESTAMPTZ` parameter.
 *
 * An unparseable instant would be rejected by the planner with a bare driver error, and `created_at`
 * is the ordering key the page is read by, so it is refused here with the field that is wrong.
 */
function assertInstant(value: unknown, column: string, code: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(
      `${code}: ${column} must be an ISO-8601 instant so the created_at bound of the page stays ` +
        `comparable to the durable ordering key (${CODE_OWNER}).`,
    );
  }

  return value;
}

/**
 * Validates the agent filter of `listTasks()`.
 *
 * `agent_run_logs.agent_id` is a `VARCHAR(32)` identity. A blank value would match no step row and
 * silently answer an empty page, and an oversized one cannot be a stored identity, so both are
 * refused instead of being applied as a filter that cannot match anything.
 */
function assertAgentId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 32) {
    throw new Error(
      'TASK_AGENT_ID_INVALID: agent_id must be the non-empty identity (at most 32 characters) of ' +
        'an agent that holds a step row in agentos.agent_run_logs for the runs it acted in ' +
        `(${CODE_OWNER}).`,
    );
  }

  return value;
}

/**
 * Parses the keyset cursor of `listTasks()`.
 *
 * A cursor is `<created_at>|<run_id>`: the exact key of the last row of the previous page, and both
 * halves are validated in the strictest form this module publishes. The instant must be exactly the
 * canonical ISO-8601 UTC string of the row, and the run id must be a non-empty `VARCHAR(64)` value
 * that does not itself carry the separator — the first separator is where the cursor splits, so a
 * run id containing one could not be published as a round-tripping cursor in the first place.
 * Anything else is refused rather than applied as a "close enough" bound, because a wrong bound
 * silently skips or repeats durable runs.
 *
 * @param cursor Candidate cursor, as handed back by a client.
 * @returns The `(created_at, run_id)` pair the next page resumes strictly after.
 * @throws Error `TASK_LIST_CURSOR_INVALID` when the cursor is not one this module published.
 */
function parseTaskListCursor(
  cursor: unknown,
): { readonly created_at: string; readonly run_id: string } {
  const separator = typeof cursor === 'string' ? cursor.indexOf(CURSOR_SEPARATOR) : -1;
  const created_at = separator < 0 ? '' : (cursor as string).slice(0, separator);
  const run_id = separator < 0 ? '' : (cursor as string).slice(separator + 1);
  const instant = new Date(created_at);

  if (
    separator < 0 ||
    Number.isNaN(instant.getTime()) ||
    instant.toISOString() !== created_at ||
    run_id.trim().length === 0 ||
    run_id.length > 64 ||
    run_id.includes(CURSOR_SEPARATOR)
  ) {
    throw new Error(
      `TASK_LIST_CURSOR_INVALID: ${String(cursor)} is not a task-page cursor; a cursor is ` +
        '`<created_at>|<run_id>`, carrying the canonical ISO-8601 UTC instant and the run id of the ' +
        `row the previous page ended on (${CODE_OWNER}).`,
    );
  }

  return { created_at, run_id };
}

/**
 * Reads the SQLSTATE of a `pg` driver error, when the failure carries one.
 *
 * Only used to translate the two constraints an honest caller can actually hit — a unique violation
 * (`23505`) on a tenant-scoped key — into a refusal that names the key it collided on. Anything else
 * is rethrown untouched, because a driver or connection failure is not a lifecycle outcome.
 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }

  const { code } = error as { code?: unknown };

  return typeof code === 'string' ? code : undefined;
}

/**
 * Resolves the compare-and-increment base of a write from the locked row (implement/04 §4.2).
 *
 * The base is what the `UPDATE` restates as `task_version = <base>`, so a writer that lost the race
 * matches 0 rows instead of forcing a newer checkpoint back to its own version. A supplied guard is
 * therefore compared here, while the row is locked, so the refusal can say which versions disagreed
 * rather than inferring it from an empty result set.
 *
 * @param locked Row read under `SELECT ... FOR UPDATE`.
 * @param guard Caller's optimistic guard, if any.
 * @returns The version the write must compare against.
 * @throws Error `TASK_VERSION_INVALID` when the guarded version is not a positive integer.
 * @throws Error `TASK_VERSION_CONFLICT` when the stored version is not the guarded one.
 */
export function assertGuard(locked: DurableTaskRecord, guard: DurableTaskGuard | undefined): number {
  if (guard === undefined) {
    return locked.task_version;
  }

  assertPositiveInteger(guard.expected_task_version, 'task_version', 'TASK_VERSION_INVALID');

  if (locked.task_version !== guard.expected_task_version) {
    throw new Error(
      `TASK_VERSION_CONFLICT: run ${locked.run_id} is at task_version ${locked.task_version}, not ` +
        `the guarded ${guard.expected_task_version}; the caller read a stale checkpoint, so this ` +
        'write is refused instead of overwriting the newer one (INT-FR-ORC-OPTIMISTIC-CAS).',
    );
  }

  return locked.task_version;
}

/**
 * Publishes the single row of a writing statement — `INSERT ... RETURNING`, or an `UPDATE ...
 * RETURNING` whose guard, state and lock were already verified.
 *
 * A locked row cannot vanish and cannot change version behind the lock, so a write that matched
 * anything other than exactly one row is a defect in the statement — never a conflict. Reporting
 * success without a returned row would let a caller treat an unpersisted checkpoint as durable.
 *
 * @param result Result of the writing statement's `RETURNING`.
 * @param run_id Run the statement addressed, for the refusal message.
 * @returns The written row, published for the caller.
 * @throws Error `TASK_WRITE_LOST` when the statement returned no row.
 */
export function assertSingleRow(
  result: QueryResult<DurableTaskRow>,
  run_id: string,
): DurableTaskRecord {
  const [row] = result.rows;

  if (row === undefined) {
    throw new Error(
      `TASK_WRITE_LOST: the guarded write of run ${run_id} matched no row after the row had been ` +
        'locked and its version verified; refusing to report a checkpoint that was not persisted ' +
        '(implement/04 §4.2).',
    );
  }

  return toDurableTaskRecord(row);
}

/**
 * Durable task persistence (implement/03 §1 DOMAIN 5, implement/04 §4.1-§4.2).
 *
 * The surface is the durable half of `IStatefulWorkflowEngine`: create the run's task row, read it
 * back, page the tenant's rows for the operator read model, checkpoint progress, transition the
 * lifecycle state, record a classified failure, and re-enter a failed run at the operator's explicit
 * request. Every method opens exactly one tenant-scoped transaction through `withTenantContext`, and
 * every write locks the row, compares `task_version` and increments it.
 *
 * The AUTH-4 pause and the human decision are NOT here: they must write `actions` and `approvals`
 * in the same transaction as the task, which is `ApprovalRepository`'s job.
 */
export class DurableWorkflowRepository {
  private readonly runInTenantTransaction: TenantTransactionRunner;

  /**
   * @param runInTenantTransaction Binds a tenant to the transaction every statement runs in.
   * Defaults to the package's `withTenantContext` binder.
   */
  constructor(runInTenantTransaction: TenantTransactionRunner = withTenantContext) {
    this.runInTenantTransaction = runInTenantTransaction;
  }

  /**
   * Creates the durable task of a run (implement/04 §4.1, `platform_durable_tasks`).
   *
   * One row per `(tenant_id, run_id)` (`uq_platform_tasks_run`): a redelivered request starts a new
   * run with its own id, so a taken key is a programming error and is refused rather than merged.
   *
   * @param input Tenant, run, correlation id and the opening step/state.
   * @returns The inserted row, at `task_version` 1.
   * @throws Error `TASK_STATE_INVALID` for a state outside the closed enum.
   * @throws Error `TASK_CURRENT_STEP_INVALID` / `TASK_MAX_RETRIES_INVALID` for a bad column value.
   * @throws Error `DURABLE_TASK_EXISTS` when this tenant already has a task for the run.
   */
  async createTask(input: CreateDurableTaskInput): Promise<DurableTaskRecord> {
    assertIdentifier(input.tenant_id, 'tenant_id', 36, 'TASK_TENANT_ID_REQUIRED');
    assertIdentifier(input.run_id, 'run_id', 64, 'TASK_RUN_ID_REQUIRED');
    assertIdentifier(input.correlation_id, 'correlation_id', 64, 'TASK_CORRELATION_ID_REQUIRED');

    const state = input.state ?? 'queued';
    assertTaskState(state);

    const current_step = input.current_step ?? 1;
    assertPositiveInteger(current_step, 'current_step', 'TASK_CURRENT_STEP_INVALID');

    const max_retries = input.max_retries ?? 3;
    if (typeof max_retries !== 'number' || !Number.isInteger(max_retries) || max_retries < 0) {
      throw new Error(
        'TASK_MAX_RETRIES_INVALID: max_retries must be an integer >= 0; it bounds how often the ' +
          'task is re-queued on a RETRYABLE failure (implement/04 §4.4).',
      );
    }

    if (PARKED_STATES.includes(state)) {
      assertCompleteCheckpoint(input.state_payload);
    }

    const state_payload = serializeJsonb(input.state_payload ?? {}, 'TASK_PAYLOAD_UNSERIALIZABLE');

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      try {
        const result = await client.query<DurableTaskRow>(INSERT_TASK, [
          input.tenant_id,
          input.run_id,
          input.correlation_id,
          current_step,
          state,
          max_retries,
          state_payload,
        ]);

        return assertSingleRow(result, input.run_id);
      } catch (error) {
        if (errorCode(error) === '23505') {
          throw new Error(
            `DURABLE_TASK_EXISTS: run ${input.run_id} already has a durable task in this tenant ` +
              '(uq_platform_tasks_run); a retry reuses the run, it never creates a second schedule ' +
              'of record (implement/04 §4.2).',
            { cause: error },
          );
        }

        throw error;
      }
    });
  }

  /**
   * Reads the durable task of one run inside the caller's tenant scope.
   *
   * @param tenant_id Tenant that owns the row; also enforced by row-level security.
   * @param run_id Durable run identifier.
   * @returns The stored row, or `null` when this tenant holds no task for the run.
   */
  async getTask(tenant_id: string, run_id: string): Promise<DurableTaskRecord | null> {
    assertIdentifier(run_id, 'run_id', 64, 'TASK_RUN_ID_REQUIRED');

    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<DurableTaskRow>(SELECT_TASK, [tenant_id, run_id]);

      return result.rows[0] === undefined ? null : toDurableTaskRecord(result.rows[0]);
    });
  }

  /**
   * Reads one page of the tenant's durable runs, newest first (implement/04 §4.1, the R16 read model).
   *
   * The page is ordered and paged by `(created_at, run_id)` — the instant the row was created, never
   * `updated_at`, so a run a worker keeps writing does not move under the cursor. `limit + 1` rows
   * are read so `next_cursor` is `null` exactly when no further row exists; the cursor it publishes
   * is the exact key of the last row of the page.
   *
   * Every filter is applied inside the tenant's transaction, so the run list a tenant reads is its
   * own by predicate and by row-level security alike, and the `agent_id` filter reads
   * `agentos.agent_run_logs` with the same binding.
   *
   * @param input Tenant, the optional state / agent / creation-window filters, page size and cursor.
   * @returns The page, newest first, and the cursor of the following page (`null` at the end).
   * @throws Error `TASK_STATE_INVALID` for a state outside the closed lifecycle.
   * @throws Error `TASK_AGENT_ID_INVALID` for a blank or oversized agent filter.
   * @throws Error `TASK_LIST_RANGE_INVALID` when `from` / `to` is not an ISO-8601 instant.
   * @throws Error `TASK_LIST_LIMIT_INVALID` when `limit` is not an integer in 1..200.
   * @throws Error `TASK_LIST_CURSOR_INVALID` when a cursor is not one this module published.
   */
  async listTasks(input: DurableTaskListInput): Promise<DurableTaskPage> {
    assertIdentifier(input.tenant_id, 'tenant_id', 36, 'TASK_TENANT_ID_REQUIRED');

    const state = input.state ?? null;

    if (state !== null) {
      assertTaskState(state);
    }

    const agent_id = input.agent_id === undefined ? null : assertAgentId(input.agent_id);
    const from =
      input.from === undefined
        ? null
        : assertInstant(input.from, 'from', 'TASK_LIST_RANGE_INVALID');
    const to =
      input.to === undefined ? null : assertInstant(input.to, 'to', 'TASK_LIST_RANGE_INVALID');
    const limit = input.limit ?? DEFAULT_TASK_LIST_LIMIT;

    if (
      typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_TASK_LIST_LIMIT
    ) {
      throw new Error(
        `TASK_LIST_LIMIT_INVALID: limit must be an integer between 1 and ${MAX_TASK_LIST_LIMIT} ` +
          `(default ${DEFAULT_TASK_LIST_LIMIT}); received ${String(input.limit)}.`,
      );
    }

    const cursor = input.cursor === undefined ? null : parseTaskListCursor(input.cursor);

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<DurableTaskRow>(SELECT_TASK_PAGE, [
        input.tenant_id,
        state,
        from,
        to,
        agent_id,
        cursor === null ? null : cursor.created_at,
        cursor === null ? null : cursor.run_id,
        limit + 1,
      ]);
      const rows = result.rows.slice(0, limit);
      const last = rows[rows.length - 1];

      return {
        items: rows.map(toDurableTaskRecord),
        next_cursor:
          result.rows.length > limit && last !== undefined
            ? `${last.created_at.toISOString()}${CURSOR_SEPARATOR}${last.run_id}`
            : null,
      };
    });
  }

  /**
   * Advances the run's cursor and merges a progress payload (implement/04 §4.2 statement 2).
   *
   * The write is refused while the task is parked (`awaiting_human`, where only the human decision
   * may move it) or terminal, and the version guard makes a stale writer match 0 rows instead of
   * overwriting a newer checkpoint (INT-FR-ORC-OPTIMISTIC-CAS).
   *
   * @param tenant_id Tenant that owns the run.
   * @param run_id Durable run identifier.
   * @param stepIndex Step the run has reached.
   * @param checkpointPayload Progress blob, merged into `state_payload`.
   * @param guard Optional optimistic guard; without it the locked version is the CAS base.
   * @returns The row after the write.
   * @throws Error `DURABLE_TASK_NOT_FOUND` when the tenant holds no task for the run.
   * @throws Error `TASK_ALREADY_TERMINAL` / `TASK_NOT_PROGRESSABLE` for a closed or parked task.
   * @throws Error `TASK_VERSION_CONFLICT` when the guard's version is not the stored one.
   * @throws Error `TASK_LEASE_NOT_HELD` when a supplied lease owner does not hold the lease.
   */
  async updateTaskProgress(
    tenant_id: string,
    run_id: string,
    stepIndex: number,
    checkpointPayload: unknown,
    guard?: DurableTaskGuard,
  ): Promise<DurableTaskRecord> {
    assertIdentifier(run_id, 'run_id', 64, 'TASK_RUN_ID_REQUIRED');
    assertPositiveInteger(stepIndex, 'current_step', 'TASK_CURRENT_STEP_INVALID');

    if (!isPlainObject(checkpointPayload)) {
      throw new Error(
        'TASK_PROGRESS_PAYLOAD_INVALID: a progress checkpoint is a JSON object merged into ' +
          'state_payload; a non-object would replace the blob instead of extending it ' +
          '(implement/04 §4.2 statement 2).',
      );
    }

    const state_payload = serializeJsonb(checkpointPayload, 'TASK_PAYLOAD_UNSERIALIZABLE');

    return this.runInTenantTransaction(tenant_id, async (client) => {
      const open = this.assertOpen(await this.lockWithin(client, tenant_id, run_id));
      const base = assertGuard(open, guard);
      assertLeaseHeld(open.state, guard?.lease_owner);

      const result = await client.query<DurableTaskRow>(UPDATE_TASK_PROGRESS, [
        tenant_id,
        run_id,
        stepIndex,
        state_payload,
        base,
      ]);

      return assertSingleRow(result, run_id);
    });
  }

  /**
   * Moves the task along the closed lifecycle (implement/04 §4.1 transition table).
   *
   * Write discipline, in the order the refusals fire:
   *
   *  * `UNKNOWN` is not a state, and a blank reason is not a transition intent;
   *  * entering `waiting` or `awaiting_human` requires a COMPLETE checkpoint, which REPLACES
   *    `state_payload` — a progress merge would store a checkpoint with a stale cursor;
   *  * a terminal row is closed and a parked row is owned by its approval: neither can be moved
   *    here, so `awaiting_human` is only reachable through
   *    `ApprovalRepository.pauseForApproval` and only left through `claimApprovalAndResume`;
   *  * the guard's `expected_task_version` must be the stored version, and the update restates it,
   *    so a stale transition matches 0 rows instead of forcing the state.
   *
   * `reason` is validated and carried into the refusal diagnostics; P0 stores no transition history
   * (`platform_durable_tasks` has no such column) — the transition record belongs to the append-only
   * `audit_records` chain the caller writes (implement/04 §4.1).
   *
   * @param tenant_id Tenant that owns the run.
   * @param run_id Durable run identifier.
   * @param state Target lifecycle state.
   * @param reason Why the task moves; required, and echoed in every refusal.
   * @param checkpointPayload Complete checkpoint for a park state, progress blob otherwise.
   * @param guard Optional optimistic guard; without it the locked version is the CAS base.
   * @returns The row after the write.
   * @throws Error `CHECKPOINT_INCOMPLETE` for a park transition without a complete checkpoint.
   * @throws Error `TASK_TRANSITION_REASON_REQUIRED` when the transition names no reason.
   * @throws Error `TASK_PROGRESS_PAYLOAD_INVALID` for a non-object progress payload.
   * @throws Error `DURABLE_TASK_NOT_FOUND` when the tenant holds no task for the run.
   * @throws Error `TASK_ALREADY_TERMINAL` / `TASK_PAUSE_RESUME_REQUIRES_DECISION`.
   * @throws Error `TASK_PAUSE_REQUIRES_APPROVAL` when `awaiting_human` is requested directly.
   * @throws Error `TASK_VERSION_CONFLICT` when the guard's version is not the stored one.
   */
  async transitionTask(
    tenant_id: string,
    run_id: string,
    state: DurableTaskState,
    reason: string,
    checkpointPayload?: unknown,
    guard?: DurableTaskGuard,
  ): Promise<DurableTaskRecord> {
    assertIdentifier(run_id, 'run_id', 64, 'TASK_RUN_ID_REQUIRED');
    assertTaskState(state);

    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new Error(
        'TASK_TRANSITION_REASON_REQUIRED: every lifecycle transition names why the task moves; ' +
          'refusing a transition whose reason would leave the audit trail unable to explain it ' +
          '(implement/04 §4.1).',
      );
    }

    if (state === 'awaiting_human') {
      throw new Error(
        'TASK_PAUSE_REQUIRES_APPROVAL: awaiting_human is reachable only through ' +
          'ApprovalRepository.pauseForApproval, which inserts the PENDING AUTH-4 approval row, the ' +
          `actions row it binds and the task pause in ONE transaction; a bare transition ('${reason}') ` +
          'would park the run with no row that can resume it (implement/04 §4.2 statement 3).',
      );
    }

    // `waiting` parks on a COMPLETE checkpoint, so the blob is validated (and serialized) before the
    // transaction opens and REPLACES state_payload; every other transition merges a progress blob.
    const parked = PARKED_STATES.includes(state);

    if (parked) {
      assertCompleteCheckpoint(checkpointPayload);
    } else if (checkpointPayload !== undefined && !isPlainObject(checkpointPayload)) {
      throw new Error(
        'TASK_PROGRESS_PAYLOAD_INVALID: a transition payload is a JSON object merged into ' +
          'state_payload; a non-object would replace the blob instead of extending it ' +
          '(implement/04 §4.2 statement 2).',
      );
    }

    const payload =
      checkpointPayload === undefined
        ? undefined
        : serializeJsonb(checkpointPayload, 'TASK_PAYLOAD_UNSERIALIZABLE');

    return this.runInTenantTransaction(tenant_id, async (client) => {
      const open = this.assertOpen(
        await this.lockWithin(client, tenant_id, run_id),
        'TASK_PAUSE_RESUME_REQUIRES_DECISION',
      );
      const base = assertGuard(open, guard);
      assertLeaseHeld(open.state, guard?.lease_owner);

      const statement = parked
        ? UPDATE_TASK_STATE_REPLACE_PAYLOAD
        : payload === undefined
          ? UPDATE_TASK_STATE
          : UPDATE_TASK_STATE_MERGE_PAYLOAD;
      const params =
        payload === undefined
          ? [tenant_id, run_id, state, base]
          : [tenant_id, run_id, state, payload, base];

      return assertSingleRow(await client.query<DurableTaskRow>(statement, params), run_id);
    });
  }

  /**
   * Records one classified failure of an open task and applies the §4.4 recovery decision.
   *
   * The class is persisted, never inferred: `UNKNOWN` is refused outright because an indeterminate
   * external outcome is not a verdict about the task — it leaves the `effect_reservations` row
   * `RESERVED` and parks the run for reconciliation, and `last_error_class` has no member for it
   * (implement/04 §3.2.4, §4.4). The outcome then follows the retry budget:
   *
   *  * `RETRYABLE` with `retry_count < max_retries` → back to `queued` with `retry_count + 1`, a
   *    backoff timer for the caller, and the lease released (the failed worker is done with the run);
   *  * `FATAL`, or `RETRYABLE` with the budget spent → `failed`, carrying the class and diagnostics.
   *
   * No evidence or progress is rolled back: the checkpoint stays as the failed attempt left it, so a
   * requeued run resumes from the last verified cursor (§4.4).
   *
   * @param input Tenant, run, classified failure and its diagnostics.
   * @returns Whether the task was re-queued, and the row it left behind.
   * @throws Error `TASK_ERROR_CLASS_INVALID` for `UNKNOWN` or any class outside the column's CHECK.
   * @throws Error `TASK_ERROR_DETAILS_INVALID` when the diagnostics are not a JSON object.
   * @throws Error `DURABLE_TASK_NOT_FOUND` when the tenant holds no task for the run.
   * @throws Error `TASK_ALREADY_TERMINAL` / `TASK_NOT_PROGRESSABLE` for a closed or parked task.
   * @throws Error `TASK_VERSION_CONFLICT` when the guard's version is not the stored one.
   */
  async recordFailure(input: RecordTaskFailureInput): Promise<TaskFailureOutcome> {
    assertIdentifier(input.tenant_id, 'tenant_id', 36, 'TASK_TENANT_ID_REQUIRED');
    assertIdentifier(input.run_id, 'run_id', 64, 'TASK_RUN_ID_REQUIRED');

    if (input.error_class !== 'RETRYABLE' && input.error_class !== 'FATAL') {
      throw new Error(
        `TASK_ERROR_CLASS_INVALID: ${String(input.error_class)} is not a persisted error class; ` +
          'last_error_class accepts RETRYABLE | FATAL only, because an indeterminate external ' +
          'outcome (UNKNOWN) is reconciled by effect_key and never stored as a task error ' +
          '(implement/04 §3.2.4).',
      );
    }

    if (!isPlainObject(input.error_details)) {
      throw new Error(
        'TASK_ERROR_DETAILS_INVALID: error_details must be a JSON object so a failed attempt ' +
          'records what it observed instead of a value JSON would drop (implement/04 §4.4).',
      );
    }

    const error_details = serializeJsonb(input.error_details, 'TASK_ERROR_DETAILS_INVALID');
    const guard =
      input.expected_task_version === undefined
        ? undefined
        : { expected_task_version: input.expected_task_version };

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const open = this.assertOpen(await this.lockWithin(client, input.tenant_id, input.run_id));
      const base = assertGuard(open, guard);
      const requeued = input.error_class === 'RETRYABLE' && open.retry_count < open.max_retries;

      const statement = requeued ? UPDATE_TASK_FAILURE_REQUEUE : UPDATE_TASK_FAILURE_TERMINAL;
      const row = assertSingleRow(
        await client.query<DurableTaskRow>(statement, [
          input.tenant_id,
          input.run_id,
          input.error_class,
          error_details,
          base,
        ]),
        input.run_id,
      );

      return {
        requeued,
        state: row.state,
        retry_count: row.retry_count,
        task_version: row.task_version,
      };
    });
  }

  /**
   * Re-enters a FAILED run at the operator's explicit request (implement/04 §4.4 recovery, R13).
   *
   * This is the one transition that leaves a terminal state, and it is deliberately narrow: only
   * `failed` may be re-entered, because it is the one terminal state that records an attempt which
   * ended rather than a run that finished or was called off (`completed` / `stopped` are never
   * revived). A queued, running or waiting run needs no requeue — it is already scheduled — and a
   * parked one belongs to the approval bound to it.
   *
   * It is NOT the automatic retry of `recordFailure()`: no failure is classified, `retry_count` is
   * left exactly as the failed attempt left it (an operator decision neither earns nor spends the
   * automatic budget), and the checkpoint is untouched — the plan, the cursor, the drafted action and
   * the immutable `request_id` stay stored, so the re-entered step derives the SAME `effect_key` and
   * the effect reservation keeps the re-entry at-most-once. Only the failure classification and the
   * lease are cleared, and the state moves to `queued` at `task_version + 1`.
   *
   * The row is locked and its state and version are verified before the single `UPDATE`, so two
   * operators cannot both re-enter the same attempt: the loser matches 0 rows instead of reviving a
   * run that is already scheduled again (INT-FR-ORC-OPTIMISTIC-CAS).
   *
   * @param input Tenant, run, why the operator re-enters the run, and the optional guard.
   * @returns The row after the write: `queued`, at `task_version + 1`, on the same checkpoint.
   * @throws Error `TASK_REQUEUE_REASON_REQUIRED` when the requeue names no reason.
   * @throws Error `DURABLE_TASK_NOT_FOUND` when the tenant holds no task for the run.
   * @throws Error `TASK_REQUEUE_NOT_FAILED` for a task in any state but `failed`.
   * @throws Error `TASK_VERSION_INVALID` / `TASK_VERSION_CONFLICT` for a bad or stale guard.
   */
  async requeueFailed(input: RequeueFailedTaskInput): Promise<DurableTaskRecord> {
    assertIdentifier(input.tenant_id, 'tenant_id', 36, 'TASK_TENANT_ID_REQUIRED');
    assertIdentifier(input.run_id, 'run_id', 64, 'TASK_RUN_ID_REQUIRED');

    if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
      throw new Error(
        'TASK_REQUEUE_REASON_REQUIRED: an operator requeue names why the failed run is re-entered; ' +
          'without it neither the refusal diagnostic nor the audit record the caller appends could ' +
          'explain the re-entry (implement/04 §4.1, §4.4).',
      );
    }

    const guard =
      input.expected_task_version === undefined
        ? undefined
        : { expected_task_version: input.expected_task_version };

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const failed = this.assertRequeueable(
        await this.lockWithin(client, input.tenant_id, input.run_id),
        input.reason,
      );
      const base = assertGuard(failed, guard);

      return assertSingleRow(
        await client.query<DurableTaskRow>(UPDATE_TASK_OPERATOR_REQUEUE, [
          input.tenant_id,
          input.run_id,
          base,
        ]),
        input.run_id,
      );
    });
  }

  /**
   * Locks the run's task inside the caller's transaction — the locking read of `lockDurableTask`.
   *
   * Every write path in this class and in `ApprovalRepository` starts with this lock and only then
   * touches `actions` / `approvals`, so the lock order is uniform and two writers of the same run
   * serialize instead of deadlocking (implement/04 §4.2 statements 2-4).
   */
  private lockWithin(
    client: PoolClient,
    tenant_id: string,
    run_id: string,
  ): Promise<DurableTaskRecord | null> {
    return lockDurableTask(client, tenant_id, run_id);
  }

  /**
   * Refuses a write against a missing, closed or parked task, and returns the row it may write.
   *
   * The three refusals share one order because they answer one question — may this caller write the
   * run's progress? — and a caller told `DURABLE_TASK_NOT_FOUND` when the real reason is a closed
   * task would retry forever. A parked task (`awaiting_human`, the only non-terminal state outside
   * `OPEN_STATES`) is refused for every caller, because its only writer is the bound human decision;
   * `parked_code` lets the caller name its own intent, so a progress write reports
   * `TASK_NOT_PROGRESSABLE` while a lifecycle transition reports
   * `TASK_PAUSE_RESUME_REQUIRES_DECISION`.
   *
   * @param locked Row read under `SELECT ... FOR UPDATE`, or `null` when the run has no task.
   * @param parked_code Error code for a task parked on an approval.
   * @returns The same row, narrowed to a row that may be written.
   * @throws Error `DURABLE_TASK_NOT_FOUND` / `TASK_ALREADY_TERMINAL` / `parked_code`.
   */
  private assertOpen(
    locked: DurableTaskRecord | null,
    parked_code = 'TASK_NOT_PROGRESSABLE',
  ): DurableTaskRecord {
    if (locked === null) {
      throw new Error(
        'DURABLE_TASK_NOT_FOUND: this tenant holds no durable task for the run, so there is no ' +
          'schedule of record to write; the run must create its task first (implement/04 §4.2).',
      );
    }

    if (TERMINAL_STATES.includes(locked.state)) {
      throw new Error(
        `TASK_ALREADY_TERMINAL: run ${locked.run_id} is ${locked.state}, and a closed task is never ` +
          'revived — a new attempt is a new run with its own durable task (implement/04 §4.1).',
      );
    }

    if (!OPEN_STATES.includes(locked.state)) {
      throw new Error(
        `${parked_code}: run ${locked.run_id} is parked in ${locked.state} on approval ` +
          `${String(locked.paused_for_approval_id)} and only that bound human decision may move it; ` +
          'any other write would resume past the AUTH-4 gate (implement/04 §4.2 statement 4).',
      );
    }

    return locked;
  }

  /**
   * Refuses an operator requeue of anything but a failed task, and returns the row that may be
   * re-entered.
   *
   * The refusal names the state the run is actually in, because the operator's next move differs by
   * state: an open run is already scheduled and needs no requeue, a parked one is owned by the
   * approval bound to it, and a closed run (`completed` / `stopped`) is never revived. Only `failed`
   * is re-enterable, and it is re-entered on the checkpoint it failed with — under the same
   * `effect_key`, so the reservation still keeps the attempt at-most-once.
   *
   * @param locked Row read under `SELECT ... FOR UPDATE`, or `null` when the run has no task.
   * @param reason Why the operator asked for the requeue; echoed when it is refused.
   * @returns The same row, narrowed to a failed task.
   * @throws Error `DURABLE_TASK_NOT_FOUND` / `TASK_REQUEUE_NOT_FAILED`.
   */
  private assertRequeueable(locked: DurableTaskRecord | null, reason: string): DurableTaskRecord {
    if (locked === null) {
      throw new Error(
        'DURABLE_TASK_NOT_FOUND: this tenant holds no durable task for the run, so there is no ' +
          'schedule of record to re-enter (implement/04 §4.2).',
      );
    }

    if (locked.state === 'failed') {
      return locked;
    }

    if (locked.state === 'awaiting_human') {
      throw new Error(
        `TASK_REQUEUE_NOT_FAILED: run ${locked.run_id} is parked in awaiting_human on approval ` +
          `${String(locked.paused_for_approval_id)}, and only that bound human decision may move it; ` +
          `refusing to re-enter it ('${reason}') (implement/04 §4.2 statement 4).`,
      );
    }

    throw new Error(
      `TASK_REQUEUE_NOT_FAILED: run ${locked.run_id} is ${locked.state}, and an operator requeue ` +
        'only re-enters a FAILED run — an open run is already scheduled, and a closed one ' +
        `(completed, stopped) is never revived ('${reason}') (implement/04 §4.1).`,
    );
  }
}
