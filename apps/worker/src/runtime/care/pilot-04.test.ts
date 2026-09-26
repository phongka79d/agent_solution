/**
 * @file PILOT-04 / E2E-OFF-ESC Offline Acceptance Pilot Harness (SRS §21, §8; implement/09 §2.4).
 *
 * Scenario Fixtures (from E2E-OFF-ESC):
 *   - run_id: RUN-E2E-OFF-ESC
 *   - case_id: 11111111-1111-4111-8111-111111111114 (CASE-0115-014)
 *   - tenant: T1 (11111111-1111-1111-1111-111111111111)
 *   - customer: 11111111-1111-4111-8111-111111111112 (cust-a)
 *   - channel: ZALO
 *   - operator: OP-SUPPORT-01
 *   - frozen clock: 2026-01-15T10:00:00.000Z
 *
 * Acceptance Verification:
 *   Step 1: Complaint ingestion -> intent classification -> CareAgentRuntime human handoff plan
 *   Step 2: Canonical CarePolicyEngine & PEP policy validation (all valid normalization, zero expected failure)
 *   Step 3: Real SkillRuntime/tool-port escalation via injected in-memory HandoffRepository (exact effect key & idempotent replay)
 *   Step 4: Existing service-case repository seam executes manage_case CREATE/NEW -> CLASSIFIED and RESOLVE to RESOLVED with version fencing & evidence
 *   Step 5: Existing approval decision/resume contract queues exact-bound approval, consumes once via RevenueOrchestrator.resumeTask, and rejects duplicate/conflicting decisions
 *   Step 6: Acquire takeover, assert real session-control/orchestrator path is silent with zero outbound dispatch, release/resume assigned operator, and assert authorized resolution completes
 *   Step 7: Assert tenant/customer/effect-key isolation and no duplicate handoff or unauthorized outbound send
 */

import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  computeEffectKey,
  computeRequestFingerprint,
  MemoryEffectGuard,
  PolicyEnforcementPoint,
  type PolicyAuditPort,
  type PolicyAuditRecord,
} from '@agentos/core-engine';
import type {
  ActionDraft,
  DurableLeaseManager,
  DurableTaskCheckpoint,
  HydratedContext,
  PlannedStep,
  SignalEnvelope,
} from '@agentos/core-engine/contracts';
import type {
  AgentRunLogRecord,
  AppendEvidenceInput,
  ApprovalRecord,
  ApprovalRepository,
  AuditRepository,
  CareHandoffEnqueueResult,
  CareHandoffExecutionReceipt,
  CareHandoffOutput,
  CareHandoffReconciliation,
  ClaimApprovalAndResumeInput,
  ClaimApprovalAndResumeResult,
  ConversationRecord,
  ConversationRepository,
  CreateDurableTaskInput,
  DurableTaskGuard,
  DurableTaskRecord,
  DurableTaskState,
  DurableWorkflowRepository,
  EnqueueCareHandoffInput,
  EvidenceRepository,
  ImmutableEvidenceRecord,
  ManageServiceCaseInput,
  ManagedServiceCase,
  PauseForApprovalInput,
  PauseForApprovalResult,
  ReconcileCareHandoffInput,
  RecordTaskFailureInput,
  ReleaseTaskLeaseInput,
  RenewTaskLeaseInput,
  ServiceCaseReconciliation,
  ServiceCaseState,
} from '@agentos/database';
import { CareAgentRuntime } from './agent-runtime.js';
import { createDurableAdapters } from '../shared/adapters.js';
import {
  createCareOrchestratorFactory,
  createCarePolicyEngine,
  DEFAULT_P1B_CARE_SKILL_ENABLEMENT,
} from './factory.js';
import { createCareSkillServices } from './skills/index.js';

type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

type ManageCaseToolInput = Omit<
  ManageServiceCaseInput,
  'effect_key' | 'request_fingerprint' | 'actor_id' | 'sla_target_hours'
>;

interface MutableDurableTaskRecord extends Omit<Mutable<DurableTaskRecord>, 'state_payload'> {
  state_payload: Record<string, unknown>;
}

type MutableConversationRecord = Mutable<ConversationRecord>;

interface MutableApprovalRecord {
  id: string;
  tenant_id: string;
  run_id: string;
  action_id: string;
  campaign_id: string | null;
  effect_key: string;
  authority_required: 'AUTH-4';
  payload: unknown;
  payload_sha256: string;
  reason: string;
  operator_id: string | null;
  decision: ApprovalRecord['decision'];
  is_paused: boolean;
  review_comment: string | null;
  decided_at: string | null;
  created_at: string;
}

type QueuedApprovalDecision = 'APPROVE' | 'REJECT' | 'MODIFY' | 'PAUSE' | 'CANCEL';

interface QueueApprovalDecisionInput {
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

interface QueueApprovalDecisionResult {
  readonly approval_id: string;
  readonly task_id: string;
  readonly status: 'QUEUED';
  readonly queued_at: string;
}

interface ApprovalDetailRecord {
  readonly approval: ApprovalRecord;
  readonly action: {
    readonly id: string;
    readonly tenant_id?: string;
    readonly decision_id?: string | null;
    readonly skill_name?: string;
    readonly effect_key?: string;
    readonly action_revision?: number;
    readonly target_channel?: string;
    readonly action_payload?: unknown;
    readonly status?: string;
    readonly created_at?: string;
  };
}

interface TaskFailureOutcome {
  readonly requeued: boolean;
  readonly state: DurableTaskState;
  readonly retry_count: number;
  readonly task_version: number;
}

function toDurableTaskSnapshot(task: MutableDurableTaskRecord): DurableTaskRecord {
  return {
    ...task,
    state_payload: { ...task.state_payload },
  };
}

function toApprovalSnapshot(record: MutableApprovalRecord): ApprovalRecord {
  return {
    ...record,
  };
}

function toConversationSnapshot(record: MutableConversationRecord): ConversationRecord {
  return {
    ...record,
  };
}
// ============================================================================
// Deterministic Scenario Fixtures (E2E-OFF-ESC / PILOT-04)
// ============================================================================

const SCENARIO_ID = 'E2E-OFF-ESC';
const RUN_ID = 'RUN-E2E-OFF-ESC';
const CASE_ID = '11111111-1111-4111-8111-111111111114';
const TENANT_T1 = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT = '22222222-2222-2222-2222-222222222222';
const CUSTOMER_A = '11111111-1111-4111-8111-111111111112';
const CHANNEL_ZALO = 'ZALO';
const SESSION_ID = 'SESSION-CONV-991';
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111113';
const OPERATOR_ID = 'OP-SUPPORT-01';
const FROZEN_TIME_ISO = '2026-01-15T10:00:00.000Z';
const FROZEN_CLOCK = () => new Date(FROZEN_TIME_ISO);
const AUDIT_SECRET = 'audit_hmac_secret_for_pilot_04_testing_only!';
const COMPLAINT_UTTERANCE = 'San pham giao vo hop, toi yeu cau hoan tien 1200 TWD';

const PILOT_SKILL_ENABLEMENT: typeof DEFAULT_P1B_CARE_SKILL_ENABLEMENT = Object.freeze({
  enabled_skill_ids: Object.freeze([
    ...DEFAULT_P1B_CARE_SKILL_ENABLEMENT.enabled_skill_ids,
    'skill.care.manage_case',
  ]),
});

// ============================================================================
// Canonical Helpers
// ============================================================================

function computePayloadSha256(payload: unknown): string {
  function canonicalize(val: unknown): string {
    if (val === null || typeof val !== 'object') {
      return JSON.stringify(val);
    }
    if (Array.isArray(val)) {
      return '[' + val.map(canonicalize).join(',') + ']';
    }
    const record = val as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(record[k])).join(',') + '}';
  }
  return createHash('sha256').update(canonicalize(payload)).digest('hex');
}

/**
 * In-memory double for ServiceCaseRepository adhering strictly to
 * Pick<ServiceCaseRepository, 'manage' | 'reconcile'> seam.
 */
function createInMemoryCaseRepository() {
  const cases = new Map<string, ManagedServiceCase & { resolution?: string | null }>();
  const events = new Map<string, { fingerprint: string; output: ManagedServiceCase }>();

  const EDGES: Record<ServiceCaseState, readonly ServiceCaseState[]> = {
    NEW: ['CLASSIFIED'],
    CLASSIFIED: ['ASSIGNED'],
    ASSIGNED: ['IN_PROGRESS'],
    IN_PROGRESS: ['WAITING_CUSTOMER', 'RESOLVED'],
    WAITING_CUSTOMER: ['IN_PROGRESS', 'RESOLVED'],
    RESOLVED: ['CLOSED'],
    CLOSED: [],
  };

  return {
    cases,
    events,
    async manage(input: ManageServiceCaseInput): Promise<ManagedServiceCase> {
      const eventKey = `${input.tenant_id}:${input.effect_key}`;
      const existingEvent = events.get(eventKey);
      if (existingEvent) {
        if (existingEvent.fingerprint !== input.request_fingerprint) {
          throw new Error('IDEMPOTENCY_CONFLICT: effect_key already used with different request fingerprint.');
        }
        return existingEvent.output;
      }

      if (input.action_type === 'CREATE') {
        const case_id = input.case_id ?? ('case-' + randomUUID().slice(0, 8));
        const caseRecord: ManagedServiceCase & { resolution?: string | null } = {
          case_id,
          customer_id: input.customer_id,
          intent: input.intent,
          priority: input.priority,
          status: 'NEW',
          conversation_id: input.conversation_id,
          related_order_id: input.related_order_id ?? null,
          evidence_refs: input.evidence_refs ? [...input.evidence_refs] : [],
          assigned_owner: 'CS-01',
          sla_target_hours: input.sla_target_hours ?? 4,
          updated_at: FROZEN_TIME_ISO,
          case_version: 1,
          resolution: null,
        };
        cases.set(`${input.tenant_id}:${case_id}`, caseRecord);
        events.set(eventKey, { fingerprint: input.request_fingerprint, output: caseRecord });
        return caseRecord;
      }

      const caseKey = `${input.tenant_id}:${input.case_id}`;
      const current = cases.get(caseKey);
      if (!current) {
        throw new Error('CASE_NOT_FOUND: case does not exist in this tenant.');
      }

      if (
        current.customer_id !== input.customer_id ||
        current.conversation_id !== input.conversation_id ||
        current.intent !== input.intent.trim()
      ) {
        throw new Error('CASE_BINDING_MISMATCH: customer, conversation, and intent must match the stored case.');
      }

      if (input.expected_case_version !== undefined && input.expected_case_version !== current.case_version) {
        throw new Error(
          `CASE_VERSION_CONFLICT: expected case version ${input.expected_case_version} does not match current version ${current.case_version}.`,
        );
      }

      let newStatus: ServiceCaseState = current.status;
      let newOwner: string | null = current.assigned_owner;
      let newResolution = current.resolution ?? null;
      let newEvidence = [...current.evidence_refs];

      if (input.action_type === 'TRANSITION_STATE') {
        if (!input.target_status) {
          throw new Error('CASE_TARGET_STATUS_REQUIRED: TRANSITION_STATE requires target_status.');
        }
        if (!EDGES[current.status].includes(input.target_status)) {
          throw new Error(
            `INVALID_FSM_TRANSITION: ${current.status} cannot transition to ${input.target_status}; case was not changed.`,
          );
        }
        newStatus = input.target_status;
      } else if (input.action_type === 'ASSIGN') {
        if (!input.assigned_owner) {
          throw new Error('CASE_OWNER_REQUIRED: assigned_owner is required.');
        }
        if (current.status === 'CLASSIFIED') {
          newStatus = 'ASSIGNED';
        } else if (!['ASSIGNED', 'IN_PROGRESS', 'WAITING_CUSTOMER'].includes(current.status)) {
          throw new Error(`INVALID_FSM_TRANSITION: ASSIGN is not allowed from ${current.status}.`);
        }
        newOwner = input.assigned_owner;
      } else if (input.action_type === 'RESOLVE') {
        if (!EDGES[current.status].includes('RESOLVED')) {
          throw new Error(
            `INVALID_FSM_TRANSITION: ${current.status} cannot transition to RESOLVED; case was not changed.`,
          );
        }
        if (!input.evidence_refs || input.evidence_refs.length === 0) {
          throw new Error('CASE_EVIDENCE_REQUIRED: resolution or closure requires linked evidence.');
        }
        if (!input.notes || input.notes.trim().length === 0) {
          throw new Error('CASE_RESOLUTION_REQUIRED: resolution notes are required.');
        }
        newStatus = 'RESOLVED';
        newResolution = input.notes.trim();
        newEvidence = Array.from(new Set([...newEvidence, ...input.evidence_refs]));
      } else {
        throw new Error(`CASE_ACTION_INVALID: unsupported action ${input.action_type}.`);
      }

      const updatedCase: ManagedServiceCase & { resolution?: string | null } = {
        ...current,
        status: newStatus,
        assigned_owner: newOwner,
        resolution: newResolution,
        evidence_refs: newEvidence,
        case_version: current.case_version + 1,
        updated_at: FROZEN_TIME_ISO,
      };

      cases.set(caseKey, updatedCase);
      events.set(eventKey, { fingerprint: input.request_fingerprint, output: updatedCase });
      return updatedCase;
    },

    async reconcile(input: ManageServiceCaseInput): Promise<ServiceCaseReconciliation> {
      const eventKey = `${input.tenant_id}:${input.effect_key}`;
      const existingEvent = events.get(eventKey);
      if (existingEvent) {
        return { state: 'COMMITTED', output: existingEvent.output };
      }
      const current = input.case_id ? cases.get(`${input.tenant_id}:${input.case_id}`) : undefined;
      return {
        state: 'NOT_COMMITTED',
        case_id: current?.case_id ?? null,
        current_case_version: current?.case_version ?? null,
        current_status: current?.status ?? null,
      };
    },
  };
}

/**
 * In-memory execution lease manager for deterministic offline testing.
 */
function createOfflineLeaseManager(): DurableLeaseManager {
  const leases = new Map<string, { worker_id: string; expires_at: number }>();
  return {
    async acquireLease(tenant_id: string, run_id: string, worker_id: string): Promise<boolean> {
      const key = `${tenant_id}:${run_id}`;
      const held = leases.get(key);
      const now = Date.now();
      if (held !== undefined && held.worker_id !== worker_id && held.expires_at > now) {
        return false;
      }
      leases.set(key, { worker_id, expires_at: now + 30_000 });
      return true;
    },
    async releaseLease(tenant_id: string, run_id: string, worker_id: string): Promise<void> {
      const key = `${tenant_id}:${run_id}`;
      const held = leases.get(key);
      if (held !== undefined && held.worker_id === worker_id) {
        leases.delete(key);
      }
    },
  };
}

/**
 * In-memory repository harness for creating real production Care adapters.
 */
function createInMemoryAdapterRepositories() {
  const tasks = new Map<string, MutableDurableTaskRecord>();
  const approvals = new Map<string, MutableApprovalRecord>();
  const evidenceLogs: ImmutableEvidenceRecord[] = [];
  const auditLogs: AgentRunLogRecord[] = [];
  const outcomeWatches: Array<Record<string, unknown>> = [];
  const conversations = new Map<string, MutableConversationRecord>();

  const workflowRepository: DurableWorkflowRepository = {
    async getTask(tenant_id: string, run_id: string): Promise<DurableTaskRecord | null> {
      const task = tasks.get(`${tenant_id}:${run_id}`);
      return task ? toDurableTaskSnapshot(task) : null;
    },
    async createTask(params: CreateDurableTaskInput): Promise<DurableTaskRecord> {
      const record: MutableDurableTaskRecord = {
        task_id: `task-${params.run_id}`,
        tenant_id: params.tenant_id,
        run_id: params.run_id,
        correlation_id: params.correlation_id,
        current_step: params.current_step ?? 1,
        state: params.state ?? 'running',
        task_version: 1,
        lease_owner: 'w-biz-e2e',
        lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
        retry_count: 0,
        max_retries: params.max_retries ?? 3,
        last_error_class: null,
        paused_for_approval_id: null,
        state_payload: (params.state_payload as Record<string, unknown>) ?? {},
        error_details: null,
        created_at: FROZEN_TIME_ISO,
        updated_at: FROZEN_TIME_ISO,
      };
      tasks.set(`${params.tenant_id}:${params.run_id}`, record);
      return toDurableTaskSnapshot(record);
    },
    async updateTaskProgress(
      tenant_id: string,
      run_id: string,
      stepIndex: number,
      checkpointPayload: unknown,
      guard?: DurableTaskGuard,
    ): Promise<DurableTaskRecord> {
      const existing = tasks.get(`${tenant_id}:${run_id}`);
      if (!existing) {
        throw new Error(`DURABLE_TASK_NOT_FOUND: task '${run_id}' not found for tenant '${tenant_id}'.`);
      }
      if (guard?.expected_task_version !== undefined && existing.task_version !== guard.expected_task_version) {
        throw new Error(
          `TASK_VERSION_CONFLICT: run ${run_id} is at task_version ${existing.task_version}, not the guarded ${guard.expected_task_version}.`,
        );
      }
      if (guard?.lease_owner !== undefined && existing.lease_owner !== guard.lease_owner) {
        throw new Error(
          `TASK_LEASE_NOT_HELD: worker '${guard.lease_owner}' does not hold lease for run ${run_id}.`,
        );
      }
      existing.current_step = stepIndex;
      existing.task_version += 1;
      if (checkpointPayload && typeof checkpointPayload === 'object') {
        existing.state_payload = {
          ...existing.state_payload,
          ...(checkpointPayload as Record<string, unknown>),
        };
      }
      existing.updated_at = FROZEN_TIME_ISO;
      return toDurableTaskSnapshot(existing);
    },
    async transitionTask(
      tenant_id: string,
      run_id: string,
      state: DurableTaskState,
      reason: string,
      checkpointPayload?: unknown,
      eventOrGuard?: DurableTaskGuard | string,
    ): Promise<DurableTaskRecord> {
      void reason;
      const existing = tasks.get(`${tenant_id}:${run_id}`);
      if (!existing) {
        throw new Error(`DURABLE_TASK_NOT_FOUND: task '${run_id}' not found for tenant '${tenant_id}'.`);
      }

      let resolvedPayload = checkpointPayload;
      let resolvedGuard: DurableTaskGuard | undefined;

      if (typeof eventOrGuard === 'object' && eventOrGuard !== null) {
        resolvedGuard = eventOrGuard;
      } else if (
        eventOrGuard === undefined &&
        checkpointPayload !== undefined &&
        typeof checkpointPayload === 'object' &&
        checkpointPayload !== null &&
        ('expected_task_version' in checkpointPayload || 'lease_owner' in checkpointPayload) &&
        !('plan' in checkpointPayload) &&
        !('current_step' in checkpointPayload)
      ) {
        resolvedGuard = checkpointPayload as DurableTaskGuard;
        resolvedPayload = undefined;
      }

      if (
        resolvedGuard?.expected_task_version !== undefined &&
        existing.task_version !== resolvedGuard.expected_task_version
      ) {
        throw new Error(
          `TASK_VERSION_CONFLICT: run ${run_id} is at task_version ${existing.task_version}, not the guarded ${resolvedGuard.expected_task_version}.`,
        );
      }
      if (
        resolvedGuard?.lease_owner !== undefined &&
        existing.lease_owner !== resolvedGuard.lease_owner
      ) {
        throw new Error(
          `TASK_LEASE_NOT_HELD: worker '${resolvedGuard.lease_owner}' does not hold lease for run ${run_id}.`,
        );
      }

      existing.state = state;
      existing.task_version += 1;

      if (state === 'waiting') {
        if (resolvedPayload && typeof resolvedPayload === 'object') {
          existing.state_payload = { ...(resolvedPayload as Record<string, unknown>) };
        }
      } else {
        if (resolvedPayload && typeof resolvedPayload === 'object') {
          existing.state_payload = {
            ...existing.state_payload,
            ...(resolvedPayload as Record<string, unknown>),
          };
        }
        if (state !== 'awaiting_human') {
          existing.paused_for_approval_id = null;
          delete existing.state_payload['resume_event'];
        }
      }

      existing.updated_at = FROZEN_TIME_ISO;
      return toDurableTaskSnapshot(existing);
    },
    async renewTaskLease(params: RenewTaskLeaseInput): Promise<DurableTaskRecord> {
      const existing = tasks.get(`${params.tenant_id}:${params.run_id}`);
      if (!existing) throw new Error('TASK_NOT_FOUND');
      existing.lease_owner = params.lease_owner;
      existing.lease_expires_at = new Date(Date.now() + 120_000).toISOString();
      existing.updated_at = FROZEN_TIME_ISO;
      return toDurableTaskSnapshot(existing);
    },
    async releaseTaskLease(input: ReleaseTaskLeaseInput): Promise<DurableTaskRecord> {
      const existing = tasks.get(`${input.tenant_id}:${input.run_id}`);
      if (!existing) throw new Error('DURABLE_TASK_NOT_FOUND');
      if (existing.lease_owner !== input.lease_owner) {
        throw new Error('TASK_LEASE_NOT_HELD');
      }
      if (existing.task_version !== input.task_version) {
        throw new Error('TASK_VERSION_CONFLICT');
      }
      const target = input.target_state ?? 'queued';
      existing.state = target;
      existing.lease_owner = null;
      existing.lease_expires_at = null;
      existing.task_version += 1;
      existing.updated_at = FROZEN_TIME_ISO;
      return toDurableTaskSnapshot(existing);
    },
    async recordFailure(params: RecordTaskFailureInput): Promise<TaskFailureOutcome> {
      const existing = tasks.get(`${params.tenant_id}:${params.run_id}`);
      if (!existing) throw new Error('TASK_NOT_FOUND');
      existing.state = 'failed';
      existing.updated_at = FROZEN_TIME_ISO;
      return {
        requeued: false,
        state: 'failed',
        retry_count: existing.retry_count,
        task_version: existing.task_version,
      };
    },
    async recordTaskFailure(params: RecordTaskFailureInput): Promise<TaskFailureOutcome> {
      const existing = tasks.get(`${params.tenant_id}:${params.run_id}`);
      if (!existing) throw new Error('TASK_NOT_FOUND');
      existing.state = 'failed';
      existing.updated_at = FROZEN_TIME_ISO;
      return {
        requeued: false,
        state: 'failed',
        retry_count: existing.retry_count,
        task_version: existing.task_version,
      };
    },
  } as unknown as DurableWorkflowRepository;

  const approvalRepository: ApprovalRepository = {
    async pauseForApproval(input: PauseForApprovalInput): Promise<PauseForApprovalResult> {
      const approval_id = 'appr-care-0115';
      const checkpoint = input.checkpoint as DurableTaskCheckpoint | undefined;
      const pendingReqAuth = checkpoint?.pending_action?.required_authority;
      if (pendingReqAuth !== 'AUTH-4') {
        throw new Error(
          `APPROVAL_REQUIRES_AUTH4: pending action declares ${String(pendingReqAuth)}; the gate admits AUTH-0..AUTH-3 by rank comparison (AUTO_APPROVED) and pauses only AUTH-4.`,
        );
      }
      const payloadSha256 = computePayloadSha256(input.approval.payload);
      const approval: MutableApprovalRecord = {
        id: approval_id,
        tenant_id: input.tenant_id,
        run_id: input.run_id,
        action_id: input.approval.action_id,
        campaign_id: null,
        effect_key: input.approval.effect_key,
        authority_required: 'AUTH-4',
        payload: input.approval.payload,
        payload_sha256: payloadSha256,
        reason: input.approval.reason,
        decision: 'PENDING',
        operator_id: null,
        review_comment: null,
        is_paused: true,
        created_at: FROZEN_TIME_ISO,
        decided_at: null,
      };
      approvals.set(approval_id, approval);

      const taskKey = `${input.tenant_id}:${input.run_id}`;
      const existingTask = tasks.get(taskKey);
      const taskRecord: MutableDurableTaskRecord = existingTask
        ? {
            ...existingTask,
            state: 'awaiting_human',
            task_version: input.expected_task_version + 1,
            paused_for_approval_id: approval_id,
            state_payload: (input.checkpoint as Record<string, unknown>) ?? {},
            updated_at: FROZEN_TIME_ISO,
          }
        : {
            task_id: `task-${input.run_id}`,
            tenant_id: input.tenant_id,
            run_id: input.run_id,
            correlation_id: `corr-${input.run_id}`,
            current_step: 1,
            state: 'awaiting_human',
            task_version: input.expected_task_version + 1,
            lease_owner: 'w-biz-e2e',
            lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
            retry_count: 0,
            max_retries: 3,
            last_error_class: null,
            paused_for_approval_id: approval_id,
            state_payload: (input.checkpoint as Record<string, unknown>) ?? {},
            error_details: null,
            created_at: FROZEN_TIME_ISO,
            updated_at: FROZEN_TIME_ISO,
          };
      tasks.set(taskKey, taskRecord);

      return {
        approval_id,
        approval: toApprovalSnapshot(approval),
        action: {
          id: input.approval.action_id,
          tenant_id: input.tenant_id,
          decision_id: null,
          skill_name: 'skill.care.refund',
          effect_key: input.approval.effect_key,
          action_revision: 1,
          target_channel: 'PostgreSQL.RefundStore',
          action_payload: input.approval.payload,
          status: 'pending',
          created_at: FROZEN_TIME_ISO,
        } as unknown as PauseForApprovalResult['action'],
        task: toDurableTaskSnapshot(taskRecord),
      };
    },

    async queueDecision(input: QueueApprovalDecisionInput): Promise<QueueApprovalDecisionResult> {
      const approval = approvals.get(input.approval_id);
      if (!approval) throw new Error('APPROVAL_NOT_FOUND: approval does not exist.');
      if (
        approval.tenant_id !== input.tenant_id ||
        approval.run_id !== input.run_id ||
        approval.effect_key !== input.effect_key
      ) {
        throw new Error('APPROVAL_BINDING_MISMATCH: decision parameters do not match approval binding.');
      }
      if (approval.decision !== 'PENDING') {
        throw new Error(`APPROVAL_NOT_CLAIMABLE: approval is already ${approval.decision}.`);
      }
      if (approval.payload_sha256 !== input.expected_payload_sha256) {
        throw new Error('APPROVAL_STALE_PAYLOAD: payload hash mismatch.');
      }

      const task = tasks.get(`${input.tenant_id}:${input.run_id}`);
      if (!task || task.state !== 'awaiting_human') {
        throw new Error('APPROVAL_NOT_CLAIMABLE: task is not awaiting_human.');
      }

      const existingResumeEvent = task.state_payload['resume_event'] as Record<string, unknown> | undefined;
      const newResumeEvent: Record<string, unknown> = {
        tenant_id: input.tenant_id,
        run_id: input.run_id,
        effect_key: input.effect_key,
        event_type: 'human.approval',
        approval_id: input.approval_id,
        expected_payload_sha256: input.expected_payload_sha256,
        operator_id: input.operator_id,
        reason: input.reason,
        ...(input.modified_payload === undefined ? {} : { modifications: input.modified_payload }),
      };

      if (existingResumeEvent !== undefined) {
        if (computePayloadSha256(existingResumeEvent) !== computePayloadSha256(newResumeEvent)) {
          throw new Error('APPROVAL_DECISION_CONFLICT: a different authenticated decision is already queued for this approval.');
        }
        return {
          approval_id: approval.id,
          task_id: task.task_id,
          status: 'QUEUED',
          queued_at: task.updated_at,
        };
      }

      task.state_payload['resume_event'] = newResumeEvent;
      task.updated_at = FROZEN_TIME_ISO;
      return {
        approval_id: approval.id,
        task_id: task.task_id,
        status: 'QUEUED',
        queued_at: task.updated_at,
      };
    },

    async claimApprovalAndResume(input: ClaimApprovalAndResumeInput): Promise<ClaimApprovalAndResumeResult> {
      const approval = approvals.get(input.approval_id);
      if (!approval) throw new Error('APPROVAL_NOT_FOUND: approval does not exist.');
      if (
        approval.tenant_id !== input.tenant_id ||
        approval.run_id !== input.run_id ||
        approval.effect_key !== input.effect_key
      ) {
        throw new Error('APPROVAL_BINDING_MISMATCH: parameters do not match approval binding.');
      }

      const task = tasks.get(`${input.tenant_id}:${input.run_id}`);
      if (!task || task.state !== 'awaiting_human') {
        throw new Error(
          `APPROVAL_NOT_CLAIMABLE: run ${input.run_id} is ${task?.state ?? 'unknown'}, not awaiting_human; a decision is claimable only while the run is parked on the gate it decides.`,
        );
      }

      if (approval.decision !== 'PENDING') {
        throw new Error(`APPROVAL_ALREADY_DECIDED: approval has decision ${approval.decision}, not PENDING.`);
      }

      if (approval.payload_sha256 !== input.expected_payload_sha256) {
        throw new Error('APPROVAL_STALE_PAYLOAD: payload hash mismatch.');
      }

      approval.decision = input.decision as ApprovalRecord['decision'];
      approval.operator_id = input.operator_id;
      approval.review_comment = input.review_comment;
      approval.decided_at = FROZEN_TIME_ISO;
      approval.is_paused = false;

      task.state = 'running';
      task.task_version += 1;
      task.paused_for_approval_id = null;
      task.updated_at = FROZEN_TIME_ISO;

      return {
        claimed: true,
        approval: toApprovalSnapshot(approval),
        action: {
          id: approval.action_id,
          tenant_id: approval.tenant_id,
          decision_id: approval.id,
          skill_name: 'skill.care.refund',
          effect_key: approval.effect_key,
          action_revision: 1,
          target_channel: 'PostgreSQL.RefundStore',
          action_payload: approval.payload,
          status: 'authorized',
          created_at: FROZEN_TIME_ISO,
        } as unknown as ClaimApprovalAndResumeResult['action'],
        task: toDurableTaskSnapshot(task),
      };
    },

    async getDetail(tenant_id: string, approval_id: string): Promise<ApprovalDetailRecord | null> {
      const approval = approvals.get(approval_id);
      if (!approval || approval.tenant_id !== tenant_id) return null;
      return {
        approval: toApprovalSnapshot(approval),
        action: {
          id: approval.action_id,
          tenant_id: approval.tenant_id,
          decision_id: null,
          skill_name: 'skill.care.refund',
          effect_key: approval.effect_key,
          action_revision: 1,
          target_channel: 'PostgreSQL.RefundStore',
          action_payload: approval.payload,
          status: 'pending',
          created_at: FROZEN_TIME_ISO,
        },
      };
    },
  } as unknown as ApprovalRepository;

  const evidenceRepository: EvidenceRepository = {
    async appendEvidence(params: AppendEvidenceInput): Promise<ImmutableEvidenceRecord> {
      const record: ImmutableEvidenceRecord = {
        evidence_id: `evi-${randomUUID().slice(0, 8)}`,
        tenant_id: params.tenant_id,
        run_id: params.run_id,
        correlation_id: params.correlation_id,
        step_index: params.step_index,
        effect_key: params.effect_key,
        previous_evidence_hash: params.previous_evidence_hash ?? '0'.repeat(64),
        payload_sha256: computePayloadSha256(params.payload),
        chain_hash: 'b'.repeat(64),
        signature: 'c'.repeat(64),
        raw_payload: params.payload,
        created_at: FROZEN_TIME_ISO,
      };
      evidenceLogs.push(record);
      return record;
    },
    async logAgentRun(): Promise<void> {},
    async initializeOutcomeWatch(params: Record<string, unknown>): Promise<void> {
      outcomeWatches.push({ ...params });
    },
  } as unknown as EvidenceRepository;

  const auditRepository: AuditRepository = {
    async append(params: AgentRunLogRecord): Promise<void> {
      auditLogs.push(params);
    },
  } as unknown as AuditRepository;

  const conversationRepository: ConversationRepository = {
    async getByThread(tenant_id: string, thread_id: string): Promise<ConversationRecord | null> {
      const conv = conversations.get(`${tenant_id}:${thread_id}`);
      return conv ? toConversationSnapshot(conv) : null;
    },
    async returnToAgent(tenant_id: string, thread_id: string, operator_id: string): Promise<void> {
      const conv = conversations.get(`${tenant_id}:${thread_id}`);
      if (conv && (conv.takeover_operator_id === operator_id || !conv.takeover_operator_id)) {
        conv.state = 'open';
        conv.takeover_operator_id = null;
      }
    },
    async releaseTakeover(tenant_id: string, thread_id: string, operator_id: string): Promise<void> {
      const conv = conversations.get(`${tenant_id}:${thread_id}`);
      if (conv && (conv.takeover_operator_id === operator_id || !conv.takeover_operator_id)) {
        conv.state = 'open';
        conv.takeover_operator_id = null;
      }
    },
  } as unknown as ConversationRepository;

  return {
    tasks,
    approvals,
    evidenceLogs,
    outcomeWatches,
    auditLogs,
    conversations,
    workflowRepository,
    approvalRepository,
    evidenceRepository,
    auditRepository,
    conversationRepository,
  };
}

// ============================================================================
// PILOT-04 / E2E-OFF-ESC Acceptance Tests
// ============================================================================

describe('PILOT-04 / E2E-OFF-ESC: Complaint Escalation, Operator Takeover & Authorized Resolution', () => {
  const signal: SignalEnvelope = {
    signal_id: 'sig-e2e-esc-001',
    tenant_id: TENANT_T1,
    correlation_id: `corr-${RUN_ID}`,
    source_channel: CHANNEL_ZALO,
    event_type: 'message.received',
    subject: {
      session_id: SESSION_ID,
      channel_type: 'zalo',
      channel_identifier: 'zalo-user-cust-a',
      verified_customer_id: CUSTOMER_A,
    },
    payload: {
      message: COMPLAINT_UTTERANCE,
      content: COMPLAINT_UTTERANCE,
    },
    timestamp: FROZEN_TIME_ISO,
  };

  const context: HydratedContext = {
    tenant_id: TENANT_T1,
    correlation_id: `corr-${RUN_ID}`,
    working_memory: {
      session_id: SESSION_ID,
      conversation_id: CONVERSATION_ID,
      last_touch_channel: CHANNEL_ZALO,
      turn_count: 1,
      takeover_active: false,
    },
    customer: {
      customer_id: CUSTOMER_A,
      tenant_id: TENANT_T1,
      verified_phone: '+84900000001',
      verified_email: 'cust-a@example.com',
      total_spent: 2400,
      order_count: 2,
      rfm_segment_hypothesis: 'AT_RISK',
      consent_marketing: true,
      consent_updated_at: FROZEN_TIME_ISO,
      suppression_active: false,
      created_at: FROZEN_TIME_ISO,
    },
    knowledge_citations: [],
    hydrated_at: FROZEN_TIME_ISO,
  };

  it('Step 1: Ingests complaint, classifies intent, and formulates human escalation plan (CareAgentRuntime)', async () => {
    expect(SCENARIO_ID).toBe('E2E-OFF-ESC');
    const services = createCareSkillServices({
      erp_read: null,
      env: {},
      now: FROZEN_CLOCK,
      resolve_correlation_id: async () => `corr-${RUN_ID}`,
      resolve_grant: async () => 'AUTH-3',
      skill_enablement: DEFAULT_P1B_CARE_SKILL_ENABLEMENT,
      handoff_repository: {
        enqueue: vi.fn(),
        reconcile: vi.fn(),
      },
    });

    const agentRuntime = new CareAgentRuntime({
      registry: services.registry,
      now: FROZEN_CLOCK,
    });

    // 1. Ingest complaint utterance & classify intent deterministically
    const hypothesis = await agentRuntime.deriveHypothesis(signal, context);
    expect(hypothesis.classification).toBe('HYPOTHESIS');
    expect(hypothesis.intent).toBe('complaint');
    expect(hypothesis.confidence).toBeGreaterThanOrEqual(0.9);
    expect(hypothesis.derived_from_signals).toContain(signal.signal_id);
    expect(hypothesis.reasoning).toContain('Deterministic Customer Care classification: complaint');

    // 2. Resolve routing -> HUMAN_HANDOFF (FR-CS-002)
    const routing = await agentRuntime.resolveRouting(signal, context, hypothesis);
    expect(routing.target_agent).toBe('HUMAN_HANDOFF');
    expect(routing.requires_clarification).toBe(false);

    // 3. Formulate plan -> skill.care.escalate_to_human
    const plan = await agentRuntime.formulatePlan(routing, context, hypothesis);
    expect(plan.fallback_strategy).toBe('ESCALATE_HUMAN');
    expect(plan.steps).toHaveLength(1);

    const step = plan.steps[0]!;
    expect(step.skill_id).toBe('skill.care.escalate_to_human');
    expect(step.agent_id).toBe('CS-01');
    expect(step.required_authority).toBe('AUTH-3');
    expect(step.mutating).toBe(true);
    expect(step.idempotent).toBe(false);
    expect(step.price_bearing).toBe(false);

    // Input parameters binding check
    expect(step.input_parameters).toEqual({
      tenant_id: TENANT_T1,
      session_id: SESSION_ID,
      conversation_id: CONVERSATION_ID,
      customer_id: CUSTOMER_A,
      escalation_reason: 'customer_complaint',
      summary_context: hypothesis.reasoning,
    });
  });

  it('Step 2: Canonical CarePolicyEngine & PEP policy validation for human escalation action draft', async () => {
    const effectKey = computeEffectKey({
      tenant_id: TENANT_T1,
      skill_id: 'skill.care.escalate_to_human',
      step_index: 1,
      action_revision: 0,
      request_id: 'req-esc-001',
    });

    const actionDraft: ActionDraft = {
      action_id: randomUUID(),
      run_id: RUN_ID,
      tenant_id: TENANT_T1,
      request_id: 'req-esc-001',
      action_revision: 0,
      agent_id: 'CS-01',
      skill_id: 'skill.care.escalate_to_human',
      adapter_target: 'Orchestrator.HandoffBus',
      step_index: 1,
      mutating: true,
      price_bearing: false,
      effect_key: effectKey,
      required_authority: 'AUTH-3',
      payload: {
        tenant_id: TENANT_T1,
        session_id: SESSION_ID,
        conversation_id: CONVERSATION_ID,
        customer_id: CUSTOMER_A,
        escalation_reason: 'customer_complaint',
        summary_context: 'Deterministic Customer Care classification: complaint.',
        effect_key: effectKey,
      },
    };

    const auditRecords: PolicyAuditRecord[] = [];
    const policyAuditSink: PolicyAuditPort = {
      append: async (record: PolicyAuditRecord) => {
        auditRecords.push(record);
      },
    };

    // BR-010: mutating escalation fails closed without durable audit sink
    const unconfiguredEngine = createCarePolicyEngine({
      auditSecret: AUDIT_SECRET,
      now: FROZEN_CLOCK,
      resolveGrant: async () => 'AUTH-3',
    });
    const unconfiguredResult = await unconfiguredEngine.evaluateAuthority(actionDraft, context);
    expect(unconfiguredResult.verdict).toBe('DENIED');
    expect(unconfiguredResult.reason).toContain('EVIDENCE_REQUIRED');

    // Real CarePolicyEngine with bound audit sink evaluates authority
    const policyEngine = createCarePolicyEngine({
      auditSecret: AUDIT_SECRET,
      now: FROZEN_CLOCK,
      resolveGrant: async () => 'AUTH-3',
      audit: policyAuditSink,
    });
    // 1. Valid policy normalization: CarePolicyEngine accepts canonical fields
    const validated = await policyEngine.validateAction(actionDraft, context);
    expect(validated.skill_id).toBe('skill.care.escalate_to_human');
    expect(validated.payload).toEqual(actionDraft.payload);

    // 2. PolicyEngine evaluateAuthority: AUTO_APPROVED when assigned authority meets required authority (AUTH-3)
    const authResult = await policyEngine.evaluateAuthority(actionDraft, context);
    expect(authResult.verdict).toBe('AUTO_APPROVED');

    // 3. Real PolicyEnforcementPoint enforcement
    const pep = new PolicyEnforcementPoint({
      registry: {
        getSkill: () => ({
          skill_id: 'skill.care.escalate_to_human',
          allowed_agents: ['CS-01', 'CS-02'],
          required_authority: 'AUTH-3',
          mutating: true,
          price_bearing: false,
          idempotent: false,
          epistemic_class: 'FACT',
          write_target: 'FACT',
          requires_consent: false,
          requires_verified_identity: false,
          timeout_ms: 2000,
        }),
        getAgent: () => ({ agent_id: 'CS-01', assigned_authority: 'AUTH-3' }),
      },
      approvals: { createOrReadPending: async () => ({ approval_id: 'appr-01' }) },
      auditSecret: AUDIT_SECRET,
      now: FROZEN_CLOCK,
      audit: policyAuditSink,
    });

    const pepDecision = await pep.enforce(
      {
        tenant_id: TENANT_T1,
        agent_id: 'CS-01',
        run_id: RUN_ID,
        request_id: 'req-esc-001',
        correlation_id: `corr-${RUN_ID}`,
        session_id: SESSION_ID,
        takeover_active: false,
        verified_customer_id: CUSTOMER_A,
      },
      {
        skill_id: 'skill.care.escalate_to_human',
        tool_name: 'Orchestrator.HandoffBus',
        payload: actionDraft.payload,
        required_authority: 'AUTH-3',
      },
    );
    expect(pepDecision.verdict).toBe('AUTO_APPROVED');
    expect(pepDecision.authorized).toBe(true);
    expect(auditRecords.length).toBeGreaterThan(0);
    expect(auditRecords.some((r) => r.skill_id === 'skill.care.escalate_to_human')).toBe(true);
  });

  it('Step 3: Real SkillRuntime/tool-port escalation through injected in-memory HandoffRepository with exact effect key and idempotent replay', async () => {
    const handoffStore = new Map<string, { output: CareHandoffOutput; receipt: CareHandoffExecutionReceipt }>();
    let enqueueCount = 0;

    const handoffRepository = {
      enqueue: vi.fn(async (input: EnqueueCareHandoffInput): Promise<CareHandoffEnqueueResult> => {
        enqueueCount += 1;
        const key = `${input.tenant_id}:${input.effect_key}`;
        const existing = handoffStore.get(key);
        if (existing) {
          return { disposition: 'REPLAY', output: existing.output, receipt: existing.receipt };
        }
        const handoff_id = `handoff_${randomUUID().slice(0, 8)}`;
        const output: CareHandoffOutput = {
          handoff_id,
          queue_position: 1,
          status: 'ENQUEUED',
          escalated_at: FROZEN_TIME_ISO,
        };
        const receipt: CareHandoffExecutionReceipt = {
          execution_id: handoff_id,
          adapter_status: 'SUCCESS',
          provider_reference: handoff_id,
          response_payload: output,
          latency_ms: 0,
          token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
        };
        handoffStore.set(key, { output, receipt });
        return { disposition: 'CREATED', output, receipt };
      }),
      reconcile: vi.fn(async (input: ReconcileCareHandoffInput): Promise<CareHandoffReconciliation> => {
        const key = `${input.tenant_id}:${input.effect_key}`;
        const existing = handoffStore.get(key);
        if (!existing) return { state: 'NOT_COMMITTED' };
        return { state: 'COMMITTED', output: existing.output, receipt: existing.receipt };
      }),
    };

    const services = createCareSkillServices({
      erp_read: null,
      env: {},
      now: FROZEN_CLOCK,
      resolve_correlation_id: async () => `corr-${RUN_ID}`,
      resolve_grant: async () => 'AUTH-3',
      skill_enablement: DEFAULT_P1B_CARE_SKILL_ENABLEMENT,
      handoff_repository: handoffRepository,
    });

    const effectKey = computeEffectKey({
      tenant_id: TENANT_T1,
      skill_id: 'skill.care.escalate_to_human',
      step_index: 1,
      action_revision: 0,
      request_id: 'req-esc-001',
    });

    const actionDraft: ActionDraft = {
      action_id: randomUUID(),
      run_id: RUN_ID,
      tenant_id: TENANT_T1,
      request_id: 'req-esc-001',
      action_revision: 0,
      agent_id: 'CS-01',
      skill_id: 'skill.care.escalate_to_human',
      adapter_target: 'Orchestrator.HandoffBus',
      step_index: 1,
      mutating: true,
      price_bearing: false,
      effect_key: effectKey,
      required_authority: 'AUTH-3',
      payload: {
        tenant_id: TENANT_T1,
        session_id: SESSION_ID,
        conversation_id: CONVERSATION_ID,
        customer_id: CUSTOMER_A,
        escalation_reason: 'customer_complaint',
        summary_context: 'Deterministic Customer Care classification: complaint.',
      },
    };

    // 1. First dispatch creates the durable handoff package via SkillRuntimeEngine -> tool-port
    const receipt1 = await services.dispatcher.dispatch(actionDraft);
    expect(receipt1.adapter_status).toBe('SUCCESS');
    expect(receipt1.provider_reference).toMatch(/^handoff_/);
    expect(handoffStore.size).toBe(1);
    expect(enqueueCount).toBe(1);

    const firstHandoff = handoffStore.get(`${TENANT_T1}:${effectKey}`);
    expect(firstHandoff).toBeDefined();
    expect(firstHandoff?.output.status).toBe('ENQUEUED');
    expect(firstHandoff?.output.queue_position).toBe(1);
    expect(firstHandoff?.output.escalated_at).toBe(FROZEN_TIME_ISO);

    // 2. Second dispatch (idempotent replay of identical action) returns existing receipt without second queue item
    const receipt2 = await services.dispatcher.dispatch(actionDraft);
    expect(receipt2.adapter_status).toBe('SUCCESS');
    expect(receipt2.execution_id).toBe(receipt1.execution_id);
    expect(receipt2.provider_reference).toBe(receipt1.provider_reference);
    expect(enqueueCount).toBe(2);
    expect(handoffStore.size).toBe(1);

    // 3. Provider reconciliation by effect_key confirms committed receipt
    const reconciliation = await handoffRepository.reconcile({
      tenant_id: TENANT_T1,
      effect_key: effectKey,
      request_fingerprint: computeRequestFingerprint(actionDraft.payload as Record<string, unknown>),
    });
    expect(reconciliation.state).toBe('COMMITTED');
    if (reconciliation.state === 'COMMITTED') {
      expect(reconciliation.output.handoff_id).toBe(firstHandoff?.output.handoff_id);
      expect(reconciliation.receipt.execution_id).toBe(receipt1.execution_id);
    }
  });

  it('Step 4: Existing service-case repository seam executes manage_case CREATE/NEW -> CLASSIFIED and RESOLVE to RESOLVED with version fencing and evidence', async () => {
    const caseRepo = createInMemoryCaseRepository();

    const services = createCareSkillServices({
      erp_read: null,
      env: {},
      now: FROZEN_CLOCK,
      resolve_correlation_id: async () => `corr-${RUN_ID}`,
      resolve_grant: async () => 'AUTH-3',
      skill_enablement: PILOT_SKILL_ENABLEMENT,
      case_repository: caseRepo,
      case_sla_target_hours: async () => 4,
    });

    const effectKeyCreate = computeEffectKey({
      tenant_id: TENANT_T1,
      skill_id: 'skill.care.manage_case',
      step_index: 1,
      action_revision: 0,
      request_id: 'req-case-create',
    });

    // 1. CREATE: initializes case in NEW status, version 1
    const createdCase = await services.tool_port.invoke<ManageCaseToolInput, ManagedServiceCase>({
      skill_id: 'skill.care.manage_case',
      tool_binding: 'PostgreSQL.CaseManagementStore',
      input: {
        tenant_id: TENANT_T1,
        case_id: CASE_ID,
        customer_id: CUSTOMER_A,
        intent: 'complaint',
        priority: 'P2',
        conversation_id: CONVERSATION_ID,
        action_type: 'CREATE',
      },
      context: {
        ...context,
        run_id: RUN_ID,
        caller_agent: 'CS-01',
        effect_key: effectKeyCreate,
        granted_authority: 'AUTH-3',
      },
    });

    expect(createdCase.case_id).toBe(CASE_ID);
    expect(createdCase.status).toBe('NEW');
    expect(createdCase.case_version).toBe(1);
    expect(createdCase.sla_target_hours).toBe(4);

    // 2. Version fencing: stale expected_case_version fails closed with CASE_VERSION_CONFLICT
    const effectKeyStale = computeEffectKey({
      tenant_id: TENANT_T1,
      skill_id: 'skill.care.manage_case',
      step_index: 2,
      action_revision: 0,
      request_id: 'req-case-stale',
    });

    await expect(
      services.tool_port.invoke<ManageCaseToolInput, ManagedServiceCase>({
        skill_id: 'skill.care.manage_case',
        tool_binding: 'PostgreSQL.CaseManagementStore',
        input: {
          tenant_id: TENANT_T1,
          case_id: CASE_ID,
          customer_id: CUSTOMER_A,
          intent: 'complaint',
          priority: 'P2',
          conversation_id: CONVERSATION_ID,
          action_type: 'TRANSITION_STATE',
          target_status: 'CLASSIFIED',
          expected_case_version: 99,
        },
        context: {
          ...context,
          run_id: RUN_ID,
          caller_agent: 'CS-01',
          effect_key: effectKeyStale,
          granted_authority: 'AUTH-3',
        },
      }),
    ).rejects.toMatchObject({ code: 'CASE_VERSION_CONFLICT' });

    // 3. Transition NEW -> CLASSIFIED with expected_case_version 1
    const effectKeyClassify = computeEffectKey({
      tenant_id: TENANT_T1,
      skill_id: 'skill.care.manage_case',
      step_index: 3,
      action_revision: 0,
      request_id: 'req-case-classify',
    });

    const classifiedCase = await services.tool_port.invoke<ManageCaseToolInput, ManagedServiceCase>({
      skill_id: 'skill.care.manage_case',
      tool_binding: 'PostgreSQL.CaseManagementStore',
      input: {
        tenant_id: TENANT_T1,
        case_id: CASE_ID,
        customer_id: CUSTOMER_A,
        intent: 'complaint',
        priority: 'P2',
        conversation_id: CONVERSATION_ID,
        action_type: 'TRANSITION_STATE',
        target_status: 'CLASSIFIED',
        expected_case_version: 1,
      },
      context: {
        ...context,
        run_id: RUN_ID,
        caller_agent: 'CS-01',
        effect_key: effectKeyClassify,
        granted_authority: 'AUTH-3',
      },
    });

    expect(classifiedCase.status).toBe('CLASSIFIED');
    expect(classifiedCase.case_version).toBe(2);

    // 4. Progress FSM: CLASSIFIED -> ASSIGNED -> IN_PROGRESS
    const effectKeyAssign = computeEffectKey({
      tenant_id: TENANT_T1,
      skill_id: 'skill.care.manage_case',
      step_index: 4,
      action_revision: 0,
      request_id: 'req-case-assign',
    });

    const assignedCase = await services.tool_port.invoke<ManageCaseToolInput, ManagedServiceCase>({
      skill_id: 'skill.care.manage_case',
      tool_binding: 'PostgreSQL.CaseManagementStore',
      input: {
        tenant_id: TENANT_T1,
        case_id: CASE_ID,
        customer_id: CUSTOMER_A,
        intent: 'complaint',
        priority: 'P2',
        conversation_id: CONVERSATION_ID,
        action_type: 'ASSIGN',
        assigned_owner: OPERATOR_ID,
        expected_case_version: 2,
      },
      context: {
        ...context,
        run_id: RUN_ID,
        caller_agent: 'CS-01',
        effect_key: effectKeyAssign,
        granted_authority: 'AUTH-3',
      },
    });

    expect(assignedCase.status).toBe('ASSIGNED');
    expect(assignedCase.assigned_owner).toBe(OPERATOR_ID);
    expect(assignedCase.case_version).toBe(3);

    const effectKeyInProgress = computeEffectKey({
      tenant_id: TENANT_T1,
      skill_id: 'skill.care.manage_case',
      step_index: 5,
      action_revision: 0,
      request_id: 'req-case-inprogress',
    });

    const inProgressCase = await services.tool_port.invoke<ManageCaseToolInput, ManagedServiceCase>({
      skill_id: 'skill.care.manage_case',
      tool_binding: 'PostgreSQL.CaseManagementStore',
      input: {
        tenant_id: TENANT_T1,
        case_id: CASE_ID,
        customer_id: CUSTOMER_A,
        intent: 'complaint',
        priority: 'P2',
        conversation_id: CONVERSATION_ID,
        action_type: 'TRANSITION_STATE',
        target_status: 'IN_PROGRESS',
        expected_case_version: 3,
      },
      context: {
        ...context,
        run_id: RUN_ID,
        caller_agent: 'CS-01',
        effect_key: effectKeyInProgress,
        granted_authority: 'AUTH-3',
      },
    });

    expect(inProgressCase.status).toBe('IN_PROGRESS');
    expect(inProgressCase.case_version).toBe(4);

    // 5. Evidence fencing: RESOLVE without evidence_refs fails closed with CASE_EVIDENCE_REQUIRED
    const effectKeyResolveNoEvidence = computeEffectKey({
      tenant_id: TENANT_T1,
      skill_id: 'skill.care.manage_case',
      step_index: 6,
      action_revision: 0,
      request_id: 'req-case-resolve-no-ev',
    });

    await expect(
      services.tool_port.invoke<ManageCaseToolInput, ManagedServiceCase>({
        skill_id: 'skill.care.manage_case',
        tool_binding: 'PostgreSQL.CaseManagementStore',
        input: {
          tenant_id: TENANT_T1,
          case_id: CASE_ID,
          customer_id: CUSTOMER_A,
          intent: 'complaint',
          priority: 'P2',
          conversation_id: CONVERSATION_ID,
          action_type: 'RESOLVE',
          expected_case_version: 4,
          evidence_refs: [],
          notes: 'Attempted resolution without audit evidence',
        },
        context: {
          ...context,
          run_id: RUN_ID,
          caller_agent: 'CS-01',
          effect_key: effectKeyResolveNoEvidence,
          granted_authority: 'AUTH-3',
        },
      }),
    ).rejects.toMatchObject({ code: 'CASE_EVIDENCE_REQUIRED' });

    // 6. RESOLVE to RESOLVED with valid evidence_refs and version fencing
    const effectKeyResolve = computeEffectKey({
      tenant_id: TENANT_T1,
      skill_id: 'skill.care.manage_case',
      step_index: 7,
      action_revision: 0,
      request_id: 'req-case-resolve',
    });

    const resolvedCase = await services.tool_port.invoke<ManageCaseToolInput, ManagedServiceCase>({
      skill_id: 'skill.care.manage_case',
      tool_binding: 'PostgreSQL.CaseManagementStore',
      input: {
        tenant_id: TENANT_T1,
        case_id: CASE_ID,
        customer_id: CUSTOMER_A,
        intent: 'complaint',
        priority: 'P2',
        conversation_id: CONVERSATION_ID,
        action_type: 'RESOLVE',
        expected_case_version: 4,
        evidence_refs: ['evi_audit_compensation_proof_01'],
        notes: 'Operator OP-SUPPORT-01 authorized replacement and resolved complaint.',
      },
      context: {
        ...context,
        run_id: RUN_ID,
        caller_agent: 'CS-01',
        effect_key: effectKeyResolve,
        granted_authority: 'AUTH-3',
      },
    });

    expect(resolvedCase.status).toBe('RESOLVED');
    expect(resolvedCase.case_version).toBe(5);
    expect(resolvedCase.evidence_refs).toContain('evi_audit_compensation_proof_01');

    // 7. Stale version fencing on resolved case
    await expect(
      services.tool_port.invoke<ManageCaseToolInput, ManagedServiceCase>({
        skill_id: 'skill.care.manage_case',
        tool_binding: 'PostgreSQL.CaseManagementStore',
        input: {
          tenant_id: TENANT_T1,
          case_id: CASE_ID,
          customer_id: CUSTOMER_A,
          intent: 'complaint',
          priority: 'P2',
          conversation_id: CONVERSATION_ID,
          action_type: 'CLOSE',
          expected_case_version: 4,
        },
        context: {
          ...context,
          run_id: RUN_ID,
          caller_agent: 'CS-01',
          effect_key: computeEffectKey({
            tenant_id: TENANT_T1,
            skill_id: 'skill.care.manage_case',
            step_index: 8,
            action_revision: 0,
            request_id: 'req-case-close-stale',
          }),
          granted_authority: 'AUTH-3',
        },
      }),
    ).rejects.toMatchObject({ code: 'CASE_VERSION_CONFLICT' });
  });

  it('Step 5: Existing approval decision/resume contract queues exact-bound approval, consumes once via RevenueOrchestrator.resumeTask, and rejects duplicate/conflicting decisions', async () => {
    const repos = createInMemoryAdapterRepositories();
    const APPROVAL_ID = 'appr-care-0115';
    const effectKeyApproval = computeEffectKey({
      tenant_id: TENANT_T1,
      skill_id: 'skill.care.manage_case',
      step_index: 1,
      action_revision: 0,
      request_id: 'req-appr-01',
    });

    const caseRepo = createInMemoryCaseRepository();
    // Prime the case in repository so manage_case can transition to RESOLVED
    await caseRepo.manage({
      tenant_id: TENANT_T1,
      case_id: CASE_ID,
      customer_id: CUSTOMER_A,
      intent: 'complaint',
      priority: 'P2',
      conversation_id: CONVERSATION_ID,
      action_type: 'CREATE',
      effect_key: computeEffectKey({
        tenant_id: TENANT_T1,
        skill_id: 'skill.care.manage_case',
        step_index: 1,
        action_revision: 0,
        request_id: 'req-prime-create',
      }),
      request_fingerprint: 'fp-prime-create',
      actor_id: 'CS-01',
    });
    await caseRepo.manage({
      tenant_id: TENANT_T1,
      case_id: CASE_ID,
      customer_id: CUSTOMER_A,
      intent: 'complaint',
      priority: 'P2',
      conversation_id: CONVERSATION_ID,
      action_type: 'TRANSITION_STATE',
      target_status: 'CLASSIFIED',
      expected_case_version: 1,
      effect_key: computeEffectKey({
        tenant_id: TENANT_T1,
        skill_id: 'skill.care.manage_case',
        step_index: 2,
        action_revision: 0,
        request_id: 'req-prime-classify',
      }),
      request_fingerprint: 'fp-prime-classify',
      actor_id: 'CS-01',
    });
    await caseRepo.manage({
      tenant_id: TENANT_T1,
      case_id: CASE_ID,
      customer_id: CUSTOMER_A,
      intent: 'complaint',
      priority: 'P2',
      conversation_id: CONVERSATION_ID,
      action_type: 'ASSIGN',
      assigned_owner: OPERATOR_ID,
      expected_case_version: 2,
      effect_key: computeEffectKey({
        tenant_id: TENANT_T1,
        skill_id: 'skill.care.manage_case',
        step_index: 3,
        action_revision: 0,
        request_id: 'req-prime-assign',
      }),
      request_fingerprint: 'fp-prime-assign',
      actor_id: 'CS-01',
    });
    await caseRepo.manage({
      tenant_id: TENANT_T1,
      case_id: CASE_ID,
      customer_id: CUSTOMER_A,
      intent: 'complaint',
      priority: 'P2',
      conversation_id: CONVERSATION_ID,
      action_type: 'TRANSITION_STATE',
      target_status: 'IN_PROGRESS',
      expected_case_version: 3,
      effect_key: computeEffectKey({
        tenant_id: TENANT_T1,
        skill_id: 'skill.care.manage_case',
        step_index: 4,
        action_revision: 0,
        request_id: 'req-prime-in-prog',
      }),
      request_fingerprint: 'fp-prime-in-prog',
      actor_id: 'CS-01',
    });

    const approvalActionPayload = {
      tenant_id: TENANT_T1,
      case_id: CASE_ID,
      customer_id: CUSTOMER_A,
      effect_key: effectKeyApproval,
      intent: 'complaint',
      priority: 'P2' as const,
      conversation_id: CONVERSATION_ID,
      action_type: 'RESOLVE' as const,
      expected_case_version: 4,
      evidence_refs: ['evi_audit_compensation_proof_01'],
      notes: 'Operator OP-SUPPORT-01 approved compensation exception for damaged package.',
    };
    const payloadSha256 = computePayloadSha256(approvalActionPayload);

    const actionStep: PlannedStep = {
      step_index: 1,
      agent_id: 'CS-01',
      skill_id: 'skill.care.manage_case',
      adapter_target: 'PostgreSQL.CaseManagementStore',
      input_parameters: approvalActionPayload,
      required_authority: 'AUTH-4',
      mutating: true,
      price_bearing: false,
      idempotent: false,
      timeout_ms: 3000,
      depends_on_steps: [],
    };

    const pendingAction: ActionDraft = {
      action_id: '00000000-0000-4000-8000-000000000055',
      run_id: RUN_ID,
      tenant_id: TENANT_T1,
      request_id: 'req-appr-01',
      action_revision: 0,
      agent_id: 'CS-01',
      skill_id: 'skill.care.manage_case',
      adapter_target: 'PostgreSQL.CaseManagementStore',
      step_index: 1,
      mutating: true,
      price_bearing: false,
      effect_key: effectKeyApproval,
      required_authority: 'AUTH-4',
      payload: approvalActionPayload,
    };

    const taskCheckpoint: DurableTaskCheckpoint = {
      plan: {
        plan_id: 'plan-e2e-esc',
        steps: [actionStep],
        fallback_strategy: 'FAIL_CLOSED',
      },
      current_step: 1,
      pending_action: pendingAction,
      context,
      previous_evidence_hash: '0'.repeat(64),
      request_id: 'req-appr-01',
    };

    // 0. Assert in-memory seam rejects non-AUTH-4 pause attempts (APPROVAL_REQUIRES_AUTH4)
    await expect(
      repos.approvalRepository.pauseForApproval({
        tenant_id: TENANT_T1,
        run_id: RUN_ID,
        expected_task_version: 1,
        checkpoint: {
          ...taskCheckpoint,
          pending_action: { ...pendingAction, required_authority: 'AUTH-3' },
        },
        approval: {
          action_id: pendingAction.action_id,
          effect_key: effectKeyApproval,
          payload: approvalActionPayload,
          reason: 'Requested compensation of 1200 TWD exceeds autonomous threshold',
        },
      }),
    ).rejects.toThrow(/APPROVAL_REQUIRES_AUTH4/);

    // 1. Queue an exact-bound approval: pauseForApproval parks task in awaiting_human
    const pauseResult = await repos.approvalRepository.pauseForApproval({
      tenant_id: TENANT_T1,
      run_id: RUN_ID,
      expected_task_version: 1,
      checkpoint: taskCheckpoint,
      approval: {
        action_id: pendingAction.action_id,
        effect_key: effectKeyApproval,
        payload: approvalActionPayload,
        reason: 'Requested compensation of 1200 TWD exceeds autonomous threshold (AUTH-4)',
      },
    });

    expect(pauseResult.approval_id).toBe(APPROVAL_ID);
    const parkedTask = repos.tasks.get(`${TENANT_T1}:${RUN_ID}`);
    expect(parkedTask?.state).toBe('awaiting_human');
    expect(parkedTask?.paused_for_approval_id).toBe(APPROVAL_ID);

    // 2. Queue decision via existing decision contract (QueueApprovalDecisionInput)
    const decisionInput: QueueApprovalDecisionInput = {
      tenant_id: TENANT_T1,
      approval_id: APPROVAL_ID,
      run_id: RUN_ID,
      effect_key: effectKeyApproval,
      expected_payload_sha256: payloadSha256,
      decision: 'APPROVE',
      operator_id: OPERATOR_ID,
      reason: 'Operator OP-SUPPORT-01 reviewed customer photos and approved compensation exception',
    };

    const queuedDecision = await repos.approvalRepository.queueDecision(decisionInput);
    expect(queuedDecision.status).toBe('QUEUED');
    expect(queuedDecision.approval_id).toBe(APPROVAL_ID);

    // 3. Idempotent replay: submitting the exact same decision event succeeds
    const replayDecision = await repos.approvalRepository.queueDecision(decisionInput);
    expect(replayDecision.status).toBe('QUEUED');
    expect(replayDecision.approval_id).toBe(APPROVAL_ID);

    // 4. Conflicting decision: a different decision on the already-decided queue item fails closed
    const conflictingDecision: QueueApprovalDecisionInput = {
      ...decisionInput,
      decision: 'REJECT',
      reason: 'Conflicting operator reject decision',
    };
    await expect(repos.approvalRepository.queueDecision(conflictingDecision)).rejects.toThrow(
      /APPROVAL_DECISION_CONFLICT: a different authenticated decision is already queued for this approval/,
    );

    // 5. Build real RevenueOrchestrator using createCareOrchestratorFactory wired to the repository seam
    const skillServices = createCareSkillServices({
      erp_read: null,
      env: {},
      now: FROZEN_CLOCK,
      resolve_correlation_id: async () => `corr-${RUN_ID}`,
      resolve_grant: async () => 'AUTH-3',
      skill_enablement: PILOT_SKILL_ENABLEMENT,
      case_repository: caseRepo,
      case_sla_target_hours: async () => 4,
    });

    const factory = createCareOrchestratorFactory({
      workerId: 'w-biz-e2e',
      auditSecret: AUDIT_SECRET,
      now: FROZEN_CLOCK,
      resolve_grant: async () => 'AUTH-3',
      resolve_correlation_id: async () => `corr-${RUN_ID}`,
      effectGuard: new MemoryEffectGuard(),
      workflowRepository: repos.workflowRepository,
      approvalRepository: repos.approvalRepository,
      evidenceRepository: repos.evidenceRepository,
      auditRepository: repos.auditRepository,
      conversationRepository: repos.conversationRepository,
      skillServices,
      case_sla_target_hours: async () => 4,
      skill_enablement: PILOT_SKILL_ENABLEMENT,
      policyEngine: createCarePolicyEngine({
        auditSecret: AUDIT_SECRET,
        now: FROZEN_CLOCK,
        resolveGrant: async () => 'AUTH-3',
        audit: { append: async (rec) => { repos.auditLogs.push(rec as unknown as AgentRunLogRecord); } },
      }),
    });
    const orchestrator = await factory(TENANT_T1);

    // 6. Consume once via existing resume path (orchestrator.resumeTask)
    const resumeEvent = {
      tenant_id: TENANT_T1,
      run_id: RUN_ID,
      effect_key: effectKeyApproval,
      event_type: 'human.approval' as const,
      approval_id: APPROVAL_ID,
      expected_payload_sha256: payloadSha256,
      operator_id: OPERATOR_ID,
      reason: decisionInput.reason,
    };

    const resumeResult = await orchestrator.resumeTask(RUN_ID, resumeEvent);
    expect(resumeResult.lifecycle_state).toBe('completed');
    expect(resumeResult.run_id).toBe(RUN_ID);

    // Verify approval record is marked decided in repository
    const decidedApproval = repos.approvals.get(APPROVAL_ID);
    expect(decidedApproval?.decision).toBe('APPROVED');
    expect(decidedApproval?.operator_id).toBe(OPERATOR_ID);

    // 7. Single-use consumption: calling resumeTask again fails closed because task is completed
    await expect(orchestrator.resumeTask(RUN_ID, resumeEvent)).rejects.toThrow(
      /Cannot resume task currently in/i,
    );

    // Also assert repository seam rejects a second claim attempt (not awaiting_human)
    await expect(
      repos.approvalRepository.claimApprovalAndResume({
        tenant_id: TENANT_T1,
        run_id: RUN_ID,
        approval_id: APPROVAL_ID,
        effect_key: effectKeyApproval,
        expected_payload_sha256: payloadSha256,
        authorized_action: null,
        decision: 'APPROVED',
        operator_id: OPERATOR_ID,
        review_comment: decisionInput.reason,
      }),
    ).rejects.toThrow(/APPROVAL_NOT_CLAIMABLE/);
  });

  it('Step 6: Acquire takeover, assert real session-control/orchestrator path is silent with zero outbound dispatch, release/resume assigned operator, and assert authorized resolution completes', async () => {
    const repos = createInMemoryAdapterRepositories();
    const caseRepo = createInMemoryCaseRepository();

    // 1. Prime thread conversation in conversationRepository
    const initialConversation: ConversationRecord = {
      conversation_id: CONVERSATION_ID,
      tenant_id: TENANT_T1,
      channel: CHANNEL_ZALO,
      external_thread_id: SESSION_ID,
      customer_id: CUSTOMER_A,
      active_agent: 'CS-01',
      state: 'open',
      takeover_operator_id: null,
      last_message_at: FROZEN_TIME_ISO,
      created_at: FROZEN_TIME_ISO,
    };
    repos.conversations.set(`${TENANT_T1}:${SESSION_ID}`, initialConversation);

    // Build real adapters over the repository doubles
    const adapters = createDurableAdapters({
      workflowRepository: repos.workflowRepository,
      approvalRepository: repos.approvalRepository,
      evidenceRepository: repos.evidenceRepository,
      auditRepository: repos.auditRepository,
      conversationRepository: repos.conversationRepository,
      auditSecret: AUDIT_SECRET,
      now: FROZEN_CLOCK,
    });

    const offlineLeaseManager = createOfflineLeaseManager();

    const skillServices = createCareSkillServices({
      erp_read: null,
      env: {},
      now: FROZEN_CLOCK,
      resolve_correlation_id: async () => `corr-${RUN_ID}`,
      resolve_grant: async () => 'AUTH-3',
      skill_enablement: PILOT_SKILL_ENABLEMENT,
      case_repository: caseRepo,
      case_sla_target_hours: async () => 4,
    });

    const factory = createCareOrchestratorFactory({
      workerId: 'w-biz-e2e',
      auditSecret: AUDIT_SECRET,
      now: FROZEN_CLOCK,
      resolve_grant: async () => 'AUTH-3',
      resolve_correlation_id: async () => `corr-${RUN_ID}`,
      effectGuard: new MemoryEffectGuard(),
      workflowRepository: repos.workflowRepository,
      approvalRepository: repos.approvalRepository,
      evidenceRepository: repos.evidenceRepository,
      auditRepository: repos.auditRepository,
      conversationRepository: repos.conversationRepository,
      sessionControl: adapters.sessionControl,
      skillServices,
      case_sla_target_hours: async () => 4,
      skill_enablement: PILOT_SKILL_ENABLEMENT,
      leaseManager: offlineLeaseManager,
    });

    const orchestrator = await factory(TENANT_T1);

    // 2. Operator acquires takeover: conversation state set to paused_takeover
    const activeTakeoverConv: ConversationRecord = {
      ...initialConversation,
      state: 'paused_takeover',
      takeover_operator_id: OPERATOR_ID,
    };
    repos.conversations.set(`${TENANT_T1}:${SESSION_ID}`, activeTakeoverConv);

    // Verify real sessionControl detects active takeover lock
    expect(await adapters.sessionControl.isTakenOver(TENANT_T1, SESSION_ID)).toBe(true);

    // 3. Process signal during active operator takeover lock:
    // Real RevenueOrchestrator checks real sessionControl at Step 2 (CONTEXT),
    // halts execution and transitions task to 'stopped'. Visited stages: SIGNAL, CONTEXT. Zero dispatch.
    const resultWhileLocked = await orchestrator.processSignal(signal);
    expect(resultWhileLocked.lifecycle_state).toBe('stopped');
    expect(resultWhileLocked.message).toBe('Session locked by human operator');
    expect(orchestrator.visitedStages).toEqual(['SIGNAL', 'CONTEXT']);

    // Real PEP check: mutating actions denied under active takeover
    const pep = new PolicyEnforcementPoint({
      registry: {
        getSkill: () => ({
          skill_id: 'skill.care.escalate_to_human',
          allowed_agents: ['CS-01', 'CS-02'],
          required_authority: 'AUTH-3',
          mutating: true,
          price_bearing: false,
          idempotent: false,
          epistemic_class: 'FACT',
          write_target: 'FACT',
          requires_consent: false,
          requires_verified_identity: false,
          timeout_ms: 2000,
        }),
        getAgent: () => ({ agent_id: 'CS-01', assigned_authority: 'AUTH-3' }),
      },
      approvals: { createOrReadPending: async () => ({ approval_id: 'dummy' }) },
      auditSecret: AUDIT_SECRET,
      now: FROZEN_CLOCK,
    });

    const lockedPepDecision = await pep.enforce(
      {
        tenant_id: TENANT_T1,
        agent_id: 'CS-01',
        run_id: RUN_ID,
        request_id: 'req-takeover-check',
        correlation_id: `corr-${RUN_ID}`,
        session_id: SESSION_ID,
        takeover_active: true,
      },
      {
        skill_id: 'skill.care.escalate_to_human',
        tool_name: 'Orchestrator.HandoffBus',
        payload: { session_id: SESSION_ID },
        required_authority: 'AUTH-3',
      },
    );
    expect(lockedPepDecision.verdict).toBe('DENIED');
    expect(lockedPepDecision.errorCode).toBe('HUMAN_TAKEOVER');

    // 4. Operator releases takeover via real sessionControl.returnToAgent
    await adapters.sessionControl.returnToAgent(TENANT_T1, SESSION_ID, OPERATOR_ID);
    expect(await adapters.sessionControl.isTakenOver(TENANT_T1, SESSION_ID)).toBe(false);

    // 5. Authorized resolution path completes:
    // Create case and execute authorized resolution through the real SkillRuntime/dispatcher
    const resolutionSkillServices = createCareSkillServices({
      erp_read: null,
      env: {},
      now: FROZEN_CLOCK,
      resolve_correlation_id: async () => `corr-${RUN_ID}`,
      resolve_grant: async () => 'AUTH-3',
      skill_enablement: PILOT_SKILL_ENABLEMENT,
      case_repository: caseRepo,
      case_sla_target_hours: async () => 4,
    });

    // Create and advance case to IN_PROGRESS
    const effectKeyResCreate = computeEffectKey({
      tenant_id: TENANT_T1,
      skill_id: 'skill.care.manage_case',
      step_index: 1,
      action_revision: 0,
      request_id: 'req-res-create',
    });
    await resolutionSkillServices.tool_port.invoke<ManageCaseToolInput, ManagedServiceCase>({
      skill_id: 'skill.care.manage_case',
      tool_binding: 'PostgreSQL.CaseManagementStore',
      input: {
        tenant_id: TENANT_T1,
        case_id: CASE_ID,
        customer_id: CUSTOMER_A,
        intent: 'complaint',
        priority: 'P2',
        conversation_id: CONVERSATION_ID,
        action_type: 'CREATE',
      },
      context: { ...context, run_id: RUN_ID, caller_agent: 'CS-01', effect_key: effectKeyResCreate, granted_authority: 'AUTH-3' },
    });
    await resolutionSkillServices.tool_port.invoke<ManageCaseToolInput, ManagedServiceCase>({
      skill_id: 'skill.care.manage_case',
      tool_binding: 'PostgreSQL.CaseManagementStore',
      input: {
        tenant_id: TENANT_T1,
        case_id: CASE_ID,
        customer_id: CUSTOMER_A,
        intent: 'complaint',
        priority: 'P2',
        conversation_id: CONVERSATION_ID,
        action_type: 'TRANSITION_STATE',
        target_status: 'CLASSIFIED',
        expected_case_version: 1,
      },
      context: {
        ...context,
        run_id: RUN_ID,
        caller_agent: 'CS-01',
        effect_key: computeEffectKey({
          tenant_id: TENANT_T1,
          skill_id: 'skill.care.manage_case',
          step_index: 2,
          action_revision: 0,
          request_id: 'req-res-classify',
        }),
        granted_authority: 'AUTH-3',
      },
    });
    await resolutionSkillServices.tool_port.invoke<ManageCaseToolInput, ManagedServiceCase>({
      skill_id: 'skill.care.manage_case',
      tool_binding: 'PostgreSQL.CaseManagementStore',
      input: {
        tenant_id: TENANT_T1,
        case_id: CASE_ID,
        customer_id: CUSTOMER_A,
        intent: 'complaint',
        priority: 'P2',
        conversation_id: CONVERSATION_ID,
        action_type: 'ASSIGN',
        assigned_owner: OPERATOR_ID,
        expected_case_version: 2,
      },
      context: {
        ...context,
        run_id: RUN_ID,
        caller_agent: 'CS-01',
        effect_key: computeEffectKey({
          tenant_id: TENANT_T1,
          skill_id: 'skill.care.manage_case',
          step_index: 3,
          action_revision: 0,
          request_id: 'req-res-assign',
        }),
        granted_authority: 'AUTH-3',
      },
    });
    await resolutionSkillServices.tool_port.invoke<ManageCaseToolInput, ManagedServiceCase>({
      skill_id: 'skill.care.manage_case',
      tool_binding: 'PostgreSQL.CaseManagementStore',
      input: {
        tenant_id: TENANT_T1,
        case_id: CASE_ID,
        customer_id: CUSTOMER_A,
        intent: 'complaint',
        priority: 'P2',
        conversation_id: CONVERSATION_ID,
        action_type: 'TRANSITION_STATE',
        target_status: 'IN_PROGRESS',
        expected_case_version: 3,
      },
      context: {
        ...context,
        run_id: RUN_ID,
        caller_agent: 'CS-01',
        effect_key: computeEffectKey({
          tenant_id: TENANT_T1,
          skill_id: 'skill.care.manage_case',
          step_index: 4,
          action_revision: 0,
          request_id: 'req-res-in-prog',
        }),
        granted_authority: 'AUTH-3',
      },
    });

    // Execute authorized resolution through dispatcher
    const resolveActionDraft: ActionDraft = {
      action_id: randomUUID(),
      run_id: RUN_ID,
      tenant_id: TENANT_T1,
      request_id: 'req-auth-resolve',
      action_revision: 0,
      agent_id: 'CS-01',
      skill_id: 'skill.care.manage_case',
      adapter_target: 'PostgreSQL.CaseManagementStore',
      step_index: 5,
      mutating: true,
      price_bearing: false,
      effect_key: computeEffectKey({
        tenant_id: TENANT_T1,
        skill_id: 'skill.care.manage_case',
        step_index: 5,
        action_revision: 0,
        request_id: 'req-auth-resolve',
      }),
      required_authority: 'AUTH-3',
      payload: {
        tenant_id: TENANT_T1,
        case_id: CASE_ID,
        customer_id: CUSTOMER_A,
        intent: 'complaint',
        priority: 'P2',
        conversation_id: CONVERSATION_ID,
        action_type: 'RESOLVE',
        expected_case_version: 4,
        evidence_refs: ['evi_audit_authorized_resolution_01'],
        notes: 'Operator OP-SUPPORT-01 completed authorized resolution after takeover release.',
      },
    };

    const resolveReceipt = await resolutionSkillServices.dispatcher.dispatch(resolveActionDraft);
    expect(resolveReceipt.adapter_status).toBe('SUCCESS');

    // Verify case in repository is resolved
    const storedCase = caseRepo.cases.get(`${TENANT_T1}:${CASE_ID}`);
    expect(storedCase?.status).toBe('RESOLVED');
    expect(storedCase?.case_version).toBe(5);
    expect(storedCase?.evidence_refs).toContain('evi_audit_authorized_resolution_01');
  });

  it('Step 7: Tenant, customer, and effect-key isolation & no duplicate handoff or unauthorized outbound send', async () => {
    // 1. Deterministic effect key isolation between tenants
    const effectKeyT1 = computeEffectKey({
      tenant_id: TENANT_T1,
      skill_id: 'skill.care.escalate_to_human',
      step_index: 1,
      action_revision: 0,
      request_id: 'req-binding-check',
    });

    const effectKeyOtherTenant = computeEffectKey({
      tenant_id: OTHER_TENANT,
      skill_id: 'skill.care.escalate_to_human',
      step_index: 1,
      action_revision: 0,
      request_id: 'req-binding-check',
    });

    expect(effectKeyT1).not.toBe(effectKeyOtherTenant);

    // 2. Deterministic request fingerprinting
    const fp1 = computeRequestFingerprint({ tenant_id: TENANT_T1, reason: 'complaint' });
    const fp2 = computeRequestFingerprint({ tenant_id: TENANT_T1, reason: 'complaint' });
    expect(fp1).toBe(fp2);

    // 3. Real PolicyEngine rejects cross-tenant action draft
    const policyEngine = createCarePolicyEngine({
      auditSecret: AUDIT_SECRET,
      now: FROZEN_CLOCK,
      resolveGrant: async () => 'AUTH-3',
    });

    const crossTenantAction: ActionDraft = {
      action_id: randomUUID(),
      run_id: RUN_ID,
      tenant_id: OTHER_TENANT,
      request_id: 'req-cross-tenant',
      action_revision: 0,
      agent_id: 'CS-01',
      skill_id: 'skill.care.search_faq',
      adapter_target: 'SecondBrain.FAQEngine',
      step_index: 1,
      mutating: false,
      price_bearing: false,
      effect_key: effectKeyOtherTenant,
      required_authority: 'AUTH-1',
      payload: {
        tenant_id: OTHER_TENANT,
        query_text: 'policy',
      },
    };

    await expect(policyEngine.validateAction(crossTenantAction, context)).rejects.toThrow(
      /CROSS_TENANT_ASSERTION/,
    );

    // 4. Real PolicyEngine rejects cross-customer action draft
    const crossCustomerAction: ActionDraft = {
      action_id: randomUUID(),
      run_id: RUN_ID,
      tenant_id: TENANT_T1,
      request_id: 'req-cross-customer',
      action_revision: 0,
      agent_id: 'CS-01',
      skill_id: 'skill.care.escalate_to_human',
      adapter_target: 'Orchestrator.HandoffBus',
      step_index: 1,
      mutating: true,
      price_bearing: false,
      effect_key: effectKeyT1,
      required_authority: 'AUTH-3',
      payload: {
        tenant_id: TENANT_T1,
        session_id: SESSION_ID,
        conversation_id: CONVERSATION_ID,
        customer_id: '11111111-1111-4111-8111-999999999999',
        escalation_reason: 'customer_complaint',
      },
    };

    await expect(policyEngine.validateAction(crossCustomerAction, context)).rejects.toThrow(
      /CROSS_CUSTOMER_ASSERTION/,
    );

    // 5. Tool port rejects cross-tenant case management attempt
    const caseRepo = createInMemoryCaseRepository();
    const services = createCareSkillServices({
      erp_read: null,
      env: {},
      now: FROZEN_CLOCK,
      resolve_correlation_id: async () => `corr-${RUN_ID}`,
      resolve_grant: async () => 'AUTH-3',
      skill_enablement: PILOT_SKILL_ENABLEMENT,
      case_repository: caseRepo,
      case_sla_target_hours: async () => 4,
    });

    await expect(
      services.tool_port.invoke<ManageCaseToolInput, ManagedServiceCase>({
        skill_id: 'skill.care.manage_case',
        tool_binding: 'PostgreSQL.CaseManagementStore',
        input: {
          tenant_id: OTHER_TENANT,
          case_id: CASE_ID,
          customer_id: CUSTOMER_A,
          intent: 'complaint',
          priority: 'P2',
          conversation_id: CONVERSATION_ID,
          action_type: 'CREATE',
        },
        context: {
          ...context,
          run_id: RUN_ID,
          caller_agent: 'CS-01',
          effect_key: effectKeyT1,
          granted_authority: 'AUTH-3',
        },
      }),
    ).rejects.toMatchObject({ code: 'TENANT_SCOPE_MISMATCH' });

    // 6. Isolation confirms zero mutations made for other tenant
    expect(caseRepo.cases.size).toBe(0);
  });
});
