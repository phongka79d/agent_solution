/**
 * @file In-memory durable task engine (implement/04 §4.1–§4.4).
 *
 * This binding implements `IStatefulWorkflowEngine` with the SAME guards the SQL statements of
 * §4.2 apply, minus the transport: tenant-scoped rows, an optimistic `task_version` on every
 * write, an atomically inserted PENDING approval as the only resume authority, and a single-use
 * claim. It is a test/composition binding, not a second correctness authority — a real deployment
 * binds the PostgreSQL statements, and the rules here are written so the app-level contract cannot
 * drift from them.
 *
 * Mirrored invariants:
 * - Tasks are keyed by `(tenant_id, run_id)`; a lookup under the wrong tenant is a miss and can
 *   never read or write another tenant's row (NFR-006).
 * - `pauseForApproval` inserts exactly one PENDING row per `(tenant_id, run_id, effect_key,
 *   action_id)` binding and parks the task in `awaiting_human` in one step; a replay returns the
 *   existing `approval_id` instead of inserting a second row (§4.2(3), §4.4 step 3).
 * - `claimApprovalAndResume` claims one approval exactly once. A stale digest, a binding mismatch,
 *   an empty operator id, a decided row or a repeated PAUSE all return `{ claimed: false }` and
 *   write nothing (§4.2(4)).
 * - `recordFailure` persists only `RETRYABLE | FATAL`; `UNKNOWN` is a reconciliation state, not a
 *   stored error class, so it is refused instead of being written (§4.4).
 * - `updateTaskProgress` mirrors `state_payload = state_payload || $5::jsonb`: a top-level merge,
 *   so a progress write never erases the checkpoint the resume path needs.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { IStatefulWorkflowEngine } from '../contracts/ports.js';
import {
  OrchestratorError,
  type ActionDraft,
  type DurableTaskCheckpoint,
  type DurableTaskGuard,
  type PersistedErrorClass,
  type TaskLifecycleState,
} from '../contracts/types.js';
import { canonicalizeJson } from '../effects/canonical-json.js';
import { assertTaskTransition, taskTransitionEvent } from './task-fsm.js';

/** The five human-decision routes of §4.2(4). `PENDING` is the state before any decision. */
export type ApprovalDecision = 'PENDING' | 'APPROVED' | 'MODIFIED' | 'REJECTED' | 'CANCELLED';

/**
 * One `approvals` row as this binding stores it. `payload_sha256` is the reviewed digest: the
 * SHA-256 of the RFC 8785 canonical approval payload, recomputed at claim time by the SQL binding
 * and stored here at pause time so a caller can supply the same value as
 * `expected_payload_sha256`.
 */
export interface PersistedApproval {
  readonly approval_id: string;
  readonly tenant_id: string;
  readonly run_id: string;
  readonly action_id: string;
  readonly effect_key: string;
  readonly payload: unknown;
  readonly payload_sha256: string;
  readonly reason: string;
  readonly decision: ApprovalDecision;
  readonly is_paused: boolean;
  readonly operator_id: string | null;
  readonly review_comment: string | null;
  readonly created_at: string;
  /** Null while the approval is PENDING (including after an explicit PAUSE). */
  readonly decided_at: string | null;
}

export interface MemoryWorkflowEngineOptions {
  /**
   * §4.4 `retry_count < max_retries`: a RETRYABLE failure at or above this count fails the task
   * terminally instead of re-queuing it. Infrastructure budget, not an ASM policy default.
   */
  readonly max_retries?: number;
  /** Injectable clock (milliseconds since epoch) for deterministic `created_at` / `updated_at`. */
  readonly now?: () => number;
}

interface TaskRow {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly correlation_id: string;
  state: TaskLifecycleState;
  current_step: number;
  task_version: number;
  retry_count: number;
  last_error_class: PersistedErrorClass | null;
  error_details: Record<string, unknown> | null;
  state_payload: DurableTaskCheckpoint | null;
  paused_for_approval_id: string | null;
  readonly created_at: string;
  updated_at: string;
}

interface ApprovalRow {
  approval_id: string;
  tenant_id: string;
  run_id: string;
  action_id: string;
  effect_key: string;
  payload: unknown;
  payload_sha256: string;
  reason: string;
  decision: ApprovalDecision;
  is_paused: boolean;
  operator_id: string | null;
  review_comment: string | null;
  created_at: string;
  decided_at: string | null;
}

/** States a task may be created in: §4.1 starts at `queued`; the orchestrator claims the lease
 * first and therefore creates the row already `running` (§3.3 `processSignal`). */
const CREATABLE_STATES: Readonly<Record<'queued' | 'running', true>> = { queued: true, running: true };

/** The only error classes `platform_durable_tasks.last_error_class` accepts (§03, §4.4). */
const PERSISTED_ERROR_CLASSES: Readonly<Record<PersistedErrorClass, true>> = {
  RETRYABLE: true,
  FATAL: true,
};

export class MemoryWorkflowEngine implements IStatefulWorkflowEngine {
  private readonly tasks = new Map<string, Map<string, TaskRow>>();
  private readonly approvals = new Map<string, ApprovalRow[]>();
  private readonly maxRetries: number;
  private readonly now: () => number;

  constructor(options: MemoryWorkflowEngineOptions = {}) {
    this.maxRetries = options.max_retries ?? 3;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Inserts version 1 of a task. A second insert for the same `(tenant_id, run_id)` is refused:
   * silently replacing a live task row would drop its lease holder, its retry counter and its
   * evidence cursor at exactly the moment a concurrent worker may be advancing them.
   */
  public async createTask(task: {
    run_id: string;
    tenant_id: string;
    correlation_id: string;
    current_step: number;
    state: TaskLifecycleState;
  }): Promise<void> {
    if (!Object.prototype.hasOwnProperty.call(CREATABLE_STATES, task.state)) {
      throw new OrchestratorError(
        'INVALID_TASK_STATE',
        `A task is created 'queued' or 'running'; refusing to create '${task.run_id}' as '${task.state}'.`,
      );
    }
    if (this.lookupTask(task.tenant_id, task.run_id) !== undefined) {
      throw new OrchestratorError(
        'TASK_ALREADY_EXISTS',
        `Task '${task.run_id}' already exists for this tenant; refusing to overwrite its lease, version and checkpoint.`,
      );
    }

    const timestamp = new Date(this.now()).toISOString();
    const row: TaskRow = {
      tenant_id: task.tenant_id,
      run_id: task.run_id,
      correlation_id: task.correlation_id,
      state: task.state,
      current_step: task.current_step,
      task_version: 1,
      retry_count: 0,
      last_error_class: null,
      error_details: null,
      state_payload: null,
      paused_for_approval_id: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    const tenantTasks = this.tasks.get(task.tenant_id);
    if (tenantTasks === undefined) {
      this.tasks.set(task.tenant_id, new Map([[task.run_id, row]]));
    } else {
      tenantTasks.set(task.run_id, row);
    }
  }

  /** Tenant-scoped read of the durable task, or null when this tenant owns no such run. */
  public async getTask(
    tenant_id: string,
    run_id: string,
  ): Promise<{
    task_version: number;
    state: TaskLifecycleState;
    correlation_id: string;
    state_payload: DurableTaskCheckpoint | null;
  } | null> {
    const row = this.lookupTask(tenant_id, run_id);
    if (row === undefined) {
      return null;
    }
    return {
      task_version: row.task_version,
      state: row.state,
      correlation_id: row.correlation_id,
      state_payload: row.state_payload,
    };
  }

  /**
   * §4.2 statement (2): only a live step advances the cursor. The progress payload is merged into
   * `state_payload` (`state_payload || $5::jsonb`), so the plan/context/evidence cursor written by
   * a park or pause survives a progress write. A terminal task is never re-opened, and a task this
   * tenant does not own is a no-op.
   */
  public async updateTaskProgress(
    tenant_id: string,
    run_id: string,
    stepIndex: number,
    checkpointPayload: unknown,
  ): Promise<void> {
    const row = this.lookupTask(tenant_id, run_id);
    if (row === undefined || row.state !== 'running') {
      return;
    }
    if (!isPlainRecord(checkpointPayload)) {
      throw new OrchestratorError(
        'CHECKPOINT_INCOMPLETE',
        `updateTaskProgress for '${run_id}' requires a JSON object checkpoint payload.`,
      );
    }

    row.current_step = stepIndex;
    row.state_payload = { ...(row.state_payload ?? {}), ...checkpointPayload } as DurableTaskCheckpoint;
    row.task_version += 1;
    row.updated_at = new Date(this.now()).toISOString();
  }

  /**
   * Applies one §4.1 transition under the FSM.
   *
   * The interface hands over a target state, so the canonical event for the pair is derived by
   * `taskTransitionEvent()`; callers that know the exact cause (e.g. `task.await_event` versus
   * `task.dispatch_timeout`) may pass it as `event`, but an illegal pair is still refused. A
   * supplied checkpoint replaces `state_payload`; omitting it leaves the stored checkpoint intact,
   * which is what the resume path depends on.
   */
  public async transitionTask(
    tenant_id: string,
    run_id: string,
    state: TaskLifecycleState,
    reason: string,
    checkpointPayload?: unknown,
    eventOrGuard?: string | DurableTaskGuard,
  ): Promise<void> {
    const row = this.requireTask(tenant_id, run_id);

    const resolvedEvent = (typeof eventOrGuard === 'string' ? eventOrGuard : undefined) ?? taskTransitionEvent(row.state, state);
    if (typeof eventOrGuard === 'object' && eventOrGuard.expected_task_version !== undefined && eventOrGuard.expected_task_version !== row.task_version) {
      throw new OrchestratorError('CONCURRENT_TASK_LOCK', `Stale task version for '${run_id}'.`);
    }
    if (resolvedEvent === null) {
      throw new OrchestratorError(
        'INVALID_TASK_STATE',
        `No legal event moves task '${run_id}' from '${row.state}' to '${state}' (reason: ${reason}).`,
      );
    }
    assertTaskTransition(row.state, state, resolvedEvent);

    if (checkpointPayload !== undefined && !isPlainRecord(checkpointPayload)) {
      throw new OrchestratorError(
        'CHECKPOINT_INCOMPLETE',
        `transitionTask for '${run_id}' requires a JSON object checkpoint payload.`,
      );
    }

    row.state = state;
    // The binding is only meaningful while the task is parked for that approval; a task leaving
    // `awaiting_human` for any other reason must not keep a stale resume authority (§4.2(4)).
    if (state !== 'awaiting_human') {
      row.paused_for_approval_id = null;
    }
    if (checkpointPayload !== undefined) {
      row.state_payload = checkpointPayload as unknown as DurableTaskCheckpoint;
    }
    row.task_version += 1;
    row.updated_at = new Date(this.now()).toISOString();
  }

  /**
   * §4.2 statement (3): insert the PENDING approval and park the task, atomically and tenant-scoped.
   *
   * A replay for the SAME `(effect_key, action_id)` binding returns the existing `approval_id` and
   * writes nothing, so a retried step can never accumulate a second PENDING row (§4.4 step 3). A
   * pause for a DIFFERENT binding while the run already has a PENDING approval is refused: the
   * task's `paused_for_approval_id` can only point at one reviewed action, and silently rebinding
   * it would turn one human decision into authorization for another action.
   *
   * @throws {OrchestratorError} `TASK_NOT_FOUND` (unknown run for this tenant),
   *   `CONCURRENT_TASK_LOCK` (stale `expected_task_version` ⇒ zero rows updated),
   *   `INVALID_TASK_STATE` (the task is not `running`), `APPROVAL_ALREADY_PENDING` (another binding
   *   is pending) or `CANONICAL_JSON_UNSUPPORTED` (the payload has no canonical form, so no digest
   *   could ever match it).
   */
  public async pauseForApproval(params: {
    tenant_id: string;
    run_id: string;
    expected_task_version: number;
    checkpoint: unknown;
    approval: { action_id: string; effect_key: string; payload: unknown; reason: string };
  }): Promise<{ approval_id: string }> {
    const row = this.requireTask(params.tenant_id, params.run_id);

    const pending = this.listApprovalRows(params.tenant_id, params.run_id).find(
      (approval) => approval.decision === 'PENDING',
    );
    if (pending !== undefined) {
      if (pending.effect_key === params.approval.effect_key && pending.action_id === params.approval.action_id) {
        return { approval_id: pending.approval_id };
      }
      throw new OrchestratorError(
        'APPROVAL_ALREADY_PENDING',
        `Task '${params.run_id}' is already paused for approval '${pending.approval_id}' bound to action '${pending.action_id}'; a different action cannot be paused on the same run.`,
      );
    }

    if (row.task_version !== params.expected_task_version) {
      throw new OrchestratorError(
        'CONCURRENT_TASK_LOCK',
        `Task '${params.run_id}' was advanced by another worker (expected version ${params.expected_task_version}, found ${row.task_version}); re-read before pausing.`,
      );
    }
    assertTaskTransition(row.state, 'awaiting_human', 'task.require_auth4');

    if (!isPlainRecord(params.checkpoint)) {
      throw new OrchestratorError(
        'CHECKPOINT_INCOMPLETE',
        `pauseForApproval for '${params.run_id}' requires a complete checkpoint payload (§4.2).`,
      );
    }

    const timestamp = new Date(this.now()).toISOString();
    const approval: ApprovalRow = {
      approval_id: randomUUID(),
      tenant_id: params.tenant_id,
      run_id: params.run_id,
      action_id: params.approval.action_id,
      effect_key: params.approval.effect_key,
      payload: params.approval.payload,
      payload_sha256: sha256Hex(canonicalizeJson(params.approval.payload)),
      reason: params.approval.reason,
      decision: 'PENDING',
      is_paused: false,
      operator_id: null,
      review_comment: null,
      created_at: timestamp,
      decided_at: null,
    };
    this.approvalRows(params.tenant_id).push(approval);

    row.state = 'awaiting_human';
    row.paused_for_approval_id = approval.approval_id;
    row.state_payload = params.checkpoint as unknown as DurableTaskCheckpoint;
    row.task_version += 1;
    row.updated_at = timestamp;

    return { approval_id: approval.approval_id };
  }

  /**
   * §4.2(4): decide and resume, or retain PENDING + `awaiting_human` for an explicit PAUSE.
   *
   * The claim is single-use. Every refusal — unknown approval, binding mismatch, digest mismatch,
   * missing operator, already-decided row, or a repeated PAUSE — returns `{ claimed: false }` and
   * writes nothing, so a caller can retry the read instead of having consumed the approval.
   *
   * `expected_payload_sha256` is the digest of the REVIEWED payload (the one stored at pause time,
   * mirrored in `PersistedApproval.payload_sha256`) — the same value the SQL binding recomputes
   * over canonical `approvals.payload` while the row is locked.
   */
  public async claimApprovalAndResume(params: {
    tenant_id: string;
    run_id: string;
    approval_id: string;
    effect_key: string;
    expected_payload_sha256: string;
    authorized_action: ActionDraft | null;
    decision: 'APPROVED' | 'MODIFIED' | 'REJECTED' | 'PAUSE' | 'CANCELLED';
    operator_id: string;
    review_comment: string | null;
  }): Promise<{ claimed: boolean }> {
    const row = this.requireTask(params.tenant_id, params.run_id);

    const approval = this.listApprovalRows(params.tenant_id, params.run_id).find(
      (candidate) => candidate.approval_id === params.approval_id,
    );
    if (approval === undefined) {
      return { claimed: false };
    }
    const bindingIsCurrent =
      approval.run_id === params.run_id &&
      approval.effect_key === params.effect_key &&
      row.paused_for_approval_id === approval.approval_id &&
      row.state === 'awaiting_human';
    if (!bindingIsCurrent) {
      return { claimed: false };
    }
    // `operator_id` must be the authenticated decision principal; a decision with no identified
    // human is never a decision (never payload-only authority).
    if (params.operator_id.trim().length === 0) {
      return { claimed: false };
    }
    if (approval.payload_sha256 !== params.expected_payload_sha256) {
      return { claimed: false };
    }
    if (approval.decision !== 'PENDING') {
      return { claimed: false };
    }

    const timestamp = new Date(this.now()).toISOString();

    if (params.decision === 'PAUSE') {
      // Repeated PAUSE conflicts: the first pause already holds the reviewed digest, and clearing
      // it is not this route's job — only an explicit terminal decision may decide a paused item.
      if (approval.is_paused) {
        return { claimed: false };
      }
      approval.is_paused = true;
      approval.operator_id = params.operator_id;
      approval.review_comment = params.review_comment;
      row.task_version += 1;
      row.updated_at = timestamp;
      return { claimed: true };
    }

    const target: TaskLifecycleState =
      params.decision === 'REJECTED' || params.decision === 'CANCELLED' ? 'stopped' : 'running';
    const event =
      params.decision === 'APPROVED'
        ? 'human.approval'
        : params.decision === 'MODIFIED'
          ? 'human.modify'
          : params.decision === 'REJECTED'
            ? 'human.reject'
            : 'human.cancel';
    assertTaskTransition(row.state, target, event);

    approval.decision = params.decision;
    approval.is_paused = false;
    approval.operator_id = params.operator_id;
    approval.review_comment = params.review_comment;
    approval.decided_at = timestamp;

    // APPROVE persists the unchanged authorized action; MODIFY persists the explicitly authorized
    // new revision under its own deterministic key (§4.2(4)). The checkpoint's pending action is
    // updated in the same step so a crash between this claim and the dispatch resumes the exact
    // action the human released — never a re-drafted one.
    if (params.authorized_action !== null) {
      if (params.decision === 'MODIFIED') {
        approval.payload = params.authorized_action.payload;
        approval.effect_key = params.authorized_action.effect_key;
        approval.payload_sha256 = sha256Hex(canonicalizeJson(params.authorized_action.payload));
      }
      if (row.state_payload !== null) {
        row.state_payload = { ...row.state_payload, pending_action: params.authorized_action };
      }
    }

    row.state = target;
    row.paused_for_approval_id = null;
    row.task_version += 1;
    row.updated_at = timestamp;

    return { claimed: true };
  }

  /**
   * §4.4 durable recovery: classify, count, re-queue or fail terminally.
   *
   * `RETRYABLE` below `max_retries` re-queues the task (the step's `effect_key` is unchanged, so its
   * reservation keeps the retry at-most-once). At or above the budget the task fails terminally —
   * the stored class stays `RETRYABLE` because that is what actually happened. `FATAL` fails
   * immediately. `UNKNOWN` is refused: it is a reconciliation state resolved by `effect_key`, and
   * the durable row's `last_error_class` only accepts `RETRYABLE | FATAL`.
   *
   * A missing task or an already-terminal task is a no-op (`{ requeued: false }`): this method is
   * called from a failure path, and a refusal there must never mask the original error.
   */
  public async recordFailure(params: {
    tenant_id: string;
    run_id: string;
    error_class: PersistedErrorClass;
    error_details: Record<string, unknown>;
  }): Promise<{ requeued: boolean }> {
    if (!Object.prototype.hasOwnProperty.call(PERSISTED_ERROR_CLASSES, params.error_class)) {
      throw new OrchestratorError(
        'INVALID_ERROR_CLASS',
        `'${String(params.error_class)}' is not a persisted error class; UNKNOWN is a reconciliation state resolved by effect_key, never written to the durable task (§4.4).`,
      );
    }

    const row = this.lookupTask(params.tenant_id, params.run_id);
    if (row === undefined) {
      return { requeued: false };
    }

    row.error_details = params.error_details;
    // §4.4: "Re-queue the task with `retry_count + 1` … while `retry_count < max_retries`". The
    // budget is read BEFORE the increment, so `max_retries` counts the RETRIES granted after the
    // first attempt: with the default of 3, failures arriving at retry_count 0, 1 and 2 re-queue
    // the task (taking it to 1, 2 and 3), and the failure that arrives once `retry_count` has
    // reached the budget is terminal — the §4.1 matrix guard (`retry_count >= max_retries` ⇒
    // `task.fatal_error`). Retries are therefore three, attempts are four.
    const retryable = params.error_class === 'RETRYABLE';
    const withinRetryBudget = row.retry_count < this.maxRetries;

    if (retryable && withinRetryBudget) {
      row.retry_count += 1;
      row.last_error_class = 'RETRYABLE';
      const requeueEvent = taskTransitionEvent(row.state, 'queued');
      if (requeueEvent !== null) {
        assertTaskTransition(row.state, 'queued', requeueEvent);
        row.state = 'queued';
      }
      row.task_version += 1;
      row.updated_at = new Date(this.now()).toISOString();
      return { requeued: true };
    }

    row.last_error_class = params.error_class;
    const failEvent = taskTransitionEvent(row.state, 'failed');
    if (failEvent !== null) {
      assertTaskTransition(row.state, 'failed', failEvent);
      row.state = 'failed';
    }
    row.task_version += 1;
    row.updated_at = new Date(this.now()).toISOString();
    return { requeued: false };
  }

  /** Read-only view of this run's approvals, oldest first (inspection/test surface). */
  public listApprovals(tenant_id: string, run_id: string): readonly PersistedApproval[] {
    return this.listApprovalRows(tenant_id, run_id).map((approval) => ({ ...approval }));
  }

  private lookupTask(tenant_id: string, run_id: string): TaskRow | undefined {
    return this.tasks.get(tenant_id)?.get(run_id);
  }

  private requireTask(tenant_id: string, run_id: string): TaskRow {
    const row = this.lookupTask(tenant_id, run_id);
    if (row === undefined) {
      throw new OrchestratorError('TASK_NOT_FOUND', `Task '${run_id}' does not exist for this tenant.`);
    }
    return row;
  }

  private approvalRows(tenant_id: string): ApprovalRow[] {
    const existing = this.approvals.get(tenant_id);
    if (existing !== undefined) {
      return existing;
    }
    const created: ApprovalRow[] = [];
    this.approvals.set(tenant_id, created);
    return created;
  }

  private listApprovalRows(tenant_id: string, run_id: string): ApprovalRow[] {
    return (this.approvals.get(tenant_id) ?? []).filter((approval) => approval.run_id === run_id);
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
