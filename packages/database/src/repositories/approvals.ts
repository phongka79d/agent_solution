import { createHash } from 'node:crypto';

import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

import { withTenantContext } from '../rls.js';
import {
  PLATFORM_DURABLE_TASKS,
  TASK_PROJECTION,
  assertCompleteCheckpoint,
  assertGuard,
  assertIdentifier,
  assertLeaseHeld,
  assertPositiveInteger,
  assertSingleRow,
  isPlainObject,
  lockDurableTask,
  serializeJsonb,
} from './durable-workflows.js';
import type { DurableTaskRecord, DurableTaskRow } from './durable-workflows.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

/**
 * The AUTH-4 pause and the human decision that releases or closes it (implement/03 §1 DOMAIN 5,
 * implement/04 §4.2).
 *
 * `agentos.approvals` is the SINGLE canonical human-authorization record and therefore the only
 * resume authority: one PENDING row per `(tenant_id, effect_key)` is inserted in the same
 * transaction that parks the durable task in `awaiting_human`, and a decided row is never inserted
 * again and never decided twice. `approval_queue` is a view over that table, so the console and the
 * resume path can never disagree about what is waiting.
 *
 * Four rules shape every method below:
 *
 *  * **Tenant-scoped by construction.** Each call opens exactly one `withTenantContext()`
 *    transaction, so the transaction-local `app.current_tenant_id` binding and the `tenant_id`
 *    predicate always agree and RLS (NFR-006) denies an unbound read or write.
 *  * **One lock order, one transaction.** A writer locks the task first and only then touches
 *    `actions` / `approvals` (`task` -> `actions` -> `approvals`), so two writers of the same run
 *    serialize instead of deadlocking and no partial pause can be observed: the action row, the
 *    PENDING approval row and the task pause commit together or not at all (`actions` is inserted
 *    first because `approvals.action_id` references it).
 *  * **AUTH-4 only.** An approval is a routing outcome for one prepared action, never a grant: a
 *    drafted action whose `required_authority` is not `AUTH-4` is refused (AUTH-0..AUTH-3 are
 *    admitted by rank comparison, and AUTH-5 is a prohibited verdict the policy gate denies - no
 *    row may ever authorize it), and `approvals.authority_required` accepts `AUTH-4` alone.
 *  * **The decision binds bytes, not intent.** The human reviews `approvals.payload`, so every
 *    claim recomputes SHA-256 over its RFC 8785 canonical form while the row is locked and compares
 *    it with the digest the reviewer read back; a different payload is `APPROVAL_STALE_PAYLOAD` and
 *    no write happens. The digest primitive is local (`canonicalizeJson` / `sha256CanonicalJson`
 *    below) because `packages/database` is a leaf of the package DAG and may not import
 *    `@agentos/core-engine`; it is byte-compatible with `durability/canonical-json.ts`, and it is
 *    exported so the console, the API route and this repository compute one digest, never three.
 *
 * `actions.action_revision` numbers revisions of the same action; see
 * `PAUSED_ACTION_REVISION_OFFSET` for how the canonical draft's zero-based revision maps onto the
 * column's one-based lattice.
 */

/** `agentos` is not on the connection `search_path`, so every statement is schema-qualified. */
const APPROVALS = 'agentos.approvals';
const ACTIONS = 'agentos.actions';

/**
 * The decisions the human route may store (`approvals.decision`, implement/08 §7.2). `PENDING` is
 * not among them: it is the state a row is created in, never a decision.
 */
export type ApprovalDecision = 'APPROVED' | 'MODIFIED' | 'REJECTED' | 'PAUSE' | 'CANCELLED';

/**
 * Every value `approvals.decision` accepts. `EXPIRED` is representable because the column's CHECK
 * declares it, but no code path here writes it: approval expiry is `[OWNER-DECISION-REQUIRED]` and
 * no automated sweep or TTL exists (§4.2), so an undecided row stays PENDING until a human decides.
 */
export type ApprovalStatus = 'PENDING' | ApprovalDecision | 'EXPIRED';

/** Every value `actions.status` accepts; only `pending` may be revised by a MODIFIED decision. */
export type ActionStatus = 'pending' | 'authorized' | 'dispatched' | 'failed';

/**
 * The `DurableTaskCheckpoint.pending_action` / `IStatefulWorkflowEngine.claimApprovalAndResume`
 * `authorized_action` fields this module reads, spelled out structurally so `packages/database`
 * keeps its type-only edge to the orchestration contracts and imports no core-engine runtime.
 */
export interface ApprovalActionDraft {
  readonly action_id: string;
  readonly tenant_id: string;
  readonly run_id: string;
  readonly skill_id: string;
  readonly adapter_target: string;
  readonly step_index: number;
  readonly request_id: string;
  readonly action_revision: number;
  readonly effect_key: string;
  readonly required_authority: string;
  readonly approval_payload_digest?: string;
  readonly payload: Record<string, unknown>;
}

/** One `agentos.approvals` row, published with its timestamps as ISO-8601 UTC strings. */
export interface ApprovalRecord {
  readonly id: string;
  readonly tenant_id: string;
  readonly run_id: string;
  readonly action_id: string;
  /** Null until campaigns land (P1): the column is present and the FK is deferred. */
  readonly campaign_id: string | null;
  readonly effect_key: string;
  readonly authority_required: 'AUTH-4';
  readonly payload: unknown;
  /**
   * SHA-256 of the RFC 8785 canonical `payload`, computed on read. It is not a column: the digest
   * is derived from the reviewed bytes, and every decision compares against the same derivation.
   */
  readonly payload_sha256: string;
  readonly reason: string;
  readonly operator_id: string | null;
  readonly decision: ApprovalStatus;
  readonly is_paused: boolean;
  readonly review_comment: string | null;
  readonly decided_at: string | null;
  readonly created_at: string;
}

/** One `agentos.actions` row: the prepared outgoing command an approval authorizes. */
export interface ActionRecord {
  readonly id: string;
  readonly tenant_id: string;
  readonly decision_id: string | null;
  readonly skill_name: string;
  readonly effect_key: string;
  readonly action_revision: number;
  readonly target_channel: string;
  readonly action_payload: unknown;
  readonly status: ActionStatus;
  readonly created_at: string;
}

/**
 * One approval with the prepared command it authorizes: the item the R14 queue renders and the
 * object the §8.2.1 detail read returns.
 *
 * The `approval` half is the canonical record of implement/03 §1 DOMAIN 5, published with the digest
 * of the bytes the human reviews; the `action` half is the row `approvals.action_id` names, so an
 * item carries the command a decision would release and not only the ticket that gates it.
 */
export interface ApprovalDetailRecord {
  readonly approval: ApprovalRecord;
  readonly action: ActionRecord;
}

/**
 * Input of `listPending()`: the tenant whose queue is read, the page size (default 50,
 * maximum 200) and the resume cursor.
 *
 * There is no `status` member because the queue IS the `PENDING` projection (`06` §8.1.3 R14): the
 * baseline supports no other filter, and a second value would be answered by a different read rather
 * than by this one. An item a human parked is still undecided, so it is in this queue.
 */
export interface ApprovalListInput {
  readonly tenant_id: string;
  /** Cursor of the following page, exactly as this module published it (`<created_at>|<id>`). */
  readonly cursor?: string;
  readonly limit?: number;
}

/** One page of the PENDING queue: at most `limit` items and the cursor of the following page. */
export interface ApprovalQueuePage {
  readonly items: readonly ApprovalDetailRecord[];
  readonly next_cursor: string | null;
}

/** Input of `pauseForApproval()`; the port's own parameter object (`IStatefulWorkflowEngine`). */
export interface PauseForApprovalInput {
  readonly tenant_id: string;
  readonly run_id: string;
  /** The version the caller read; restated as the compare-and-increment base of the pause. */
  readonly expected_task_version: number;
  /** Complete `DurableTaskCheckpoint`; it REPLACES `state_payload` for the parked task (§4.2). */
  readonly checkpoint: unknown;
  readonly approval: {
    readonly action_id: string;
    readonly effect_key: string;
    readonly payload: unknown;
    readonly reason: string;
  };
}

/** Outcome of `pauseForApproval()`: the durable rows the pause committed. */
export interface PauseForApprovalResult {
  readonly approval_id: string;
  readonly approval: ApprovalRecord;
  readonly action: ActionRecord;
  readonly task: DurableTaskRecord;
}

/** Input of `claimApprovalAndResume()`; the port's own parameter object (`IStatefulWorkflowEngine`). */
export interface ClaimApprovalAndResumeInput {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly approval_id: string;
  readonly effect_key: string;
  /** The digest the operator reviewed; a different stored payload is `APPROVAL_STALE_PAYLOAD`. */
  readonly expected_payload_sha256: string;
  readonly authorized_action: ApprovalActionDraft | null;
  readonly decision: ApprovalDecision;
  readonly operator_id: string;
  readonly review_comment: string | null;
  /** Version and lease fence supplied by the worker after it claimed the durable handoff. */
  readonly expected_task_version?: number;
  readonly lease_owner?: string;
  readonly expected_resume_event?: Record<string, unknown>;
}
/** Decision values accepted by the API handoff writer before the worker consumes the approval. */
export type QueuedApprovalDecision = 'APPROVE' | 'REJECT' | 'MODIFY' | 'PAUSE' | 'CANCEL';

/** Input of the durable approval decision handoff. */
export interface QueueApprovalDecisionInput {
  readonly tenant_id: string;
  readonly approval_id: string;
  readonly run_id: string;
  readonly effect_key: string;
  readonly expected_payload_sha256: string;
  readonly decision: QueuedApprovalDecision;
  readonly operator_id: string;
  readonly reason: string;
  readonly modified_payload?: Record<string, unknown>;
}

/** Result of persisting a decision event without consuming the approval. */
export interface QueueApprovalDecisionResult {
  readonly approval_id: string;
  readonly task_id: string;
  readonly status: 'QUEUED';
  readonly queued_at: string;
}

/** Outcome of `claimApprovalAndResume()`: the decided rows and the task they moved. */
export interface ClaimApprovalAndResumeResult {
  /**
   * `true` on every return. A claim that cannot be executed is refused with an explicit error
   * rather than reported as an unclaimed `false`, so a caller can never mistake a refusal for a
   * no-op; the flag exists for structural compatibility with the port.
   */
  readonly claimed: boolean;
  readonly approval: ApprovalRecord;
  readonly action: ActionRecord;
  readonly task: DurableTaskRecord;
}

/** The columns every approval read publishes, in the order `toApprovalRecord` expects them. */
const APPROVAL_PROJECTION = `
    id,
    tenant_id,
    run_id,
    action_id,
    campaign_id,
    effect_key,
    authority_required,
    payload,
    reason,
    operator_id,
    decision,
    is_paused,
    review_comment,
    decided_at,
    created_at`;

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

const SELECT_APPROVAL = `SELECT${APPROVAL_PROJECTION}
  FROM ${APPROVALS}
  WHERE tenant_id = $1 AND id = $2`;

/** The locking read of the human decision: the row is frozen before its digest is compared. */
const SELECT_APPROVAL_FOR_UPDATE = `${SELECT_APPROVAL}
  FOR UPDATE`;

const SELECT_APPROVAL_BY_EFFECT_KEY = `SELECT${APPROVAL_PROJECTION}
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
const SELECT_PENDING_APPROVALS = `SELECT${APPROVAL_PROJECTION}
  FROM ${APPROVALS}
  WHERE tenant_id = $1
    AND decision = 'PENDING'
    AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
  ORDER BY created_at ASC, id ASC
  LIMIT $4`;

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
    reason
  )
  VALUES ($1, $2, $3::uuid, $4, 'AUTH-4', $5::jsonb, $6)
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
const DECIDE_APPROVAL = `UPDATE ${APPROVALS}
  SET decision = $3,
      operator_id = $4,
      review_comment = $5,
      is_paused = FALSE,
      decided_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND id = $2 AND decision = 'PENDING'
  RETURNING${APPROVAL_PROJECTION}`;

/**
 * The MODIFIED decision: the row authorizes the new revision by moving its binding. `payload` and
 * `effect_key` advance together with the `actions` row, so the digest a later reader recomputes is
 * the digest of the authorized revision, not of the one that was reviewed.
 */
const MODIFY_APPROVAL = `UPDATE ${APPROVALS}
  SET decision = 'MODIFIED',
      operator_id = $3,
      review_comment = $4,
      effect_key = $5,
      payload = $6::jsonb,
      is_paused = FALSE,
      decided_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND id = $2 AND decision = 'PENDING'
  RETURNING${APPROVAL_PROJECTION}`;

/**
 * The `actions` half of a MODIFIED decision: the same row keeps its identity and advances its
 * revision, payload and deterministic key. The revision is restated from the locked row, so the
 * three columns move exactly once per human revision.
 */
const MODIFY_ACTION = `UPDATE ${ACTIONS}
  SET action_revision = $3,
      effect_key = $4,
      action_payload = $5::jsonb
  WHERE tenant_id = $1 AND id = $2
  RETURNING${ACTION_PROJECTION}`;

/**
 * Bare lowercase hex SHA-256: the single accepted encoding of every digest in this schema, and the
 * only spelling `expected_payload_sha256` may arrive in.
 */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A canonical UUID: the type of `approvals.id`, `approvals.action_id` and `actions.id`. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A UTF-16 string with no lone surrogate: such a string has no UTF-8 encoding to digest. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * `actions.action_revision` is one-based (`CHECK (action_revision >= 1)`, `DEFAULT 1`) while the
 * canonical draft numbers the first revision `0`. The row therefore stores `draft + 1`: the first
 * persisted revision is the column's own initial `1` (the revision the fixture business key
 * `(tenant_id, action_id, action_revision)` uses for a first dispatch), and because both lattices
 * advance by one per human revision, "the revision is incremented in place" holds in the stored
 * column as well - a MODIFIED draft that carries `base + 1` is written as `stored + 1`.
 */
const PAUSED_ACTION_REVISION_OFFSET = 1;

/** One approval row exactly as `pg` returns it, before the projection is published. */
interface ApprovalRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  run_id: string;
  action_id: string;
  campaign_id: string | null;
  effect_key: string;
  authority_required: 'AUTH-4';
  payload: unknown;
  reason: string;
  operator_id: string | null;
  decision: ApprovalStatus;
  is_paused: boolean;
  review_comment: string | null;
  decided_at: Date | null;
  created_at: Date;
}

/** One action row exactly as `pg` returns it, before the projection is published. */
interface ActionRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  decision_id: string | null;
  skill_name: string;
  effect_key: string;
  action_revision: number;
  target_channel: string;
  action_payload: unknown;
  status: ActionStatus;
  created_at: Date;
}

/**
 * Publishes one approval row with its timestamps as ISO-8601 UTC strings, so the row survives
 * serialization into a console projection or a resume checkpoint unchanged.
 *
 * `payload_sha256` is computed, never stored: `approvals` binds the reviewed bytes, and every
 * decision re-derives the digest from them (there is no column a stale digest could drift into).
 */
function toApprovalRecord(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    run_id: row.run_id,
    action_id: row.action_id,
    campaign_id: row.campaign_id,
    effect_key: row.effect_key,
    authority_required: row.authority_required,
    payload: row.payload,
    payload_sha256: sha256CanonicalJson(row.payload),
    reason: row.reason,
    operator_id: row.operator_id,
    decision: row.decision,
    is_paused: row.is_paused,
    review_comment: row.review_comment,
    decided_at: row.decided_at === null ? null : row.decided_at.toISOString(),
    created_at: row.created_at.toISOString(),
  };
}

/** Publishes one action row with its timestamp as an ISO-8601 UTC string. */
function toActionRecord(row: ActionRow): ActionRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    decision_id: row.decision_id,
    skill_name: row.skill_name,
    effect_key: row.effect_key,
    action_revision: row.action_revision,
    target_channel: row.target_channel,
    action_payload: row.action_payload,
    status: row.status,
    created_at: row.created_at.toISOString(),
  };
}

/* ------------------------------------------------------------------------------------------------
 * Canonical JSON and its digest (implement/04 §6.1 step 1-2, implement/08 §4.2)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Serializes a value to its canonical JSON form (RFC 8785 / JCS restricted to I-JSON values).
 *
 * This is the byte contract every durable digest of this platform is computed over: object members
 * are sorted by UTF-16 code unit and emitted without insignificant whitespace, arrays keep their
 * order, strings are escaped minimally and digested as UTF-8, and numbers are rendered by the
 * ECMAScript number-to-string algorithm RFC 8785 specifies. A value JSON cannot represent is
 * refused instead of being converted - an `undefined` member or a `Date` would otherwise change
 * the hashed bytes without the caller noticing, and two writers could then claim to have hashed the
 * same payload while hashing different bytes.
 *
 * The implementation is local because `packages/database` is a leaf of the package DAG
 * (implement/02 §2) and may not import `@agentos/core-engine`; it is byte-compatible with
 * `durability/canonical-json.ts`, which is the same restriction viewed from the other side.
 *
 * @param value Value to canonicalize; only JSON-representable data is accepted.
 * @returns The canonical JSON text; UTF-8 encode it before digesting.
 * @throws Error `CANONICAL_JSON_INVALID` when the value has no canonical form; the message names
 *   the offending path.
 */
export function canonicalizeJson(value: unknown): string {
  return serializeCanonical(value, '$');
}

/**
 * Digests a value with SHA-256 over its canonical JSON form (§04 §6.1 step 1-2, §08 §4.2).
 *
 * This is the digest an approval is bound to: the console shows it, the operator reviews the
 * payload it was computed from, and `claimApprovalAndResume()` recomputes it while the row is
 * locked. It is exported so all three compute one digest rather than three.
 *
 * @param value Value to canonicalize and digest.
 * @returns 64 lower-case hexadecimal characters.
 * @throws Error `CANONICAL_JSON_INVALID` when the value is not canonicalizable.
 */
export function sha256CanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex');
}

/**
 * Serializes one node, carrying the path of the current node for diagnostics.
 *
 * @param value Node to serialize.
 * @param path JSON-pointer-like location used in the refusal message.
 * @returns Canonical JSON text for the node.
 * @throws Error `CANONICAL_JSON_INVALID` for any non-representable value.
 */
function serializeCanonical(value: unknown, path: string): string {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(
          `CANONICAL_JSON_INVALID: ${path} is the non-finite number ${String(value)}, which JSON ` +
            'cannot represent and a digest must not silently convert (NFR-002).',
        );
      }

      return JSON.stringify(value);
    case 'string':
      assertWellFormedUnicode(value, path);

      return JSON.stringify(value);
    case 'object':
      return Array.isArray(value)
        ? serializeCanonicalArray(value, path)
        : serializeCanonicalObject(value, path);
    default:
      throw new Error(
        `CANONICAL_JSON_INVALID: ${path} is a ${typeof value} value, which has no canonical JSON ` +
          'form; dropping the member would change the hashed bytes without the caller noticing ' +
          '(implement/04 §6.1).',
      );
  }
}

/**
 * Serializes an array in source order. A sparse hole is a rejection, not a `null`: the hole has no
 * value to hash, and `JSON.stringify` would silently write one.
 */
function serializeCanonicalArray(items: readonly unknown[], path: string): string {
  const parts: string[] = [];

  for (let index = 0; index < items.length; index += 1) {
    parts.push(serializeCanonical(items[index], `${path}[${index}]`));
  }

  return `[${parts.join(',')}]`;
}

/** Serializes a plain object with members sorted by UTF-16 code unit (never by locale). */
function serializeCanonicalObject(record: object, path: string): string {
  const prototype: unknown = Object.getPrototypeOf(record);

  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(
      `CANONICAL_JSON_INVALID: ${path} is a ${describePrototype(prototype as object)}; only plain ` +
        'objects are canonical JSON, because a class instance carries state a digest would have to ' +
        'guess how to render (implement/04 §6.1).',
    );
  }

  const members = record as Record<string, unknown>;
  const parts = Object.keys(members)
    .sort()
    .map((key) => {
      assertWellFormedUnicode(key, `${path}.${key}`);

      return `${JSON.stringify(key)}:${serializeCanonical(members[key], `${path}.${key}`)}`;
    });

  return `{${parts.join(',')}}`;
}

/**
 * Names a non-plain object's prototype for a refusal message.
 *
 * @param prototype Prototype of the rejected object.
 * @returns A readable type name such as `Date instance`, or a generic description.
 */
function describePrototype(prototype: object): string {
  if ('constructor' in prototype) {
    const { constructor } = prototype as { constructor?: unknown };

    if (typeof constructor === 'function' && constructor.name.length > 0) {
      return `${constructor.name} instance`;
    }
  }

  return 'non-plain object';
}

/**
 * Ensures a string is valid Unicode.
 *
 * A lone surrogate has no UTF-8 encoding, so it would otherwise be replaced and hashed as U+FFFD -
 * a silent conversion that hides an upstream encoding bug behind a digest that nobody can
 * reproduce.
 */
function assertWellFormedUnicode(value: string, path: string): void {
  if (LONE_SURROGATE.test(value)) {
    throw new Error(
      `CANONICAL_JSON_INVALID: ${path} contains a lone surrogate, which has no UTF-8 encoding; ` +
        'refusing to hash a replacement character in its place (implement/04 §6.1).',
    );
  }
}

/* ------------------------------------------------------------------------------------------------
 * Fail-closed input validation
 * ---------------------------------------------------------------------------------------------- */

/**
 * Reads the SQLSTATE of a `pg` driver error, when the failure carries one.
 *
 * Only used to translate a unique violation (`23505`) on a tenant-scoped key into a refusal that
 * names the key it collided on. Anything else is rethrown untouched, because a driver or connection
 * failure is not an approval outcome.
 */
function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }

  const { code } = error as { code?: unknown };

  return typeof code === 'string' ? code : undefined;
}

/**
 * Validates a UUID against the `UUID` columns (`approvals.id`, `approvals.action_id`, `actions.id`).
 *
 * A non-UUID would be rejected by PostgreSQL with `22P02`, which tells a caller nothing about which
 * identity it broke; refusing here keeps the failure at the boundary that produced it.
 */
function assertUuid(value: unknown, column: string, code: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error(
      `${code}: ${column} must be a UUID; a durable identity that cannot address the row it names ` +
        'is refused before the transaction opens (implement/03 §1 DOMAIN 5).',
    );
  }

  return value;
}

/**
 * Reads a non-empty bounded string out of an untyped JSON value.
 *
 * `assertIdentifier` states the same rule for typed inputs but returns `void`; this reader is used
 * for the fields of a draft that arrive as `unknown`, so the value it validated is the value that
 * gets written.
 */
function readIdentifier(
  value: unknown,
  column: string,
  max_length: number,
  code: string,
): string {
  assertIdentifier(value, column, max_length, code);

  return value as string;
}

/**
 * Reads a non-negative integer out of an untyped JSON value.
 *
 * The bound matches the canonical identity inputs of implement/04 §3.2.3: `step_index` and
 * `action_revision` are non-negative, and an absent or fractional one would collapse two distinct
 * revisions onto one identity.
 */
function readNonNegativeInteger(value: unknown, column: string, code: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `${code}: ${column} must be an integer >= 0; a missing or fractional component cannot be ` +
        'part of a deterministic identity (implement/04 §3.2.3).',
    );
  }

  return value;
}

/**
 * Normalizes and validates a canonical payload digest.
 *
 * This is a fail-closed guard, not decoration: a digest that arrives with a prefix, in upper case,
 * or blank-padded would never compare equal to the recomputed one, so the refusal names the exact
 * spelling the binding accepts instead of reporting a payload mismatch that is really a typo.
 */
function normalizeDigest(value: unknown, code: string, purpose: string): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';

  if (!SHA256_HEX.test(normalized)) {
    throw new Error(
      `${code}: the digest must be the bare lowercase 64-character hex SHA-256 of the RFC 8785 ` +
        `canonical payload ${purpose} (implement/08 §4.2).`,
    );
  }

  return normalized;
}

/** Validates a decision against the closed five-value vocabulary of the human route. */
function assertDecision(value: unknown): asserts value is ApprovalDecision {
  if (
    value !== 'APPROVED' &&
    value !== 'MODIFIED' &&
    value !== 'REJECTED' &&
    value !== 'PAUSE' &&
    value !== 'CANCELLED'
  ) {
    throw new Error(
      `APPROVAL_DECISION_INVALID: ${String(value)} is not a human decision; the route accepts ` +
        'APPROVED | MODIFIED | REJECTED | PAUSE | CANCELLED, and PENDING is the state a row is ' +
        'created in rather than a decision (implement/08 §7.2).',
    );
  }
}

/**
 * Refuses a pause whose drafted action is not an AUTH-4 routing outcome.
 *
 * The two refusals are deliberately different: AUTH-5 is a prohibited verdict the policy gate
 * DENIES, so a row that authorized it would turn a refusal into a human override, while AUTH-0..3
 * are admitted by rank comparison and never reach an approval row at all (§3.1).
 */
function assertAuthorityBinding(draft: ApprovalActionDraft, source: string): void {
  if (draft.required_authority === 'AUTH-5') {
    throw new Error(
      `AUTH5_NEVER_APPROVABLE: ${source} declares AUTH-5, which is a prohibited verdict the ` +
        'authority gate denies; no approval row may authorize it, because an approval is a routing ' +
        'outcome for one prepared AUTH-4 action and never a grant of clearance (implement/04 §3.1).',
    );
  }

  if (draft.required_authority !== 'AUTH-4') {
    throw new Error(
      `APPROVAL_REQUIRES_AUTH4: ${source} declares ${String(draft.required_authority)}; the gate ` +
        'admits AUTH-0..AUTH-3 by rank comparison (AUTO_APPROVED) and pauses only AUTH-4, so a ' +
        'row for any other authority would bypass the verdict that produced it (implement/04 §4.2).',
    );
  }
}

/**
 * Reads one drafted action out of an untyped JSON value - the checkpoint's `pending_action` or the
 * decision's `authorized_action`.
 *
 * Every field the pause writes or the decision compares is validated here, before a transaction
 * opens, so an action that cannot be persisted or compared is refused at the boundary that
 * produced it rather than by a `VARCHAR(64)` or a `UUID` cast deep inside a statement.
 *
 * @param value Candidate draft.
 * @param source Where the draft came from, named in every refusal.
 * @returns The draft, narrowed to the fields this module reads.
 * @throws Error `APPROVAL_ACTION_INVALID` when the draft cannot be one.
 */
function readActionDraft(value: unknown, source: string): ApprovalActionDraft {
  if (!isPlainObject(value)) {
    throw new Error(
      `APPROVAL_ACTION_INVALID: ${source} must be the drafted action object the approval binds; a ` +
        'pause without it has no command to authorize (implement/04 §4.2 statement 3).',
    );
  }

  const draft = value;

  const payload = draft['payload'];
  if (!isPlainObject(payload)) {
    throw new Error(
      `APPROVAL_ACTION_INVALID: ${source}.payload must be the action payload object the digest is ` +
        'computed over; the approval binds those bytes and cannot bind a scalar (implement/08 §4.2).',
    );
  }

  const action_revision = readNonNegativeInteger(
    draft['action_revision'],
    'action_revision',
    'APPROVAL_ACTION_REVISION_INVALID',
  );

  return {
    action_id: assertUuid(draft['action_id'], 'action_id', 'APPROVAL_ACTION_ID_INVALID'),
    tenant_id: readIdentifier(
      draft['tenant_id'],
      'tenant_id',
      36,
      'APPROVAL_ACTION_TENANT_REQUIRED',
    ),
    run_id: readIdentifier(draft['run_id'], 'run_id', 64, 'APPROVAL_ACTION_RUN_REQUIRED'),
    skill_id: readIdentifier(draft['skill_id'], 'skill_id', 64, 'APPROVAL_SKILL_ID_REQUIRED'),
    adapter_target: readIdentifier(
      draft['adapter_target'],
      'adapter_target',
      32,
      'APPROVAL_TARGET_CHANNEL_REQUIRED',
    ),
    step_index: readNonNegativeInteger(
      draft['step_index'],
      'step_index',
      'APPROVAL_STEP_INDEX_INVALID',
    ),
    request_id: readIdentifier(
      draft['request_id'],
      'request_id',
      128,
      'APPROVAL_REQUEST_ID_REQUIRED',
    ),
    action_revision,
    effect_key: readIdentifier(
      draft['effect_key'],
      'effect_key',
      128,
      'APPROVAL_EFFECT_KEY_REQUIRED',
    ),
    required_authority: readIdentifier(
      draft['required_authority'],
      'required_authority',
      16,
      'APPROVAL_AUTHORITY_REQUIRED',
    ),
    payload,
  };
}

/** A pause whose inputs were validated and whose JSON payloads were serialized once. */
interface PreparedPause {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly action_id: string;
  readonly effect_key: string;
  readonly skill_name: string;
  readonly target_channel: string;
  readonly action_revision: number;
  readonly payload: string;
  readonly payload_sha256: string;
  readonly reason: string;
  readonly checkpoint: string;
}

/** A decision whose inputs were validated, with the reviewed digest normalized. */
interface PreparedClaim {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly approval_id: string;
  readonly effect_key: string;
  readonly reviewed_digest: string;
  readonly decision: ApprovalDecision;
  readonly operator_id: string;
  readonly review_comment: string | null;
  readonly authorized: ApprovalActionDraft | null;
  readonly expected_task_version?: number;
  readonly lease_owner?: string;
  readonly expected_resume_event?: Record<string, unknown>;
}
interface PreparedQueueDecision {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly approval_id: string;
  readonly effect_key: string;
  readonly reviewed_digest: string;
  readonly decision: QueuedApprovalDecision;
  readonly operator_id: string;
  readonly reason: string;
  readonly resume_event: Record<string, unknown>;
}

/**
 * Validates one pause and binds it to its drafted action, before any transaction opens.
 *
 * The checks are the AUTH-4 binding of the port: the approval must name the action the checkpoint
 * carries (`action_id`, `effect_key`), the two must be the SAME tenant and run, the authority must
 * be AUTH-4, and the approved payload must be the drafted payload down to its canonical digest -
 * an approval that authorized different bytes would release a command no human reviewed.
 *
 * @param input The port's pause parameters.
 * @returns The prepared pause, with both JSON columns serialized.
 * @throws Error `CHECKPOINT_INCOMPLETE` when the checkpoint is not a complete `DurableTaskCheckpoint`.
 * @throws Error `APPROVAL_ACTION_INVALID` / `APPROVAL_AUTHORITY_REQUIRED` for a draft that cannot pause.
 * @throws Error `AUTH5_NEVER_APPROVABLE` / `APPROVAL_REQUIRES_AUTH4` for a non-AUTH-4 route.
 * @throws Error `APPROVAL_BINDING_MISMATCH` when the approval and the draft describe different commands.
 */
function preparePause(input: PauseForApprovalInput): PreparedPause {
  assertIdentifier(input.tenant_id, 'tenant_id', 36, 'APPROVAL_TENANT_ID_REQUIRED');
  assertIdentifier(input.run_id, 'run_id', 64, 'APPROVAL_RUN_ID_REQUIRED');
  assertPositiveInteger(
    input.expected_task_version,
    'task_version',
    'APPROVAL_TASK_VERSION_INVALID',
  );

  const checkpoint: unknown = input.checkpoint;
  assertCompleteCheckpoint(checkpoint);

  const draft = readActionDraft(
    checkpoint['pending_action'],
    "the checkpoint's pending_action",
  );
  assertAuthorityBinding(draft, "the checkpoint's pending_action");

  const action_id = assertUuid(
    input.approval.action_id,
    'action_id',
    'APPROVAL_ACTION_ID_INVALID',
  );
  const effect_key = readIdentifier(
    input.approval.effect_key,
    'effect_key',
    128,
    'APPROVAL_EFFECT_KEY_REQUIRED',
  );
  const reason = input.approval.reason as unknown;

  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new Error(
      'APPROVAL_REASON_REQUIRED: the approval states why a human is asked; the reason is what ' +
        'SCR-003 shows above the reviewed payload, so a blank one is not a queue item ' +
        '(implement/04 §4.2 statement 3).',
    );
  }

  if (!isPlainObject(input.approval.payload)) {
    throw new Error(
      'APPROVAL_PAYLOAD_INVALID: the approved payload must be the JSON object the digest is ' +
        'computed over; the approval binds those bytes and cannot bind a scalar (implement/08 §4.2).',
    );
  }

  if (action_id !== draft.action_id) {
    throw new Error(
      `APPROVAL_BINDING_MISMATCH: the approval authorizes action ${action_id} while the checkpoint's ` +
        `pending_action is ${draft.action_id}; the row and the command it releases must be the same ` +
        'prepared action (implement/04 §4.2 statement 3).',
    );
  }

  if (effect_key !== draft.effect_key) {
    throw new Error(
      `APPROVAL_BINDING_MISMATCH: the approval binds effect_key ${effect_key} while the drafted ` +
        `action derives ${draft.effect_key}; an approval is bound to one effect revision and never ` +
        'to a key some other revision could also produce (BR-005).',
    );
  }

  if (draft.tenant_id !== input.tenant_id || draft.run_id !== input.run_id) {
    throw new Error(
      `APPROVAL_BINDING_MISMATCH: the drafted action belongs to tenant ${draft.tenant_id} run ` +
        `${draft.run_id}, not to tenant ${input.tenant_id} run ${input.run_id}; a pause may only ` +
        'bind an action of the run it parks (NFR-006).',
    );
  }

  const payload_sha256 = sha256CanonicalJson(input.approval.payload);

  if (payload_sha256 !== sha256CanonicalJson(draft.payload)) {
    throw new Error(
      'APPROVAL_BINDING_MISMATCH: the payload the approval binds is not the payload of the drafted ' +
        'action; a human would review one command and release another (implement/08 §4.2).',
    );
  }

  return {
    tenant_id: input.tenant_id,
    run_id: input.run_id,
    action_id,
    effect_key,
    skill_name: draft.skill_id,
    target_channel: draft.adapter_target,
    action_revision: draft.action_revision + PAUSED_ACTION_REVISION_OFFSET,
    payload: serializeJsonb(input.approval.payload, 'APPROVAL_PAYLOAD_UNSERIALIZABLE'),
    payload_sha256,
    reason,
    checkpoint: serializeJsonb(checkpoint, 'APPROVAL_CHECKPOINT_UNSERIALIZABLE'),
  };
}

/**
 * Validates one human decision before any transaction opens.
 *
 * @param input The port's decision parameters.
 * @returns The prepared claim, with the reviewed digest normalized.
 * @throws Error `APPROVAL_ID_INVALID` / `APPROVAL_EFFECT_KEY_REQUIRED` when the claim cannot address a row.
 * @throws Error `APPROVAL_DIGEST_INVALID` when the reviewed digest is not a bare SHA-256.
 * @throws Error `APPROVAL_DECISION_INVALID` for a decision outside the five-value route.
 * @throws Error `APPROVAL_OPERATOR_REQUIRED` when the decision names no authenticated operator.
 * @throws Error `MODIFICATION_REQUIRED` for a MODIFIED decision without its authorized revision.
 * @throws Error `APPROVAL_DECISION_ACTION_MISMATCH` when a decision that authorizes nothing carries an action.
 */
function prepareClaim(input: ClaimApprovalAndResumeInput): PreparedClaim {
  assertIdentifier(input.tenant_id, 'tenant_id', 36, 'APPROVAL_TENANT_ID_REQUIRED');
  assertIdentifier(input.run_id, 'run_id', 64, 'APPROVAL_RUN_ID_REQUIRED');

  const approval_id = assertUuid(input.approval_id, 'approval_id', 'APPROVAL_ID_INVALID');
  const effect_key = readIdentifier(
    input.effect_key,
    'effect_key',
    128,
    'APPROVAL_EFFECT_KEY_REQUIRED',
  );
  const reviewed_digest = normalizeDigest(
    input.expected_payload_sha256,
    'APPROVAL_DIGEST_INVALID',
    'the operator reviewed',
  );

  assertDecision(input.decision);
  assertIdentifier(input.operator_id, 'operator_id', 128, 'APPROVAL_OPERATOR_REQUIRED');

  const review_comment = input.review_comment;

  if (review_comment !== null && typeof review_comment !== 'string') {
    throw new Error(
      'APPROVAL_REVIEW_COMMENT_INVALID: review_comment must be the operator note or null, so the ' +
        'audited decision records what the human actually wrote (implement/08 §7.2).',
    );
  }
  if (input.lease_owner !== undefined) {
    assertIdentifier(input.lease_owner, 'lease_owner', 128, 'APPROVAL_LEASE_OWNER_REQUIRED');
    assertPositiveInteger(
      input.expected_task_version,
      'task_version',
      'APPROVAL_TASK_VERSION_INVALID',
    );
    if (!isPlainObject(input.expected_resume_event)) {
      throw new Error(
        'APPROVAL_RESUME_EVENT_REQUIRED: a worker-fenced approval claim must restate the exact ' +
          'durable resume event it is consuming.',
      );
    }
  }

  const authorized =
    input.authorized_action === null
      ? null
      : readActionDraft(input.authorized_action, 'the authorized_action of this decision');

  if (input.decision === 'MODIFIED' && authorized === null) {
    throw new Error(
      'MODIFICATION_REQUIRED: a MODIFIED decision authorizes a NEW action revision, so it must ' +
        'carry the action it authorized; without it the decision would release the revision a human ' +
        'explicitly replaced (implement/04 §4.2 step 4).',
    );
  }

  if (input.decision !== 'MODIFIED' && input.decision !== 'APPROVED' && authorized !== null) {
    throw new Error(
      `APPROVAL_DECISION_ACTION_MISMATCH: a ${input.decision} decision authorizes no action, so it ` +
        'must not carry one; an approval authorizes exactly one prepared command ' +
        '(implement/04 §4.2 step 4).',
    );
  }

  return {
    tenant_id: input.tenant_id,
    run_id: input.run_id,
    approval_id,
    effect_key,
    reviewed_digest,
    decision: input.decision,
    operator_id: input.operator_id,
    review_comment,
    authorized,
    ...(input.expected_task_version === undefined ? {} : { expected_task_version: input.expected_task_version }),
    ...(input.lease_owner === undefined ? {} : { lease_owner: input.lease_owner }),
    ...(input.expected_resume_event === undefined ? {} : { expected_resume_event: input.expected_resume_event }),
  };
}
function prepareQueueDecision(input: QueueApprovalDecisionInput): PreparedQueueDecision {
  assertIdentifier(input.tenant_id, 'tenant_id', 36, 'APPROVAL_TENANT_ID_REQUIRED');
  assertIdentifier(input.run_id, 'run_id', 64, 'APPROVAL_RUN_ID_REQUIRED');
  const approval_id = assertUuid(input.approval_id, 'approval_id', 'APPROVAL_ID_INVALID');
  const effect_key = readIdentifier(
    input.effect_key,
    'effect_key',
    128,
    'APPROVAL_EFFECT_KEY_REQUIRED',
  );
  const reviewed_digest = normalizeDigest(
    input.expected_payload_sha256,
    'APPROVAL_DIGEST_INVALID',
    'the operator reviewed',
  );
  assertIdentifier(input.operator_id, 'operator_id', 128, 'APPROVAL_OPERATOR_REQUIRED');
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
    throw new Error('APPROVAL_REASON_REQUIRED: every queued decision must carry a non-empty reason.');
  }

  let event_type: string;
  switch (input.decision) {
    case 'APPROVE':
      event_type = 'human.approval';
      break;
    case 'REJECT':
      event_type = 'human.reject';
      break;
    case 'MODIFY':
      event_type = 'human.modify';
      break;
    case 'PAUSE':
      event_type = 'human.pause';
      break;
    case 'CANCEL':
      event_type = 'human.cancel';
      break;
    default:
      throw new Error('APPROVAL_DECISION_INVALID: the queued decision is outside the five-value route.');
  }

  if (input.decision === 'MODIFY') {
    if (!isPlainObject(input.modified_payload)) {
      throw new Error('MODIFICATION_REQUIRED: MODIFY requires a JSON object of payload modifications.');
    }
  } else if (input.modified_payload !== undefined) {
    throw new Error('APPROVAL_DECISION_ACTION_MISMATCH: modified_payload is only valid for MODIFY.');
  }

  const resume_event: Record<string, unknown> = {
    tenant_id: input.tenant_id,
    run_id: input.run_id,
    effect_key,
    event_type,
    approval_id,
    expected_payload_sha256: reviewed_digest,
    operator_id: input.operator_id,
    reason: input.reason,
    ...(input.modified_payload === undefined ? {} : { modifications: input.modified_payload }),
  };

  return {
    tenant_id: input.tenant_id,
    run_id: input.run_id,
    approval_id,
    effect_key,
    reviewed_digest,
    decision: input.decision,
    operator_id: input.operator_id,
    reason: input.reason,
    resume_event,
  };
}

/** Publishes the row of an approval `UPDATE` whose predicate was verified against a locked row. */
function assertApprovalRow(result: QueryResult<ApprovalRow>, approval_id: string): ApprovalRecord {
  const [row] = result.rows;

  if (row === undefined) {
    throw new Error(
      `APPROVAL_WRITE_LOST: the decision of approval ${approval_id} matched no row while the row was ` +
        'locked and still PENDING; refusing to report a decision that was not persisted ' +
        '(implement/04 §4.2 statement 4).',
    );
  }

  return toApprovalRecord(row);
}

/* ------------------------------------------------------------------------------------------------
 * The console reads (implement/06 §8.1.3 R14, §8.2.1)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Parses the keyset cursor of `listPending()`.
 *
 * A cursor is `<created_at>|<approval_id>`, and both halves are validated in the strictest form this
 * module publishes: the instant must be exactly the canonical ISO-8601 UTC string of the row this
 * module handed out, and the identity must be its UUID. Anything else is refused rather than applied
 * as a "close enough" bound, because a wrong bound silently skips or repeats PENDING rows
 * (`06` §8.1.3 R14).
 *
 * @param cursor Candidate cursor, as handed back by a client.
 * @returns The `(created_at, approval_id)` pair the next page resumes strictly after.
 * @throws Error `APPROVAL_CURSOR_INVALID` when the cursor is not one this module published.
 */
function parsePendingCursor(
  cursor: unknown,
): { readonly created_at: string; readonly approval_id: string } {
  const separator = typeof cursor === 'string' ? cursor.indexOf(CURSOR_SEPARATOR) : -1;
  const created_at_text = separator < 0 ? '' : (cursor as string).slice(0, separator);
  const approval_id = separator < 0 ? '' : (cursor as string).slice(separator + 1);
  const created_at = new Date(created_at_text);

  if (
    separator < 0 ||
    Number.isNaN(created_at.getTime()) ||
    created_at.toISOString() !== created_at_text ||
    !UUID.test(approval_id)
  ) {
    throw new Error(
      `APPROVAL_CURSOR_INVALID: ${String(cursor)} is not a queue cursor; a cursor is ` +
        '`<created_at>|<approval_id>`, carrying the canonical ISO-8601 UTC instant and the UUID of ' +
        'the row the previous page ended on (implement/06 §8.1.3 R14).',
    );
  }

  return { created_at: created_at_text, approval_id };
}

/**
 * Publishes the action one approval authorizes out of the actions a read returned.
 *
 * `approvals.action_id` is a tenant-scoped foreign key onto `actions (tenant_id, id)`
 * (`migrations/0001_tenant_scoped_fks.sql`), so an approval this tenant can read always names an
 * action of the same tenant, and a read that cannot see it means the two halves of the binding do
 * not agree: publishing the item without its command would show a gate nothing can be released
 * through, so it is refused instead (implement/03 §1 DOMAIN 5).
 *
 * @param actions Actions the read returned, keyed by id.
 * @param action_id Identity the approval binds.
 * @returns The action row of that identity.
 * @throws Error `APPROVAL_ACTION_MISSING` when the bound action is not visible in this tenant.
 */
function requireAction(
  actions: ReadonlyMap<string, ActionRecord>,
  action_id: string,
): ActionRecord {
  const action = actions.get(action_id);

  if (action === undefined) {
    throw new Error(
      `APPROVAL_ACTION_MISSING: action ${action_id} is not visible in the tenant whose approval ` +
        'binding names it, so the item cannot be published with the command it authorizes ' +
        '(implement/03 §1 DOMAIN 5).',
    );
  }

  return action;
}

/**
 * The AUTH-4 pause and the human decision (`agentos.approvals`, `agentos.actions`).
 *
 * The surface is the approval half of `IStatefulWorkflowEngine`: `pauseForApproval()` opens the
 * gate, `claimApprovalAndResume()` decides it and moves the task. Both are idempotent where
 * idempotence is safe - a repeated pause of the same effect revision returns the row it already
 * committed instead of inserting a second authorization, and a repeated decision is refused
 * because a one-time authorization is never consumed twice. The two console reads, `getDetail()`
 * (`06` §8.2.1) and `listPending()` (`06` §8.1.3 R14), expose the same rows without
 * locking or writing anything, so SCR-003 renders the bytes a decision would be compared against.
 *
 * Every method opens exactly one tenant-scoped transaction through `withTenantContext`, locks the
 * task first and writes `actions`/`approvals` only after it, and restates `task_version` as the
 * compare-and-increment base of the pause, the hold, the resume and the stop.
 */
export class ApprovalRepository {
  private readonly runInTenantTransaction: TenantTransactionRunner;

  /**
   * @param runInTenantTransaction Binds a tenant to the transaction every statement runs in.
   * Defaults to the package's `withTenantContext` binder.
   */
  constructor(runInTenantTransaction: TenantTransactionRunner = withTenantContext) {
    this.runInTenantTransaction = runInTenantTransaction;
  }

  /**
   * Reads one approval with the action it authorizes (implement/06 §8.2.1 SCR-003 detail read).
   *
   * The row is read by `(tenant_id, id)` inside one tenant-scoped transaction, so an id of another
   * tenant matches no row for the predicate and no row for row-level security alike: the caller
   * reads `null` and the route answers `404`, never a redacted success. `payload_sha256` is derived
   * from the stored `payload` exactly as `claimApprovalAndResume()` derives it, so the digest the
   * operator reviews is the digest the decision compares.
   *
   * Nothing is locked and nothing is written - not even for the item's `PENDING` state - so this
   * read of the console never blocks the resume path and never moves a row.
   *
   * @param tenant_id Tenant whose approval is read; also enforced by row-level security.
   * @param approval_id The `approvals.id` of the queue item.
   * @returns The approval with its action, or `null` when this tenant holds no such row.
   * @throws Error `APPROVAL_TENANT_ID_REQUIRED` when the tenant is blank or padded.
   * @throws Error `APPROVAL_ID_INVALID` when the id is not a UUID.
   * @throws Error `APPROVAL_ACTION_MISSING` when the bound action is not visible in this tenant.
   */
  async getDetail(tenant_id: string, approval_id: string): Promise<ApprovalDetailRecord | null> {
    assertIdentifier(tenant_id, 'tenant_id', 36, 'APPROVAL_TENANT_ID_REQUIRED');
    const id = assertUuid(approval_id, 'approval_id', 'APPROVAL_ID_INVALID');

    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<ApprovalRow>(SELECT_APPROVAL, [tenant_id, id]);
      const [row] = result.rows;

      if (row === undefined) {
        return null;
      }

      const approval = toApprovalRecord(row);
      const actions = await this.readActionsByIds(client, tenant_id, [approval.action_id]);

      return { approval, action: requireAction(actions, approval.action_id) };
    });
  }

  /**
   * Reads one page of the PENDING approval queue, oldest first (implement/06 §8.1.3 R14).
   *
   * The page is the `approval_queue` projection of implement/03 §1 DOMAIN 5 read from the canonical
   * `approvals` row, so the console and the resume path can never disagree about what is waiting: the
   * predicate is `decision = 'PENDING'` alone, which keeps a paused-but-undecided item in the queue
   * exactly once (`is_paused` set, `status` still `PENDING`) and drops a row the moment a human
   * decides it. Ordering and paging are by `(created_at, id)`, the durable ordering key of the queue;
   * the cursor resumes strictly after the last row of the previous page, and the page is read with
   * one row more than requested so `next_cursor` is `null` exactly at the end of the queue.
   *
   * A tenant with no PENDING row reads an empty page instead of a fabricated item, and a tenant that
   * is not the caller's binds a different transaction, so another tenant's queue is out of scope by
   * predicate and by row-level security alike.
   *
   * @param input Tenant, page size (default 50, maximum 200) and the resume cursor.
   * @returns The page, oldest first, each item carrying the action the approval authorizes.
   * @throws Error `APPROVAL_TENANT_ID_REQUIRED` when the tenant is blank or padded.
   * @throws Error `APPROVAL_LIMIT_INVALID` when `limit` is not an integer in 1..200.
   * @throws Error `APPROVAL_CURSOR_INVALID` when the cursor is not one this module published.
   * @throws Error `APPROVAL_ACTION_MISSING` when a listed approval's action is not visible.
   */
  async listPending(input: ApprovalListInput): Promise<ApprovalQueuePage> {
    assertIdentifier(input.tenant_id, 'tenant_id', 36, 'APPROVAL_TENANT_ID_REQUIRED');
    const limit = input.limit === undefined ? DEFAULT_PENDING_LIMIT : input.limit;

    if (
      typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_PENDING_LIMIT
    ) {
      throw new Error(
        `APPROVAL_LIMIT_INVALID: limit must be an integer between 1 and ${MAX_PENDING_LIMIT} ` +
          `(default ${DEFAULT_PENDING_LIMIT}); received ${String(input.limit)}.`,
      );
    }

    const cursor = input.cursor === undefined ? null : parsePendingCursor(input.cursor);

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<ApprovalRow>(SELECT_PENDING_APPROVALS, [
        input.tenant_id,
        cursor === null ? null : cursor.created_at,
        cursor === null ? null : cursor.approval_id,
        limit + 1,
      ]);
      const rows = result.rows.slice(0, limit);
      const last = rows[rows.length - 1];

      if (last === undefined) {
        return { items: [], next_cursor: null };
      }

      const actions = await this.readActionsByIds(
        client,
        input.tenant_id,
        rows.map((row) => row.action_id),
      );

      return {
        items: rows.map((row) => {
          const approval = toApprovalRecord(row);

          return { approval, action: requireAction(actions, approval.action_id) };
        }),
        next_cursor:
          result.rows.length > limit
            ? `${last.created_at.toISOString()}${CURSOR_SEPARATOR}${last.id}`
            : null,
      };
    });
  }

  /**
   * Pauses a running task on ONE PENDING AUTH-4 approval (implement/04 §4.2 statement 3).
   *
   * One transaction commits three things or none: the `actions` row of the prepared command, the
   * PENDING `approvals` row that binds it (`(tenant_id, run_id, action_id, effect_key, payload)`),
   * and the task parked in `awaiting_human` with its pointer set and its COMPLETE checkpoint stored.
   * The lock order is task -> action -> approval, so a concurrent writer of the same run serializes
   * instead of deadlocking, and `ON CONFLICT (tenant_id, effect_key) DO NOTHING` makes the binding
   * exactly-once: a redelivered pause reads back the row it collided with, and a row that was
   * already decided is never reopened.
   *
   * @param input Tenant, run, expected task version, complete checkpoint and the approval binding.
   * @returns The durable approval id with the rows the pause committed.
   * @throws Error `DURABLE_TASK_NOT_FOUND` when this tenant holds no task for the run.
   * @throws Error `TASK_PAUSE_REQUIRES_RUNNING` when the task is terminal or already parked on
   *   another approval.
   * @throws Error `APPROVAL_BINDING_MISMATCH` when approval, action and task do not describe one binding.
   * @throws Error `APPROVAL_ALREADY_DECIDED` when the effect revision already carries a decided row.
   * @throws Error `ACTION_EFFECT_KEY_CONFLICT` when the effect key already names another action.
   */
  async pauseForApproval(input: PauseForApprovalInput): Promise<PauseForApprovalResult> {
    const prepared = preparePause(input);

    return this.runInTenantTransaction(prepared.tenant_id, async (client) => {
      const task = await lockDurableTask(client, prepared.tenant_id, prepared.run_id);

      if (task === null) {
        throw new Error(
          'DURABLE_TASK_NOT_FOUND: this tenant holds no durable task for the run, so there is no ' +
            'run to park; the approval gate parks the schedule of record, never a task that was ' +
            'never created (implement/04 §4.2).',
        );
      }

      if (task.state === 'awaiting_human') {
        return this.replayPauseWithin(client, prepared, task);
      }

      if (task.state !== 'running') {
        throw new Error(
          `TASK_PAUSE_REQUIRES_RUNNING: run ${prepared.run_id} is ${task.state}; only the worker ` +
            'that holds the run may park it, so a pause that is not issued from a running task is ' +
            'refused instead of parking a closed or queued row (implement/04 §4.2 statement 3).',
        );
      }

      const base_version = assertGuard(task, {
        expected_task_version: input.expected_task_version,
      });
      const action = await this.insertActionWithin(client, prepared);
      const approval = await this.insertApprovalWithin(client, prepared, action);
      const parked = assertSingleRow(
        await client.query<DurableTaskRow>(PAUSE_TASK, [
          prepared.tenant_id,
          prepared.run_id,
          approval.id,
          prepared.checkpoint,
          base_version,
        ]),
        prepared.run_id,
      );

      return { approval_id: approval.id, approval, action, task: parked };
    });
  }

  /**
   * The redelivered pause: the task is already parked, so the transaction reads the binding back
   * instead of writing a second authorization.
   *
   * The replay is only accepted when the parked task points at the approval of THIS effect revision
   * and that row still binds the same payload digest; anything else means the run is parked on
   * another decision and is refused, because two pauses over one run would leave two rows able to
   * resume it.
   */
  private async replayPauseWithin(
    client: PoolClient,
    prepared: PreparedPause,
    task: DurableTaskRecord,
  ): Promise<PauseForApprovalResult> {
    const action = await this.lockActionByEffectKey(
      client,
      prepared.tenant_id,
      prepared.effect_key,
    );
    const approval = await this.lockApprovalByEffectKey(
      client,
      prepared.tenant_id,
      prepared.effect_key,
    );

    if (action === null || approval === null) {
      throw new Error(
        `TASK_PAUSE_RESUME_REQUIRES_DECISION: run ${prepared.run_id} is parked in awaiting_human on ` +
          `approval ${String(task.paused_for_approval_id)}, but effect_key ${prepared.effect_key} ` +
          'has no matching approval row in this tenant; the run can only leave the gate through ' +
          'the decision it names (implement/04 §4.2 statement 4).',
      );
    }

    if (approval.decision !== 'PENDING') {
      throw new Error(
        `APPROVAL_ALREADY_DECIDED: effect_key ${prepared.effect_key} carries decision ` +
          `${approval.decision}; a decided authorization is spent and is never reopened by a ` +
          'second pause (implement/04 §4.2).',
      );
    }

    if (
      approval.run_id !== prepared.run_id ||
      approval.action_id !== action.id ||
      action.id !== prepared.action_id
    ) {
      throw new Error(
        `APPROVAL_BINDING_MISMATCH: approval ${approval.id} binds run ${approval.run_id} to action ` +
          `${approval.action_id}, which is not run ${prepared.run_id} / action ${prepared.action_id}; ` +
          'refusing to park the run on another binding (implement/04 §4.2 statement 3).',
      );
    }

    if (approval.payload_sha256 !== prepared.payload_sha256) {
      throw new Error(
        'APPROVAL_BINDING_MISMATCH: the pending approval of effect_key ' +
          `${prepared.effect_key} binds a different payload than the one this pause presents for ` +
          'the same revision; one revision carries one reviewed payload (implement/08 §4.2).',
      );
    }

    if (task.paused_for_approval_id !== approval.id) {
      throw new Error(
        `TASK_PAUSE_RESUME_REQUIRES_DECISION: run ${prepared.run_id} is parked on approval ` +
          `${String(task.paused_for_approval_id)}, not on ${approval.id}; a second approval must ` +
          'not claim a park it did not create (implement/04 §4.2 statement 4).',
      );
    }

    return { approval_id: approval.id, approval, action, task };
  }

  /**
   * Inserts the prepared command, or reads the row the deterministic key already names.
   *
   * `(tenant_id, effect_key)` is the identity of one effect revision, so losing the insert means an
   * action for that identity already exists: it is reused only when it is the same action, revision
   * and payload, and refused otherwise (`ACTION_EFFECT_KEY_CONFLICT`) - a second command under one
   * effect key would make the dispatch guard's "one key, one effect" guarantee meaningless.
   */
  private async insertActionWithin(
    client: PoolClient,
    prepared: PreparedPause,
  ): Promise<ActionRecord> {
    let inserted: ActionRow | undefined;

    try {
      const result = await client.query<ActionRow>(INSERT_ACTION, [
        prepared.action_id,
        prepared.tenant_id,
        prepared.skill_name,
        prepared.effect_key,
        prepared.action_revision,
        prepared.target_channel,
        prepared.payload,
      ]);

      [inserted] = result.rows;
    } catch (error) {
      if (sqlState(error) === '23505') {
        throw new Error(
          `ACTION_ID_IN_USE: action ${prepared.action_id} is already bound to another effect_key in ` +
            'this tenant (actions_pkey); an action id identifies one prepared command and is never ' +
            'reused for a second effect (implement/03 §1 DOMAIN 5).',
          { cause: error },
        );
      }

      throw error;
    }

    if (inserted !== undefined) {
      return toActionRecord(inserted);
    }

    const existing = await this.lockActionByEffectKey(
      client,
      prepared.tenant_id,
      prepared.effect_key,
    );

    if (existing === null) {
      throw new Error(
        `APPROVAL_ACTION_UNSTABLE: effect_key ${prepared.effect_key} was reported as taken by the ` +
          'insert but no action row is visible in this transaction; refusing to park a run on a ' +
          'command that cannot be read back (implement/04 §4.2).',
      );
    }

    if (
      existing.id !== prepared.action_id ||
      existing.action_revision !== prepared.action_revision ||
      sha256CanonicalJson(existing.action_payload) !== prepared.payload_sha256
    ) {
      throw new Error(
        `ACTION_EFFECT_KEY_CONFLICT: effect_key ${prepared.effect_key} already names action ` +
          `${existing.id} (revision ${existing.action_revision}) with a different payload; a ` +
          'deterministic key that maps two commands would let a replay dispatch the wrong one ' +
          '(BR-005).',
      );
    }

    return existing;
  }

  /**
   * Inserts the PENDING approval, or reads the row the effect revision already carries.
   *
   * The conflict path is the "one approval per effect revision" rule: the existing row is reused
   * only while it is still PENDING and still bound to this run, action and payload digest. A decided
   * row is refused (`APPROVAL_ALREADY_DECIDED`) because the authorization it recorded has been
   * consumed, and a row bound to another run is refused rather than repointed.
   */
  private async insertApprovalWithin(
    client: PoolClient,
    prepared: PreparedPause,
    action: ActionRecord,
  ): Promise<ApprovalRecord> {
    const result = await client.query<ApprovalRow>(INSERT_APPROVAL, [
      prepared.tenant_id,
      prepared.run_id,
      action.id,
      prepared.effect_key,
      prepared.payload,
      prepared.reason,
    ]);
    const [inserted] = result.rows;

    if (inserted !== undefined) {
      return toApprovalRecord(inserted);
    }

    const existing = await this.lockApprovalByEffectKey(
      client,
      prepared.tenant_id,
      prepared.effect_key,
    );

    if (existing === null) {
      throw new Error(
        `APPROVAL_UNSTABLE: effect_key ${prepared.effect_key} was reported as taken by the insert ` +
          'but no approval row is visible in this transaction; refusing to park a run on an ' +
          'authorization that cannot be read back (implement/04 §4.2 statement 3).',
      );
    }

    if (existing.decision !== 'PENDING') {
      throw new Error(
        `APPROVAL_ALREADY_DECIDED: effect_key ${prepared.effect_key} carries decision ` +
          `${existing.decision}; an approval authorizes exactly one execution, so a decided row is ` +
          'never reopened and a second authorization is never inserted (implement/04 §4.2).',
      );
    }

    if (existing.run_id !== prepared.run_id || existing.action_id !== action.id) {
      throw new Error(
        `APPROVAL_BINDING_MISMATCH: approval ${existing.id} binds run ${existing.run_id} to action ` +
          `${existing.action_id}, which is not run ${prepared.run_id} / action ${action.id}; the ` +
          'pending row belongs to another binding and is never repointed (implement/04 §4.2).',
      );
    }

    if (existing.payload_sha256 !== prepared.payload_sha256) {
      throw new Error(
        `APPROVAL_BINDING_MISMATCH: approval ${existing.id} binds a different payload than the one ` +
          `this pause presents for effect_key ${prepared.effect_key}; one revision carries one ` +
          'reviewed payload (implement/08 §4.2).',
      );
    }

    return existing;
  }

  /** Locks and publishes the action one effect key names, or `null` when this tenant holds none. */
  private async lockActionByEffectKey(
    client: PoolClient,
    tenant_id: string,
    effect_key: string,
  ): Promise<ActionRecord | null> {
    const result = await client.query<ActionRow>(SELECT_ACTION_BY_EFFECT_KEY_FOR_UPDATE, [
      tenant_id,
      effect_key,
    ]);
    const [row] = result.rows;

    return row === undefined ? null : toActionRecord(row);
  }

  /** Locks and publishes one approval row, or `null` when this tenant holds none for that id. */
  private async lockApprovalById(
    client: PoolClient,
    tenant_id: string,
    approval_id: string,
  ): Promise<ApprovalRecord | null> {
    const result = await client.query<ApprovalRow>(SELECT_APPROVAL_FOR_UPDATE, [
      tenant_id,
      approval_id,
    ]);
    const [row] = result.rows;

    return row === undefined ? null : toApprovalRecord(row);
  }

  /** Locks the approval one effect key carries, or `null` when the tenant holds none. */
  private async lockApprovalByEffectKey(
    client: PoolClient,
    tenant_id: string,
    effect_key: string,
  ): Promise<ApprovalRecord | null> {
    const result = await client.query<ApprovalRow>(SELECT_APPROVAL_BY_EFFECT_KEY_FOR_UPDATE, [
      tenant_id,
      effect_key,
    ]);
    const [row] = result.rows;

    return row === undefined ? null : toApprovalRecord(row);
  }

  /**
   * Reads the actions a page or a detail read published, within the transaction that read the
   * approvals, so both halves of every item come from one tenant scope and one snapshot.
   *
   * The rows are keyed by id rather than joined, because `toActionRecord` reads the action
   * projection in its own order and a joined row would have to restate every column of both halves.
   */
  private async readActionsByIds(
    client: PoolClient,
    tenant_id: string,
    action_ids: readonly string[],
  ): Promise<ReadonlyMap<string, ActionRecord>> {
    const result = await client.query<ActionRow>(SELECT_ACTIONS_BY_IDS, [tenant_id, action_ids]);

    return new Map(
      result.rows.map((row): [string, ActionRecord] => [row.id, toActionRecord(row)]),
    );
  }
  /**
   * Persists one authenticated approval decision as a durable resume event. The approval remains
   * PENDING until the worker has acquired the task lease and the core has rechecked policy and
   * takeover state; this method never consumes human authorization from the API process.
   */
  async queueDecision(input: QueueApprovalDecisionInput): Promise<QueueApprovalDecisionResult> {
    const prepared = prepareQueueDecision(input);

    return this.runInTenantTransaction(prepared.tenant_id, async (client) => {
      const task = await lockDurableTask(client, prepared.tenant_id, prepared.run_id);
      if (task === null) {
        throw new Error('DURABLE_TASK_NOT_FOUND: this tenant holds no durable task for the run.');
      }
      if (task.state !== 'awaiting_human') {
        throw new Error(
          'APPROVAL_NOT_CLAIMABLE: a decision handoff is accepted only while the task is awaiting_human.',
        );
      }
      if (task.paused_for_approval_id !== prepared.approval_id) {
        throw new Error(
          'APPROVAL_BINDING_MISMATCH: run ' + prepared.run_id + ' is not parked on approval ' + prepared.approval_id + '.',
        );
      }

      assertCompleteCheckpoint(task.state_payload);
      const action = await this.lockActionByEffectKey(
        client,
        prepared.tenant_id,
        prepared.effect_key,
      );
      if (action === null) {
        throw new Error('APPROVAL_BINDING_MISMATCH: effect_key ' + prepared.effect_key + ' has no action.');
      }

      const approval = await this.lockApprovalById(
        client,
        prepared.tenant_id,
        prepared.approval_id,
      );
      if (approval === null) {
        throw new Error('APPROVAL_NOT_FOUND: approval ' + prepared.approval_id + ' does not exist.');
      }
      if (
        approval.run_id !== prepared.run_id ||
        approval.effect_key !== prepared.effect_key ||
        approval.action_id !== action.id ||
        action.effect_key !== prepared.effect_key
      ) {
        throw new Error(
          'APPROVAL_BINDING_MISMATCH: approval ' + approval.id + ' does not match run ' +
            prepared.run_id + ', action ' + action.id + ' and effect_key ' + prepared.effect_key + '.',
        );
      }
      if (approval.decision !== 'PENDING') {
        throw new Error(
          'APPROVAL_NOT_CLAIMABLE: approval ' + approval.id + ' is already ' + approval.decision + '.',
        );
      }
      if (approval.payload_sha256 !== prepared.reviewed_digest) {
        throw new Error(
          'APPROVAL_STALE_PAYLOAD: approval ' + approval.id + ' now binds a different reviewed payload.',
        );
      }

      const checkpoint = task.state_payload;
      if (!isPlainObject(checkpoint)) {
        throw new Error('CHECKPOINT_INCOMPLETE: the approval task checkpoint is not a JSON object.');
      }
      const existingEvent = checkpoint['resume_event'];
      if (existingEvent !== undefined) {
        if (
          !isPlainObject(existingEvent) ||
          canonicalizeJson(existingEvent) !== canonicalizeJson(prepared.resume_event)
        ) {
          throw new Error(
            'APPROVAL_DECISION_CONFLICT: a different authenticated decision is already queued for this approval.',
          );
        }
        return {
          approval_id: approval.id,
          task_id: task.task_id,
          status: 'QUEUED',
          queued_at: task.updated_at,
        };
      }

      const payload = serializeJsonb(
        { ...checkpoint, resume_event: prepared.resume_event },
        'APPROVAL_CHECKPOINT_UNSERIALIZABLE',
      );
      const queued = assertSingleRow(
        await client.query<DurableTaskRow>(QUEUE_APPROVAL_RESUME_EVENT, [
          prepared.tenant_id,
          prepared.run_id,
          payload,
          task.task_version,
          prepared.approval_id,
        ]),
        prepared.run_id,
      );

      return {
        approval_id: approval.id,
        task_id: queued.task_id,
        status: 'QUEUED',
        queued_at: queued.updated_at,
      };
    });
  }

  /**
   * Decides one parked approval and moves the task it parked (implement/04 §4.2 statement 4).
   *
   * The transaction locks the task, the action and the approval before anything is decided, then
   * requires the exact binding - the run, the effect key, the action, and a still-PENDING row (a
   * decision is single-use, so `decided_at IS NULL` is the whole claim) - and recomputes SHA-256
   * over the RFC 8785 canonical `approvals.payload` to compare it with the digest the operator
   * reviewed. A mismatch is `APPROVAL_STALE_PAYLOAD` and NO write happens: the reviewed revision is
   * gone, so the decision must be re-reviewed rather than applied to bytes nobody read.
   *
   * The decision then writes once: `decided_at`, `operator_id`, `review_comment`, `is_paused =
   * FALSE`, and - for MODIFIED - the new revision of `actions` and the new binding of `approvals`.
   * The task moves to `running` for APPROVED/MODIFIED and to `stopped` for REJECTED/CANCELLED, and
   * PAUSE keeps the row PENDING and the task `awaiting_human` while writing `is_paused` alone.
   *
   * @param input Tenant, run, approval, effect key, reviewed digest, authorized action and decision.
   * @returns The decided rows and the task they moved, with `claimed: true`.
   * @throws Error `DURABLE_TASK_NOT_FOUND` when this tenant holds no task for the run.
   * @throws Error `APPROVAL_NOT_CLAIMABLE` when the task is not parked, the row is decided, or a
   *   PAUSE is repeated.
   * @throws Error `APPROVAL_BINDING_MISMATCH` when the claim does not name the row the task is parked on.
   * @throws Error `APPROVAL_NOT_FOUND` when the approval row does not exist.
   * @throws Error `APPROVAL_STALE_PAYLOAD` when the stored payload is not the reviewed digest.
   * @throws Error `MODIFICATION_REQUIRED` / `APPROVAL_REVISION_INVALID` for a MODIFIED decision whose
   *   revision does not advance exactly one step, or whose identity changed.
   * @throws Error `APPROVAL_ACTION_DISPATCHED` when the revision being replaced was already dispatched.
   */
  async claimApprovalAndResume(
    input: ClaimApprovalAndResumeInput,
  ): Promise<ClaimApprovalAndResumeResult> {
    const prepared = prepareClaim(input);

    return this.runInTenantTransaction(prepared.tenant_id, async (client) => {
      const task = await lockDurableTask(client, prepared.tenant_id, prepared.run_id);

      if (task === null) {
        throw new Error(
          'DURABLE_TASK_NOT_FOUND: this tenant holds no durable task for the run, so there is no ' +
            'parked schedule of record to release (implement/04 §4.2).',
        );
      }

      if (task.state !== 'awaiting_human') {
        throw new Error(
          `APPROVAL_NOT_CLAIMABLE: run ${prepared.run_id} is ${task.state}, not awaiting_human; a ` +
            'decision is claimable only while the run is parked on the gate it decides, so a claim ' +
            'against a released, requeued or closed run is refused (implement/04 §4.2 statement 4).',
        );
      }

      if (task.paused_for_approval_id !== prepared.approval_id) {
        throw new Error(
          `APPROVAL_BINDING_MISMATCH: run ${prepared.run_id} is parked on approval ` +
            `${String(task.paused_for_approval_id)}, not on ${prepared.approval_id}; the decision ` +
            'must name the approval the task waits for (implement/04 §4.2 statement 4).',
        );
      }
      if (prepared.lease_owner !== undefined) {
        assertLeaseHeld(task, prepared.lease_owner);
        if (task.task_version !== prepared.expected_task_version) {
          throw new Error('TASK_VERSION_CONFLICT: the approval claim read a stale task version.');
        }
        const taskPayload = isPlainObject(task.state_payload) ? task.state_payload : null;
        const currentEvent = taskPayload?.['resume_event'];
        if (
          !isPlainObject(currentEvent) ||
          prepared.expected_resume_event === undefined ||
          canonicalizeJson(currentEvent) !== canonicalizeJson(prepared.expected_resume_event)
        ) {
          throw new Error(
            'APPROVAL_RESUME_EVENT_CONFLICT: the worker claim does not match the exact durable decision event.',
          );
        }
      }

      const action = await this.lockActionByEffectKey(
        client,
        prepared.tenant_id,
        prepared.effect_key,
      );

      if (action === null) {
        throw new Error(
          `APPROVAL_BINDING_MISMATCH: effect_key ${prepared.effect_key} addresses no action in this ` +
            'tenant, so the approval authorizes a command that is not there (implement/04 §4.2).',
        );
      }

      const approval = await this.lockApprovalById(
        client,
        prepared.tenant_id,
        prepared.approval_id,
      );

      if (approval === null) {
        throw new Error(
          `APPROVAL_NOT_FOUND: this tenant holds no approval ${prepared.approval_id}; a decision is ` +
            'made against the durable row, never against a ticket the queue no longer carries ' +
            '(implement/03 §1 DOMAIN 5).',
        );
      }

      if (
        approval.run_id !== prepared.run_id ||
        approval.effect_key !== prepared.effect_key ||
        approval.action_id !== action.id ||
        action.effect_key !== prepared.effect_key
      ) {
        throw new Error(
          `APPROVAL_BINDING_MISMATCH: approval ${approval.id} binds run ${approval.run_id}, action ` +
            `${approval.action_id} and effect_key ${approval.effect_key}, which is not run ` +
            `${prepared.run_id}, action ${action.id} and effect_key ${prepared.effect_key}; the ` +
            'one-time authorization releases exactly the binding it recorded (implement/04 §4.2).',
        );
      }

      if (approval.decision !== 'PENDING') {
        throw new Error(
          `APPROVAL_NOT_CLAIMABLE: approval ${approval.id} is ${approval.decision} since ` +
            `${String(approval.decided_at)}; a decision is single-use and a decided row is never ` +
            'claimed twice (implement/04 §4.2 statement 4).',
        );
      }

      if (approval.payload_sha256 !== prepared.reviewed_digest) {
        throw new Error(
          `APPROVAL_STALE_PAYLOAD: approval ${approval.id} now binds payload digest ` +
            `${approval.payload_sha256} while the operator reviewed ${prepared.reviewed_digest}; ` +
            'the reviewed revision is gone, so the decision is refused without writing anything ' +
            '(implement/04 §4.2 statement 4).',
        );
      }

      switch (prepared.decision) {
        case 'PAUSE':
          return this.holdWithin(client, prepared, task, action, approval);
        case 'APPROVED':
        case 'REJECTED':
        case 'CANCELLED':
          return this.decideWithin(client, prepared, task, action, approval, prepared.decision);
        case 'MODIFIED':
          return this.modifyWithin(client, prepared, task, action);
      }
    });
  }

  /**
   * PAUSE: keep the PENDING approval and parked task, then consume the worker handoff lease/event.
   */
  private async holdWithin(
    client: PoolClient,
    prepared: PreparedClaim,
    task: DurableTaskRecord,
    action: ActionRecord,
    approval: ApprovalRecord,
  ): Promise<ClaimApprovalAndResumeResult> {
    if (approval.is_paused) {
      throw new Error(
        'APPROVAL_NOT_CLAIMABLE: approval ' + approval.id + ' is already paused; a repeated pause is refused.',
      );
    }

    const paused = assertApprovalRow(
      await client.query<ApprovalRow>(PAUSE_APPROVAL, [
        prepared.tenant_id,
        prepared.approval_id,
      ]),
      prepared.approval_id,
    );
    const held = assertSingleRow(
      await client.query<DurableTaskRow>(HOLD_TASK, [
        prepared.tenant_id,
        prepared.run_id,
        prepared.approval_id,
        task.task_version,
      ]),
      prepared.run_id,
    );

    return { claimed: true, approval: paused, action, task: held };
  }

  /**
   * APPROVED / REJECTED / CANCELLED: one decision, one terminal write.
   *
   * APPROVED persists the unchanged authorized action - the revision the operator read is the
   * revision that resumes, so the action row is not touched - while REJECTED and CANCELLED
   * authorize nothing and stop the run. When an APPROVED decision carries the action it authorized,
   * that action must be the very binding the row holds, down to the reviewed payload digest.
   */
  private async decideWithin(
    client: PoolClient,
    prepared: PreparedClaim,
    task: DurableTaskRecord,
    action: ActionRecord,
    approval: ApprovalRecord,
    decision: Exclude<ApprovalDecision, 'PAUSE' | 'MODIFIED'>,
  ): Promise<ClaimApprovalAndResumeResult> {
    if (decision === 'APPROVED' && prepared.authorized !== null) {
      const authorized = prepared.authorized;

      if (authorized.action_id !== action.id || authorized.effect_key !== approval.effect_key) {
        throw new Error(
          `APPROVAL_BINDING_MISMATCH: the approved action ${authorized.action_id} / ` +
            `${authorized.effect_key} is not the binding of approval ${approval.id} ` +
            `(${action.id} / ${approval.effect_key}); an approval releases the prepared command it ` +
            'was reviewed against (implement/04 §4.2 statement 4).',
        );
      }

      if (sha256CanonicalJson(authorized.payload) !== prepared.reviewed_digest) {
        throw new Error(
          'APPROVAL_BINDING_MISMATCH: the payload of the approved action is not the payload the ' +
            `operator reviewed (${prepared.reviewed_digest}); an approval authorizes the bytes that ` +
            'were read back, never a payload that arrived with the decision (implement/08 §4.2).',
        );
      }
    }

    const decided = assertApprovalRow(
      await client.query<ApprovalRow>(DECIDE_APPROVAL, [
        prepared.tenant_id,
        prepared.approval_id,
        decision,
        prepared.operator_id,
        prepared.review_comment,
      ]),
      prepared.approval_id,
    );

    const moved = assertSingleRow(
      await client.query<DurableTaskRow>(decision === 'APPROVED' ? RESUME_TASK : STOP_TASK, [
        prepared.tenant_id,
        prepared.run_id,
        task.task_version,
      ]),
      prepared.run_id,
    );

    return { claimed: true, approval: decided, action, task: moved };
  }

  /**
   * MODIFIED: the operator authorizes a NEW revision of the same action, in place.
   *
   * The decision must preserve everything that identifies the command - tenant, run, action,
   * skill, channel, step and inbound `request_id` - and change exactly two things: the payload and
   * the revision. The revision advances one step from the draft the pause stored (the column stores
   * it one higher, see `PAUSED_ACTION_REVISION_OFFSET`), a revision that did not move is refused
   * instead of being reported as a modification, and a revised revision must derive a different
   * deterministic key because the key IS the identity of the revision.
   *
   * The old revision must still be `pending`: the reservation is only created at dispatch, which
   * happens after the gate, so a `pending` action row is the durable proof that the replaced
   * revision never left the platform. The action, the approval and the task's checkpoint move in one
   * transaction, so a later resume reads the authorized revision rather than the reviewed one.
   */
  private async modifyWithin(
    client: PoolClient,
    prepared: PreparedClaim,
    task: DurableTaskRecord,
    action: ActionRecord,
  ): Promise<ClaimApprovalAndResumeResult> {
    const authorized = prepared.authorized;

    if (authorized === null) {
      throw new Error(
        'MODIFICATION_REQUIRED: a MODIFIED decision authorizes a new action revision and cannot be ' +
          'applied without it (implement/04 §4.2 step 4).',
      );
    }

    const checkpoint: unknown = task.state_payload;
    assertCompleteCheckpoint(checkpoint);

    const base = readActionDraft(
      checkpoint['pending_action'],
      "the checkpoint's pending_action",
    );
    assertAuthorityBinding(base, "the checkpoint's pending_action");

    if (action.status !== 'pending') {
      throw new Error(
        `APPROVAL_ACTION_DISPATCHED: action ${action.id} is ${action.status}; a revision that was ` +
          'already authorized or dispatched - or whose outcome is unknown - is never replaced, ' +
          'because the effect it may have caused cannot be revised (implement/04 §4.2 step 4).',
      );
    }

    if (
      authorized.action_id !== base.action_id ||
      authorized.tenant_id !== prepared.tenant_id ||
      authorized.run_id !== prepared.run_id
    ) {
      throw new Error(
        `APPROVAL_BINDING_MISMATCH: the modified revision names action ${authorized.action_id} of ` +
          `tenant ${authorized.tenant_id} run ${authorized.run_id}, which is not the paused action ` +
          `${base.action_id} of tenant ${prepared.tenant_id} run ${prepared.run_id}; a MODIFY ` +
          'revises one prepared command and never replaces it with another (implement/04 §4.2).',
      );
    }

    if (
      authorized.skill_id !== base.skill_id ||
      authorized.adapter_target !== base.adapter_target ||
      authorized.step_index !== base.step_index ||
      authorized.request_id !== base.request_id
    ) {
      throw new Error(
        'APPROVAL_IDENTITY_CHANGED: a MODIFIED decision may change the payload and the revision ' +
          'only; the skill, the target channel, the step and the immutable inbound request_id that ' +
          'the deterministic key is derived from are preserved (implement/04 §4.2 step 4).',
      );
    }

    assertAuthorityBinding(authorized, 'the authorized_action of this decision');

    if (action.action_revision !== base.action_revision + PAUSED_ACTION_REVISION_OFFSET) {
      throw new Error(
        `APPROVAL_REVISION_INVALID: the stored action is at revision ${action.action_revision} ` +
          `while the paused draft is revision ${base.action_revision}; the row and the checkpoint ` +
          'no longer describe one revision (implement/03 §1 DOMAIN 5).',
      );
    }

    if (authorized.action_revision !== base.action_revision + 1) {
      throw new Error(
        `APPROVAL_REVISION_INVALID: the modified draft is revision ${authorized.action_revision} ` +
          `while the paused revision is ${base.action_revision}; MODIFY advances the revision by ` +
          'exactly one, so a revision that did not move - or jumped - is refused instead of being ' +
          'stored as a modification (implement/04 §4.2 step 4).',
      );
    }

    if (authorized.effect_key === base.effect_key) {
      throw new Error(
        `APPROVAL_EFFECT_KEY_UNCHANGED: the modified revision reuses effect_key ` +
          `${authorized.effect_key}; the key is the identity of one revision, so a new revision ` +
          'must derive a new key rather than inherit the reserved one (BR-005).',
      );
    }

    const revision = action.action_revision + 1;
    const payload = serializeJsonb(authorized.payload, 'APPROVAL_PAYLOAD_UNSERIALIZABLE');
    let revised_action: ActionRow | undefined;
    let decided: ApprovalRecord;

    try {
      const action_result = await client.query<ActionRow>(MODIFY_ACTION, [
        prepared.tenant_id,
        action.id,
        revision,
        authorized.effect_key,
        payload,
      ]);

      [revised_action] = action_result.rows;

      decided = assertApprovalRow(
        await client.query<ApprovalRow>(MODIFY_APPROVAL, [
          prepared.tenant_id,
          prepared.approval_id,
          prepared.operator_id,
          prepared.review_comment,
          authorized.effect_key,
          payload,
        ]),
        prepared.approval_id,
      );
    } catch (error) {
      if (sqlState(error) === '23505') {
        throw new Error(
          `APPROVAL_EFFECT_KEY_CONFLICT: effect_key ${authorized.effect_key} is already bound in ` +
            'this tenant; the new revision must derive a key of its own, and a key another command ' +
            'holds would make two revisions dispatch as one (BR-005).',
          { cause: error },
        );
      }

      throw error;
    }

    if (revised_action === undefined) {
      throw new Error(
        `APPROVAL_WRITE_LOST: the revision ${revision} of action ${action.id} matched no row while ` +
          'the row was locked; refusing to report a modification that was not persisted ' +
          '(implement/04 §4.2 step 4).',
      );
    }

    const checkpointWithoutEvent = { ...checkpoint };
    delete checkpointWithoutEvent['resume_event'];
    const checkpointPayload = serializeJsonb(
      {
        ...checkpointWithoutEvent,
        pending_action: authorized,
      },
      'APPROVAL_CHECKPOINT_UNSERIALIZABLE',
    );
    const moved = assertSingleRow(
      await client.query<DurableTaskRow>(RESUME_TASK_REVISED, [
        prepared.tenant_id,
        prepared.run_id,
        checkpointPayload,
        task.task_version,
      ]),
      prepared.run_id,
    );

    return { claimed: true, approval: decided, action: toActionRecord(revised_action), task: moved };
  }
}