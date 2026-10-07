import type { PoolClient } from 'pg';

import { withTenantContext } from '../rls.js';
import type { TenantTransactionRunner } from './effect-reservations.js';
import {
  INSERT_TASK,
  PLATFORM_DURABLE_TASKS,
  SELECT_CLAIMABLE_TASK,
  SELECT_TASK,
  SELECT_TASK_FOR_UPDATE,
  SELECT_TASK_PAGE,
  TASK_PROJECTION,
  UPDATE_CLAIM_TASK,
  UPDATE_CLEAR_HANDOFF_EVIDENCE_TASK,
  UPDATE_HANDOFF_EVIDENCE_TASK,
  UPDATE_RECONCILE_TASK,
  UPDATE_RENEW_LEASE,
  UPDATE_RELEASE_LEASE,
  UPDATE_TASK_FAILURE_REQUEUE,
  UPDATE_TASK_FAILURE_TERMINAL,
  UPDATE_TASK_OPERATOR_REQUEUE,
  UPDATE_TASK_PROGRESS,
  UPDATE_TASK_STATE,
  UPDATE_TASK_STATE_MERGE_PAYLOAD,
  UPDATE_TASK_STATE_REPLACE_PAYLOAD,
} from './durable-workflows.sql.js';
import type { DurableTaskRow } from './durable-workflows.guards.js';
import {
  DEFAULT_TASK_LIST_LIMIT,
  MAX_TASK_LIST_LIMIT,
  OPEN_STATES,
  PARKED_STATES,
  TERMINAL_STATES,
  CURSOR_SEPARATOR,
  assertAgentId,
  assertCompleteCheckpoint,
  assertGuard,
  assertIdentifier,
  assertInstant,
  assertLeaseHeld,
  assertPositiveInteger,
  assertSingleRow,
  assertTaskState,
  errorCode,
  isPlainObject,
  parseTaskListCursor,
  serializeJsonb,
  toDurableTaskRecord,
  CODE_OWNER,
  canonicalizeEvent,
} from './durable-workflows.guards.js';

export {
  PLATFORM_DURABLE_TASKS,
  TASK_PROJECTION,
  assertCompleteCheckpoint,
  assertGuard,
  assertIdentifier,
  assertLeaseHeld,
  assertPositiveInteger,
  assertSingleRow,
  isPlainObject,
  serializeJsonb,
  toDurableTaskRecord,
};
export type { DurableTaskRow } from './durable-workflows.guards.js';

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

/** Input for the preclaimed conversation admission writer; queued turns begin at step zero. */
export type CreateQueuedAdmissionTaskInput = Omit<CreateDurableTaskInput, 'current_step' | 'state'>;

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
  readonly now?: Date | string | number;
}

/** Input of `claimNextQueuedTask()`: tenant, lease owner, and optional lease TTL. */
export interface ClaimNextQueuedTaskInput {
  readonly tenant_id: string;
  readonly lease_owner: string;
  readonly lease_duration_ms?: number;
}

/** Result of `claimNextQueuedTask()`: claimed task, lease owner, expiry, and version. */
export interface ClaimTaskResult {
  readonly task: DurableTaskRecord;
  readonly lease_owner: string;
  readonly lease_expires_at: string;
  readonly task_version: number;
}

/** Input of `renewTaskLease()`: tenant, run, lease owner, version, and optional duration. */
export interface RenewTaskLeaseInput {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly lease_owner: string;
  readonly task_version: number;
  readonly lease_duration_ms?: number;
  readonly now?: Date | string | number;
}

/** Input of `releaseTaskLease()`: tenant, run, lease owner, version, and optional target state. */
export interface ReleaseTaskLeaseInput {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly lease_owner: string;
  readonly task_version: number;
  readonly target_state?: DurableTaskState;
  readonly now?: Date | string | number;
}

/** Input of `recordFailure()` (§4.4 durable recovery). */
export interface RecordTaskFailureInput {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly error_class: FailureClass;
  readonly error_details: Record<string, unknown>;
  /** Optional optimistic guard; see `DurableTaskGuard`. */
  readonly expected_task_version?: number;
  readonly lease_owner?: string;
  readonly now?: Date | string | number;
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

/** Input of `queueReconciliation()`: tenant, run, operator resolution and proof. */
export interface QueueReconciliationInput {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly resolution: 'PROVIDER_CONFIRMED_SUCCEEDED' | 'PROVIDER_CONFIRMED_ABSENT' | 'ESCALATE_MANUALLY';
  readonly reason: string;
  readonly operator_id: string;
  readonly receipt?: Record<string, unknown>;
}

/** Input of `queueHandoffEvidence()`: tenant, run, evidence payload and optional fences. */
export interface QueueHandoffEvidenceInput {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly evidence_payload: Record<string, unknown>;
  readonly step_index?: number;
  readonly effect_key?: string;
  readonly reason?: string;
  readonly expected_task_version?: number;
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
 * Inserts one durable task row within an existing client transaction.
 *
 * @param client PostgreSQL client in an active transaction.
 * @param input Task properties.
 * @returns The inserted row at task_version 1.
 */
export async function insertDurableTask(
  client: PoolClient,
  input: CreateDurableTaskInput,
): Promise<DurableTaskRecord> {
  assertIdentifier(input.tenant_id, 'tenant_id', 36, 'TASK_TENANT_ID_REQUIRED');
  assertIdentifier(input.run_id, 'run_id', 64, 'TASK_RUN_ID_REQUIRED');
  assertIdentifier(input.correlation_id, 'correlation_id', 64, 'TASK_CORRELATION_ID_REQUIRED');

  const state = input.state ?? 'queued';
  assertTaskState(state);

  const current_step = input.current_step ?? 1;
  if (typeof current_step !== 'number' || !Number.isInteger(current_step) || current_step < 0) {
    throw new Error(
      `TASK_CURRENT_STEP_INVALID: current_step must be an integer >= 0 (${CODE_OWNER}).`,
    );
  }

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

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      return insertDurableTask(client, input);
    });
  }

  /**
   * Writes the opening queued task for a reservation claimed by the API admission path.
   *
   * This is intentionally separate from `createTask`: ordinary task creation keeps its historical
   * positive-step contract, while conversation admission's opening step is the durable zero.
   */
  async createQueuedAdmissionTask(input: CreateQueuedAdmissionTaskInput): Promise<DurableTaskRecord> {
    assertIdentifier(input.tenant_id, 'tenant_id', 36, 'TASK_TENANT_ID_REQUIRED');
    assertIdentifier(input.run_id, 'run_id', 64, 'TASK_RUN_ID_REQUIRED');
    assertIdentifier(input.correlation_id, 'correlation_id', 64, 'TASK_CORRELATION_ID_REQUIRED');
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      return insertDurableTask(client, {
        ...input,
        state: 'queued',
        current_step: 0,
      });
    });
  }


  async claimNextQueuedTask(input: ClaimNextQueuedTaskInput): Promise<ClaimTaskResult | null> {
    assertIdentifier(input.tenant_id, 'tenant_id', 36, 'TASK_TENANT_ID_REQUIRED');
    assertIdentifier(input.lease_owner, 'lease_owner', 128, 'TASK_LEASE_OWNER_REQUIRED');
    const ttl = input.lease_duration_ms ?? 30_000;
    if (!Number.isInteger(ttl) || ttl < 1) throw new Error('TASK_LEASE_DURATION_INVALID');
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const selected = await client.query<DurableTaskRow>(SELECT_CLAIMABLE_TASK, [input.tenant_id]);
      const row = selected.rows[0];
      if (!row) return null;
      const claimed = assertSingleRow(await client.query<DurableTaskRow>(UPDATE_CLAIM_TASK, [input.tenant_id, input.lease_owner, ttl, row.run_id, row.task_version]), row.run_id);
      if (!claimed.lease_expires_at) throw new Error('TASK_LEASE_NOT_HELD');
      return { task: claimed, lease_owner: input.lease_owner, lease_expires_at: claimed.lease_expires_at, task_version: claimed.task_version };
    });
  }

  async renewTaskLease(input: RenewTaskLeaseInput): Promise<DurableTaskRecord> {
    assertIdentifier(input.tenant_id, 'tenant_id', 36, 'TASK_TENANT_ID_REQUIRED');
    assertIdentifier(input.run_id, 'run_id', 64, 'TASK_RUN_ID_REQUIRED');
    const ttl = input.lease_duration_ms ?? 30_000;
    if (!Number.isInteger(ttl) || ttl < 1) throw new Error('TASK_LEASE_DURATION_INVALID');
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const row = await this.lockWithin(client, input.tenant_id, input.run_id);
      if (!row) throw new Error('DURABLE_TASK_NOT_FOUND');
      assertLeaseHeld(row, input.lease_owner);
      if (row.task_version !== input.task_version) throw new Error('TASK_VERSION_CONFLICT');
      return assertSingleRow(await client.query<DurableTaskRow>(UPDATE_RENEW_LEASE, [input.tenant_id, input.run_id, ttl, input.task_version, input.lease_owner]), input.run_id);
    });
  }

  async releaseTaskLease(input: ReleaseTaskLeaseInput): Promise<DurableTaskRecord> {
    assertIdentifier(input.tenant_id, 'tenant_id', 36, 'TASK_TENANT_ID_REQUIRED');
    assertIdentifier(input.run_id, 'run_id', 64, 'TASK_RUN_ID_REQUIRED');
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const row = await this.lockWithin(client, input.tenant_id, input.run_id);
      if (!row) throw new Error('DURABLE_TASK_NOT_FOUND');
      assertLeaseHeld(row, input.lease_owner);
      if (row.task_version !== input.task_version) throw new Error('TASK_VERSION_CONFLICT');
      const target = input.target_state ?? 'queued';
      assertTaskState(target);
      if (target !== 'queued' && target !== 'waiting' && target !== 'awaiting_human') {
        throw new Error('TASK_LEASE_RELEASE_STATE_INVALID');
      }
      if (
        target === 'awaiting_human'
        && !(isPlainObject(row.state_payload) && Object.prototype.hasOwnProperty.call(row.state_payload, 'resume_event'))
      ) {
        throw new Error('TASK_LEASE_RELEASE_STATE_INVALID');
      }
      return assertSingleRow(await client.query<DurableTaskRow>(UPDATE_RELEASE_LEASE, [input.tenant_id, input.run_id, target, input.task_version, input.lease_owner]), input.run_id);
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
      assertLeaseHeld(open, guard?.lease_owner);

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

    if (state === 'awaiting_human') {
      throw new Error(
        'TASK_PAUSE_REQUIRES_APPROVAL: awaiting_human is reachable only through ApprovalRepository.pauseForApproval.',
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
      assertLeaseHeld(open, guard?.lease_owner);

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
    const guard = input.expected_task_version === undefined ? undefined : { expected_task_version: input.expected_task_version };

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const open = this.assertOpen(await this.lockWithin(client, input.tenant_id, input.run_id));
      const base = assertGuard(open, guard);
      assertLeaseHeld(open, input.lease_owner);
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
   * Reconciles a waiting task: atomically clears any prior lease, records one resume_event and
   * leaves the task parked until the worker performs the guarded provider check (R18).
   */
  async queueReconciliation(input: QueueReconciliationInput): Promise<DurableTaskRecord> {
    assertIdentifier(input.tenant_id, 'tenant_id', 36, 'TASK_TENANT_ID_REQUIRED');
    assertIdentifier(input.run_id, 'run_id', 64, 'TASK_RUN_ID_REQUIRED');
    assertIdentifier(input.operator_id, 'operator_id', 128, 'OPERATOR_ID_REQUIRED');

    if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
      throw new Error(
        'TASK_TRANSITION_REASON_REQUIRED: reason is mandatory for reconciliation (implement/06 §8.1.2 R18).',
      );
    }

    const resolution = input.resolution;
    if (
      resolution !== 'PROVIDER_CONFIRMED_SUCCEEDED' &&
      resolution !== 'PROVIDER_CONFIRMED_ABSENT' &&
      resolution !== 'ESCALATE_MANUALLY'
    ) {
      throw new Error('RECONCILIATION_RESOLUTION_INVALID: invalid reconciliation resolution');
    }

    const resume_event = {
      tenant_id: input.tenant_id,
      event_type: 'human.reconcile',
      operator_id: input.operator_id,
      reconciliation_resolution: resolution,
      ...(input.receipt !== undefined ? { reconciliation_receipt: input.receipt } : {}),
      reason: input.reason,
    };
    const resumeEventCanonical = canonicalizeEvent(resume_event);

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const locked = await this.lockWithin(client, input.tenant_id, input.run_id);
      if (locked === null) {
        throw new Error(
          'DURABLE_TASK_NOT_FOUND: this tenant holds no durable task for the run (implement/04 §4.2).',
        );
      }

      if (TERMINAL_STATES.includes(locked.state)) {
        throw new Error(
          `TASK_ALREADY_TERMINAL: run ${locked.run_id} is ${locked.state}, and a closed task is never revived.`,
        );
      }

      if (locked.state !== 'waiting') {
        throw new Error(
          `RUN_NOT_RECONCILABLE: run ${locked.run_id} is in state '${locked.state}', not 'waiting'; only a parked task awaiting reconciliation can be reconciled.`,
        );
      }

      assertCompleteCheckpoint(locked.state_payload);
      const existingPayload = isPlainObject(locked.state_payload) ? locked.state_payload : {};
      const existingEvent = existingPayload['resume_event'];
      if (existingEvent !== undefined) {
        if (canonicalizeEvent(existingEvent) !== resumeEventCanonical) {
          throw new Error(
            'RECONCILIATION_EVENT_CONFLICT: a different reconciliation event is already queued for this run.',
          );
        }
        return locked;
      }

      const newPayload = serializeJsonb(
        { ...existingPayload, resume_event },
        'TASK_PAYLOAD_UNSERIALIZABLE',
      );

      return assertSingleRow(
        await client.query<DurableTaskRow>(UPDATE_RECONCILE_TASK, [
          input.tenant_id,
          input.run_id,
          newPayload,
          locked.task_version,
        ]),
        input.run_id,
      );
    });
  }

  /**
   * Attaches a durable handoff evidence repair event ('human.handoff.evidence') to an awaiting_human task
   * while retaining its complete checkpoint.
   */
  async queueHandoffEvidence(input: QueueHandoffEvidenceInput): Promise<{ queued: boolean; task_version?: number }> {
    assertIdentifier(input.tenant_id, 'tenant_id', 36, 'TASK_TENANT_ID_REQUIRED');
    assertIdentifier(input.run_id, 'run_id', 64, 'TASK_RUN_ID_REQUIRED');
    if (!isPlainObject(input.evidence_payload)) {
      throw new Error('HANDOFF_EVIDENCE_PAYLOAD_INVALID: evidence_payload must be a valid JSON object');
    }

    const resume_event = {
      tenant_id: input.tenant_id,
      run_id: input.run_id,
      event_type: 'human.handoff.evidence' as const,
      evidence_payload: input.evidence_payload,
      ...(input.step_index !== undefined ? { step_index: input.step_index } : {}),
      ...(input.effect_key !== undefined ? { effect_key: input.effect_key } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    };
    const resumeEventCanonical = canonicalizeEvent(resume_event);

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const locked = await this.lockWithin(client, input.tenant_id, input.run_id);
      if (locked === null) {
        throw new Error(
          'DURABLE_TASK_NOT_FOUND: this tenant holds no durable task for the run (implement/04 §4.2).',
        );
      }

      if (TERMINAL_STATES.includes(locked.state)) {
        throw new Error(
          `TASK_ALREADY_TERMINAL: run ${locked.run_id} is ${locked.state}, and a closed task is never revived.`,
        );
      }

      if (locked.state !== 'awaiting_human') {
        throw new Error(
          `TASK_NOT_AWAITING_HUMAN: run ${locked.run_id} is in state '${locked.state}', not 'awaiting_human'.`,
        );
      }

      if (input.expected_task_version !== undefined && locked.task_version !== input.expected_task_version) {
        throw new Error(
          `TASK_VERSION_CONFLICT: task ${locked.run_id} version ${locked.task_version} does not match expected ${input.expected_task_version}.`,
        );
      }

      assertCompleteCheckpoint(locked.state_payload);
      const existingPayload = isPlainObject(locked.state_payload) ? locked.state_payload : {};
      const existingEvent = existingPayload['resume_event'];
      if (existingEvent !== undefined) {
        if (canonicalizeEvent(existingEvent) !== resumeEventCanonical) {
          throw new Error(
            'HANDOFF_EVIDENCE_EVENT_CONFLICT: a different resume event is already queued for this run.',
          );
        }
        return { queued: true, task_version: locked.task_version };
      }

      const newPayload = serializeJsonb(
        { ...existingPayload, resume_event },
        'TASK_PAYLOAD_UNSERIALIZABLE',
      );

      const repaired = assertSingleRow(
        await client.query<DurableTaskRow>(UPDATE_HANDOFF_EVIDENCE_TASK, [
          input.tenant_id,
          input.run_id,
          newPayload,
          locked.task_version,
        ]),
        input.run_id,
      );
      return { queued: true, task_version: repaired.task_version };
    });
  }
  /** Clears only a consumed handoff evidence repair event while retaining awaiting_human and the worker lease. */
  async clearHandoffEvidence(input: {
    tenant_id: string;
    run_id: string;
    expected_task_version: number;
    lease_owner: string;
    expected_resume_event: Record<string, unknown>;
  }): Promise<{ cleared: boolean; task_version?: number }> {
    assertIdentifier(input.tenant_id, 'tenant_id', 36, 'TASK_TENANT_ID_REQUIRED');
    assertIdentifier(input.run_id, 'run_id', 64, 'TASK_RUN_ID_REQUIRED');
    assertIdentifier(input.lease_owner, 'lease_owner', 128, 'TASK_LEASE_OWNER_REQUIRED');
    const expectedEventCanonical = canonicalizeEvent(input.expected_resume_event);

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const locked = await this.lockWithin(client, input.tenant_id, input.run_id);
      if (locked === null) throw new Error('DURABLE_TASK_NOT_FOUND');
      if (locked.state !== 'awaiting_human') {
        throw new Error(`TASK_NOT_AWAITING_HUMAN: run ${locked.run_id} is ${locked.state}.`);
      }
      assertLeaseHeld(locked, input.lease_owner);
      if (locked.task_version !== input.expected_task_version) {
        throw new Error('TASK_VERSION_CONFLICT');
      }
      const payload = isPlainObject(locked.state_payload) ? locked.state_payload : {};
      const existingEvent = payload['resume_event'];
      if (!isPlainObject(existingEvent) || canonicalizeEvent(existingEvent) !== expectedEventCanonical) {
        throw new Error('HANDOFF_EVIDENCE_EVENT_CONFLICT: the repair event changed before clear.');
      }
      const nextPayload = { ...payload };
      delete nextPayload['resume_event'];
      const serialized = serializeJsonb(nextPayload, 'TASK_PAYLOAD_UNSERIALIZABLE');
      const cleared = assertSingleRow(
        await client.query<DurableTaskRow>(UPDATE_CLEAR_HANDOFF_EVIDENCE_TASK, [
          input.tenant_id,
          input.run_id,
          serialized,
          input.expected_task_version,
          input.lease_owner,
        ]),
        input.run_id,
      );
      return { cleared: true, task_version: cleared.task_version };
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
