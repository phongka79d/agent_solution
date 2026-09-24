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

  it('resumes task when payload carries resume_event and a complete checkpoint', async () => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    const completeCheckpoint = {
      resume_event: { type: 'human_approval', approval_id: 'appr-1' },
      plan: { plan_id: 'plan-1', steps: [], fallback_strategy: 'FAIL_CLOSED' },
      context: { tenant_id, correlation_id: 'corr-1' },
      hypothesis: { classification: 'HYPOTHESIS' },
      pending_action: { action_id: 'act-1', run_id: 'run-1', skill_id: 'skill.care.lookup_order' },
      completed_steps: [],
    };

    const taskRecord = {
      tenant_id,
      run_id: 'run-1',
      correlation_id: 'corr-1',
      task_version: 2,
      state: 'running',
      lease_owner: 'worker-1',
      state_payload: completeCheckpoint,
    } as DurableTaskRecord;

    const resumeTask = vi.fn().mockResolvedValue(undefined);
    const mockOrchestrator = { resumeTask };
    const orchestratorFactory = vi.fn().mockResolvedValue(mockOrchestrator);
    const getTask = vi.fn().mockResolvedValue({ ...taskRecord, state: 'completed' });
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
    expect(resumeTask).toHaveBeenCalledWith('run-1', completeCheckpoint.resume_event);
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it('fails closed with CHECKPOINT_INCOMPLETE when resume_event has incomplete checkpoint', async () => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    const incompletePayload = {
      resume_event: { type: 'human_approval', approval_id: 'appr-1' },
      // Missing context, hypothesis, pending_action, completed_steps
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
});
