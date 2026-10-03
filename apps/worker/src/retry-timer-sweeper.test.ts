import { describe, expect, it, vi } from 'vitest';

import {
  createRetryTimerSweeper,
  DEFAULT_RETRY_SWEEP_INTERVAL_MS,
  RETRY_SWEEP_BATCH_LIMIT,
} from './retry-timer-sweeper.js';
import type { RetryTimerCandidate } from '@agentos/database';

const retryCandidate: RetryTimerCandidate = {
  tenant_id: 'tenant-1',
  run_id: 'retry-run',
  retry_count: 2,
  wait_reason: 'RETRY',
  has_resume_event: false,
};

const unknownEffectCandidate: RetryTimerCandidate = {
  tenant_id: 'tenant-1',
  run_id: 'unknown-run',
  retry_count: 1,
  wait_reason: 'RECONCILE',
  has_resume_event: false,
};

const alreadyQueuedCandidate: RetryTimerCandidate = {
  tenant_id: 'tenant-1',
  run_id: 'already-queued-run',
  retry_count: 1,
  wait_reason: 'RETRY',
  has_resume_event: true,
};

describe('createRetryTimerSweeper', () => {
  it('queues each due retry once and skips UNKNOWN-effect waits', async () => {
    const queued = new Set<string>();
    const queueRetryTimer = vi.fn(async (input: { tenant_id: string; run_id: string; retry_count: number }) => {
      const identity = `${input.tenant_id}:${input.run_id}:${input.retry_count}`;
      if (queued.has(identity)) return false;
      queued.add(identity);
      return true;
    });
    const listRetryTimerCandidates = vi.fn(async (tenant_id: string, limit: number) => {
      expect(limit).toBe(RETRY_SWEEP_BATCH_LIMIT);
      if (tenant_id !== 'tenant-1') return [];
      return [retryCandidate, unknownEffectCandidate, alreadyQueuedCandidate]
        .filter((candidate) => !queued.has(`${candidate.tenant_id}:${candidate.run_id}:${candidate.retry_count}`));
    });
    const sweeper = createRetryTimerSweeper({
      tenantIds: ['tenant-1', 'tenant-2'],
      repository: { listRetryTimerCandidates, queueRetryTimer },
      autoStart: false,
    });

    expect(sweeper.intervalMs).toBe(DEFAULT_RETRY_SWEEP_INTERVAL_MS);
    await sweeper.runOnce();
    await sweeper.runOnce();

    expect(listRetryTimerCandidates).toHaveBeenCalledTimes(4);
    expect(queueRetryTimer).toHaveBeenCalledTimes(1);
    expect(queueRetryTimer).toHaveBeenCalledWith({
      tenant_id: 'tenant-1',
      run_id: 'retry-run',
      retry_count: 2,
    });
    expect(queued).toEqual(new Set(['tenant-1:retry-run:2']));
    await sweeper.stop();
  });
});
