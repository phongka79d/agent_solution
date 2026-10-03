import {
  PLATFORM_DURABLE_TASKS,
  TASK_PROJECTION,
} from './durable-workflows.js';
/** `agentos` is not on the connection `search_path`, so every statement is schema-qualified. */
const APPROVALS = 'agentos.approvals';
const ACTIONS = 'agentos.actions';

/** A campaign attached to the same tenant/run gives approval reviewers a meaningful campaign name. */
const CAMPAIGN_NAME_PROJECTION = `,
    (
      SELECT c.name
      FROM agentos.campaigns AS c
      WHERE c.tenant_id = agentos.approvals.tenant_id
        AND c.run_id = agentos.approvals.run_id
      LIMIT 1
    ) AS campaign_name`;


/** The approval columns and run-linked campaign name every approval read publishes. */
const APPROVAL_PROJECTION = `
    id,
    tenant_id,
    run_id,
    action_id,
    campaign_id,
    effect_key,
    authority_required,
    payload,
    digest_version,
    original_payload,
    original_payload_sha256,
    original_digest_version,
    reason,
    operator_id,
    CASE
      WHEN decision = 'PENDING' AND expires_at <= CURRENT_TIMESTAMP THEN 'EXPIRED'
      ELSE decision
    END AS decision,
    is_paused,
    review_comment,
    decided_at,
    expires_at,
    created_at${CAMPAIGN_NAME_PROJECTION}`;

/** The columns every action read publishes, in the order `toActionRecord` expects them. */
const ACTION_PROJECTION = `
    id,
    tenant_id,
    decision_id,
    skill_name,
    effect_key,
    action_revision,
    target_channel,
    action_payload,
    status,
    created_at`;

/**
 * Read-time expiry is a durable transition, not an in-memory projection. The CTE first locks and
 * fails the prepared action, then marks the same pending approval EXPIRED in one statement. A later
 * SELECT in the transaction observes both writes. The main SELECT intentionally retains the
 * deadline CASE so its same-statement snapshot publishes EXPIRED even though PostgreSQL data
 * modifying CTEs use the statement snapshot.
 */
const SELECT_APPROVAL = `WITH expired AS (
  SELECT id, action_id
  FROM ${APPROVALS}
  WHERE tenant_id = $1 AND id = $2 AND decision = 'PENDING' AND expires_at <= CURRENT_TIMESTAMP
), expired_actions AS (
  UPDATE ${ACTIONS} AS a
  SET status = 'failed'
  FROM expired
  WHERE a.tenant_id = $1 AND a.id = expired.action_id AND a.status = 'pending'
), expired_approvals AS (
  UPDATE ${APPROVALS} AS p
  SET decision = 'EXPIRED', is_paused = FALSE, decided_at = CURRENT_TIMESTAMP
  FROM expired
  WHERE p.tenant_id = $1 AND p.id = expired.id AND p.decision = 'PENDING'
)
SELECT${APPROVAL_PROJECTION}
  FROM ${APPROVALS}
  WHERE tenant_id = $1 AND id = $2`;

const SELECT_APPROVAL_FOR_UPDATE = `${SELECT_APPROVAL}
  FOR UPDATE`;

const SELECT_APPROVAL_BY_EFFECT_KEY = `WITH expired AS (
  SELECT id, action_id
  FROM ${APPROVALS}
  WHERE tenant_id = $1 AND effect_key = $2 AND decision = 'PENDING' AND expires_at <= CURRENT_TIMESTAMP
), expired_actions AS (
  UPDATE ${ACTIONS} AS a
  SET status = 'failed'
  FROM expired
  WHERE a.tenant_id = $1 AND a.id = expired.action_id AND a.status = 'pending'
), expired_approvals AS (
  UPDATE ${APPROVALS} AS p
  SET decision = 'EXPIRED', is_paused = FALSE, decided_at = CURRENT_TIMESTAMP
  FROM expired
  WHERE p.tenant_id = $1 AND p.id = expired.id AND p.decision = 'PENDING'
)
SELECT${APPROVAL_PROJECTION}
  FROM ${APPROVALS}
  WHERE tenant_id = $1 AND effect_key = $2`;

const SELECT_APPROVAL_BY_EFFECT_KEY_FOR_UPDATE = `${SELECT_APPROVAL_BY_EFFECT_KEY}
  FOR UPDATE`;


const SELECT_ACTION_BY_EFFECT_KEY = `SELECT${ACTION_PROJECTION}
  FROM ${ACTIONS}
  WHERE tenant_id = $1 AND effect_key = $2`;

/**
 * The paused action is locked by its effect key: the pause and the decision both address it by the
 * identity the approval binds, so a different revision can never be released under this approval.
 */
const SELECT_ACTION_BY_EFFECT_KEY_FOR_UPDATE = `${SELECT_ACTION_BY_EFFECT_KEY}
  FOR UPDATE`;

/** Separator of the `<created_at>|<approval_id>` keyset cursor the queue read publishes. */
const CURSOR_SEPARATOR = '|';

/** Default page size of `listPending()`, and the largest page it accepts. */
const DEFAULT_PENDING_LIMIT = 50;
const MAX_PENDING_LIMIT = 200;

/**
 * One page of the PENDING queue (`06` §8.1.3 R14, implement/03 §1 DOMAIN 5 `approval_queue`).
 *
 * The predicate is `decision = 'PENDING'` alone and never `is_paused = FALSE`: a parked item is an
 * UNDECIDED item, so it stays in the queue exactly once with `is_paused` set (SCR-003 renders it as
 * PAUSED), and a row that leaves the queue is a row a human decided. The page is ordered by
 * `(created_at, id)` - `id` breaks the tie between two rows created in the same statement - and the
 * cursor resumes strictly after the last row of the previous page, so the keyset is total: a resumed
 * page can neither repeat nor skip an item. The predicate leads with the
 * `(tenant_id, decision, created_at)` prefix of `idx_approvals_pending`, and the statement reads the
 * canonical table rather than the `approval_queue` view so the console and the resume path read one
 * storage object.
 */
const SELECT_PENDING_APPROVALS = `WITH expired AS (
  SELECT id, action_id
  FROM ${APPROVALS}
  WHERE tenant_id = $1 AND decision = 'PENDING' AND expires_at <= CURRENT_TIMESTAMP
), expired_actions AS (
  UPDATE ${ACTIONS} AS a
  SET status = 'failed'
  FROM expired
  WHERE a.tenant_id = $1 AND a.id = expired.action_id AND a.status = 'pending'
), expired_approvals AS (
  UPDATE ${APPROVALS} AS p
  SET decision = 'EXPIRED', is_paused = FALSE, decided_at = CURRENT_TIMESTAMP
  FROM expired
  WHERE p.tenant_id = $1 AND p.id = expired.id AND p.decision = 'PENDING'
)
SELECT${APPROVAL_PROJECTION}
  FROM ${APPROVALS}
  WHERE tenant_id = $1
    AND decision = 'PENDING'
    AND expires_at > CURRENT_TIMESTAMP
    AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
  ORDER BY created_at ASC, id ASC
  LIMIT $4`;

/**
 * One page of the DECIDED (processed) approval history (`T6.8`): every row a human already resolved,
 * newest decision first. The predicate is `decision <> 'PENDING'`, so an EXPIRED row is included
 * because it is a terminal outcome the console groups under Đã xử lý. The keyset is
 * `(COALESCE(decided_at, created_at), id)` descending, and a resumed page continues strictly below
 * the last published row.
 */
const SELECT_DECIDED_APPROVALS = `SELECT${APPROVAL_PROJECTION}
  FROM ${APPROVALS}
  WHERE tenant_id = $1
    AND decision <> 'PENDING'
    AND ($2::timestamptz IS NULL OR (COALESCE(decided_at, created_at), id) < ($2::timestamptz, $3::uuid))
  ORDER BY COALESCE(decided_at, created_at) DESC, id DESC
  LIMIT $4`;

/**
 * Persists the deadline transition for at most one tenant's batch. Candidate action rows are locked
 * before the approval update, matching the decision path's action -> approval lock order, so
 * concurrent sweepers do not claim the same prepared command. The returned binding fields are used
 * to append the corresponding audit-chain records in the same transaction.
 */
const EXPIRE_OVERDUE_APPROVALS = `WITH expired AS (
  SELECT p.id, p.run_id, p.action_id, p.effect_key
  FROM ${ACTIONS} AS a
  JOIN ${APPROVALS} AS p
    ON p.tenant_id = a.tenant_id AND p.action_id = a.id
  WHERE a.tenant_id = $1
    AND p.decision = 'PENDING'
    AND p.expires_at <= CURRENT_TIMESTAMP
  ORDER BY p.expires_at ASC, p.id ASC
  LIMIT $2::int
  FOR UPDATE OF a SKIP LOCKED
), failed_actions AS (
  UPDATE ${ACTIONS} AS a
  SET status = 'failed'
  FROM expired
  WHERE a.tenant_id = $1
    AND a.id = expired.action_id
    AND a.status = 'pending'
), expired_approvals AS (
  UPDATE ${APPROVALS} AS p
  SET decision = 'EXPIRED',
      is_paused = FALSE,
      decided_at = CURRENT_TIMESTAMP
  FROM expired
  WHERE p.tenant_id = $1
    AND p.id = expired.id
    AND p.decision = 'PENDING'
  RETURNING p.id, p.run_id, p.action_id, p.effect_key
)
SELECT id, run_id, action_id, effect_key
FROM expired_approvals
ORDER BY id`;

/**
 * The actions of one page of approvals, and the single action of the §8.2.1 detail read, read by the
 * identities the page published.
 *
 * `approvals.action_id` is the tenant-scoped foreign key onto `actions (tenant_id, id)`
 * (`migrations/0001_tenant_scoped_fks.sql`), so one statement under the page's own tenant predicate
 * carries exactly the commands that page authorizes - no join, no second tenant scope, and no column
 * published outside the projection the write path already reads back.
 */
const SELECT_ACTIONS_BY_IDS = `SELECT${ACTION_PROJECTION}
  FROM ${ACTIONS}
  WHERE tenant_id = $1 AND id = ANY($2::uuid[])`;

/**
 * The `actions` row of the pause. `ON CONFLICT (tenant_id, effect_key) DO NOTHING` is the
 * exactly-once rule of the gate: one prepared command per deterministic key, and a caller that
 * loses the race reads the row it collided with instead of inserting a second one. `status` takes
 * the column default `pending` - a prepared command is never born dispatched.
 */
const INSERT_ACTION = `INSERT INTO ${ACTIONS} (
    id,
    tenant_id,
    skill_name,
    effect_key,
    action_revision,
    target_channel,
    action_payload
  )
  VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb)
  ON CONFLICT (tenant_id, effect_key) DO NOTHING
  RETURNING${ACTION_PROJECTION}`;

/**
 * The PENDING row of the pause, bound to `(tenant_id, run_id, action_id, effect_key, payload)`.
 * `authority_required` is written explicitly rather than defaulted: the routing outcome this row
 * records is an AUTH-4 verdict, and the column accepts nothing else.
 */
const INSERT_APPROVAL = `INSERT INTO ${APPROVALS} (
    tenant_id,
    run_id,
    action_id,
    effect_key,
    authority_required,
    payload,
    digest_version,
    reason
  )
  VALUES ($1, $2, $3::uuid, $4, 'AUTH-4', $5::jsonb, $6, $7)
  ON CONFLICT (tenant_id, effect_key) DO NOTHING
  RETURNING${APPROVAL_PROJECTION}`;

/**
 * The pause of implement/04 §4.2 statement 3: park the task on the approval, REPLACE `state_payload`
 * with the complete checkpoint the resume path re-enters from, and bump `task_version` against the
 * version the caller read (`0 rows` there means another writer advanced the task first).
 */
const PAUSE_TASK = `UPDATE ${PLATFORM_DURABLE_TASKS}
  SET state = 'awaiting_human',
      paused_for_approval_id = $3::uuid,
      state_payload = $4::jsonb,
      lease_owner = NULL,
      lease_expires_at = NULL,
      task_version = task_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND run_id = $2 AND task_version = $5
  RETURNING${TASK_PROJECTION}`;

/**
 * An explicit human PAUSE: the row stays PENDING and the task stays parked. It clears only the
 * worker handoff lease/event; the checkpoint remains the cursor the next resume re-enters from.
 */
const HOLD_TASK = `UPDATE ${PLATFORM_DURABLE_TASKS}
  SET state = 'awaiting_human',
      paused_for_approval_id = $3::uuid,
      state_payload = state_payload - 'resume_event',
      lease_owner = NULL,
      lease_expires_at = NULL,
      task_version = task_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND run_id = $2 AND task_version = $4
  RETURNING${TASK_PROJECTION}`;

/** APPROVED / MODIFIED: leave the gate and consume the queued handoff event. */
const RESUME_TASK = `UPDATE ${PLATFORM_DURABLE_TASKS}
  SET state = 'running',
      paused_for_approval_id = NULL,
      state_payload = state_payload - 'resume_event',
      task_version = task_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND run_id = $2 AND task_version = $3
  RETURNING${TASK_PROJECTION}`;

/**
 * MODIFIED resume: the checkpoint pending_action is rewritten in the same statement, so the
 * revision the operator authorized - not the revision that was reviewed - is what a later resume
 * reads back (the authorized revision is saved atomically with the decision).
 */
const RESUME_TASK_REVISED = `UPDATE ${PLATFORM_DURABLE_TASKS}
  SET state = 'running',
      paused_for_approval_id = NULL,
      state_payload = $3::jsonb,
      task_version = task_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND run_id = $2 AND task_version = $4
  RETURNING${TASK_PROJECTION}`;

/** REJECTED / CANCELLED: the run is closed, and a closed task is never revived (§4.1). */
const STOP_TASK = `UPDATE ${PLATFORM_DURABLE_TASKS}
  SET state = 'stopped',
      paused_for_approval_id = NULL,
      state_payload = state_payload - 'resume_event',
      lease_owner = NULL,
      lease_expires_at = NULL,
      task_version = task_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND run_id = $2 AND task_version = $3
  RETURNING${TASK_PROJECTION}`;

/** Explicit PAUSE: the row stays PENDING and the worker consumes the event before this write. */
const PAUSE_APPROVAL = `UPDATE ${APPROVALS}
  SET is_paused = TRUE
  WHERE tenant_id = $1 AND id = $2 AND decision = 'PENDING'
  RETURNING${APPROVAL_PROJECTION}`;
/** Persist one authenticated decision event without consuming the PENDING approval. */
const QUEUE_APPROVAL_RESUME_EVENT = `UPDATE ${PLATFORM_DURABLE_TASKS}
  SET state_payload = $3::jsonb,
      task_version = task_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1
    AND run_id = $2
    AND state = 'awaiting_human'
    AND paused_for_approval_id = $5::uuid
    AND task_version = $4
  RETURNING${TASK_PROJECTION}`;

/**
 * A terminal decision, written once: `decided_at` is set with the decision (the
 * `ck_approvals_decided` CHECK keeps PENDING and `decided_at IS NULL` equivalent), `is_paused` is
 * cleared (`ck_approvals_pause_pending`), and the PENDING predicate makes a second decision match
 * no row.
 */
const DECIDE_APPROVAL = `WITH action_status AS (
  UPDATE ${ACTIONS}
  SET status = CASE WHEN $3 = 'APPROVED' THEN 'authorized' ELSE 'failed' END
  WHERE tenant_id = $1
    AND id = (
      SELECT action_id
      FROM ${APPROVALS}
      WHERE tenant_id = $1
        AND id = $2
        AND decision = 'PENDING'
        AND expires_at > CURRENT_TIMESTAMP
    )
)
UPDATE ${APPROVALS}
  SET decision = $3,
      operator_id = $4,
      review_comment = $5,
      is_paused = FALSE,
      decided_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND id = $2 AND decision = 'PENDING'
    AND expires_at > CURRENT_TIMESTAMP
  RETURNING${APPROVAL_PROJECTION}`;

/**
 * The MODIFIED decision: the row authorizes the new revision by moving its binding. `payload` and
 * `effect_key` advance together with the `actions` row, so the digest a later reader recomputes is
 * the digest of the authorized revision, not of the one that was reviewed.
 * The original normalized payload, digest and version are captured from the old binding once.
 */
const MODIFY_APPROVAL = `UPDATE ${APPROVALS}
  SET decision = 'MODIFIED',
      operator_id = $3,
      review_comment = $4,
      effect_key = $5,
      original_payload = COALESCE(original_payload, payload),
      original_payload_sha256 = CASE WHEN original_payload IS NULL THEN $8 ELSE original_payload_sha256 END,
      original_digest_version = CASE WHEN original_payload IS NULL THEN digest_version ELSE original_digest_version END,
      payload = $6::jsonb,
      digest_version = $7,
      is_paused = FALSE,
      decided_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND id = $2 AND decision = 'PENDING'
    AND expires_at > CURRENT_TIMESTAMP
  RETURNING${APPROVAL_PROJECTION}`;

/**
 * The `actions` half of a MODIFIED decision: the same row keeps its identity and advances its
 * revision, payload and deterministic key. The revision is restated from the locked row, so the
 * three columns move exactly once per human revision.
 */
const MODIFY_ACTION = `UPDATE ${ACTIONS}
  SET action_revision = $3,
      effect_key = $4,
      action_payload = $5::jsonb,
      status = 'authorized'
  WHERE tenant_id = $1 AND id = $2
  RETURNING${ACTION_PROJECTION}`;

export {
  ACTIONS,
  ACTION_PROJECTION,
  APPROVALS,
  APPROVAL_PROJECTION,
  CURSOR_SEPARATOR,
  DECIDE_APPROVAL,
  DEFAULT_PENDING_LIMIT,
  EXPIRE_OVERDUE_APPROVALS,
  HOLD_TASK,
  INSERT_ACTION,
  INSERT_APPROVAL,
  MAX_PENDING_LIMIT,
  MODIFY_ACTION,
  MODIFY_APPROVAL,
  PAUSE_APPROVAL,
  PAUSE_TASK,
  QUEUE_APPROVAL_RESUME_EVENT,
  RESUME_TASK,
  RESUME_TASK_REVISED,
  SELECT_ACTIONS_BY_IDS,
  SELECT_ACTION_BY_EFFECT_KEY,
  SELECT_ACTION_BY_EFFECT_KEY_FOR_UPDATE,
  SELECT_APPROVAL,
  SELECT_APPROVAL_BY_EFFECT_KEY,
  SELECT_APPROVAL_BY_EFFECT_KEY_FOR_UPDATE,
  SELECT_APPROVAL_FOR_UPDATE,
  SELECT_DECIDED_APPROVALS,
  SELECT_PENDING_APPROVALS,
  STOP_TASK,
};
