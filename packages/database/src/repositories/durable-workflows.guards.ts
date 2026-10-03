import type { QueryResult, QueryResultRow } from 'pg';

import type {
  DurableTaskGuard,
  DurableTaskRecord,
  DurableTaskState,
  PersistedErrorClass,
} from './durable-workflows.js';

import { canonicalizeJson } from './canonical-json.js';
/** Every state the enum accepts, in declaration order. */
export const DURABLE_TASK_STATES: readonly DurableTaskState[] = [
  'queued',
  'running',
  'waiting',
  'awaiting_human',
  'completed',
  'stopped',
  'failed',
];

/** States a task never leaves: a terminal row is closed, and a new attempt needs a new run. */
export const TERMINAL_STATES: readonly DurableTaskState[] = ['completed', 'stopped', 'failed'];

/**
 * States whose `state_payload` must be a COMPLETE `DurableTaskCheckpoint` (implement/04 §4.2). The
 * resume path re-enters the plan from this blob and fails closed with `CHECKPOINT_INCOMPLETE`
 * rather than re-deciding anything, so an incomplete checkpoint must never reach the column.
 */
export const PARKED_STATES: readonly DurableTaskState[] = ['waiting', 'awaiting_human'];

/**
 * States that own their progress: a queued, running or waiting task may checkpoint and may record a
 * classified failure. `awaiting_human` is excluded on purpose — a parked task is moved only by the
 * human decision (`claimApprovalAndResume`), so a progress write there would bypass the gate.
 */
export const OPEN_STATES: readonly DurableTaskState[] = ['queued', 'running', 'waiting'];

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
export const CURSOR_SEPARATOR = '|';

/** Default page size of `listTasks()`, and the largest page it accepts. */
export const DEFAULT_TASK_LIST_LIMIT = 50;
export const MAX_TASK_LIST_LIMIT = 200;
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
/**
 * Canonical comparison for JSONB event replays; object key order is not event identity.
 *
 * The bytes are the shared canonical serializer (`./canonical-json.js`), so the same event written
 * by one process and read back by another compares equal; only the refusal vocabulary is local to
 * this repository (`TASK_PAYLOAD_UNSERIALIZABLE` rather than `CANONICAL_JSON_INVALID`).
 */
export function canonicalizeEvent(value: unknown): string {
  try {
    return canonicalizeJson(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`TASK_PAYLOAD_UNSERIALIZABLE: resume event is not JSON-serializable: ${detail}`);
  }
}

/** Validates a lifecycle state against the closed enum (`UNKNOWN` is not a member). */
export function assertTaskState(state: unknown): asserts state is DurableTaskState {
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
export const CODE_OWNER = 'implement/03 §1 DOMAIN 5, implement/04 §4.2';

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
export function assertLeaseHeld(
  row: Pick<DurableTaskRecord, 'state' | 'lease_owner' | 'lease_expires_at' | 'state_payload'>,
  lease_owner: string | undefined,
  now: Date = new Date(),
): void {
  if (lease_owner === undefined) return;
  if (lease_owner.trim().length === 0) throw new Error('TASK_LEASE_OWNER_REQUIRED: lease_owner must be a non-empty worker identity.');
  // A claimed waiting/awaiting_human row may already have consumed `resume_event`. Claim
  // selection still requires the event; release and fenced transition do not, or the worker that
  // just consumed it cannot drop the lease it still holds.
  const claimedPark = row.state === 'waiting' || row.state === 'awaiting_human';
  const leaseState = row.state === 'running' || claimedPark;
  if (!leaseState || row.lease_owner !== lease_owner || row.lease_expires_at === null || Date.parse(row.lease_expires_at) <= now.getTime()) {
    throw new Error('TASK_LEASE_NOT_HELD: the worker does not hold a live lease for this run.');
  }
}

/**
 * Validates an ISO-8601 instant bound into a `TIMESTAMPTZ` parameter.
 *
 * An unparseable instant would be rejected by the planner with a bare driver error, and `created_at`
 * is the ordering key the page is read by, so it is refused here with the field that is wrong.
 */
export function assertInstant(value: unknown, column: string, code: string): string {
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
export function assertAgentId(value: unknown): string {
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
export function parseTaskListCursor(
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
export function errorCode(error: unknown): string | undefined {
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
