import type { PoolClient, QueryResultRow } from 'pg';

import { withTenantContext } from '../rls.js';
import { AuditRepository } from './audit-evidence.js';
import {
  assertCompleteCheckpoint,
  assertGuard,
  assertIdentifier,
  assertLeaseHeld,
  assertSingleRow,
  isPlainObject,
  lockDurableTask,
  serializeJsonb,
} from './durable-workflows.js';
import type { DurableTaskRecord, DurableTaskRow } from './durable-workflows.js';
import type { TenantTransactionRunner } from './effect-reservations.js';
import { canonicalizeJson, sha256CanonicalJson } from './canonical-json.js';
export { canonicalizeJson, sha256CanonicalJson } from './canonical-json.js';
import {
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
  SELECT_ACTION_BY_EFFECT_KEY_FOR_UPDATE,
  SELECT_APPROVAL,
  SELECT_APPROVAL_BY_EFFECT_KEY_FOR_UPDATE,
  SELECT_APPROVAL_FOR_UPDATE,
  SELECT_PENDING_APPROVALS,
  STOP_TASK,
} from './approvals.sql.js';
import {
  PAUSED_ACTION_REVISION_OFFSET,
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
} from './approvals.validation.js';
import type {
  ActionRow,
  ApprovalRow,
  PreparedClaim,
  PreparedPause,
} from './approvals.validation.js';

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
 *    no write happens. The digest primitive is local (`canonicalizeJson` / `sha256CanonicalJson`)
 *    in `canonical-json.ts` because `packages/database` is a leaf of the package DAG and may not
 *    import `@agentos/core-engine`; it is byte-compatible with `durability/canonical-json.ts`, and
 *    it is exported so the console, the API route and this repository compute one digest, never
 *    three.
 *
 * `actions.action_revision` numbers revisions of the same action; see
 * `PAUSED_ACTION_REVISION_OFFSET` for how the canonical draft's zero-based revision maps onto the
 * column's one-based lattice.
 */
/**
 * The decisions the human route may store (`approvals.decision`, implement/08 §7.2). `PENDING` is
 * not among them: it is the state a row is created in, never a decision.
 */
export type ApprovalDecision = 'APPROVED' | 'MODIFIED' | 'REJECTED' | 'PAUSE' | 'CANCELLED';

/**
 * Every value `approvals.decision` accepts. `EXPIRED` is persisted by the deadline transition when a
 * pending decision crosses its bounded review window.
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
  /** Deadline after which a pending human decision is durably expired. */
  readonly expires_at: string;
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
interface ExpiredApprovalRow extends QueryResultRow {
  readonly id: string;
  readonly run_id: string;
  readonly action_id: string;
  readonly effect_key: string;
}

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
   * An expired pending deadline is persisted by the read statement: the prepared action is failed and
   * the approval is marked EXPIRED atomically, rather than synthesizing an in-memory status.
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
      const action = requireAction(actions, approval.action_id);

      return { approval, action };
    });
  }

  /**
   * Reads one page of the PENDING approval queue, oldest first (implement/06 §8.1.3 R14).
   *
   * The page is the `approval_queue` projection of implement/03 §1 DOMAIN 5 read from the canonical
   * `approvals` row, so the console and the resume path can never disagree about what is waiting: the
   * predicate is `decision = 'PENDING'` with `expires_at > CURRENT_TIMESTAMP`, and the read persists
   * expired rows as EXPIRED while failing their prepared actions. A parked-but-undecided item remains
   * in the queue exactly once (`is_paused` set, status still `PENDING`) until its deadline. Ordering
   * and paging are by `(created_at, id)`, the durable ordering key of the queue;
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
          const action = requireAction(actions, approval.action_id);
          return { approval, action };
        }),
        next_cursor:
          result.rows.length > limit
            ? `${last.created_at.toISOString()}${CURSOR_SEPARATOR}${last.id}`
            : null,
      };
    });
  }

  /**
   * Persists expired pending approvals for one tenant in bounded batches.
   *
   * The approval and its prepared action are changed first, then one append-only audit-chain event
   * is written for each returned binding. The audit repository is intentionally bound to this
   * transaction's client, so an unconfirmed audit append rolls back the expiry transition instead
   * of leaving a state change without its compliance record.
   *
   * @param tenant_id Tenant whose pending approvals are swept.
   * @param limit Maximum number of approvals to expire, between 1 and 500.
   * @returns Approval ids transitioned to EXPIRED in this transaction.
   */
  async expireOverdueApprovals(tenant_id: string, limit: number): Promise<readonly string[]> {
    assertIdentifier(tenant_id, 'tenant_id', 36, 'APPROVAL_TENANT_ID_REQUIRED');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error(
        'APPROVAL_EXPIRY_LIMIT_INVALID: limit must be a positive integer no greater than 500.',
      );
    }

    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<ExpiredApprovalRow>(EXPIRE_OVERDUE_APPROVALS, [
        tenant_id,
        limit,
      ]);
      const audit = new AuditRepository(async (_tenantId, work) => work(client));

      for (const expired of result.rows) {
        await audit.append({
          tenant_id,
          run_id: expired.run_id,
          agent_id: 'HUMAN_HANDOFF',
          customer_or_entity_id: expired.run_id,
          trigger: 'approval_expiry_sweeper',
          context: {
            approval_id: expired.id,
            action_id: expired.action_id,
            effect_key: expired.effect_key,
          },
          skill: 'approvals.expiry',
          tool: 'approval-expiry-sweeper',
          decision: {
            outcome: 'EXPIRED',
            approval_id: expired.id,
          },
          authority: 'AUTH-0',
          approval: {
            id: expired.id,
            decision: 'EXPIRED',
          },
          action: {
            id: expired.action_id,
            effect_key: expired.effect_key,
            status: 'failed',
          },
          execution_status: 'failed',
          evidence: {},
          outcome: null,
          latency_ms: 0,
          cost: {},
          error: { code: 'APPROVAL_EXPIRED' },
        });
      }

      return result.rows.map((row) => row.id);
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
      if (approval.decision === 'EXPIRED') {
        throw new Error(
          'APPROVAL_EXPIRED: this approval crossed its review deadline and cannot receive a decision.',
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
      if (approval.decision === 'EXPIRED') {
        throw new Error(
          `APPROVAL_EXPIRED: approval ${approval.id} crossed its review deadline and cannot be claimed.`,
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

    return {
      claimed: true,
      approval: decided,
      action: {
        ...action,
        status: decision === 'APPROVED' ? 'authorized' : 'failed',
      },
      task: moved,
    };
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
    const authorizedPayloadDigest = sha256CanonicalJson(authorized.payload);
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
    const checkpointAction = {
      ...authorized,
      approval_id: prepared.approval_id,
      approval_payload_digest: authorizedPayloadDigest,
    };
    const checkpointPayload = serializeJsonb(
      {
        ...checkpointWithoutEvent,
        pending_action: checkpointAction,
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

    return {
      claimed: true,
      approval: decided,
      action: { ...toActionRecord(revised_action), status: 'authorized' },
      task: moved,
    };
  }
}