import { describe, expect, it, vi } from 'vitest';
import type { DurableTaskRecord, DurableWorkflowRepository } from '@agentos/database';

import { processClaimedTask, startWorker } from './worker.js';

describe('startWorker', () => {

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

  it('routes resumed Marketing tasks through the shared domain registry and orchestrator path', async () => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    const resumeEvent = {
      tenant_id,
      run_id: 'run-marketing-resume-1',
      event_type: 'human.approval',
      approval_id: '00000000-0000-4000-8000-000000000099',
      expected_payload_sha256: 'a'.repeat(64),
      operator_id: 'operator-marketing-1',
    };
    const signal = {
      signal_id: 'sig-marketing-resume-1',
      tenant_id,
      correlation_id: 'corr-marketing-resume-1',
      source_channel: 'MARKETING_CAMPAIGN',
      event_type: 'campaign.requested',
      payload: { module: 'marketing', skill_id: 'skill.mkt.dispatch_campaign', input: { tenant_id } },
    };
    const taskRecord = {
      tenant_id,
      run_id: 'run-marketing-resume-1',
      correlation_id: signal.correlation_id,
      task_version: 2,
      state: 'awaiting_human',
      lease_owner: 'worker-1',
      state_payload: {
        signal,
        resume_event: resumeEvent,
        plan: { plan_id: 'plan-marketing-1', steps: [], fallback_strategy: 'FAIL_CLOSED' },
        current_step: 1,
        pending_action: { action_id: '00000000-0000-4000-8000-000000000098', effect_key: 'effect-marketing-1' },
        context: { tenant_id, correlation_id: signal.correlation_id },
        previous_evidence_hash: '0'.repeat(64),
        request_id: signal.signal_id,
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

});
