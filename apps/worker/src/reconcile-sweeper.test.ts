import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_RECONCILE_SWEEP_INTERVAL_MS,
  createReconcileSweeper,
  type ReconciliationSweepRepository,
} from './reconcile-sweeper.js';

const RECEIPT = {
  execution_id: 'API-001:action-1:reconciled',
  adapter_status: 'SUCCESS',
  provider_reference: 'provider-1',
};
const candidate = (effect_key: string) => ({
  tenant_id: 'tenant-1',
  run_id: `run-${effect_key}`,
  effect_key,
  skill_id: 'skill-1',
  step_index: 0,
  reserved_at: '2026-01-01T00:00:00.000Z',
  expires_at: '2026-01-04T00:00:00.000Z',
  max_age_reached: false,
  state_payload: {
    pending_action: {
      mutating: true,
      effect_key,
      action_id: `action-${effect_key}`,
      adapter_target: 'API-001',
    },
  },
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createReconcileSweeper', () => {
  it('runs on the 60-second cadence and commits only provider-proven results', async () => {
    vi.useFakeTimers();
    const rows = [candidate('success'), candidate('absence'), candidate('unknown')];
    const repository: ReconciliationSweepRepository = {
      listReconciliationCandidates: vi.fn().mockResolvedValue(rows),
      recordReconciliationOutcome: vi.fn().mockResolvedValue('COMPLETED'),
    };
    const reconcileAction = vi.fn(async ({ effect_key }: { effect_key: string }) => {
      if (effect_key === 'success') return { outcome: 'SUCCEEDED' as const, receipt: RECEIPT };
      if (effect_key === 'absence') return { outcome: 'FAILED' as const };
      return { outcome: 'INDETERMINATE' as const };
    });
    const sweeper = createReconcileSweeper({
      tenantIds: ['tenant-1'],
      repository,
      reconcileAction,
    });

    expect(sweeper.intervalMs).toBe(DEFAULT_RECONCILE_SWEEP_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(DEFAULT_RECONCILE_SWEEP_INTERVAL_MS - 1);
    expect(repository.listReconciliationCandidates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(repository.listReconciliationCandidates).toHaveBeenCalledWith('tenant-1', 5, 200);
    expect(reconcileAction).toHaveBeenCalledWith({
      tenant_id: 'tenant-1',
      effect_key: 'success',
      action_id: 'action-success',
      adapter_target: 'API-001',
      skill_id: 'skill-1',
    });
    expect(repository.recordReconciliationOutcome).toHaveBeenNthCalledWith(1, {
      tenant_id: 'tenant-1', run_id: 'run-success', effect_key: 'success',
      outcome: 'SUCCEEDED', receipt: RECEIPT,
    });
    expect(repository.recordReconciliationOutcome).toHaveBeenNthCalledWith(2, {
      tenant_id: 'tenant-1', run_id: 'run-absence', effect_key: 'absence', outcome: 'FAILED',
    });
    expect(repository.recordReconciliationOutcome).toHaveBeenNthCalledWith(3, {
      tenant_id: 'tenant-1', run_id: 'run-unknown', effect_key: 'unknown', outcome: 'INDETERMINATE',
    });

    await sweeper.stop();
    expect(sweeper.isRunning).toBe(false);
  });

  it('does not settle a success without a provider receipt and isolates failures', async () => {
    const repository: ReconciliationSweepRepository = {
      listReconciliationCandidates: vi.fn()
        .mockResolvedValueOnce([candidate('no-proof'), candidate('bad-row')])
        .mockRejectedValueOnce(new Error('tenant database unavailable')),
      recordReconciliationOutcome: vi.fn().mockResolvedValue('UNCHANGED'),
    };
    const errors = vi.fn();
    const sweeper = createReconcileSweeper({
      tenantIds: ['tenant-1', 'tenant-2'],
      repository,
      reconcileAction: vi.fn(async () => ({ outcome: 'SUCCEEDED' as const, receipt: { adapter_status: 'SUCCESS' } })),
      onError: errors,
      autoStart: false,
    });

    await sweeper.runOnce();

    expect(repository.recordReconciliationOutcome).toHaveBeenCalledWith({
      tenant_id: 'tenant-1', run_id: 'run-no-proof', effect_key: 'no-proof', outcome: 'INDETERMINATE',
    });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(repository.listReconciliationCandidates).toHaveBeenCalledTimes(2);
  });
});
