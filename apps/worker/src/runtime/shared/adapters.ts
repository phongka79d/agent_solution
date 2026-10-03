/**
 * @file Durable Runtime Adapters (implement/04 §3.3, §4.4, §6.1).
 *
 * Implements the domain-neutral runtime seams (IStatefulWorkflowEngine, IEvidenceLogger,
 * IAuditTrail, ISessionControl, DurableLeaseManager) as thin delegations over the durable
 * PostgreSQL repositories in packages/database. Serves Care, Sales and Marketing domain runtimes.
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

import { appendTerminalRunNotice } from '@agentos/core-engine';
import {
  OrchestratorError,
  type ActionDraft,
  type AgentRunLogRecord,
  type DurableLeaseManager,
  type DurableTaskGuard,
  type DurableTaskSnapshot,
  type ExecutionReceipt,
  type IAuditTrail,
  type IEvidenceLogger,
  type IPlanInputResolver,
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
  ImmutableEvidenceRecord as DatabaseImmutableEvidenceRecord,
  RecordTaskFailureInput,
} from '@agentos/database';
import { verifyEvidenceChain } from '@agentos/database';

export interface DurableAdaptersOptions {
  readonly workflowRepository: DurableWorkflowRepository;
  readonly approvalRepository: ApprovalRepository;
  readonly evidenceRepository: EvidenceRepository;
  readonly auditRepository: AuditRepository;
  readonly conversationRepository: ConversationRepository;
  readonly auditSecret: string;
  readonly planInputResolver?: IPlanInputResolver;
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

export interface DurableAdapters {
  readonly workflowEngine: IStatefulWorkflowEngine;
  readonly evidenceLogger: IEvidenceLogger;
  readonly auditTrail: IAuditTrail;
  readonly sessionControl: ISessionControl;
  readonly leaseManager: DurableLeaseManager;
  /** Canonical closed resolver for server-authored receipt bindings. */
  readonly planInputResolver?: IPlanInputResolver;
}

interface OutcomeWatchWriter {
  initializeOutcomeWatch(params: {
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

const RECEIPT_RESPONSE_PATH_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.(?:[A-Za-z][A-Za-z0-9_]*|0|[1-9][0-9]?)){0,7}$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function receiptBindingRefusal(message: string): never {
  throw new OrchestratorError('INPUT_BINDING_RECEIPT_INVALID', message);
}

function assertEvidenceIdentity(
  record: DatabaseImmutableEvidenceRecord,
  expected: { tenant_id: string; run_id: string; effect_key?: string; step_index: number },
): void {
  if (
    record.tenant_id !== expected.tenant_id
    || record.run_id !== expected.run_id
    || record.step_index !== expected.step_index
    || (expected.effect_key !== undefined && record.effect_key !== expected.effect_key)
    || record.effect_key.trim().length === 0
  ) {
    receiptBindingRefusal('Immutable evidence is not bound to the requested tenant, run, effect, and step.');
  }
}

function projectExecutionReceipt(raw_payload: unknown): ExecutionReceipt {
  const payload = isPlainRecord(raw_payload) ? raw_payload : null;
  const value = payload?.['receipt'];
  if (!isPlainRecord(value)) {
    receiptBindingRefusal('Immutable evidence does not contain a durable execution receipt.');
  }

  const response_payload = value['response_payload'];
  const token_usage = value['token_usage'];
  if (
    typeof value['execution_id'] !== 'string'
    || value['execution_id'].trim().length === 0
    || value['adapter_status'] !== 'SUCCESS'
    || (value['provider_reference'] !== null && typeof value['provider_reference'] !== 'string')
    || !isPlainRecord(response_payload)
    || typeof value['latency_ms'] !== 'number'
    || !Number.isFinite(value['latency_ms'])
    || value['latency_ms'] < 0
    || !isPlainRecord(token_usage)
    || typeof token_usage['prompt'] !== 'number'
    || !Number.isFinite(token_usage['prompt'])
    || token_usage['prompt'] < 0
    || typeof token_usage['completion'] !== 'number'
    || !Number.isFinite(token_usage['completion'])
    || token_usage['completion'] < 0
    || typeof token_usage['total_cost_usd'] !== 'number'
    || !Number.isFinite(token_usage['total_cost_usd'])
    || token_usage['total_cost_usd'] < 0
  ) {
    receiptBindingRefusal('Immutable evidence does not contain a successful, valid execution receipt.');
  }

  return {
    execution_id: value['execution_id'] as string,
    adapter_status: 'SUCCESS',
    provider_reference: value['provider_reference'] as string | null,
    response_payload,
    latency_ms: value['latency_ms'] as number,
    token_usage: {
      prompt: token_usage['prompt'] as number,
      completion: token_usage['completion'] as number,
      total_cost_usd: token_usage['total_cost_usd'] as number,
    },
  };
}

function mapCoreEvidence(record: DatabaseImmutableEvidenceRecord): ImmutableEvidenceRecord {
  return {
    evidence_id: record.evidence_id,
    run_id: record.run_id,
    tenant_id: record.tenant_id,
    correlation_id: record.correlation_id,
    step_index: record.step_index,
    effect_key: record.effect_key,
    previous_evidence_hash: record.previous_evidence_hash,
    payload_sha256: record.payload_sha256,
    chain_hash: record.chain_hash,
    signature: record.signature,
    created_at: record.created_at,
  };
}

function projectVerifiedCoreEvidence(
  record: DatabaseImmutableEvidenceRecord,
): ImmutableEvidenceRecord {
  const receipt = projectExecutionReceipt(record.raw_payload);
  return { ...mapCoreEvidence(record), receipt };
}

function assertVerifiedChain(
  records: readonly DatabaseImmutableEvidenceRecord[],
  tenant_id: string,
  run_id: string,
  auditSecret: string,
): void {
  const report = verifyEvidenceChain(records, { tenant_id, run_id, secret: auditSecret });
  if (!report.valid) {
    receiptBindingRefusal('Immutable evidence chain verification failed; receipt projection was refused.');
  }
}

type EvidenceRepositoryWithOptionalChainRead = EvidenceRepository & {
  readonly readEvidenceChain?: (
    tenant_id: string,
    run_id: string,
  ) => Promise<readonly DatabaseImmutableEvidenceRecord[]>;
};

async function findVerifiedEvidence(
  repository: EvidenceRepository,
  auditSecret: string,
  params: { tenant_id: string; run_id: string; effect_key: string; step_index: number },
): Promise<DatabaseImmutableEvidenceRecord | null> {
  const reader = repository as EvidenceRepositoryWithOptionalChainRead;
  if (typeof reader.readEvidenceChain === 'function') {
    const records = await reader.readEvidenceChain(params.tenant_id, params.run_id);
    const matches = records.filter(
      (candidate) =>
        candidate.effect_key === params.effect_key && candidate.step_index === params.step_index,
    );
    if (matches.length === 0) {
      return null;
    }
    if (matches.length !== 1) {
      receiptBindingRefusal('Immutable evidence has multiple records for the requested effect and step.');
    }
    const record = matches[0];
    if (record === undefined) {
      return null;
    }
    assertVerifiedChain(records, params.tenant_id, params.run_id, auditSecret);
    assertEvidenceIdentity(record, params);
    return record;
  }

  // Keep repository-injected test/composition doubles useful, but fail closed when they cannot
  // prove the same durable chain invariant as the PostgreSQL implementation.
  if (typeof repository.findEvidence !== 'function' || typeof repository.verifyRunChain !== 'function') {
    receiptBindingRefusal('Durable immutable evidence verification is unavailable.');
  }
  const record = await repository.findEvidence(params);
  if (record === null) {
    return null;
  }
  const report = await repository.verifyRunChain(params.tenant_id, params.run_id, auditSecret);
  if (!report.valid) {
    receiptBindingRefusal('Immutable evidence chain verification failed; receipt projection was refused.');
  }
  assertEvidenceIdentity(record, params);
  return record;
}

async function findVerifiedEvidenceByStep(
  repository: EvidenceRepository,
  auditSecret: string,
  params: { tenant_id: string; run_id: string; step_index: number },
): Promise<DatabaseImmutableEvidenceRecord | null> {
  const reader = repository as EvidenceRepositoryWithOptionalChainRead;
  if (typeof reader.readEvidenceChain !== 'function') {
    return null;
  }
  const records = await reader.readEvidenceChain(params.tenant_id, params.run_id);
  const matches = records.filter((candidate) => candidate.step_index === params.step_index);
  if (matches.length === 0) {
    return null;
  }
  if (matches.length !== 1) {
    receiptBindingRefusal('Immutable evidence has multiple records for the requested run and step.');
  }
  const record = matches[0];
  if (record === undefined) {
    return null;
  }
  assertVerifiedChain(records, params.tenant_id, params.run_id, auditSecret);
  assertEvidenceIdentity(record, params);
  return record;
}

/**
 * Canonical closed resolver for server-authored receipt bindings.
 *
 * The orchestrator supplies only receipts projected from verified immutable evidence. This resolver
 * performs no lookups and does not interpret arbitrary expressions; the orchestrator independently
 * compares every returned value with the declared response path before drafting an action.
 */
export const DEFAULT_PLAN_INPUT_RESOLVER: IPlanInputResolver = Object.freeze({
  async resolve({ step, previous_receipts }: Parameters<IPlanInputResolver['resolve']>[0]): Promise<Record<string, unknown>> {
    const bindings = step.input_bindings ?? {};
    const resolved: Record<string, unknown> = {};
    for (const [destination, binding] of Object.entries(bindings)) {
      const receipt = previous_receipts[String(binding.source_step_index)];
      if (receipt === undefined) {
        throw new OrchestratorError(
          'INPUT_BINDING_RECEIPT_MISSING',
          `Step ${step.step_index} has no verified receipt for source step ${binding.source_step_index}.`,
        );
      }
      if (!RECEIPT_RESPONSE_PATH_PATTERN.test(binding.response_path)) {
        throw new OrchestratorError(
          'INPUT_BINDING_RESPONSE_PATH_INVALID',
          `Step ${step.step_index}.${destination} has an invalid bounded response path.`,
        );
      }
      let value: unknown = receipt.response_payload;
      for (const segment of binding.response_path.split('.')) {
        if (Array.isArray(value) && /^(?:0|[1-9][0-9]?)$/.test(segment) && Number(segment) < value.length) {
          value = value[Number(segment)];
        } else if (isPlainRecord(value) && Object.prototype.hasOwnProperty.call(value, segment)) {
          value = value[segment];
        } else {
          throw new OrchestratorError(
            'INPUT_BINDING_RESPONSE_PATH_MISSING',
            `Step ${step.step_index}.${destination} references a missing response path.`,
          );
        }
      }
      resolved[destination] = value;
    }
    return resolved;
  },
});

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
 * Creates the runtime durable adapters bound to database repositories.
 * Serves Care, Sales and Marketing domain runtimes.
 */
export function createDurableAdapters(options: {
  workflowRepository: DurableWorkflowRepository;
  approvalRepository: ApprovalRepository;
  evidenceRepository: EvidenceRepository;
  auditRepository: AuditRepository;
  conversationRepository: ConversationRepository;
  auditSecret: string;
  planInputResolver?: IPlanInputResolver;
  now?: () => Date;
}): {
  workflowEngine: IStatefulWorkflowEngine;
  evidenceLogger: IEvidenceLogger;
  auditTrail: IAuditTrail;
  sessionControl: ISessionControl;
  leaseManager: DurableLeaseManager;
  planInputResolver: IPlanInputResolver;
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
        // Timer resumes are bound to this durable retry generation (T5.5).
        retry_count: record.retry_count,
        lease_owner: record.lease_owner,
        lease_expires_at: record.lease_expires_at,
      };
    },

    async pauseForApproval(params: {
      tenant_id: string;
      run_id: string;
      expected_task_version: number;
      checkpoint: unknown;
      approval: {
        action_id: string;
        effect_key: string;
        payload: unknown;
        payload_sha256: string;
        digest_version: number;
        reason: string;
      };
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
          payload_sha256: params.approval.payload_sha256,
          digest_version: params.approval.digest_version,
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
      if (result.claimed) {
        await appendTerminalRunNotice(result.task, options.conversationRepository);
      }
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
    async queueHandoffEvidence(params: {
      tenant_id: string;
      run_id: string;
      expected_task_version?: number;
      evidence_payload: Record<string, unknown>;
      step_index?: number;
      effect_key?: string;
      reason?: string;
    }): Promise<{ queued: boolean; task_version?: number }> {
      return await options.workflowRepository.queueHandoffEvidence(params);
    },
    async clearHandoffEvidence(params: {
      tenant_id: string;
      run_id: string;
      expected_task_version: number;
      lease_owner: string;
      expected_resume_event: Record<string, unknown>;
    }): Promise<{ cleared: boolean; task_version?: number }> {
      return await options.workflowRepository.clearHandoffEvidence(params);
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
      const record = await options.evidenceRepository.appendEvidence(input);
      // Never expose database raw_payload (which contains the provider response) to core logs.
      return mapCoreEvidence(record);
    },
    async findImmutableRecord(params: {
      tenant_id: string;
      run_id: string;
      effect_key: string;
      step_index: number;
    }): Promise<ImmutableEvidenceRecord | null> {
      const record = await findVerifiedEvidence(options.evidenceRepository, options.auditSecret, params);
      return record === null ? null : projectVerifiedCoreEvidence(record);
    },
    async findImmutableRecordByStep(params: {
      tenant_id: string;
      run_id: string;
      step_index: number;
    }): Promise<ImmutableEvidenceRecord | null> {
      const record = await findVerifiedEvidenceByStep(
        options.evidenceRepository,
        options.auditSecret,
        params,
      );
      return record === null ? null : projectVerifiedCoreEvidence(record);
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
      if (!hasOutcomeWatchWriter(options.evidenceRepository)) {
        throw new OrchestratorError(
          'CAPABILITY_NOT_ENABLED',
          `initializeOutcomeWatch is unbound: pending_outcome_attributions writer is not available for effect '${params.effect_key}' on skill '${params.skill_id}'`,
        );
      }
      await options.evidenceRepository.initializeOutcomeWatch(params);
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
    planInputResolver: options.planInputResolver ?? DEFAULT_PLAN_INPUT_RESOLVER,
  };
}
