import type { QueryResult, QueryResultRow } from 'pg';

import { CURSOR_SEPARATOR } from './approvals.sql.js';
import { sha256CanonicalJson } from './canonical-json.js';
import {
  assertCompleteCheckpoint,
  assertIdentifier,
  assertPositiveInteger,
  isPlainObject,
  serializeJsonb,
} from './durable-workflows.js';
import type {
  ActionRecord,
  ActionStatus,
  ApprovalActionDraft,
  ApprovalDecision,
  ApprovalRecord,
  ApprovalStatus,
  ClaimApprovalAndResumeInput,
  PauseForApprovalInput,
  QueueApprovalDecisionInput,
  QueuedApprovalDecision,
} from './approvals.js';

/**
 * Bare lowercase hex SHA-256: the single accepted encoding of every digest in this schema, and the
 * only spelling `expected_payload_sha256` may arrive in.
 */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A canonical UUID: the type of `approvals.id`, `approvals.action_id` and `actions.id`. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  expires_at: Date;
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
    expires_at: row.expires_at.toISOString(),
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

export {
  assertApprovalRow,
  assertAuthorityBinding,
  assertUuid,
  parsePendingCursor,
  prepareClaim,
  preparePause,
  prepareQueueDecision,
  readActionDraft,
  requireAction,
  sqlState,
  toActionRecord,
  toApprovalRecord,
  PAUSED_ACTION_REVISION_OFFSET,
};
export type {
  ActionRow,
  ApprovalRow,
  PreparedClaim,
  PreparedPause,
  PreparedQueueDecision,
};
