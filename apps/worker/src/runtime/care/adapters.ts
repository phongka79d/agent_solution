/**
 * @file Customer Care Runtime Adapters (implement/04 §3.3, §4.4, §6.1).
 *
 * Implements the runtime seams (IStatefulWorkflowEngine, IEvidenceLogger, IAuditTrail,
 * ISessionControl, DurableLeaseManager) as thin delegations over the durable PostgreSQL
 * repositories in packages/database.
 *
 * INVARIANTS:
 * 1. Transactions stay inside packages/database: never re-implement hashing, chaining, SQL or advisory locks.
 * 2. Every repository call is tenant-scoped with explicit tenant_id leading the predicate.
 * 3. Fail closed on unbound capabilities: initializeOutcomeWatch (pending_outcome_attributions) and
 *    sessionControl.returnToAgent (owner-checked transition) refuse with canonical OrchestratorError
 *    when the repository exposes no underlying implementation. Never a silent no-op.
 * 4. Fenced lease execution: acquireLease succeeds only when the worker holds the row's lease;
 *    releaseLease refuses when the worker does not hold it.
 */

import {
  OrchestratorError,
  type ActionDraft,
  type AgentRunLogRecord,
  type DurableLeaseManager,
  type DurableTaskGuard,
  type DurableTaskSnapshot,
  type IAuditTrail,
  type IEvidenceLogger,
  type ISessionControl,
  type IStatefulWorkflowEngine,
  type ImmutableEvidenceRecord,
  type PersistedErrorClass,
  type TaskLifecycleState,
} from '@agentos/core-engine/contracts';
import type {
  AppendEvidenceInput,
  ApprovalDecision,
  ApprovalRepository,
  AuditRepository,
  ConversationRecord,
  ConversationRepository,
  CreateDurableTaskInput,
  DurableTaskGuard as DbDurableTaskGuard,
  DurableTaskRecord,
  DurableTaskState,
  DurableWorkflowRepository,
  EvidenceRepository,
  RecordTaskFailureInput,
} from '@agentos/database';

export interface CareAdaptersOptions {
  readonly workflowRepository: DurableWorkflowRepository;
  readonly approvalRepository: ApprovalRepository;
  readonly evidenceRepository: EvidenceRepository;
  readonly auditRepository: AuditRepository;
  readonly conversationRepository: ConversationRepository;
  readonly auditSecret: string;
  readonly now?: () => Date;
}
function hasResumeEvent(state_payload: unknown): boolean {
  if (typeof state_payload !== 'object' || state_payload === null || Array.isArray(state_payload)) {
    return false;
  }
  const payload = state_payload as Record<string, unknown>;
  const event = payload['resume_event'];
  return typeof event === 'object' && event !== null && !Array.isArray(event);
}

export interface CareAdapters {
  readonly workflowEngine: IStatefulWorkflowEngine;
  readonly evidenceLogger: IEvidenceLogger;
  readonly auditTrail: IAuditTrail;
  readonly sessionControl: ISessionControl;
  readonly leaseManager: DurableLeaseManager;
}

interface OutcomeWatchWriter {
  initializeOutcomeWatch(params: {
    tenant_id: string;
    run_id: string;
    effect_key: string;
    skill_id: string;
  }): Promise<void>;
}

interface PendingOutcomeWriter {
  appendPendingOutcomeAttribution(params: {
    tenant_id: string;
    run_id: string;
    effect_key: string;
    skill_id: string;
  }): Promise<void>;
}

function hasOutcomeWatchWriter(repo: unknown): repo is OutcomeWatchWriter {
  return (
    typeof repo === 'object' &&
    repo !== null &&
    'initializeOutcomeWatch' in repo &&
    typeof repo.initializeOutcomeWatch === 'function'
  );
}

function hasPendingOutcomeWriter(repo: unknown): repo is PendingOutcomeWriter {
  return (
    typeof repo === 'object' &&
    repo !== null &&
    'appendPendingOutcomeAttribution' in repo &&
    typeof repo.appendPendingOutcomeAttribution === 'function'
  );
}

interface OwnerCheckedReturnToAgent {
  returnToAgent(tenant_id: string, session_id: string, operator_id: string): Promise<void>;
}

interface OwnerCheckedReleaseTakeover {
  releaseTakeover(tenant_id: string, session_id: string, operator_id: string): Promise<void>;
}

function hasOwnerCheckedReturnToAgent(repo: unknown): repo is OwnerCheckedReturnToAgent {
  return (
    typeof repo === 'object' &&
    repo !== null &&
    'returnToAgent' in repo &&
    typeof repo.returnToAgent === 'function'
  );
}

function hasOwnerCheckedReleaseTakeover(repo: unknown): repo is OwnerCheckedReleaseTakeover {
  return (
    typeof repo === 'object' &&
    repo !== null &&
    'releaseTakeover' in repo &&
    typeof repo.releaseTakeover === 'function'
  );
}

async function resolveWorkflowGuard(
  workflowRepository: DurableWorkflowRepository,
  tenant_id: string,
  run_id: string,
  guard?: DurableTaskGuard,
): Promise<DbDurableTaskGuard | undefined> {
  if (!guard) {
    return undefined;
  }
  let expectedVersion = guard.expected_task_version;
  if (expectedVersion === undefined) {
    const current = await workflowRepository.getTask(tenant_id, run_id);
    if (!current) {
      throw new OrchestratorError(
        'TASK_NOT_FOUND',
        `Cannot guard durable task: task '${run_id}' not found for tenant '${tenant_id}'`,
      );
    }
    expectedVersion = current.task_version;
  }
  const dbGuard: DbDurableTaskGuard = {
    expected_task_version: expectedVersion,
    ...(typeof guard.lease_owner === 'string' && guard.lease_owner.length > 0
      ? { lease_owner: guard.lease_owner }
      : {}),
  };
  return dbGuard;
}

/**
 * Creates the runtime Care adapters bound to durable database repositories.
 */
export function createCareAdapters(options: {
  workflowRepository: DurableWorkflowRepository;
  approvalRepository: ApprovalRepository;
  evidenceRepository: EvidenceRepository;
  auditRepository: AuditRepository;
  conversationRepository: ConversationRepository;
  auditSecret: string;
  now?: () => Date;
}): {
  workflowEngine: IStatefulWorkflowEngine;
  evidenceLogger: IEvidenceLogger;
  auditTrail: IAuditTrail;
  sessionControl: ISessionControl;
  leaseManager: DurableLeaseManager;
} {
  const workflowEngine: IStatefulWorkflowEngine = {
    async createTask(task: {
      run_id: string;
      tenant_id: string;
      correlation_id: string;
      current_step: number;
      state: TaskLifecycleState;
      state_payload?: unknown;
      lease_owner?: string | null;
      lease_expires_at?: string | null;
    }): Promise<void> {
      const input: CreateDurableTaskInput = {
        tenant_id: task.tenant_id,
        run_id: task.run_id,
        correlation_id: task.correlation_id,
        current_step: task.current_step,
        state: task.state as DurableTaskState,
        ...(task.state_payload !== undefined ? { state_payload: task.state_payload } : {}),
      };
      await options.workflowRepository.createTask(input);
    },

    async updateTaskProgress(
      tenant_id: string,
      run_id: string,
      stepIndex: number,
      checkpointPayload: unknown,
      guard?: DurableTaskGuard,
    ): Promise<void> {
      const dbGuard = await resolveWorkflowGuard(
        options.workflowRepository,
        tenant_id,
        run_id,
        guard,
      );
      if (dbGuard !== undefined) {
        await options.workflowRepository.updateTaskProgress(
          tenant_id,
          run_id,
          stepIndex,
          checkpointPayload,
          dbGuard,
        );
      } else {
        await options.workflowRepository.updateTaskProgress(
          tenant_id,
          run_id,
          stepIndex,
          checkpointPayload,
        );
      }
    },

    async transitionTask(
      tenant_id: string,
      run_id: string,
      state: TaskLifecycleState,
      reason: string,
      checkpointPayload?: unknown,
      guard?: DurableTaskGuard,
    ): Promise<void> {
      const dbGuard = await resolveWorkflowGuard(
        options.workflowRepository,
        tenant_id,
        run_id,
        guard,
      );
      if (dbGuard !== undefined) {
        await options.workflowRepository.transitionTask(
          tenant_id,
          run_id,
          state as DurableTaskState,
          reason,
          checkpointPayload,
          dbGuard,
        );
      } else {
        await options.workflowRepository.transitionTask(
          tenant_id,
          run_id,
          state as DurableTaskState,
          reason,
          checkpointPayload,
        );
      }
    },

    async getTask(tenant_id: string, run_id: string): Promise<DurableTaskSnapshot | null> {
      const record: DurableTaskRecord | null = await options.workflowRepository.getTask(
        tenant_id,
        run_id,
      );
      if (!record) {
        return null;
      }
      return {
        task_version: record.task_version,
        state: record.state,
        correlation_id: record.correlation_id,
        state_payload: record.state_payload,
        lease_owner: record.lease_owner,
        lease_expires_at: record.lease_expires_at,
      };
    },

    async pauseForApproval(params: {
      tenant_id: string;
      run_id: string;
      expected_task_version: number;
      checkpoint: unknown;
      approval: { action_id: string; effect_key: string; payload: unknown; reason: string };
    }): Promise<{ approval_id: string }> {
      const result = await options.approvalRepository.pauseForApproval({
        tenant_id: params.tenant_id,
        run_id: params.run_id,
        expected_task_version: params.expected_task_version,
        checkpoint: params.checkpoint,
        approval: {
          action_id: params.approval.action_id,
          effect_key: params.approval.effect_key,
          payload: params.approval.payload,
          reason: params.approval.reason,
        },
      });
      return { approval_id: result.approval_id };
    },

    async claimApprovalAndResume(params: {
      tenant_id: string;
      run_id: string;
      approval_id: string;
      effect_key: string;
      expected_payload_sha256: string;
      authorized_action: ActionDraft | null;
      decision: 'APPROVED' | 'MODIFIED' | 'REJECTED' | 'PAUSE' | 'CANCELLED';
      operator_id: string;
      review_comment: string | null;
      expected_task_version?: number;
      lease_owner?: string;
      expected_resume_event?: Record<string, unknown>;
    }): Promise<{ claimed: boolean }> {
      const result = await options.approvalRepository.claimApprovalAndResume({
        tenant_id: params.tenant_id,
        run_id: params.run_id,
        approval_id: params.approval_id,
        effect_key: params.effect_key,
        expected_payload_sha256: params.expected_payload_sha256,
        authorized_action: params.authorized_action,
        decision: params.decision as ApprovalDecision,
        operator_id: params.operator_id,
        review_comment: params.review_comment,
        ...(params.expected_task_version === undefined ? {} : { expected_task_version: params.expected_task_version }),
        ...(params.lease_owner === undefined ? {} : { lease_owner: params.lease_owner }),
        ...(params.expected_resume_event === undefined ? {} : { expected_resume_event: params.expected_resume_event }),
      });
      return { claimed: result.claimed };
    },

    async recordFailure(params: {
      tenant_id: string;
      run_id: string;
      error_class: PersistedErrorClass;
      error_details: Record<string, unknown>;
      expected_task_version?: number;
      guard?: DurableTaskGuard;
    }): Promise<{ requeued: boolean }> {
      let expectedVersion =
        params.expected_task_version ?? params.guard?.expected_task_version;
      if (expectedVersion === undefined) {
        const current = await options.workflowRepository.getTask(
          params.tenant_id,
          params.run_id,
        );
        if (!current) {
          throw new OrchestratorError(
            'TASK_NOT_FOUND',
            `Cannot record failure: durable task '${params.run_id}' not found for tenant '${params.tenant_id}'`,
          );
        }
        expectedVersion = current.task_version;
      }

      const failureInput: RecordTaskFailureInput = {
        tenant_id: params.tenant_id,
        run_id: params.run_id,
        error_class: params.error_class,
        error_details: params.error_details,
        expected_task_version: expectedVersion,
        ...(typeof params.guard?.lease_owner === 'string' &&
        params.guard.lease_owner.length > 0
          ? { lease_owner: params.guard.lease_owner }
          : {}),
        ...(options.now ? { now: options.now() } : {}),
      };

      const outcome = await options.workflowRepository.recordFailure(failureInput);
      return { requeued: outcome.requeued };
    },
  };

  const evidenceLogger: IEvidenceLogger = {
    async createImmutableRecord(params: {
      run_id: string;
      tenant_id: string;
      correlation_id: string;
      step_index: number;
      effect_key: string;
      previous_evidence_hash: string;
      payload: Record<string, unknown>;
    }): Promise<ImmutableEvidenceRecord> {
      const input: AppendEvidenceInput = {
        tenant_id: params.tenant_id,
        run_id: params.run_id,
        correlation_id: params.correlation_id,
        step_index: params.step_index,
        effect_key: params.effect_key,
        payload: params.payload,
        previous_evidence_hash: params.previous_evidence_hash,
        secret: options.auditSecret,
        ...(options.now ? { created_at: options.now().toISOString() } : {}),
      };
      return await options.evidenceRepository.appendEvidence(input);
    },

    async logAgentRun(runLog: AgentRunLogRecord): Promise<void> {
      await options.evidenceRepository.logAgentRun(runLog);
    },

    async initializeOutcomeWatch(params: {
      tenant_id: string;
      run_id: string;
      effect_key: string;
      skill_id: string;
    }): Promise<void> {
      if (hasOutcomeWatchWriter(options.evidenceRepository)) {
        await options.evidenceRepository.initializeOutcomeWatch(params);
        return;
      }
      if (hasPendingOutcomeWriter(options.evidenceRepository)) {
        await options.evidenceRepository.appendPendingOutcomeAttribution(params);
        return;
      }
      throw new OrchestratorError(
        'CAPABILITY_NOT_ENABLED',
        `initializeOutcomeWatch is unbound: pending_outcome_attributions writer is not available for effect '${params.effect_key}' on skill '${params.skill_id}'`,
      );
    },
  };

  const auditTrail: IAuditTrail = {
    async append(record: AgentRunLogRecord): Promise<void> {
      await options.auditRepository.append(record);
    },
  };

  const sessionControl: ISessionControl = {
    async isTakenOver(tenant_id: string, session_id: string): Promise<boolean> {
      // The orchestrator hands over the session identity of the signal, which is the channel thread
      // the conversation was bound with (R01); the durable takeover state lives on that row, and the
      // Redis lock is a live mirror of it, never the record.
      const conversation: ConversationRecord | null =
        await options.conversationRepository.getByThread(tenant_id, session_id);

      return conversation !== null && conversation.state === 'paused_takeover';
    },

    async returnToAgent(
      tenant_id: string,
      session_id: string,
      operator_id: string,
    ): Promise<void> {
      if (hasOwnerCheckedReturnToAgent(options.conversationRepository)) {
        await options.conversationRepository.returnToAgent(
          tenant_id,
          session_id,
          operator_id,
        );
        return;
      }
      if (hasOwnerCheckedReleaseTakeover(options.conversationRepository)) {
        await options.conversationRepository.releaseTakeover(
          tenant_id,
          session_id,
          operator_id,
        );
        return;
      }
      throw new OrchestratorError(
        'CAPABILITY_NOT_ENABLED',
        `returnToAgent is unbound: conversation repository exposes no owner-checked transition to open for session '${session_id}' (operator '${operator_id}')`,
      );
    },
  };

  const leaseManager: DurableLeaseManager = {
    async acquireLease(
      tenant_id: string,
      run_id: string,
      worker_id: string,
    ): Promise<boolean> {
      const task = await options.workflowRepository.getTask(tenant_id, run_id);
      if (!task) {
        return false;
      }
      const now = options.now ? options.now() : new Date();
      if (task.lease_owner !== worker_id) {
        return false;
      }
      const eventBearingWaiting =
        (task.state === 'waiting' || task.state === 'awaiting_human') && hasResumeEvent(task.state_payload);
      if (task.state !== 'running' && !eventBearingWaiting) {
        return false;
      }
      if (task.lease_expires_at === null || Date.parse(task.lease_expires_at) <= now.getTime()) {
        return false;
      }
      try {
        await options.workflowRepository.renewTaskLease({
          tenant_id,
          run_id,
          lease_owner: worker_id,
          task_version: task.task_version,
        });
        return true;
      } catch {
        return false;
      }
    },

    async releaseLease(
      tenant_id: string,
      run_id: string,
      worker_id: string,
    ): Promise<void> {
      const task = await options.workflowRepository.getTask(tenant_id, run_id);
      if (!task) {
        throw new OrchestratorError(
          'TASK_NOT_FOUND',
          `Cannot release lease: durable task '${run_id}' not found for tenant '${tenant_id}'`,
        );
      }
      if (task.lease_owner === null) {
        // Nothing to release: the row already holds no lease because this run's own completion,
        // requeue or park transition cleared it. Treating that as a contradiction would mask the
        // failure that caused the transition with a misleading lock error.
        return;
      }
      if (task.lease_owner !== worker_id) {
        throw new OrchestratorError(
          'CONCURRENT_TASK_LOCK',
          `TASK_LEASE_NOT_HELD: worker '${worker_id}' does not hold active lease for task '${run_id}' (held by: '${task.lease_owner}')`,
        );
      }
      // Terminal runs hold no schedulable lease. Event-bearing waiting rows retain their state and
      // event so the next worker can consume the durable resume exactly once.
      if (task.state === 'completed' || task.state === 'stopped' || task.state === 'failed') {
        return;
      }
      const targetState = task.state === 'awaiting_human' && hasResumeEvent(task.state_payload)
        ? 'awaiting_human'
        : task.state === 'waiting'
          ? 'waiting'
          : 'queued';
      await options.workflowRepository.releaseTaskLease({
        tenant_id,
        run_id,
        lease_owner: worker_id,
        task_version: task.task_version,
        target_state: targetState,
      });
    },
  };

  return {
    workflowEngine,
    evidenceLogger,
    auditTrail,
    sessionControl,
    leaseManager,
  };
}
