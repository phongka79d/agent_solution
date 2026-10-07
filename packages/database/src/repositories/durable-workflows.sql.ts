
/**
 * `agentos` is not on the connection `search_path`, so every statement is schema-qualified.
 *
 * Exported for `ApprovalRepository`, whose pause and human-decision transactions write the same
 * table and must not spell the name a second time.
 */
export const PLATFORM_DURABLE_TASKS = 'agentos.platform_durable_tasks';
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

/**
 * Claim the next queued task, expired-running task, or one event-bearing parked task using SELECT
 * FOR UPDATE SKIP LOCKED. A parked task keeps its lifecycle state while the worker owns the lease;
 * the resume event is the durable handoff, not a reason to rewrite the FSM state behind the core.
 */
const SELECT_CLAIMABLE_TASK = `SELECT${TASK_PROJECTION}
  FROM ${PLATFORM_DURABLE_TASKS}
  WHERE tenant_id = $1
    AND (
      state = 'queued'
      OR (state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < CURRENT_TIMESTAMP)
      OR (
        state IN ('waiting', 'awaiting_human')
        AND state_payload ? 'resume_event'
        AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < CURRENT_TIMESTAMP)
      )
    )
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED`;

/** Atomically acquire a lease without consuming a parked resume event. */
const UPDATE_CLAIM_TASK = `UPDATE ${PLATFORM_DURABLE_TASKS}
  SET state = CASE
        WHEN state IN ('waiting', 'awaiting_human') THEN state
        ELSE 'running'::agentos.task_lifecycle_state
      END,
      lease_owner = $2,
      lease_expires_at = CURRENT_TIMESTAMP + ($3 * INTERVAL '1 millisecond'),
      task_version = task_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND run_id = $4 AND task_version = $5
    AND (
      state = 'queued'
      OR (state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < CURRENT_TIMESTAMP)
      OR (
        state IN ('waiting', 'awaiting_human')
        AND state_payload ? 'resume_event'
        AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < CURRENT_TIMESTAMP)
      )
    )
  RETURNING${TASK_PROJECTION}`;

/** Renew an active unexpired lease for the owner. */
const UPDATE_RENEW_LEASE = `UPDATE ${PLATFORM_DURABLE_TASKS}
  SET lease_expires_at = CURRENT_TIMESTAMP + ($3 * INTERVAL '1 millisecond'),
      task_version = task_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND run_id = $2 AND task_version = $4 AND lease_owner = $5
  RETURNING${TASK_PROJECTION}`;

/** Release an active lease, clearing owner and expiry and setting target state. */
const UPDATE_RELEASE_LEASE = `UPDATE ${PLATFORM_DURABLE_TASKS}
  SET state = $3::agentos.task_lifecycle_state,
      lease_owner = NULL,
      lease_expires_at = NULL,
      task_version = task_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND run_id = $2 AND task_version = $4 AND lease_owner = $5
  RETURNING${TASK_PROJECTION}`;

/** Progress checkpoint (§4.2 statement 2): merge the blob, advance the cursor, bump the version. */
const UPDATE_TASK_PROGRESS = `UPDATE ${PLATFORM_DURABLE_TASKS}
  SET current_step = $3,
      state_payload = state_payload || $4::jsonb,
      task_version = task_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND run_id = $2 AND task_version = $5
  RETURNING${TASK_PROJECTION}`;

/** State transition (§4.1): terminal targets release any worker lease; parked/open targets retain it. */
const UPDATE_TASK_STATE = `UPDATE ${PLATFORM_DURABLE_TASKS}
  SET state = $3::agentos.task_lifecycle_state,
      lease_owner = CASE WHEN $3::agentos.task_lifecycle_state IN ('completed', 'stopped', 'failed') THEN NULL ELSE lease_owner END,
      lease_expires_at = CASE WHEN $3::agentos.task_lifecycle_state IN ('completed', 'stopped', 'failed') THEN NULL ELSE lease_expires_at END,
      task_version = task_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND run_id = $2 AND task_version = $4
  RETURNING${TASK_PROJECTION}`;

/** Park transition: `state_payload` is REPLACED by the complete checkpoint, never merged. */
const UPDATE_TASK_STATE_REPLACE_PAYLOAD = `UPDATE ${PLATFORM_DURABLE_TASKS}
  SET state = $3::agentos.task_lifecycle_state,
      state_payload = $4::jsonb,
      lease_owner = CASE WHEN $3::agentos.task_lifecycle_state IN ('completed', 'stopped', 'failed') THEN NULL ELSE lease_owner END,
      lease_expires_at = CASE WHEN $3::agentos.task_lifecycle_state IN ('completed', 'stopped', 'failed') THEN NULL ELSE lease_expires_at END,
      task_version = task_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND run_id = $2 AND task_version = $5
  RETURNING${TASK_PROJECTION}`;

/** Transition carrying a progress payload: terminal targets release any worker lease. */
const UPDATE_TASK_STATE_MERGE_PAYLOAD = `UPDATE ${PLATFORM_DURABLE_TASKS}
  SET state = $3::agentos.task_lifecycle_state,
      state_payload = state_payload || $4::jsonb,
      lease_owner = CASE WHEN $3::agentos.task_lifecycle_state IN ('completed', 'stopped', 'failed') THEN NULL ELSE lease_owner END,
      lease_expires_at = CASE WHEN $3::agentos.task_lifecycle_state IN ('completed', 'stopped', 'failed') THEN NULL ELSE lease_expires_at END,
      task_version = task_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND run_id = $2 AND task_version = $5
  RETURNING${TASK_PROJECTION}`;

/** `RETRYABLE` failure inside the retry budget (§4.4): re-queue with `retry_count + 1` and release
 * the lease, because the worker that failed is done with the task and a dead lease must not hold the
 * next attempt back for its full TTL. */
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

/** Reconcile transition: keeps a waiting task parked and records the worker handoff event. */
const UPDATE_RECONCILE_TASK = `UPDATE ${PLATFORM_DURABLE_TASKS}
  SET state = 'waiting',
      state_payload = state_payload || $3::jsonb,
      lease_owner = NULL,
      lease_expires_at = NULL,
      task_version = task_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND run_id = $2 AND task_version = $4
  RETURNING${TASK_PROJECTION}`;

/** Handoff evidence repair transition: attaches a resume_event to an awaiting_human task while retaining its complete checkpoint. */
const UPDATE_HANDOFF_EVIDENCE_TASK = `UPDATE ${PLATFORM_DURABLE_TASKS}
  SET state = 'awaiting_human',
      state_payload = state_payload || $3::jsonb,
      lease_owner = NULL,
      lease_expires_at = NULL,
      task_version = task_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND run_id = $2 AND task_version = $4
  RETURNING${TASK_PROJECTION}`;

const UPDATE_CLEAR_HANDOFF_EVIDENCE_TASK = `UPDATE ${PLATFORM_DURABLE_TASKS}
  SET state_payload = $3::jsonb,
      lease_owner = NULL,
      lease_expires_at = NULL,
      task_version = task_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND run_id = $2 AND state = 'awaiting_human'
    AND task_version = $4 AND lease_owner = $5
  RETURNING${TASK_PROJECTION}`;

/**
 * `FATAL` failure, or `RETRYABLE` with the budget spent (§4.4): terminate fail-closed.
 * `retry_count` records the attempts that were made and is left as it is.
 */
const UPDATE_TASK_FAILURE_TERMINAL = `UPDATE ${PLATFORM_DURABLE_TASKS}
  SET state = 'failed',
      last_error_class = $3,
      error_details = $4::jsonb,
      lease_owner = NULL,
      lease_expires_at = NULL,
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
export {
  INSERT_TASK,
  SELECT_TASK,
  SELECT_TASK_FOR_UPDATE,
  SELECT_TASK_PAGE,
  SELECT_CLAIMABLE_TASK,
  UPDATE_CLAIM_TASK,
  UPDATE_RENEW_LEASE,
  UPDATE_RELEASE_LEASE,
  UPDATE_TASK_PROGRESS,
  UPDATE_TASK_STATE,
  UPDATE_TASK_STATE_REPLACE_PAYLOAD,
  UPDATE_TASK_STATE_MERGE_PAYLOAD,
  UPDATE_TASK_FAILURE_REQUEUE,
  UPDATE_RECONCILE_TASK,
  UPDATE_HANDOFF_EVIDENCE_TASK,
  UPDATE_CLEAR_HANDOFF_EVIDENCE_TASK,
  UPDATE_TASK_FAILURE_TERMINAL,
  UPDATE_TASK_OPERATOR_REQUEUE,
};
