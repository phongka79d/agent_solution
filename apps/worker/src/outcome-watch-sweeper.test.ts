import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_OUTCOME_WATCH_SWEEP_INTERVAL_MS,
  OUTCOME_WATCH_SWEEP_BATCH_LIMIT,
  createOutcomeWatchSweeper,
} from './outcome-watch-sweeper.js';

describe('createOutcomeWatchSweeper', () => {
  it('sweeps every tenant, isolates tenant failures, and stops scheduling on shutdown', async () => {
    vi.useFakeTimers();
    try {
      const tenantIds = ['tenant-a', 'tenant-b', 'tenant-c'];
      const expireOverdueOutcomeWatches = vi.fn(async (tenant_id: string) => {
        if (tenant_id === 'tenant-b') throw new Error('tenant database unavailable');
        return [];
      });
      const onError = vi.fn();
      const sweeper = createOutcomeWatchSweeper({
        tenantIds,
        intervalMs: 100,
        repository: { expireOverdueOutcomeWatches },
        onError,
      });

      await vi.advanceTimersByTimeAsync(99);
      expect(expireOverdueOutcomeWatches).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(expireOverdueOutcomeWatches).toHaveBeenNthCalledWith(
        1,
        'tenant-a',
        OUTCOME_WATCH_SWEEP_BATCH_LIMIT,
      );
      expect(expireOverdueOutcomeWatches).toHaveBeenNthCalledWith(
        2,
        'tenant-b',
        OUTCOME_WATCH_SWEEP_BATCH_LIMIT,
      );
      expect(expireOverdueOutcomeWatches).toHaveBeenNthCalledWith(
        3,
        'tenant-c',
        OUTCOME_WATCH_SWEEP_BATCH_LIMIT,
      );
      expect(onError).toHaveBeenCalledWith('tenant-b', expect.any(Error));

      await sweeper.stop();
      expect(sweeper.isRunning).toBe(false);
      const callsAfterStop = expireOverdueOutcomeWatches.mock.calls.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(expireOverdueOutcomeWatches).toHaveBeenCalledTimes(callsAfterStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads and validates its interval and deduplicates tenant ids', () => {
    const repository = { expireOverdueOutcomeWatches: vi.fn().mockResolvedValue([]) };
    const defaulted = createOutcomeWatchSweeper({
      env: { WORKER_TENANT_IDS: 'tenant-a, tenant-a, tenant-b' },
      repository,
      autoStart: false,
    });
    expect(defaulted.intervalMs).toBe(DEFAULT_OUTCOME_WATCH_SWEEP_INTERVAL_MS);
    expect(defaulted.tenantIds).toEqual(['tenant-a', 'tenant-b']);

    expect(() => createOutcomeWatchSweeper({
      env: {
        WORKER_TENANT_IDS: 'tenant-a',
        OUTCOME_WATCH_SWEEP_INTERVAL_MS: '0',
      },
      repository,
      autoStart: false,
    })).toThrow('OUTCOME_WATCH_SWEEP_INTERVAL_MS_INVALID');
  });
});
