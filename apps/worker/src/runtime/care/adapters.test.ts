/**
 * @file Unit tests for Customer Care Runtime Adapters (apps/worker/src/runtime/care/adapters.ts).
 */

import { describe, expect, it, vi } from 'vitest';
import { OrchestratorError } from '@agentos/core-engine/contracts';
import type {
  ApprovalRepository,
  AuditRepository,
  ConversationRecord,
  ConversationRepository,
  DurableTaskRecord,
  DurableWorkflowRepository,
  EvidenceRepository,
} from '@agentos/database';
import { createCareAdapters } from './adapters.js';

function createFakeTaskRecord(overrides: Partial<DurableTaskRecord> = {}): DurableTaskRecord {
  return {
    task_id: 'task-uuid-1',
    tenant_id: 'tenant-1',
    run_id: 'run-1',
    correlation_id: 'corr-1',
    current_step: 1,
    state: 'running',
    task_version: 3,
    lease_owner: 'worker-1',
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    retry_count: 0,
    max_retries: 3,
    last_error_class: null,
    paused_for_approval_id: null,
    state_payload: { step: 'data' },
    error_details: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function createFakeConversationRecord(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    conversation_id: 'conv-1',
    tenant_id: 'tenant-1',
    channel: 'WEB_CHAT',
    external_thread_id: 'thread-1',
    customer_id: 'cust-1',
    active_agent: 'support',
    state: 'open',
    takeover_operator_id: null,
    last_message_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('createCareAdapters', () => {
  const auditSecret = 'test-secret-that-is-at-least-32-chars-long!!';
  const fixedNow = new Date('2026-09-23T12:00:00.000Z');

  function setupFakeRepos() {
    const workflowRepository = {
      createTask: vi.fn().mockResolvedValue(createFakeTaskRecord()),
      updateTaskProgress: vi.fn().mockResolvedValue(createFakeTaskRecord()),
      transitionTask: vi.fn().mockResolvedValue(createFakeTaskRecord()),
      getTask: vi.fn().mockResolvedValue(createFakeTaskRecord()),
      recordFailure: vi.fn().mockResolvedValue({
        requeued: true,
        state: 'queued',
        retry_count: 1,
        task_version: 4,
      }),
      renewTaskLease: vi.fn().mockResolvedValue(createFakeTaskRecord()),
      releaseTaskLease: vi.fn().mockResolvedValue(createFakeTaskRecord()),
      queueHandoffEvidence: vi.fn().mockResolvedValue({ queued: true, task_version: 1 }),
    } as unknown as DurableWorkflowRepository;

    const approvalRepository = {
      pauseForApproval: vi.fn().mockResolvedValue({
        approval_id: 'appr-uuid-1',
        approval: {},
        action: {},
        task: {},
      }),
      claimApprovalAndResume: vi.fn().mockResolvedValue({
        claimed: true,
        approval: {},
        action: {},
        task: {},
      }),
    } as unknown as ApprovalRepository;

    const evidenceRepository = {
      appendEvidence: vi.fn().mockResolvedValue({
        run_id: 'run-1',
        step_index: 0,
        effect_key: 'ek-1',
        previous_evidence_hash: '0'.repeat(64),
        payload_sha256: 'a'.repeat(64),
        chain_hash: 'b'.repeat(64),
        signature: 'c'.repeat(64),
        created_at: fixedNow.toISOString(),
      }),
      logAgentRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as EvidenceRepository;

    const auditRepository = {
      append: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuditRepository;

    const conversationRepository = {
      get: vi.fn().mockResolvedValue(createFakeConversationRecord()),
      getByThread: vi.fn().mockResolvedValue(createFakeConversationRecord()),
      setState: vi.fn().mockResolvedValue(true),
    } as unknown as ConversationRepository;

    const adapters = createCareAdapters({
      workflowRepository,
      approvalRepository,
      evidenceRepository,
      auditRepository,
      conversationRepository,
      auditSecret,
      now: () => fixedNow,
    });

    return {
      adapters,
      workflowRepository,
      approvalRepository,
      evidenceRepository,
      auditRepository,
      conversationRepository,
    };
  }

  describe('workflowEngine', () => {
    it('createTask delegates to workflowRepository with tenant-scoped fields', async () => {
      const { adapters, workflowRepository } = setupFakeRepos();
      await adapters.workflowEngine.createTask({
        tenant_id: 'tenant-1',
        run_id: 'run-1',
        correlation_id: 'corr-1',
        current_step: 1,
        state: 'queued',
        state_payload: { foo: 'bar' },
        lease_owner: 'worker-1',
        lease_expires_at: '2026-09-23T12:30:00.000Z',
      });

      expect(workflowRepository.createTask).toHaveBeenCalledWith({
        tenant_id: 'tenant-1',
        run_id: 'run-1',
        correlation_id: 'corr-1',
        current_step: 1,
        state: 'queued',
        state_payload: { foo: 'bar' },
      });
    });

    it('updateTaskProgress delegates to workflowRepository', async () => {
      const { adapters, workflowRepository } = setupFakeRepos();
      const guard = { expected_task_version: 2, lease_owner: 'worker-1' };
      await adapters.workflowEngine.updateTaskProgress('tenant-1', 'run-1', 2, { step: 2 }, guard);

      expect(workflowRepository.updateTaskProgress).toHaveBeenCalledWith(
        'tenant-1',
        'run-1',
        2,
        { step: 2 },
        guard,
      );
    });

    it('transitionTask delegates to workflowRepository', async () => {
      const { adapters, workflowRepository } = setupFakeRepos();
      const guard = { expected_task_version: 3 };
      await adapters.workflowEngine.transitionTask(
        'tenant-1',
        'run-1',
        'completed',
        'Step finished',
        { final: true },
        guard,
      );

      expect(workflowRepository.transitionTask).toHaveBeenCalledWith(
        'tenant-1',
        'run-1',
        'completed',
        'Step finished',
        { final: true },
        guard,
      );
    });

    it('getTask maps DurableTaskRecord to DurableTaskSnapshot faithfully', async () => {
      const { adapters, workflowRepository } = setupFakeRepos();
      const taskRow = createFakeTaskRecord({
        task_version: 5,
        state: 'waiting',
        correlation_id: 'corr-99',
        state_payload: { checkpoint: 'ok' },
        lease_owner: 'worker-2',
        lease_expires_at: '2026-09-23T13:00:00.000Z',
      });
      vi.mocked(workflowRepository.getTask).mockResolvedValueOnce(taskRow);

      const snapshot = await adapters.workflowEngine.getTask('tenant-1', 'run-1');
      expect(snapshot).toEqual({
        task_version: 5,
        state: 'waiting',
        correlation_id: 'corr-99',
        state_payload: { checkpoint: 'ok' },
        lease_owner: 'worker-2',
        lease_expires_at: '2026-09-23T13:00:00.000Z',
      });
    });

    it('getTask returns null when repository returns null', async () => {
      const { adapters, workflowRepository } = setupFakeRepos();
      vi.mocked(workflowRepository.getTask).mockResolvedValueOnce(null);

      const snapshot = await adapters.workflowEngine.getTask('tenant-1', 'run-absent');
      expect(snapshot).toBeNull();
    });

    it('pauseForApproval delegates with exact field names and maps approval_id', async () => {
      const { adapters, approvalRepository } = setupFakeRepos();
      const params = {
        tenant_id: 'tenant-1',
        run_id: 'run-1',
        expected_task_version: 2,
        checkpoint: { saved: true },
        approval: {
          action_id: 'act-1',
          effect_key: 'ek-1',
          payload: { discount: 20 },
          reason: 'Discount > 10% requires manager approval',
        },
      };

      const result = await adapters.workflowEngine.pauseForApproval(params);
      expect(approvalRepository.pauseForApproval).toHaveBeenCalledWith(params);
      expect(result).toEqual({ approval_id: 'appr-uuid-1' });
    });

    it('claimApprovalAndResume delegates with exact field names and returns { claimed }', async () => {
      const { adapters, approvalRepository } = setupFakeRepos();
      const params = {
        tenant_id: 'tenant-1',
        run_id: 'run-1',
        approval_id: 'appr-uuid-1',
        effect_key: 'ek-1',
        expected_payload_sha256: 'f'.repeat(64),
        authorized_action: null,
        decision: 'APPROVED' as const,
        operator_id: 'operator-1',
        review_comment: 'Looks good',
      };

      const result = await adapters.workflowEngine.claimApprovalAndResume(params);
      expect(approvalRepository.claimApprovalAndResume).toHaveBeenCalledWith(params);
      expect(result).toEqual({ claimed: true });
    });

    it('recordFailure delegates to workflowRepository and maps { requeued }', async () => {
      const { adapters, workflowRepository } = setupFakeRepos();
      vi.mocked(workflowRepository.recordFailure).mockResolvedValueOnce({
        requeued: true,
        state: 'queued',
        retry_count: 1,
        task_version: 2,
      });

      const result = await adapters.workflowEngine.recordFailure({
        tenant_id: 'tenant-1',
        run_id: 'run-1',
        error_class: 'RETRYABLE',
        error_details: { code: 'TIMEOUT' },
        expected_task_version: 1,
        guard: { expected_task_version: 1, lease_owner: 'worker-1' },
      });

      expect(workflowRepository.recordFailure).toHaveBeenCalledWith({
        tenant_id: 'tenant-1',
        run_id: 'run-1',
        error_class: 'RETRYABLE',
        error_details: { code: 'TIMEOUT' },
        expected_task_version: 1,
        lease_owner: 'worker-1',
        now: fixedNow,
      });
      expect(result).toEqual({ requeued: true });
    });
    it('queueHandoffEvidence delegates to workflowRepository and maps { queued, task_version }', async () => {
      const { adapters, workflowRepository } = setupFakeRepos();
      vi.mocked(workflowRepository.queueHandoffEvidence).mockResolvedValueOnce({ queued: true, task_version: 7 });

      const params = {
        tenant_id: 'tenant-1',
        run_id: 'run-1',
        expected_task_version: 6,
        evidence_payload: { evidence_card: 'EV_HUMAN_HANDOFF' },
        step_index: 1,
        effect_key: 'ek-1',
        reason: 'repair test',
      };

      const result = await adapters.workflowEngine.queueHandoffEvidence(params);

      expect(workflowRepository.queueHandoffEvidence).toHaveBeenCalledWith(params);
      expect(result).toEqual({ queued: true, task_version: 7 });
    });
  });

  describe('evidenceLogger', () => {
    it('createImmutableRecord reaches EvidenceRepository.appendEvidence with signing secret', async () => {
      const { adapters, evidenceRepository } = setupFakeRepos();
      const params = {
        run_id: 'run-1',
        tenant_id: 'tenant-1',
        correlation_id: 'corr-1',
        step_index: 0,
        effect_key: 'ek-1',
        previous_evidence_hash: '0'.repeat(64),
        payload: { message: 'hello' },
      };

      const record = await adapters.evidenceLogger.createImmutableRecord(params);
      expect(evidenceRepository.appendEvidence).toHaveBeenCalledWith({
        ...params,
        secret: auditSecret,
        created_at: fixedNow.toISOString(),
      });
      expect(record.run_id).toBe('run-1');
    });

    it('logAgentRun delegates to EvidenceRepository.logAgentRun', async () => {
      const { adapters, evidenceRepository } = setupFakeRepos();
      const runLog = {
        run_id: 'run-1',
        tenant_id: 'tenant-1',
        agent_id: 'CS-01',
        customer_or_entity_id: 'cust-1',
        trigger: 'inbound_message',
        context: {},
        skill: 'skill.care.search_faq',
        step_index: 0,
        tool: 'SecondBrain.FAQEngine',
        decision: {},
        authority: 'AUTH-1' as const,
        approval: null,
        action: {},
        execution_status: 'success' as const,
        evidence: {},
        outcome: null,
        latency_ms: 120,
        cost: {},
        error: null,
        started_at: fixedNow.toISOString(),
        completed_at: fixedNow.toISOString(),
      };

      await adapters.evidenceLogger.logAgentRun(runLog);
      expect(evidenceRepository.logAgentRun).toHaveBeenCalledWith(runLog);
    });

    it('initializeOutcomeWatch refuses with canonical OrchestratorError when capability is unbound', async () => {
      const { adapters } = setupFakeRepos();
      let caught: unknown;
      try {
        await adapters.evidenceLogger.initializeOutcomeWatch({
          tenant_id: 'tenant-1',
          run_id: 'run-1',
          effect_key: 'ek-mutating',
          skill_id: 'skill.care.order_mutation',
        });
      } catch (err: unknown) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(OrchestratorError);
      const orcErr = caught as OrchestratorError;
      expect(orcErr.code).toBe('CAPABILITY_NOT_ENABLED');
      expect(orcErr.message).toContain('initializeOutcomeWatch is unbound');
    });

    it('initializeOutcomeWatch delegates when repository exposes pending_outcome writer', async () => {
      const { adapters, evidenceRepository } = setupFakeRepos();
      const mockWriter = vi.fn().mockResolvedValue(undefined);
      Object.assign(evidenceRepository, { appendPendingOutcomeAttribution: mockWriter });

      await adapters.evidenceLogger.initializeOutcomeWatch({
        tenant_id: 'tenant-1',
        run_id: 'run-1',
        effect_key: 'ek-mutating',
        skill_id: 'skill.care.order_mutation',
      });

      expect(mockWriter).toHaveBeenCalledWith({
        tenant_id: 'tenant-1',
        run_id: 'run-1',
        effect_key: 'ek-mutating',
        skill_id: 'skill.care.order_mutation',
      });
    });
  });

  describe('auditTrail', () => {
    it('append delegates to AuditRepository.append', async () => {
      const { adapters, auditRepository } = setupFakeRepos();
      const record = {
        run_id: 'run-1',
        tenant_id: 'tenant-1',
        agent_id: 'CS-01',
        customer_or_entity_id: 'cust-1',
        trigger: 'inbound_message',
        context: {},
        skill: 'skill.care.search_faq',
        step_index: 0,
        tool: 'SecondBrain.FAQEngine',
        decision: {},
        authority: 'AUTH-1' as const,
        approval: null,
        action: {},
        execution_status: 'success' as const,
        evidence: {},
        outcome: null,
        latency_ms: 50,
        cost: {},
        error: null,
        started_at: fixedNow.toISOString(),
        completed_at: fixedNow.toISOString(),
      };

      await adapters.auditTrail.append(record);
      expect(auditRepository.append).toHaveBeenCalledWith(record);
    });
  });

  describe('sessionControl', () => {
    it('isTakenOver resolves the session through the thread row and reports a takeover', async () => {
      const { adapters, conversationRepository } = setupFakeRepos();
      vi.mocked(conversationRepository.getByThread).mockResolvedValueOnce(
        createFakeConversationRecord({ state: 'paused_takeover' }),
      );

      const result = await adapters.sessionControl.isTakenOver('tenant-1', 'thread-1');
      expect(conversationRepository.getByThread).toHaveBeenCalledWith('tenant-1', 'thread-1');
      expect(result).toBe(true);
    });

    it('isTakenOver returns false when conversation state is open or closed or not found', async () => {
      const { adapters, conversationRepository } = setupFakeRepos();
      vi.mocked(conversationRepository.getByThread).mockResolvedValueOnce(
        createFakeConversationRecord({ state: 'open' }),
      );
      expect(await adapters.sessionControl.isTakenOver('tenant-1', 'thread-1')).toBe(false);

      vi.mocked(conversationRepository.getByThread).mockResolvedValueOnce(
        createFakeConversationRecord({ state: 'closed' }),
      );
      expect(await adapters.sessionControl.isTakenOver('tenant-1', 'thread-1')).toBe(false);

      vi.mocked(conversationRepository.getByThread).mockResolvedValueOnce(null);
      expect(await adapters.sessionControl.isTakenOver('tenant-1', 'thread-1')).toBe(false);
    });

    it('returnToAgent refuses with canonical OrchestratorError when repo exposes no owner-checked transition', async () => {
      const { adapters } = setupFakeRepos();
      let caught: unknown;
      try {
        await adapters.sessionControl.returnToAgent('tenant-1', 'session-1', 'op-1');
      } catch (err: unknown) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(OrchestratorError);
      const orcErr = caught as OrchestratorError;
      expect(orcErr.code).toBe('CAPABILITY_NOT_ENABLED');
      expect(orcErr.message).toContain('returnToAgent is unbound');
    });

    it('returnToAgent delegates when repo exposes an owner-checked transition', async () => {
      const { adapters, conversationRepository } = setupFakeRepos();
      const mockReturn = vi.fn().mockResolvedValue(undefined);
      Object.assign(conversationRepository, { returnToAgent: mockReturn });

      await adapters.sessionControl.returnToAgent('tenant-1', 'session-1', 'op-1');
      expect(mockReturn).toHaveBeenCalledWith('tenant-1', 'session-1', 'op-1');
    });
  });

  describe('leaseManager', () => {
    it('acquireLease succeeds when this worker holds the live, unexpired lease and renews it', async () => {
      const { adapters, workflowRepository } = setupFakeRepos();
      const runningTask = createFakeTaskRecord({
        state: 'running',
        lease_owner: 'worker-1',
        lease_expires_at: new Date(fixedNow.getTime() + 30_000).toISOString(),
        task_version: 4,
      });
      vi.mocked(workflowRepository.getTask).mockResolvedValueOnce(runningTask);

      const acquired = await adapters.leaseManager.acquireLease('tenant-1', 'run-1', 'worker-1');
      expect(acquired).toBe(true);
      expect(workflowRepository.renewTaskLease).toHaveBeenCalledWith({
        tenant_id: 'tenant-1',
        run_id: 'run-1',
        lease_owner: 'worker-1',
        task_version: 4,
      });
    });

    it('acquireLease returns false when task does not exist', async () => {
      const { adapters, workflowRepository } = setupFakeRepos();
      vi.mocked(workflowRepository.getTask).mockResolvedValueOnce(null);

      const acquired = await adapters.leaseManager.acquireLease('tenant-1', 'run-1', 'worker-1');
      expect(acquired).toBe(false);
      expect(workflowRepository.renewTaskLease).not.toHaveBeenCalled();
    });

    it('acquireLease returns false when lease_owner is someone else', async () => {
      const { adapters, workflowRepository } = setupFakeRepos();
      const runningTask = createFakeTaskRecord({
        state: 'running',
        lease_owner: 'worker-other',
        lease_expires_at: new Date(fixedNow.getTime() + 30_000).toISOString(),
      });
      vi.mocked(workflowRepository.getTask).mockResolvedValueOnce(runningTask);

      const acquired = await adapters.leaseManager.acquireLease('tenant-1', 'run-1', 'worker-1');
      expect(acquired).toBe(false);
      expect(workflowRepository.renewTaskLease).not.toHaveBeenCalled();
    });

    it('acquireLease returns false when task is not in running state', async () => {
      const { adapters, workflowRepository } = setupFakeRepos();
      const queuedTask = createFakeTaskRecord({
        state: 'queued',
        lease_owner: 'worker-1',
        lease_expires_at: new Date(fixedNow.getTime() + 30_000).toISOString(),
      });
      vi.mocked(workflowRepository.getTask).mockResolvedValueOnce(queuedTask);

      const acquired = await adapters.leaseManager.acquireLease('tenant-1', 'run-1', 'worker-1');
      expect(acquired).toBe(false);
      expect(workflowRepository.renewTaskLease).not.toHaveBeenCalled();
    });

    it('acquireLease returns false when lease is expired', async () => {
      const { adapters, workflowRepository } = setupFakeRepos();
      const expiredTask = createFakeTaskRecord({
        state: 'running',
        lease_owner: 'worker-1',
        lease_expires_at: new Date(fixedNow.getTime() - 1000).toISOString(),
      });
      vi.mocked(workflowRepository.getTask).mockResolvedValueOnce(expiredTask);

      const acquired = await adapters.leaseManager.acquireLease('tenant-1', 'run-1', 'worker-1');
      expect(acquired).toBe(false);
      expect(workflowRepository.renewTaskLease).not.toHaveBeenCalled();
    });

    it('acquireLease returns false when renewTaskLease throws (e.g. concurrent collision)', async () => {
      const { adapters, workflowRepository } = setupFakeRepos();
      const runningTask = createFakeTaskRecord({
        state: 'running',
        lease_owner: 'worker-1',
        lease_expires_at: new Date(fixedNow.getTime() + 30_000).toISOString(),
        task_version: 4,
      });
      vi.mocked(workflowRepository.getTask).mockResolvedValueOnce(runningTask);
      vi.mocked(workflowRepository.renewTaskLease).mockRejectedValueOnce(
        new Error('TASK_VERSION_CONFLICT'),
      );

      const acquired = await adapters.leaseManager.acquireLease('tenant-1', 'run-1', 'worker-1');
      expect(acquired).toBe(false);
    });

    it('releaseLease releases the lease when worker holds it', async () => {
      const { adapters, workflowRepository } = setupFakeRepos();
      const runningTask = createFakeTaskRecord({
        state: 'running',
        lease_owner: 'worker-1',
        task_version: 4,
      });
      vi.mocked(workflowRepository.getTask).mockResolvedValueOnce(runningTask);

      await adapters.leaseManager.releaseLease('tenant-1', 'run-1', 'worker-1');
      expect(workflowRepository.releaseTaskLease).toHaveBeenCalledWith({
        tenant_id: 'tenant-1',
        run_id: 'run-1',
        lease_owner: 'worker-1',
        task_version: 4,
        target_state: 'queued',
      });
    });

    it('releaseLease preserves waiting state if task was waiting', async () => {
      const { adapters, workflowRepository } = setupFakeRepos();
      const waitingTask = createFakeTaskRecord({
        state: 'waiting',
        lease_owner: 'worker-1',
        task_version: 7,
      });
      vi.mocked(workflowRepository.getTask).mockResolvedValueOnce(waitingTask);

      await adapters.leaseManager.releaseLease('tenant-1', 'run-1', 'worker-1');
      expect(workflowRepository.releaseTaskLease).toHaveBeenCalledWith({
        tenant_id: 'tenant-1',
        run_id: 'run-1',
        lease_owner: 'worker-1',
        task_version: 7,
        target_state: 'waiting',
      });
    });

    it('releaseLease ends with a terminal run instead of re-queueing it', async () => {
      const { adapters, workflowRepository } = setupFakeRepos();

      for (const state of ['completed', 'stopped', 'failed'] as const) {
        const terminalTask = createFakeTaskRecord({
          state,
          lease_owner: 'worker-1',
          task_version: 9,
        });
        vi.mocked(workflowRepository.getTask).mockResolvedValueOnce(terminalTask);

        await adapters.leaseManager.releaseLease('tenant-1', 'run-1', 'worker-1');
      }

      expect(workflowRepository.releaseTaskLease).not.toHaveBeenCalled();
    });

    it('releaseLease is a no-op when a requeue already cleared the lease', async () => {
      const { adapters, workflowRepository } = setupFakeRepos();
      vi.mocked(workflowRepository.getTask).mockResolvedValueOnce(
        createFakeTaskRecord({ state: 'queued', lease_owner: null, task_version: 10 }),
      );

      await adapters.leaseManager.releaseLease('tenant-1', 'run-1', 'worker-1');

      expect(workflowRepository.releaseTaskLease).not.toHaveBeenCalled();
    });

    it('releaseLease refuses when worker does not hold the lease', async () => {
      const { adapters, workflowRepository } = setupFakeRepos();
      const otherWorkerTask = createFakeTaskRecord({
        state: 'running',
        lease_owner: 'worker-someone-else',
        task_version: 4,
      });
      vi.mocked(workflowRepository.getTask).mockResolvedValueOnce(otherWorkerTask);

      let caught: unknown;
      try {
        await adapters.leaseManager.releaseLease('tenant-1', 'run-1', 'worker-1');
      } catch (err: unknown) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(OrchestratorError);
      const orcErr = caught as OrchestratorError;
      expect(orcErr.code).toBe('CONCURRENT_TASK_LOCK');
      expect(orcErr.message).toContain('TASK_LEASE_NOT_HELD');
      expect(workflowRepository.releaseTaskLease).not.toHaveBeenCalled();
    });

    it('releaseLease throws TASK_NOT_FOUND when task is absent', async () => {
      const { adapters, workflowRepository } = setupFakeRepos();
      vi.mocked(workflowRepository.getTask).mockResolvedValueOnce(null);

      let caught: unknown;
      try {
        await adapters.leaseManager.releaseLease('tenant-1', 'run-absent', 'worker-1');
      } catch (err: unknown) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(OrchestratorError);
      const orcErr = caught as OrchestratorError;
      expect(orcErr.code).toBe('TASK_NOT_FOUND');
      expect(workflowRepository.releaseTaskLease).not.toHaveBeenCalled();
    });
  });
});
