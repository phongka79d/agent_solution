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
});
