import { describe, expect, it, vi } from 'vitest';
import {
  MemoryEffectGuard,
  OrchestratorError,
  RevenueOrchestrator,
} from '@agentos/core-engine';
import type { DurableTaskRecord, DurableWorkflowRepository } from '@agentos/database';
import { RunStageEventsRepository } from '@agentos/database';

import { processClaimedTask, startWorker } from './worker.js';
import { DurableRunStageRecorder } from './runtime/shared/stage-recorder.js';
import { createExecutionLeaseAssertion } from './runtime/execution-lease.js';
import { createWorkerPoller } from './worker-polling.js';

import { createDomainRuntimeRegistry } from './runtime/domain-registry.js';
import { createMarketingOrchestratorFactory } from './runtime/marketing/factory.js';

describe('claimed task domain discovery', () => {
  it.each([
    { enabled: true, resumed: false },
    { enabled: false, resumed: false },
    { enabled: true, resumed: true },
    { enabled: false, resumed: true },
  ])('rechecks missing Marketing activation before failing closed (enabled=$enabled, resumed=$resumed)', async ({ enabled, resumed }) => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    const signal = {
      signal_id: 'marketing-activation-signal',
      tenant_id,
      correlation_id: 'marketing-activation-correlation',
      source_channel: 'WEB_CHAT',
      event_type: 'campaign.requested',
      subject: { session_id: 'marketing-operator-session' },
      payload: { module: 'marketing' },
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const resumeEvent = { tenant_id, event_type: 'human.approval', operator_id: 'marketing-approver' };
    const taskRecord: DurableTaskRecord = {
      tenant_id, task_id: 'marketing-activation-run', run_id: 'marketing-activation-run',
      correlation_id: signal.correlation_id, current_step: 0, state: 'running',
      task_version: 1, lease_owner: 'worker-activation', lease_expires_at: null,
      retry_count: 0, max_retries: 3, last_error_class: null, paused_for_approval_id: null,
      state_payload: resumed ? {
        resume_event: resumeEvent,
        plan: { plan_id: 'marketing-activation-plan', domain: 'marketing', steps: [] },
        current_step: 1,
        pending_action: null,
        context: { tenant_id, correlation_id: signal.correlation_id },
        previous_evidence_hash: '0'.repeat(64),
        request_id: signal.signal_id,
      } : { signal },
      error_details: null,
      created_at: signal.timestamp, updated_at: signal.timestamp,
    };
    const factory = createMarketingOrchestratorFactory({
      auditSecret: 'marketing-activation-regression-secret',
      env: { AUDIT_HMAC_SECRET: 'marketing-activation-regression-secret' },
    });
    const orchestrator = await factory(tenant_id);
    if (orchestrator === null) throw new Error('Marketing test factory must bind');
    const processQueuedSignal = vi.spyOn(orchestrator, 'processQueuedSignal')
      .mockResolvedValue({ run_id: taskRecord.run_id, lifecycle_state: 'waiting' });
    const resumeTask = vi.spyOn(orchestrator, 'resumeTask')
      .mockResolvedValue({ run_id: taskRecord.run_id, lifecycle_state: 'waiting' });
    const refreshRegistry = vi.fn(async () => createDomainRuntimeRegistry(enabled ? [{
      contract: {
        module: 'marketing', source_channels: ['WEB_CHAT'], event_types: ['campaign.requested'],
        signal_invalid_code: 'MARKETING_SIGNAL_INVALID',
      },
      createOrchestrator: () => orchestrator,
    }] : []));
    const recordFailure = vi.fn();
    try {
      await processClaimedTask({
        taskRecord, tenant_id, worker_id: 'worker-activation',
        registry: createDomainRuntimeRegistry([]),
        refreshRegistry,
        workflowRepository: {
          getTask: vi.fn().mockResolvedValue({ ...taskRecord, state: enabled ? 'waiting' : 'failed' }),
          releaseTaskLease: vi.fn(), recordFailure, transitionTask: vi.fn(),
        },
        conversationRepository: { appendMessage: vi.fn() },
      });
      expect(refreshRegistry).toHaveBeenCalledOnce();
      if (enabled) {
        if (resumed) {
          expect(resumeTask).toHaveBeenCalledWith(taskRecord.run_id, resumeEvent);
          expect(processQueuedSignal).not.toHaveBeenCalled();
        } else {
          expect(processQueuedSignal).toHaveBeenCalledWith(taskRecord.run_id, signal, { worker_id: 'worker-activation' });
          expect(resumeTask).not.toHaveBeenCalled();
        }
        expect(recordFailure).not.toHaveBeenCalled();
      } else {
        expect(processQueuedSignal).not.toHaveBeenCalled();
        expect(resumeTask).not.toHaveBeenCalled();
        expect(recordFailure).toHaveBeenCalledWith(expect.objectContaining({
          error_class: 'FATAL',
          error_details: expect.objectContaining({ code: 'CAPABILITY_NOT_ENABLED', module: 'marketing' }),
        }));
      }
    } finally {
      processQueuedSignal.mockRestore();
      resumeTask.mockRestore();
    }
  });

  it('refreshes the discovered domain snapshot when an existing tenant activates Marketing before its next claim', async () => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    const timestamp = '2026-01-01T00:00:00.000Z';
    const signal = {
      signal_id: 'discovered-marketing-signal', tenant_id,
      correlation_id: 'discovered-marketing-correlation', source_channel: 'WEB_CHAT',
      event_type: 'campaign.requested', payload: { module: 'marketing' }, timestamp,
    };
    const taskRecord: DurableTaskRecord = {
      tenant_id, task_id: 'discovered-marketing-run', run_id: 'discovered-marketing-run',
      correlation_id: signal.correlation_id, current_step: 0, state: 'running',
      task_version: 1, lease_owner: 'worker-discovery', lease_expires_at: null,
      retry_count: 0, max_retries: 3, last_error_class: null, paused_for_approval_id: null,
      state_payload: { signal }, error_details: null, created_at: timestamp, updated_at: timestamp,
    };
    const factory = createMarketingOrchestratorFactory({
      auditSecret: 'discovered-marketing-regression-secret',
      env: { AUDIT_HMAC_SECRET: 'discovered-marketing-regression-secret' },
    });
    const orchestrator = await factory(tenant_id);
    if (orchestrator === null) throw new Error('Marketing test factory must bind');
    const processQueuedSignal = vi.spyOn(orchestrator, 'processQueuedSignal')
      .mockResolvedValue({ run_id: taskRecord.run_id, lifecycle_state: 'waiting' });
    const listActiveTenants = vi.fn()
      .mockResolvedValueOnce([{ tenant_id, enabled_domains: ['sales'] }])
      .mockResolvedValue([{ tenant_id, enabled_domains: ['sales', 'marketing'] }]);
    const claimNextQueuedTask = vi.fn().mockResolvedValueOnce({
      task: taskRecord, task_version: 1, lease_owner: 'worker-discovery', lease_expires_at: timestamp,
    }).mockResolvedValue(null);
    const recordFailure = vi.fn();
    const onError = vi.fn();
    const worker = startWorker({ ENABLED_AGENT_MODULES: 'sales,marketing' }, {
      hmac: () => '',
      workerId: 'worker-discovery',
      readiness: true,
      pollIntervalMs: 60_000,
      tenantDiscoveryIntervalMs: 60_000,
      tenantDiscoveryRepository: { listActiveTenants },
      domainRegistry: createDomainRuntimeRegistry([
        {
          contract: {
            module: 'sales', source_channels: ['WEB_CHAT'], event_types: ['message.received'],
            signal_invalid_code: 'SALES_SIGNAL_INVALID',
          },
          createOrchestrator: () => orchestrator,
        },
        {
          contract: {
            module: 'marketing', source_channels: ['WEB_CHAT'], event_types: ['campaign.requested'],
            signal_invalid_code: 'MARKETING_SIGNAL_INVALID',
          },
          createOrchestrator: () => orchestrator,
        },
      ]),
      workflowRepository: {
        claimNextQueuedTask,
        getTask: vi.fn().mockResolvedValue({ ...taskRecord, state: 'waiting' }),
        renewTaskLease: vi.fn(), releaseTaskLease: vi.fn(), recordFailure, transitionTask: vi.fn(),
      },
      conversationRepository: { appendMessage: vi.fn() },
      onError,
    });
    try {
      await vi.waitFor(() => expect(worker.getTenantIds()).toEqual([tenant_id]));
      expect(listActiveTenants).toHaveBeenCalledOnce();
      expect(await worker.poller?.pollOnce()).toBe(1);
      expect(listActiveTenants).toHaveBeenCalledTimes(2);
      expect(processQueuedSignal).toHaveBeenCalledWith(taskRecord.run_id, signal, { worker_id: 'worker-discovery' });
      expect(recordFailure).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await worker.close();
      processQueuedSignal.mockRestore();
    }
  });
});
describe('startWorker', () => {

  it('binds PostgreSQL stage recording for the production Marketing composition', async () => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    const worker = startWorker({
      ENABLED_AGENT_MODULES: 'marketing',
      AUDIT_HMAC_SECRET: 'production-binding-test-secret',
    }, {
      hmac: () => '',
      tenantIds: [tenant_id],
      autoStartPolling: false,
    });
    try {
      const orchestrator = await worker.registry?.resolve('marketing')?.createOrchestrator(tenant_id);
      expect(orchestrator).toBeDefined();
      const internals = orchestrator as unknown as {
        dependencies: { runStageRecorder?: unknown };
      };
      const recorder = internals.dependencies.runStageRecorder;
      expect(recorder).toBeInstanceOf(DurableRunStageRecorder);
      const adapter = recorder as { repository: unknown };
      expect(adapter.repository).toBeInstanceOf(RunStageEventsRepository);
    } finally {
      await worker.close();
    }
  });
  it('preserves offline Marketing workflow and stage-recorder seams', async () => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    const customWorkflowRepository = {} as DurableWorkflowRepository;
    const customWorkflowEngine = {};
    const customRecorder = {
      nextAttemptOrdinal: vi.fn(),
      append: vi.fn(),
    };
    const worker = startWorker({
      ENABLED_AGENT_MODULES: 'marketing',
      AUDIT_HMAC_SECRET: 'offline-marketing-test-secret',
    }, {
      hmac: () => '',
      tenantIds: [tenant_id],
      autoStartPolling: false,
      workflowRepository: customWorkflowRepository,
      marketingFactoryOptions: {
        auditSecret: 'offline-marketing-test-secret',
        workflowRepository: customWorkflowRepository,
        workflowEngine: customWorkflowEngine as never,
        evidenceLogger: {} as never,
        auditTrail: {} as never,
        sessionControl: {} as never,
        leaseManager: {} as never,
        runStageRecorder: customRecorder as never,
      },
    });
    try {
      const orchestrator = await worker.registry?.resolve('marketing')?.createOrchestrator(tenant_id);
      expect(orchestrator).toBeDefined();
      const internals = orchestrator as unknown as {
        dependencies: { runStageRecorder?: unknown; workflowEngine?: unknown };
      };
      expect(internals.dependencies.workflowEngine).toBe(customWorkflowEngine);
      expect(internals.dependencies.runStageRecorder).toBe(customRecorder);
      expect(internals.dependencies.runStageRecorder).not.toBeInstanceOf(DurableRunStageRecorder);
    } finally {
      await worker.close();
    }
  });


  it('does not claim tenant work when the Care orchestrator is unbound', async () => {
    const claimNextQueuedTask = vi.fn();
    const worker = startWorker({}, {
      hmac: () => '',
      tenantIds: ['00000000-0000-4000-8000-000000000001'],
      workflowRepository: { claimNextQueuedTask } as unknown as DurableWorkflowRepository,
      autoStartPolling: false,
    });

    expect(await worker.poller?.pollOnce()).toBe(0);
    expect(claimNextQueuedTask).not.toHaveBeenCalled();
    await worker.close();
  });

  it('parks a reclaimed mutating checkpoint without calling the orchestrator', async () => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    const checkpoint = {
      plan: { plan_id: 'plan-1', steps: [], fallback_strategy: 'FAIL_CLOSED' },
      current_step: 1,
      pending_action: { mutating: true, effect_key: 'effect-1' },
      context: { tenant_id },
      previous_evidence_hash: '0'.repeat(64),
      request_id: 'request-1',
    };
    const taskRecord = {
      tenant_id, run_id: 'run-1', correlation_id: 'corr-1',
      task_version: 2, state: 'running', lease_owner: 'worker-1',
      state_payload: checkpoint,
    } as DurableTaskRecord;
    const transitionTask = vi.fn().mockResolvedValue(undefined);
    const getTask = vi.fn().mockResolvedValue({ ...taskRecord, state: 'waiting' });
    const releaseTaskLease = vi.fn();
    const orchestratorFactory = vi.fn();

    await processClaimedTask({
      taskRecord, tenant_id, worker_id: 'worker-1',
      workflowRepository: {
        transitionTask, getTask, releaseTaskLease,
      } as unknown as DurableWorkflowRepository,
      orchestratorFactory,
    });

    expect(transitionTask).toHaveBeenCalledWith(
      tenant_id, 'run-1', 'waiting', expect.stringContaining('reconciliation'), checkpoint,
      { expected_task_version: 2, lease_owner: 'worker-1' },
    );
    expect(orchestratorFactory).not.toHaveBeenCalled();
    expect(releaseTaskLease).not.toHaveBeenCalled();
  });

  it('lets a reclaimed mutating step run again only when its reservation is confirmed absent', async () => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    const checkpoint = {
      plan: { plan_id: 'plan-1', steps: [], fallback_strategy: 'FAIL_CLOSED' },
      current_step: 1,
      pending_action: { mutating: true, effect_key: 'effect-1' },
      context: { tenant_id },
      previous_evidence_hash: '0'.repeat(64),
      request_id: 'request-1',
    };
    const taskRecord = {
      tenant_id, run_id: 'run-1', correlation_id: 'corr-1',
      task_version: 2, state: 'running', lease_owner: 'worker-1',
      state_payload: checkpoint,
    } as DurableTaskRecord;

    async function reclaim(status: 'FAILED' | 'RESERVED') {
      const transitionTask = vi.fn().mockResolvedValue(undefined);
      const getReservation = vi.fn().mockResolvedValue({ status });
      await processClaimedTask({
        taskRecord, tenant_id, worker_id: 'worker-1',
        workflowRepository: {
          transitionTask,
          getTask: vi.fn().mockResolvedValue(taskRecord),
          releaseTaskLease: vi.fn(),
          recordFailure: vi.fn(),
        } as unknown as DurableWorkflowRepository,
        orchestratorFactory: vi.fn().mockResolvedValue(null),
        effectReservations: { getReservation } as never,
      });
      expect(getReservation).toHaveBeenCalledWith(tenant_id, 'effect-1');
      return transitionTask.mock.calls.some((call) => call[2] === 'waiting');
    }

    expect(await reclaim('RESERVED')).toBe(true);
    expect(await reclaim('FAILED')).toBe(false);
  });
  it('does not execute a parked task until a resume event is present', async () => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    const processQueuedSignal = vi.fn();
    const taskRecord = {
      tenant_id,
      run_id: 'run-parked',
      correlation_id: 'corr-parked',
      task_version: 3,
      state: 'waiting',
      lease_owner: 'worker-1',
      state_payload: {
        signal: {
          signal_id: 'sig-parked',
          tenant_id,
          correlation_id: 'corr-parked',
          source_channel: 'WEB_CHAT',
          event_type: 'message.received',
          timestamp: '2026-09-30T00:00:00.000Z',
          subject: { session_id: 'session-parked', channel_type: 'web' },
          payload: { module: 'support', message: 'resume only after event' },
        },
      },
    } as DurableTaskRecord;
    const orchestratorFactory = vi.fn().mockResolvedValue({ processQueuedSignal });
    const getTask = vi.fn().mockResolvedValue(taskRecord);
    const releaseTaskLease = vi.fn();

    await processClaimedTask({
      taskRecord,
      tenant_id,
      worker_id: 'worker-1',
      workflowRepository: {
        getTask,
        releaseTaskLease,
      } as unknown as DurableWorkflowRepository,
      orchestratorFactory,
    });

    expect(orchestratorFactory).not.toHaveBeenCalled();
    expect(processQueuedSignal).not.toHaveBeenCalled();
    expect(releaseTaskLease).toHaveBeenCalledWith({
      tenant_id,
      run_id: 'run-parked',
      lease_owner: 'worker-1',
      task_version: 3,
      target_state: 'waiting',
    });
  });


  it('resumes task when payload carries a valid resume event and complete checkpoint', async () => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    const resumeEvent = {
      tenant_id,
      run_id: 'run-1',
      effect_key: 'effect-1',
      event_type: 'human.approval',
      approval_id: 'appr-1',
      expected_payload_sha256: 'a'.repeat(64),
      operator_id: 'operator-1',
      reason: 'approve',
    };
    const completeCheckpoint = {
      signal: {
        signal_id: 'sig-1',
        tenant_id,
        correlation_id: 'corr-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        payload: { module: 'support', message: 'help' },
      },
      resume_event: resumeEvent,
      plan: { plan_id: 'plan-1', steps: [], fallback_strategy: 'FAIL_CLOSED' },
      current_step: 1,
      context: { tenant_id, correlation_id: 'corr-1' },
      previous_evidence_hash: '0'.repeat(64),
      request_id: 'request-1',
      pending_action: { action_id: 'act-1', effect_key: 'effect-1' },
    };

    const taskRecord = {
      tenant_id,
      run_id: 'run-1',
      correlation_id: 'corr-1',
      task_version: 2,
      state: 'awaiting_human',
      lease_owner: 'worker-1',
      state_payload: completeCheckpoint,
    } as DurableTaskRecord;

    const resumeTask = vi.fn().mockResolvedValue(undefined);
    const mockOrchestrator = { resumeTask };
    const orchestratorFactory = vi.fn().mockResolvedValue(mockOrchestrator);
    const getTask = vi.fn().mockResolvedValue(taskRecord);
    const releaseTaskLease = vi.fn().mockResolvedValue(true);
    const recordFailure = vi.fn();

    await processClaimedTask({
      taskRecord,
      tenant_id,
      worker_id: 'worker-1',
      workflowRepository: {
        getTask,
        releaseTaskLease,
        recordFailure,
        transitionTask: vi.fn(),
      } as unknown as DurableWorkflowRepository,
      orchestratorFactory,
    });

    expect(orchestratorFactory).toHaveBeenCalledWith(tenant_id);
    expect(resumeTask).toHaveBeenCalledWith('run-1', resumeEvent);
    expect(recordFailure).not.toHaveBeenCalled();
    expect(releaseTaskLease).toHaveBeenCalledWith({
      tenant_id,
      run_id: 'run-1',
      lease_owner: 'worker-1',
      task_version: 2,
      target_state: 'awaiting_human',
    });
  });
  it('releases a parked lease after the orchestrator consumes its resume event', async () => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    const resumeEvent = { tenant_id, event_type: 'human.reconcile', operator_id: 'operator-1', reconciliation_resolution: 'ESCALATE_MANUALLY' };
    const checkpoint = {
      signal: {
        signal_id: 'sig-1',
        tenant_id,
        correlation_id: 'corr-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        payload: { module: 'support', message: 'help' },
      },
      plan: { plan_id: 'plan-1', steps: [], fallback_strategy: 'FAIL_CLOSED' },
      current_step: 1,
      pending_action: { mutating: true, effect_key: 'effect-1' },
      context: { tenant_id },
      previous_evidence_hash: '0'.repeat(64),
      request_id: 'request-1',
    };
    const taskRecord = {
      tenant_id,
      run_id: 'run-1',
      correlation_id: 'corr-1',
      task_version: 2,
      state: 'waiting',
      lease_owner: 'worker-1',
      state_payload: { ...checkpoint, resume_event: resumeEvent },
    } as DurableTaskRecord;
    const resumeTask = vi.fn().mockResolvedValue(undefined);
    const releaseTaskLease = vi.fn().mockResolvedValue(true);

    await processClaimedTask({
      taskRecord,
      tenant_id,
      worker_id: 'worker-1',
      workflowRepository: {
        getTask: vi.fn().mockResolvedValue({ ...taskRecord, state_payload: checkpoint }),
        releaseTaskLease,
        recordFailure: vi.fn(),
        transitionTask: vi.fn(),
      } as unknown as DurableWorkflowRepository,
      orchestratorFactory: vi.fn().mockResolvedValue({ resumeTask }),
    });

    expect(resumeTask).toHaveBeenCalledWith('run-1', resumeEvent);
    expect(releaseTaskLease).toHaveBeenCalledWith({
      tenant_id,
      run_id: 'run-1',
      lease_owner: 'worker-1',
      task_version: 2,
      target_state: 'waiting',
    });
  });

  it('fails closed with CHECKPOINT_INCOMPLETE when resume_event has incomplete checkpoint', async () => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    const incompletePayload = {
      resume_event: {
        tenant_id,
        event_type: 'human.approval',
        approval_id: 'appr-1',
        expected_payload_sha256: 'a'.repeat(64),
        operator_id: 'operator-1',
      },
      // Missing current_step, context, previous_evidence_hash, request_id and pending_action.
      plan: { plan_id: 'plan-1', steps: [] },
    };

    const taskRecord = {
      tenant_id,
      run_id: 'run-2',
      correlation_id: 'corr-2',
      task_version: 1,
      state: 'running',
      lease_owner: 'worker-1',
      state_payload: incompletePayload,
    } as DurableTaskRecord;

    const resumeTask = vi.fn();
    const orchestratorFactory = vi.fn().mockResolvedValue({ resumeTask });
    const recordFailure = vi.fn().mockResolvedValue(undefined);
    const getTask = vi.fn().mockResolvedValue({ ...taskRecord, state: 'failed' });
    const releaseTaskLease = vi.fn().mockResolvedValue(true);

    await processClaimedTask({
      taskRecord,
      tenant_id,
      worker_id: 'worker-1',
      workflowRepository: {
        getTask,
        releaseTaskLease,
        recordFailure,
        transitionTask: vi.fn(),
      } as unknown as DurableWorkflowRepository,
      orchestratorFactory,
    });

    expect(recordFailure).toHaveBeenCalledWith({
      tenant_id,
      run_id: 'run-2',
      error_class: 'FATAL',
      error_details: { code: 'CHECKPOINT_INCOMPLETE' },
      expected_task_version: 1,
      lease_owner: 'worker-1',
    });
    expect(resumeTask).not.toHaveBeenCalled();
  });
  it.each([
    ['failed', false],
    ['stopped', false],
    ['failed', true],
    ['stopped', true],
  ])(
    'appends one replay-safe system message when a conversational run is %s (checkpoint binding: %s)',
    async (terminalState, checkpointBinding) => {
      const tenant_id = '00000000-0000-4000-8000-000000000001';
      const conversation_id = '33333333-3333-4333-8333-333333333333';
      const taskRecord = {
        tenant_id,
        run_id: 'run-conversation-failure',
        correlation_id: 'corr-conversation-failure',
        task_version: 1,
        state: 'queued',
        lease_owner: 'worker-1',
        state_payload: checkpointBinding
          ? { context: { working_memory: { conversation_id } } }
          : {
              signal: {
                subject: { session_id: 'thread-1', conversation_id },
                payload: { module: 'support' },
              },
            },
      } as DurableTaskRecord;
      const getTask = vi.fn().mockResolvedValue({ ...taskRecord, state: terminalState });
      const recordFailure = vi.fn().mockResolvedValue(undefined);
      const storedMessages = new Map<string, string>();
      const appendMessage = vi.fn(async (input: {
        readonly request_id?: string;
        readonly content: string;
      }) => {
        if (input.request_id !== undefined && !storedMessages.has(input.request_id)) {
          storedMessages.set(input.request_id, input.content);
        }
        return 'message-1';
      });
      const workflowRepository = {
        getTask,
        releaseTaskLease: vi.fn(),
        recordFailure,
        transitionTask: vi.fn(),
      } as unknown as DurableWorkflowRepository;
      const params = {
        taskRecord,
        tenant_id,
        worker_id: 'worker-1',
        workflowRepository,
        conversationRepository: { appendMessage } as never,
      };

      await processClaimedTask(params);
      await processClaimedTask(params);

      expect(appendMessage).toHaveBeenCalledTimes(2);
      expect(appendMessage).toHaveBeenNthCalledWith(1, {
        tenant_id,
        conversation_id,
        sender_type: 'system',
        sender_id: 'system',
        content: 'Trợ lý chưa trả lời được. Nhân viên sẽ hỗ trợ bạn.',
        request_id: 'run-failed:run-conversation-failure',
      });
      expect(appendMessage.mock.calls[1]?.[0].request_id).toBe('run-failed:run-conversation-failure');
      expect([...storedMessages.values()]).toEqual(['Trợ lý chưa trả lời được. Nhân viên sẽ hỗ trợ bạn.']);
    },
  );

  it('reports unbound capabilities in worker.blockers', async () => {
    const worker = startWorker({}, {
      hmac: () => '',
      tenantIds: ['00000000-0000-4000-8000-000000000001'],
      autoStartPolling: false,
    });

    expect(worker.blockers).toBeDefined();
    expect(worker.blockers?.some((b) => b.includes('CARE_CAPABILITY_UNBOUND'))).toBe(true);
    await worker.close();
  });
  it('keeps startWorker polling disabled and reports a readiness blocker until admitted', async () => {
    const worker = startWorker({}, {
      hmac: () => '',
      tenantIds: ['00000000-0000-4000-8000-000000000001'],
      domainRegistry: {
        modules: () => ['support'],
        resolve: () => null,
        accepts: () => null,
      } as never,
      workflowRepository: { claimNextQueuedTask: vi.fn() } as never,
    });

    expect(worker.poller?.isRunning).toBe(false);
    expect(worker.blockers?.some((blocker) => blocker.startsWith('WORKER_READINESS_REQUIRED:'))).toBe(true);
    await worker.close();
  });
  it('starts startWorker polling after readiness is explicitly admitted', async () => {
    const scheduleTimer = vi.fn(() => ({}) as NodeJS.Timeout);
    const worker = startWorker({}, {
      hmac: () => '',
      tenantIds: ['00000000-0000-4000-8000-000000000001'],
      readiness: true,
      domainRegistry: {
        modules: () => ['support'],
        resolve: () => null,
        accepts: () => null,
      } as never,
      workflowRepository: { claimNextQueuedTask: vi.fn() } as never,
      setTimeout: scheduleTimer,
      clearTimeout: vi.fn(),
    });

    expect(worker.poller?.isRunning).toBe(true);
    expect(scheduleTimer).toHaveBeenCalledOnce();
    await worker.close();
  });

  it('fails startup closed when ENABLED_AGENT_MODULES contains an unknown module', () => {
    expect(() =>
      startWorker(
        { ENABLED_AGENT_MODULES: 'support,unknown_module' },
        {
          hmac: () => '',
          tenantIds: ['00000000-0000-4000-8000-000000000001'],
          autoStartPolling: false,
        },
      ),
    ).toThrow(/ENABLED_AGENT_MODULES_INVALID/);
  });

  it('fails task with CAPABILITY_NOT_ENABLED when module has no enabled binding', async () => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    const taskRecord = {
      tenant_id,
      run_id: 'run-sales-1',
      correlation_id: 'corr-1',
      task_version: 1,
      state: 'queued',
      lease_owner: 'worker-1',
      state_payload: {
        signal: {
          signal_id: 'sig-1',
          tenant_id,
          correlation_id: 'corr-1',
          source_channel: 'WEB_CHAT',
          event_type: 'message.received',
          payload: { module: 'sales', message: 'I want to buy shoes' },
        },
      },
    } as DurableTaskRecord;

    const recordFailure = vi.fn();
    const getTask = vi.fn().mockResolvedValue(taskRecord);
    const releaseTaskLease = vi.fn().mockResolvedValue(true);
    const orchestratorFactory = vi.fn();

    await processClaimedTask({
      taskRecord,
      tenant_id,
      worker_id: 'worker-1',
      workflowRepository: {
        getTask,
        releaseTaskLease,
        recordFailure,
        transitionTask: vi.fn(),
      } as unknown as DurableWorkflowRepository,
      orchestratorFactory,
    });

    expect(recordFailure).toHaveBeenCalledWith({
      tenant_id,
      run_id: 'run-sales-1',
      error_class: 'FATAL',
      error_details: {
        code: 'CAPABILITY_NOT_ENABLED',
        module: 'sales',
        message: expect.stringContaining('sales'),
      },
      expected_task_version: 1,
      lease_owner: 'worker-1',
    });
    expect(orchestratorFactory).not.toHaveBeenCalled();
  });

  it('reports sales capability unbound when SALES_SIGNAL_SOURCE_CHANNELS or SALES_SIGNAL_EVENT_TYPES is unset', async () => {
    const worker = startWorker(
      { ENABLED_AGENT_MODULES: 'support,sales' },
      {
        hmac: () => '',
        tenantIds: ['00000000-0000-4000-8000-000000000001'],
        autoStartPolling: false,
      },
    );

    expect(worker.blockers?.some((b) => b.includes('SALES_CAPABILITY_UNBOUND'))).toBe(true);
    expect(worker.registry?.resolve('sales')).toBeNull();
    await worker.close();
  });
  it('keeps read recommendations available without optional revenue evidence in either environment', async () => {
    const baseEnv = {
      ENABLED_AGENT_MODULES: 'sales',
      SALES_SIGNAL_SOURCE_CHANNELS: 'WEB_CHAT',
      SALES_SIGNAL_EVENT_TYPES: 'message.received',
      APP_ENV: 'local',
      AUDIT_HMAC_SECRET: 'worker-demo-evidence-test-secret',
    };
    const demoWorker = startWorker({ ...baseEnv, DEMO_MODE: 'true' }, {
      hmac: () => '',
      tenantIds: ['00000000-0000-4000-8000-000000000001'],
      autoStartPolling: false,
    });
    const productionWorker = startWorker(baseEnv, {
      hmac: () => '',
      tenantIds: ['00000000-0000-4000-8000-000000000001'],
      autoStartPolling: false,
    });

    try {
      expect(demoWorker.blockers?.some((blocker) => blocker.includes('Core.RecommendationEngine revenue evidence'))).toBe(false);
      expect(productionWorker.blockers?.some((blocker) => blocker.includes('Core.RecommendationEngine revenue evidence'))).toBe(false);
    } finally {
      await demoWorker.close();
      await productionWorker.close();
    }
  });


  it('routes module: sales to sales orchestrator factory when enabled and signal matches contract', async () => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    const taskRecord = {
      tenant_id,
      run_id: 'run-sales-2',
      correlation_id: 'corr-sales-2',
      task_version: 1,
      state: 'queued',
      lease_owner: 'worker-1',
      state_payload: {
        signal: {
          signal_id: 'sig-sales-2',
          tenant_id,
          correlation_id: 'corr-sales-2',
          source_channel: 'STOREFRONT',
          event_type: 'cart.abandoned',
          payload: { module: 'sales', cart_id: 'cart-123' },
        },
      },
    } as DurableTaskRecord;

    const processQueuedSignal = vi.fn().mockResolvedValue(undefined);
    const salesOrchestrator = { processQueuedSignal };
    const salesOrchestratorFactory = vi.fn().mockResolvedValue(salesOrchestrator);
    const careOrchestratorFactory = vi.fn();
    const recordFailure = vi.fn();
    const getTask = vi.fn().mockResolvedValue(taskRecord);
    const releaseTaskLease = vi.fn().mockResolvedValue(true);

    const worker = startWorker(
      {
        ENABLED_AGENT_MODULES: 'support,sales',
        SALES_SIGNAL_SOURCE_CHANNELS: 'STOREFRONT,WEB_CHAT',
        SALES_SIGNAL_EVENT_TYPES: 'cart.abandoned,message.received',
      },
      {
        hmac: () => '',
        tenantIds: [tenant_id],
        autoStartPolling: false,
        orchestratorFactory: careOrchestratorFactory,
        salesOrchestratorFactory,
      },
    );

    expect(worker.registry?.resolve('sales')).not.toBeNull();

    await processClaimedTask({
      taskRecord,
      tenant_id,
      worker_id: 'worker-1',
      workflowRepository: {
        getTask,
        releaseTaskLease,
        recordFailure,
        transitionTask: vi.fn(),
      } as unknown as DurableWorkflowRepository,
      registry: worker.registry,
    });

    expect(recordFailure).not.toHaveBeenCalled();
    expect(careOrchestratorFactory).not.toHaveBeenCalled();
    expect(salesOrchestratorFactory).toHaveBeenCalledWith(tenant_id);
    expect(processQueuedSignal).toHaveBeenCalledWith(
      'run-sales-2',
      (taskRecord.state_payload as Record<string, unknown>).signal,
      { worker_id: 'worker-1' },
    );

    await worker.close();
  });

  it('fails with SALES_SIGNAL_INVALID when sales signal violates its contract channels', async () => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    const taskRecord = {
      tenant_id,
      run_id: 'run-sales-3',
      correlation_id: 'corr-sales-3',
      task_version: 1,
      state: 'queued',
      lease_owner: 'worker-1',
      state_payload: {
        signal: {
          signal_id: 'sig-sales-3',
          tenant_id,
          correlation_id: 'corr-sales-3',
          source_channel: 'UNSUPPORTED_CHANNEL',
          event_type: 'cart.abandoned',
          payload: { module: 'sales', cart_id: 'cart-123' },
        },
      },
    } as DurableTaskRecord;

    const salesOrchestratorFactory = vi.fn();
    const recordFailure = vi.fn();
    const getTask = vi.fn().mockResolvedValue(taskRecord);
    const releaseTaskLease = vi.fn().mockResolvedValue(true);

    const worker = startWorker(
      {
        ENABLED_AGENT_MODULES: 'sales',
        SALES_SIGNAL_SOURCE_CHANNELS: 'STOREFRONT',
        SALES_SIGNAL_EVENT_TYPES: 'cart.abandoned',
      },
      {
        hmac: () => '',
        tenantIds: [tenant_id],
        autoStartPolling: false,
        salesOrchestratorFactory,
      },
    );

    await processClaimedTask({
      taskRecord,
      tenant_id,
      worker_id: 'worker-1',
      workflowRepository: {
        getTask,
        releaseTaskLease,
        recordFailure,
        transitionTask: vi.fn(),
      } as unknown as DurableWorkflowRepository,
      registry: worker.registry,
    });

    expect(recordFailure).toHaveBeenCalledWith({
      tenant_id,
      run_id: 'run-sales-3',
      error_class: 'FATAL',
      error_details: { code: 'SALES_SIGNAL_INVALID' },
      expected_task_version: 1,
      lease_owner: 'worker-1',
    });
    expect(salesOrchestratorFactory).not.toHaveBeenCalled();

    await worker.close();
  });

  it('resumes task through sales orchestrator factory when module is sales', async () => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    const resumeEvent = {
      tenant_id,
      run_id: 'run-sales-resume-1',
      effect_key: 'effect-sales-1',
      event_type: 'human.approval',
      approval_id: 'appr-sales-1',
      expected_payload_sha256: 'a'.repeat(64),
      operator_id: 'operator-1',
      reason: 'approve discount',
    };
    const completeCheckpoint = {
      signal: {
        signal_id: 'sig-sales-resume-1',
        tenant_id,
        correlation_id: 'corr-sales-1',
        source_channel: 'STOREFRONT',
        event_type: 'cart.abandoned',
        payload: { module: 'sales', cart_id: 'cart-1' },
      },
      resume_event: resumeEvent,
      plan: { plan_id: 'plan-1', steps: [], fallback_strategy: 'FAIL_CLOSED' },
      current_step: 1,
      context: { tenant_id, correlation_id: 'corr-sales-1' },
      previous_evidence_hash: '0'.repeat(64),
      request_id: 'request-sales-1',
      pending_action: { action_id: 'act-1', effect_key: 'effect-sales-1' },
    };

    const taskRecord = {
      tenant_id,
      run_id: 'run-sales-resume-1',
      correlation_id: 'corr-sales-1',
      task_version: 2,
      state: 'awaiting_human',
      lease_owner: 'worker-1',
      state_payload: completeCheckpoint,
    } as DurableTaskRecord;

    const salesResumeTask = vi.fn().mockResolvedValue(undefined);
    const salesOrchestrator = { resumeTask: salesResumeTask };
    const salesOrchestratorFactory = vi.fn().mockResolvedValue(salesOrchestrator);
    const careOrchestratorFactory = vi.fn();
    const getTask = vi.fn().mockResolvedValue(taskRecord);
    const releaseTaskLease = vi.fn().mockResolvedValue(true);
    const recordFailure = vi.fn();

    const worker = startWorker(
      {
        ENABLED_AGENT_MODULES: 'support,sales',
        SALES_SIGNAL_SOURCE_CHANNELS: 'STOREFRONT',
        SALES_SIGNAL_EVENT_TYPES: 'cart.abandoned',
      },
      {
        hmac: () => '',
        tenantIds: [tenant_id],
        autoStartPolling: false,
        orchestratorFactory: careOrchestratorFactory,
        salesOrchestratorFactory,
      },
    );

    await processClaimedTask({
      taskRecord,
      tenant_id,
      worker_id: 'worker-1',
      workflowRepository: {
        getTask,
        releaseTaskLease,
        recordFailure,
        transitionTask: vi.fn(),
      } as unknown as DurableWorkflowRepository,
      registry: worker.registry,
    });

    expect(recordFailure).not.toHaveBeenCalled();
    expect(careOrchestratorFactory).not.toHaveBeenCalled();
    expect(salesOrchestratorFactory).toHaveBeenCalledWith(tenant_id);
    expect(salesResumeTask).toHaveBeenCalledWith('run-sales-resume-1', resumeEvent);

    await worker.close();
  });

  it('fails closed naming sales module on resume event when sales is disabled and does NOT call Care factory', async () => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    const resumeEvent = {
      tenant_id,
      run_id: 'run-sales-resume-2',
      effect_key: 'effect-sales-2',
      event_type: 'human.approval',
      approval_id: 'appr-sales-2',
      expected_payload_sha256: 'b'.repeat(64),
      operator_id: 'operator-2',
      reason: 'approve',
    };
    const completeCheckpoint = {
      signal: {
        signal_id: 'sig-sales-resume-2',
        tenant_id,
        correlation_id: 'corr-sales-2',
        source_channel: 'STOREFRONT',
        event_type: 'cart.abandoned',
        payload: { module: 'sales', cart_id: 'cart-2' },
      },
      resume_event: resumeEvent,
      plan: { plan_id: 'plan-1', steps: [], fallback_strategy: 'FAIL_CLOSED' },
      current_step: 1,
      context: { tenant_id, correlation_id: 'corr-sales-2' },
      previous_evidence_hash: '0'.repeat(64),
      request_id: 'request-sales-2',
      pending_action: { action_id: 'act-2', effect_key: 'effect-sales-2' },
    };

    const taskRecord = {
      tenant_id,
      run_id: 'run-sales-resume-2',
      correlation_id: 'corr-sales-2',
      task_version: 2,
      state: 'awaiting_human',
      lease_owner: 'worker-1',
      state_payload: completeCheckpoint,
    } as DurableTaskRecord;

    const careResumeTask = vi.fn();
    const careOrchestratorFactory = vi.fn().mockResolvedValue({ resumeTask: careResumeTask });
    const getTask = vi.fn().mockResolvedValue(taskRecord);
    const releaseTaskLease = vi.fn().mockResolvedValue(true);
    const recordFailure = vi.fn();

    const worker = startWorker(
      {
        ENABLED_AGENT_MODULES: 'support',
      },
      {
        hmac: () => '',
        tenantIds: [tenant_id],
        autoStartPolling: false,
        orchestratorFactory: careOrchestratorFactory,
      },
    );

    await processClaimedTask({
      taskRecord,
      tenant_id,
      worker_id: 'worker-1',
      workflowRepository: {
        getTask,
        releaseTaskLease,
        recordFailure,
        transitionTask: vi.fn(),
      } as unknown as DurableWorkflowRepository,
      registry: worker.registry,
    });

    expect(recordFailure).toHaveBeenCalledWith({
      tenant_id,
      run_id: 'run-sales-resume-2',
      error_class: 'FATAL',
      error_details: {
        code: 'CAPABILITY_NOT_ENABLED',
        module: 'sales',
        message: expect.stringContaining('sales'),
      },
      expected_task_version: 2,
      lease_owner: 'worker-1',
    });
    expect(careOrchestratorFactory).not.toHaveBeenCalled();
    expect(careResumeTask).not.toHaveBeenCalled();

    await worker.close();
  });

  it('fails closed naming sales module when resume event is passed only support orchestratorFactory', async () => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    const resumeEvent = {
      tenant_id,
      run_id: 'run-sales-resume-3',
      effect_key: 'effect-sales-3',
      event_type: 'human.approval',
      approval_id: 'appr-sales-3',
      expected_payload_sha256: 'c'.repeat(64),
      operator_id: 'operator-3',
      reason: 'approve',
    };
    const completeCheckpoint = {
      signal: {
        signal_id: 'sig-sales-resume-3',
        tenant_id,
        correlation_id: 'corr-sales-3',
        source_channel: 'STOREFRONT',
        event_type: 'cart.abandoned',
        payload: { module: 'sales', cart_id: 'cart-3' },
      },
      resume_event: resumeEvent,
      plan: { plan_id: 'plan-1', steps: [], fallback_strategy: 'FAIL_CLOSED' },
      current_step: 1,
      context: { tenant_id, correlation_id: 'corr-sales-3' },
      previous_evidence_hash: '0'.repeat(64),
      request_id: 'request-sales-3',
      pending_action: { action_id: 'act-3', effect_key: 'effect-sales-3' },
    };

    const taskRecord = {
      tenant_id,
      run_id: 'run-sales-resume-3',
      correlation_id: 'corr-sales-3',
      task_version: 2,
      state: 'awaiting_human',
      lease_owner: 'worker-1',
      state_payload: completeCheckpoint,
    } as DurableTaskRecord;

    const orchestratorFactory = vi.fn();
    const recordFailure = vi.fn();
    const getTask = vi.fn().mockResolvedValue(taskRecord);
    const releaseTaskLease = vi.fn().mockResolvedValue(true);

    await processClaimedTask({
      taskRecord,
      tenant_id,
      worker_id: 'worker-1',
      workflowRepository: {
        getTask,
        releaseTaskLease,
        recordFailure,
        transitionTask: vi.fn(),
      } as unknown as DurableWorkflowRepository,
      orchestratorFactory,
    });

    expect(recordFailure).toHaveBeenCalledWith({
      tenant_id,
      run_id: 'run-sales-resume-3',
      error_class: 'FATAL',
      error_details: {
        code: 'CAPABILITY_NOT_ENABLED',
        module: 'sales',
        message: expect.stringContaining('sales'),
      },
      expected_task_version: 2,
      lease_owner: 'worker-1',
    });
    expect(orchestratorFactory).not.toHaveBeenCalled();
  });

  it('fails closed with CAPABILITY_NOT_ENABLED when fresh signal declares an unresolvable module', async () => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    const taskRecord = {
      tenant_id,
      run_id: 'run-fresh-unresolvable',
      correlation_id: 'corr-fresh-unresolvable',
      task_version: 1,
      state: 'queued',
      lease_owner: 'worker-1',
      state_payload: {
        signal: {
          signal_id: 'sig-fresh-1',
          tenant_id,
          correlation_id: 'corr-fresh-1',
          source_channel: 'WEB_CHAT',
          event_type: 'message.received',
          payload: { module: 'finance', invoice_id: 'inv-1' },
        },
      },
    } as DurableTaskRecord;

    const recordFailure = vi.fn();
    const getTask = vi.fn().mockResolvedValue(taskRecord);
    const releaseTaskLease = vi.fn().mockResolvedValue(true);
    const orchestratorFactory = vi.fn();

    await processClaimedTask({
      taskRecord,
      tenant_id,
      worker_id: 'worker-1',
      workflowRepository: {
        getTask,
        releaseTaskLease,
        recordFailure,
        transitionTask: vi.fn(),
      } as unknown as DurableWorkflowRepository,
      orchestratorFactory,
    });

    expect(recordFailure).toHaveBeenCalledWith({
      tenant_id,
      run_id: 'run-fresh-unresolvable',
      error_class: 'FATAL',
      error_details: {
        code: 'CAPABILITY_NOT_ENABLED',
        module: 'finance',
        message: expect.stringContaining('finance'),
      },
      expected_task_version: 1,
      lease_owner: 'worker-1',
    });
    expect(orchestratorFactory).not.toHaveBeenCalled();
  });

  it('routes fresh Marketing tasks through the shared domain registry and orchestrator path', async () => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    const signal = {
      signal_id: 'sig-marketing-fresh-1',
      tenant_id,
      correlation_id: 'corr-marketing-fresh-1',
      source_channel: 'MARKETING_CAMPAIGN',
      event_type: 'campaign.requested',
      payload: {
        module: 'marketing',
        skill_id: 'skill.mkt.analyze_market_signal',
        input: { tenant_id, market_region: 'TW', category_id: 'tea', observation_window_days: 7 },
      },
    };
    const taskRecord = {
      tenant_id,
      run_id: 'run-marketing-fresh-1',
      correlation_id: signal.correlation_id,
      task_version: 1,
      state: 'queued',
      lease_owner: 'worker-1',
      state_payload: { signal },
    } as DurableTaskRecord;
    const processQueuedSignal = vi.fn().mockResolvedValue(undefined);
    const marketingOrchestratorFactory = vi.fn().mockResolvedValue({ processQueuedSignal });
    const worker = startWorker(
      { ENABLED_AGENT_MODULES: 'marketing' },
      {
        hmac: () => '',
        tenantIds: [tenant_id],
        autoStartPolling: false,
        marketingOrchestratorFactory,
      },
    );

    expect(worker.registry?.resolve('marketing')).not.toBeNull();
    await processClaimedTask({
      taskRecord,
      tenant_id,
      worker_id: 'worker-1',
      workflowRepository: {
        getTask: vi.fn().mockResolvedValue(taskRecord),
        releaseTaskLease: vi.fn().mockResolvedValue(true),
        recordFailure: vi.fn(),
        transitionTask: vi.fn(),
      } as unknown as DurableWorkflowRepository,
      registry: worker.registry,
    });

    expect(marketingOrchestratorFactory).toHaveBeenCalledWith(tenant_id);
    expect(processQueuedSignal).toHaveBeenCalledWith('run-marketing-fresh-1', signal, { worker_id: 'worker-1' });
    await worker.close();
  });

  it('admits an API-shaped marketing turn (WEB_CHAT) through the shared registry binding', async () => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    // The API gateway stamps an admitted conversation turn with the conversation channel
    // (`WEB_CHAT`), so the marketing signal contract must accept it as well as the internal
    // campaign channel. A turn without a canonical `skill_id` still fails closed in the planner.
    const signal = {
      signal_id: 'sig-marketing-web-chat-1',
      tenant_id,
      correlation_id: 'corr-marketing-web-chat-1',
      source_channel: 'WEB_CHAT',
      event_type: 'campaign.requested',
      timestamp: '2026-03-01T09:00:00.000Z',
      subject: { session_id: 'session-marketing-1', channel_type: 'WEB_CHAT' },
      payload: {
        module: 'marketing',
        skill_id: 'skill.mkt.dispatch_campaign',
        input: { tenant_id, campaign_id: 'CAMP-0115-01', segment_id: 'SEG-loyal', channel: 'LINE', approved_content_id: 'draft-1' },
      },
    };
    const taskRecord = {
      tenant_id,
      run_id: 'run-marketing-web-chat-1',
      correlation_id: signal.correlation_id,
      task_version: 1,
      state: 'queued',
      lease_owner: 'worker-1',
      state_payload: { signal },
    } as DurableTaskRecord;
    const processQueuedSignal = vi.fn().mockResolvedValue(undefined);
    const marketingOrchestratorFactory = vi.fn().mockResolvedValue({ processQueuedSignal });
    const worker = startWorker(
      { ENABLED_AGENT_MODULES: 'marketing' },
      {
        hmac: () => '',
        tenantIds: [tenant_id],
        autoStartPolling: false,
        marketingOrchestratorFactory,
      },
    );
    const recordFailure = vi.fn();

    await processClaimedTask({
      taskRecord,
      tenant_id,
      worker_id: 'worker-1',
      workflowRepository: {
        getTask: vi.fn().mockResolvedValue(taskRecord),
        releaseTaskLease: vi.fn().mockResolvedValue(true),
        recordFailure,
        transitionTask: vi.fn(),
      } as unknown as DurableWorkflowRepository,
      registry: worker.registry,
    });

    expect(recordFailure).not.toHaveBeenCalled();
    expect(processQueuedSignal).toHaveBeenCalledWith('run-marketing-web-chat-1', signal, { worker_id: 'worker-1' });
    await worker.close();
  });

  it('routes resumed Marketing tasks by the checkpoint plan domain through the shared registry', async () => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    const resumeEvent = {
      tenant_id,
      run_id: 'run-marketing-resume-1',
      event_type: 'human.approval',
      approval_id: '00000000-0000-4000-8000-000000000099',
      expected_payload_sha256: 'a'.repeat(64),
      operator_id: 'operator-marketing-1',
    };
    const taskRecord = {
      tenant_id,
      run_id: 'run-marketing-resume-1',
      correlation_id: 'corr-marketing-resume-1',
      task_version: 2,
      state: 'awaiting_human',
      lease_owner: 'worker-1',
      state_payload: {
        resume_event: resumeEvent,
        plan: {
          plan_id: 'plan-marketing-1',
          domain: 'marketing',
          steps: [],
          fallback_strategy: 'FAIL_CLOSED',
        },
        current_step: 1,
        pending_action: { action_id: '00000000-0000-4000-8000-000000000098', effect_key: 'effect-marketing-1' },
        context: { tenant_id, correlation_id: 'corr-marketing-resume-1' },
        previous_evidence_hash: '0'.repeat(64),
        request_id: 'sig-marketing-resume-1',
      },
    } as DurableTaskRecord;
    const resumeTask = vi.fn().mockResolvedValue(undefined);
    const marketingOrchestratorFactory = vi.fn().mockResolvedValue({ resumeTask });
    const worker = startWorker(
      { ENABLED_AGENT_MODULES: 'marketing' },
      {
        hmac: () => '',
        tenantIds: [tenant_id],
        autoStartPolling: false,
        marketingOrchestratorFactory,
      },
    );

    await processClaimedTask({
      taskRecord,
      tenant_id,
      worker_id: 'worker-1',
      workflowRepository: {
        getTask: vi.fn().mockResolvedValue(taskRecord),
        releaseTaskLease: vi.fn().mockResolvedValue(true),
        recordFailure: vi.fn(),
        transitionTask: vi.fn(),
      } as unknown as DurableWorkflowRepository,
      registry: worker.registry,
    });

    expect(marketingOrchestratorFactory).toHaveBeenCalledWith(tenant_id);
    expect(resumeTask).toHaveBeenCalledWith('run-marketing-resume-1', resumeEvent);
    await worker.close();
  });

  it('fails closed when the durable execution lease is expired before dispatch', async () => {
    const now = new Date('2026-09-29T00:00:00.000Z');
    const assertExecutionLease = createExecutionLeaseAssertion({
      workerId: 'worker-1',
      now: () => now,
      workflowRepository: {
        getTask: vi.fn().mockResolvedValue({
          state: 'running',
          lease_owner: 'worker-1',
          lease_expires_at: '2026-09-28T23:59:59.000Z',
        } as DurableTaskRecord),
      } as unknown as DurableWorkflowRepository,
    });

    await expect(assertExecutionLease('00000000-0000-4000-8000-000000000001', 'run-expired'))
      .rejects.toMatchObject({ code: 'TASK_LEASE_EXPIRED' });
  });

  it('starts polling only when the explicit readiness gate is true', async () => {
    const claimNextQueuedTask = vi.fn();
    const scheduleTimer = vi.fn(() => ({}) as NodeJS.Timeout);
    const poller = createWorkerPoller({
      tenantIds: ['00000000-0000-4000-8000-000000000001'],
      registry: { modules: () => ['support'] } as never,
      workflowRepository: { claimNextQueuedTask } as never,
      workerId: 'worker-ready',
      leaseDurationMs: 300,
      pollIntervalMs: 1000,
      autoStartPolling: true,
      readiness: true,
      setTimeout: scheduleTimer,
      clearTimeout: vi.fn(),
      processTask: async () => undefined,
    });

    expect(poller.isRunning).toBe(true);
    expect(scheduleTimer).toHaveBeenCalledOnce();
    await poller.stop();
  });

  it('does not claim work or start when readiness is absent', async () => {
    const claimNextQueuedTask = vi.fn();
    const poller = createWorkerPoller({
      tenantIds: ['00000000-0000-4000-8000-000000000001'],
      registry: { modules: () => ['support'] } as never,
      workflowRepository: { claimNextQueuedTask } as never,
      workerId: 'worker-unready',
      leaseDurationMs: 300,
      pollIntervalMs: 1000,
      autoStartPolling: true,
      setTimeout: vi.fn(() => ({}) as NodeJS.Timeout),
      clearTimeout: vi.fn(),
      processTask: async () => undefined,
    });

    expect(poller.isRunning).toBe(false);
    expect(await poller.pollOnce()).toBe(0);
    expect(claimNextQueuedTask).not.toHaveBeenCalled();
    await poller.stop();
  });
  it('renews across an interleaved checkpoint version bump and fails when another worker owns the lease', async () => {
    vi.useFakeTimers();
    try {
      const tenant_id = '00000000-0000-4000-8000-000000000001';
      const now = new Date('2026-09-29T00:00:00.000Z');
      const task = {
        tenant_id,
        run_id: 'run-heartbeat',
        correlation_id: 'corr-heartbeat',
        task_version: 1,
        state: 'running',
        lease_owner: 'worker-1',
        lease_expires_at: new Date(now.getTime() + 10_000).toISOString(),
        state_payload: {},
      } as DurableTaskRecord;
      const checkpointed = { ...task, task_version: 2, state_payload: { current_step: 2 } };
      const lostLease = { ...checkpointed, lease_owner: 'worker-2' };
      let currentTask: DurableTaskRecord = task;
      const getTask = vi.fn()
        .mockImplementationOnce(async () => {
          currentTask = checkpointed;
          return task;
        })
        .mockImplementationOnce(async () => {
          currentTask = lostLease;
          return currentTask;
        });
      const renewTaskLease = vi.fn(async () => currentTask);
      const processTask = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      }));
      const onError = vi.fn();
      const poller = createWorkerPoller({
        tenantIds: [tenant_id],
        registry: { modules: () => ['support'] } as never,
        workflowRepository: {
          getTask,
          renewTaskLease,
          claimNextQueuedTask: vi.fn().mockResolvedValueOnce({
            task,
            task_version: 1,
            lease_owner: 'worker-1',
            lease_expires_at: task.lease_expires_at,
          }).mockResolvedValue(null),
          releaseTaskLease: vi.fn(),
          recordFailure: vi.fn(),
          transitionTask: vi.fn(),
        } as unknown as DurableWorkflowRepository,
        workerId: 'worker-1',
        leaseDurationMs: 300,
        pollIntervalMs: 1000,
        autoStartPolling: false,
        readiness: true,
        now: () => now,
        processTask,
        onError,
      });

      const pollPromise = poller.pollOnce();
      await vi.waitFor(() => {
        expect(processTask).toHaveBeenCalledOnce();
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(renewTaskLease).toHaveBeenCalledWith({
        tenant_id,
        run_id: task.run_id,
        lease_owner: 'worker-1',
        lease_duration_ms: 300,
      });
      expect(processTask.mock.calls[0]?.[0].signal.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(100);
      expect(getTask).toHaveBeenCalledTimes(2);
      expect(renewTaskLease).toHaveBeenCalledOnce();
      expect(processTask.mock.calls[0]?.[0].signal.aborted).toBe(true);
      await pollPromise;
      expect(onError).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a heartbeat once for transient database errors', async () => {
    vi.useFakeTimers();
    try {
      const transientErrors = [
        Object.assign(new Error('serialization failure'), { code: '40001' }),
        Object.assign(new Error('deadlock detected'), { code: '40P01' }),
        Object.assign(new Error('administrator shutdown'), { code: '57P01' }),
        Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
        new Error('read ECONNRESET'),
        new Error('connection reset by peer'),
      ];

      for (const transientError of transientErrors) {
        const tenant_id = '00000000-0000-4000-8000-000000000001';
        const now = new Date('2026-09-29T00:00:00.000Z');
        const task = {
          tenant_id,
          run_id: 'run-heartbeat-retry',
          correlation_id: 'corr-heartbeat-retry',
          task_version: 1,
          state: 'running',
          lease_owner: 'worker-1',
          lease_expires_at: new Date(now.getTime() + 10_000).toISOString(),
          state_payload: {},
        } as DurableTaskRecord;
        const checkpointed = { ...task, task_version: 2 };
        const renewTaskLease = vi.fn()
          .mockRejectedValueOnce(transientError)
          .mockResolvedValue(checkpointed);
        let finishTask: (() => void) | undefined;
        const processTask = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<void>((resolve) => {
          finishTask = resolve;
          signal.addEventListener('abort', () => resolve(), { once: true });
        }));
        const poller = createWorkerPoller({
          tenantIds: [tenant_id],
          registry: { modules: () => ['support'] } as never,
          workflowRepository: {
            getTask: vi.fn().mockResolvedValue(checkpointed),
            renewTaskLease,
            claimNextQueuedTask: vi.fn().mockResolvedValueOnce({
              task,
              task_version: 1,
              lease_owner: 'worker-1',
              lease_expires_at: task.lease_expires_at,
            }).mockResolvedValue(null),
            releaseTaskLease: vi.fn(),
            recordFailure: vi.fn(),
            transitionTask: vi.fn(),
          } as unknown as DurableWorkflowRepository,
          workerId: 'worker-1',
          leaseDurationMs: 300,
          pollIntervalMs: 1000,
          autoStartPolling: false,
          readiness: true,
          now: () => now,
          processTask,
        });

        const pollPromise = poller.pollOnce();
        await vi.waitFor(() => {
          expect(processTask).toHaveBeenCalledOnce();
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(renewTaskLease).toHaveBeenCalledTimes(2);
        expect(processTask.mock.calls[0]?.[0].signal.aborted).toBe(false);
        finishTask?.();
        await pollPromise;
      }
    } finally {
      vi.useRealTimers();
    }
  });
  it('fences the next dispatch when the lease is lost after the first stage', async () => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    const run_id = 'run-lease-lost-between-stages';
    const correlation_id = 'corr-lease-lost-between-stages';
    const signal = {
      signal_id: 'signal-lease-lost-between-stages',
      tenant_id,
      correlation_id,
      source_channel: 'WEB_CHAT',
      event_type: 'message.received',
      timestamp: new Date().toISOString(),
      subject: { session_id: 'session-lease-lost-between-stages', channel_type: 'WEB_CHAT' },
      payload: { module: 'sales', message: 'run two stages' },
    };
    const plan = {
      plan_id: 'plan-lease-lost-between-stages',
      fallback_strategy: 'FAIL_CLOSED',
      steps: [1, 2].map((step_index) => ({
        step_index,
        agent_id: 'SAL-01',
        skill_id: `skill.test.stage_${step_index}`,
        adapter_target: 'test.adapter',
        input_parameters: { stage: step_index },
        required_authority: 'AUTH-1',
        mutating: false,
        price_bearing: false,
        idempotent: true,
        timeout_ms: 1_000,
        depends_on_steps: step_index === 1 ? [] : [1],
      })),
    };
    const task = {
      tenant_id,
      run_id,
      correlation_id,
      task_version: 1,
      state: 'running',
      lease_owner: 'worker-1',
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      state_payload: { signal },
    } as DurableTaskRecord;
    const workflowEngine = {
      getTask: vi.fn().mockResolvedValue(task),
      createTask: vi.fn().mockResolvedValue(undefined),
      updateTaskProgress: vi.fn().mockResolvedValue(undefined),
      transitionTask: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue({ requeued: false }),
    };
    const dispatch = vi.fn(async () => {
      leaseLost = true;
      return {
        execution_id: 'execution-lease-stage-1',
        adapter_status: 'SUCCESS' as const,
        provider_reference: 'provider-lease-stage-1',
        response_payload: {},
        latency_ms: 0,
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      };
    });
    let leaseLost = false;
    const assertExecutionLease = vi.fn(async () => {
      if (leaseLost) {
        throw new OrchestratorError('TASK_LEASE_NOT_HELD', 'execution lease was lost between stages');
      }
    });
    const evidenceLogger = {
      createImmutableRecord: vi.fn(async (input: {
        readonly run_id: string;
        readonly tenant_id: string;
        readonly correlation_id: string;
        readonly step_index: number;
        readonly effect_key: string;
        readonly previous_evidence_hash: string;
      }) => ({
        evidence_id: `evidence-${input.step_index}`,
        run_id: input.run_id,
        tenant_id: input.tenant_id,
        correlation_id: input.correlation_id,
        step_index: input.step_index,
        effect_key: input.effect_key,
        previous_evidence_hash: input.previous_evidence_hash,
        payload_sha256: 'a'.repeat(64),
        chain_hash: `chain-${input.step_index}`,
        signature: 'signature',
        created_at: new Date().toISOString(),
      })),
      logAgentRun: vi.fn().mockResolvedValue(undefined),
      initializeOutcomeWatch: vi.fn().mockResolvedValue(undefined),
    };
    const orchestrator = new RevenueOrchestrator({
      contextAggregator: {
        hydrateContext: vi.fn().mockResolvedValue({
          tenant_id,
          correlation_id,
          customer: null,
          working_memory: {
            session_id: 'session-lease-lost-between-stages',
            last_touch_channel: 'WEB_CHAT',
            turn_count: 1,
            takeover_active: false,
          },
          knowledge_citations: [],
          hydrated_at: new Date().toISOString(),
        }),
      } as never,
      agentRuntime: {
        deriveHypothesis: vi.fn().mockResolvedValue({
          classification: 'HYPOTHESIS',
          intent: 'sales:test',
          confidence: 1,
          churn_risk_score: 0,
          purchase_propensity: 0,
          reasoning: 'test',
          derived_from_signals: [signal.signal_id],
        }),
        resolveRouting: vi.fn().mockResolvedValue({
          target_agent: 'SAL-01',
          requires_clarification: false,
          rationalization: 'test',
        }),
        formulatePlan: vi.fn().mockResolvedValue(plan),
      } as never,
      policyEngine: {
        validateAction: vi.fn(async (action) => action),
        evaluateAuthority: vi.fn().mockResolvedValue({ verdict: 'AUTO_APPROVED', reason: 'test' }),
      } as never,
      workflowEngine: workflowEngine as never,
      evidenceLogger: evidenceLogger as never,
      auditTrail: { append: vi.fn().mockResolvedValue(undefined) } as never,
      adapterDispatcher: { dispatch } as never,
      effectGuard: new MemoryEffectGuard(),
      sessionControl: {
        isTakenOver: vi.fn().mockResolvedValue(false),
        returnToAgent: vi.fn().mockResolvedValue(undefined),
      },
      leaseManager: {
        acquireLease: vi.fn().mockResolvedValue(true),
        releaseLease: vi.fn().mockResolvedValue(undefined),
      },
      workerId: 'worker-1',
      assertExecutionLease,
    });

    await expect(orchestrator.processQueuedSignal(run_id, signal, { worker_id: 'worker-1' }))
      .rejects.toMatchObject({ code: 'TASK_LEASE_NOT_HELD' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(assertExecutionLease).toHaveBeenCalled();
  });


});
