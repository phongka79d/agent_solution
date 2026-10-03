import { describe, expect, it, vi } from 'vitest';
import type { ClaimTaskResult, DurableTaskRecord } from '@agentos/database';

import { startWorker, type WorkerEnv } from './worker.js';
import { createWorkerPoller } from './worker-polling.js';

const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '00000000-0000-4000-8000-000000000002';

function taskFor(tenant_id: string, run_id: string): DurableTaskRecord {
  const timestamp = '2026-09-30T00:00:00.000Z';
  return {
    task_id: `task-${run_id}`,
    tenant_id,
    run_id,
    correlation_id: `correlation-${run_id}`,
    current_step: 0,
    state: 'running',
    task_version: 1,
    lease_owner: 'worker-test',
    lease_expires_at: '2026-09-30T00:01:00.000Z',
    retry_count: 0,
    max_retries: 3,
    last_error_class: null,
    paused_for_approval_id: null,
    state_payload: {},
    error_details: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function claimResult(task: DurableTaskRecord): ClaimTaskResult {
  return {
    task,
    task_version: task.task_version,
    lease_owner: 'worker-test',
    lease_expires_at: task.lease_expires_at as string,
  };
}

function pollerOptions(overrides: Record<string, unknown>) {
  return {
    tenantIds: [TENANT_A, TENANT_B],
    registry: { modules: () => ['support'] },
    workerId: 'worker-test',
    leaseDurationMs: 10_000,
    pollIntervalMs: 1_000,
    autoStartPolling: false,
    readiness: true,
    processTask: async () => undefined,
    ...overrides,
  } as never;
}

describe('worker polling concurrency and drain', () => {
  it('caps each tenant independently while allowing another tenant to claim work', async () => {
    const queues = new Map([
      [TENANT_A, [taskFor(TENANT_A, 'a-1'), taskFor(TENANT_A, 'a-2'), taskFor(TENANT_A, 'a-3')]],
      [TENANT_B, [taskFor(TENANT_B, 'b-1'), taskFor(TENANT_B, 'b-2'), taskFor(TENANT_B, 'b-3')]],
    ]);
    const claimed: string[] = [];
    const completions: Array<() => void> = [];
    const claimNextQueuedTask = vi.fn(async ({ tenant_id }: { tenant_id: string }) => {
      const next = queues.get(tenant_id)?.shift();
      if (next === undefined) return null;
      claimed.push(next.run_id);
      return claimResult(next);
    });
    const processTask = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<void>((resolve) => {
      completions.push(resolve);
      signal.addEventListener('abort', () => resolve(), { once: true });
    }));
    const poller = createWorkerPoller(pollerOptions({
      workflowRepository: { claimNextQueuedTask },
      tenantConcurrency: 2,
      processTask,
    }));

    const pollPromise = poller.pollOnce();
    await vi.waitFor(() => {
      expect(processTask).toHaveBeenCalledTimes(4);
    });

    expect(claimed.filter((run_id) => run_id.startsWith('a-'))).toHaveLength(2);
    expect(claimed.filter((run_id) => run_id.startsWith('b-'))).toHaveLength(2);
    expect(queues.get(TENANT_A)).toHaveLength(1);
    expect(queues.get(TENANT_B)).toHaveLength(1);

    for (const complete of completions) complete();
    await pollPromise;
    await expect(poller.stop()).resolves.toEqual({ timedOut: false, inFlight: 0 });
  });

  it('waits for in-flight work to complete before reporting a clean drain', async () => {
    vi.useFakeTimers();
    try {
      const task = taskFor(TENANT_A, 'clean-drain');
      let complete: (() => void) | undefined;
      const processTask = vi.fn(() => new Promise<void>((resolve) => {
        complete = resolve;
      }));
      const poller = createWorkerPoller(pollerOptions({
        tenantIds: [TENANT_A],
        workflowRepository: {
          claimNextQueuedTask: vi.fn()
            .mockResolvedValueOnce(claimResult(task))
            .mockResolvedValueOnce(null),
        },
        processTask,
      }));

      const pollPromise = poller.pollOnce();
      await Promise.resolve();
      await Promise.resolve();
      const drainPromise = poller.stop({ drainTimeoutMs: 100 });
      let drained = false;
      void drainPromise.then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);

      complete?.();
      await pollPromise;
      await expect(drainPromise).resolves.toEqual({ timedOut: false, inFlight: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts remaining attempts and reports a timed-out drain', async () => {
    vi.useFakeTimers();
    try {
      const task = taskFor(TENANT_A, 'timed-out-drain');
      let aborted = false;
      let complete: (() => void) | undefined;
      const processTask = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<void>((resolve) => {
        complete = resolve;
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        }, { once: true });
      }));
      const onError = vi.fn();
      const poller = createWorkerPoller(pollerOptions({
        tenantIds: [TENANT_A],
        workflowRepository: {
          claimNextQueuedTask: vi.fn()
            .mockResolvedValueOnce(claimResult(task))
            .mockResolvedValueOnce(null),
        },
        processTask,
        onError,
      }));

      const pollPromise = poller.pollOnce();
      await Promise.resolve();
      await Promise.resolve();
      const drainPromise = poller.stop({ drainTimeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(100);

      await expect(drainPromise).resolves.toEqual({ timedOut: true, inFlight: 1 });
      expect(aborted).toBe(true);
      expect(onError).toHaveBeenCalledWith(TENANT_A, expect.objectContaining({ message: expect.stringContaining('WORKER_DRAIN_TIMEOUT') }));
      complete?.();
      await pollPromise;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('dynamic tenant polling', () => {
  it('claims only tenant runtimes present in the latest discovery snapshot', async () => {
    const registry = { modules: () => ['support'] };
    let tenantRuntimes = [{ tenant_id: TENANT_A, registry }];
    const claimedTenants: string[] = [];
    const claimNextQueuedTask = vi.fn(async ({ tenant_id }: { tenant_id: string }) => {
      claimedTenants.push(tenant_id);
      return null;
    });
    const poller = createWorkerPoller(pollerOptions({
      tenantIds: [],
      getTenantRuntimes: () => tenantRuntimes,
      workflowRepository: { claimNextQueuedTask },
    }));

    await poller.pollOnce();
    tenantRuntimes = [
      { tenant_id: TENANT_A, registry },
      { tenant_id: TENANT_B, registry },
    ];
    await poller.pollOnce();
    tenantRuntimes = [{ tenant_id: TENANT_B, registry }];
    await poller.pollOnce();

    expect(claimedTenants).toEqual([TENANT_A, TENANT_A, TENANT_B, TENANT_B]);
    await poller.stop();
  });
});

describe('worker drain configuration', () => {
  it.each([
    ['WORKER_TENANT_CONCURRENCY', '0'],
    ['WORKER_TENANT_CONCURRENCY', 'not-an-integer'],
    ['WORKER_DRAIN_TIMEOUT_MS', '0'],
    ['WORKER_DRAIN_TIMEOUT_MS', 'not-an-integer'],
  ])('refuses invalid %s=%s at boot', (name, value) => {
    const env = { [name]: value } as WorkerEnv;
    expect(() => startWorker(env, { hmac: () => '', autoStartPolling: false })).toThrow(`${name}_INVALID`);
  });
});
