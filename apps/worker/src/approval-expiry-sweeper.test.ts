import { describe, expect, it, vi } from 'vitest';

import {
  APPROVAL_EXPIRY_SWEEP_BATCH_LIMIT,
  DEFAULT_APPROVAL_EXPIRY_SWEEP_INTERVAL_MS,
  createApprovalExpirySweeper,
} from './approval-expiry-sweeper.js';

describe('createApprovalExpirySweeper', () => {
  it('sweeps every tenant, isolates tenant failures, and stops scheduling on shutdown', async () => {
    vi.useFakeTimers();
    try {
      const tenantIds = ['tenant-a', 'tenant-b', 'tenant-c'];
      const expireOverdueApprovals = vi.fn(async (tenant_id: string) => {
        if (tenant_id === 'tenant-b') throw new Error('tenant database unavailable');
        return [];
      });
      const onError = vi.fn();
      const sweeper = createApprovalExpirySweeper({
        tenantIds,
        intervalMs: 100,
        repository: { expireOverdueApprovals },
        onError,
      });

      await vi.advanceTimersByTimeAsync(99);
      expect(expireOverdueApprovals).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(expireOverdueApprovals).toHaveBeenNthCalledWith(
        1,
        'tenant-a',
        APPROVAL_EXPIRY_SWEEP_BATCH_LIMIT,
      );
      expect(expireOverdueApprovals).toHaveBeenNthCalledWith(
        2,
        'tenant-b',
        APPROVAL_EXPIRY_SWEEP_BATCH_LIMIT,
      );
      expect(expireOverdueApprovals).toHaveBeenNthCalledWith(
        3,
        'tenant-c',
        APPROVAL_EXPIRY_SWEEP_BATCH_LIMIT,
      );
      expect(onError).toHaveBeenCalledWith('tenant-b', expect.any(Error));

      await sweeper.stop();
      expect(sweeper.isRunning).toBe(false);
      const callsAfterStop = expireOverdueApprovals.mock.calls.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(expireOverdueApprovals).toHaveBeenCalledTimes(callsAfterStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads and validates the interval environment variable', () => {
    const repository = { expireOverdueApprovals: vi.fn().mockResolvedValue([]) };
    const defaulted = createApprovalExpirySweeper({
      env: { WORKER_TENANT_IDS: 'tenant-a' },
      repository,
      autoStart: false,
    });
    expect(defaulted.intervalMs).toBe(DEFAULT_APPROVAL_EXPIRY_SWEEP_INTERVAL_MS);

    expect(() => createApprovalExpirySweeper({
      env: {
        WORKER_TENANT_IDS: 'tenant-a',
        APPROVAL_EXPIRY_SWEEP_INTERVAL_MS: '0',
      },
      repository,
      autoStart: false,
    })).toThrow('APPROVAL_EXPIRY_SWEEP_INTERVAL_MS_INVALID');
  });

  it('ignores start() calls while stop() is actively waiting for in-flight run', async () => {
    let resolveInFlight!: () => void;
    const inFlightPromise = new Promise<readonly string[]>((resolve) => {
      resolveInFlight = () => resolve([]);
    });
    const expireOverdueApprovals = vi.fn().mockImplementation(() => inFlightPromise);
    const sweeper = createApprovalExpirySweeper({
      tenantIds: ['tenant-a'],
      intervalMs: 1000,
      repository: { expireOverdueApprovals },
      autoStart: false,
    });

    void sweeper.runOnce();
    const stopPromise = sweeper.stop();
    // try to call start() while stop() is awaiting activeRun
    sweeper.start();
    expect(sweeper.isRunning).toBe(false);

    resolveInFlight();
    await stopPromise;
    expect(sweeper.isRunning).toBe(false);
  });
});
