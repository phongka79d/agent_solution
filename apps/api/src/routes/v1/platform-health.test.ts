import { describe, expect, it, vi } from 'vitest';

import { createPlatformHealthReader } from './platform-health.js';

const APPLIED_HEALTH_MIGRATION = '0040_worker_heartbeats.sql';

function dependencies(
  now: () => number,
  readSnapshot: () => Promise<Readonly<Record<string, unknown>>>,
  overrides: Partial<Parameters<typeof createPlatformHealthReader>[0]> = {},
) {
  return {
    now,
    database: async () => undefined,
    redis: async () => ({ ok: true }),
    qdrant: async () => ({ ok: true }),
    readSnapshot,
    readMigrations: async () => [APPLIED_HEALTH_MIGRATION],
    ...overrides,
  };
}

describe('platform health', () => {
  it('marks the worker fleet as failed when its only heartbeat is older than 60 seconds', async () => {
    const observedAt = Date.parse('2026-10-01T12:00:00.000Z');
    const readHealth = createPlatformHealthReader(dependencies(
      () => observedAt,
      async () => ({
        workers: [{ worker_id: 'worker-a', heartbeat_at: new Date(observedAt - 60_001).toISOString() }],
        queue_depth: 0,
        oldest_queued_at: null,
        expired_leases: 0,
        llm_last_probe: null,
        connectors: [],
      }),
    ));

    const result = await readHealth();

    expect(result.probes.workers.state).toBe('FAILED');
    expect(result.probes.workers.items[0]?.age_seconds).toBeGreaterThan(60);
  });

  it('keeps the worker fleet healthy when a fresh heartbeat coexists with a stale instance', async () => {
    const observedAt = Date.parse('2026-10-01T12:00:00.000Z');
    const readHealth = createPlatformHealthReader(dependencies(
      () => observedAt,
      async () => ({
        workers: [
          { worker_id: 'worker-stopped', heartbeat_at: new Date(observedAt - 90_000).toISOString() },
          { worker_id: 'worker-restarted', heartbeat_at: new Date(observedAt - 15_000).toISOString() },
        ],
        queue_depth: 0,
        oldest_queued_at: null,
        expired_leases: 0,
        llm_last_probe: { outcome: 'PASS' },
        connectors: [{ outcome: 'PASS' }],
      }),
    ));

    const result = await readHealth();

    expect(result.probes.workers.state).toBe('HEALTHY');
    expect(result.probes.workers.items).toHaveLength(2);
    expect(result.probes.workers.items[0]?.age_seconds).toBe(90);
    expect(result.probes.workers.items[1]?.age_seconds).toBe(15);
    expect(result.probes.migrations.state).toBe('HEALTHY');
    expect(result.state).toBe('HEALTHY');
  });

  it('marks the worker fleet as failed when no heartbeats exist', async () => {
    const readHealth = createPlatformHealthReader(dependencies(
      () => Date.parse('2026-10-01T12:00:00.000Z'),
      async () => ({ workers: [], queue_depth: 0, oldest_queued_at: null, expired_leases: 0 }),
    ));

    const result = await readHealth();

    expect(result.probes.workers.state).toBe('FAILED');
    expect(result.probes.workers.items).toEqual([]);
  });

  it('requires the real heartbeat migration rather than a nonexistent migration filename', async () => {
    const readHealth = createPlatformHealthReader(dependencies(
      () => Date.parse('2026-10-01T12:00:00.000Z'),
      async () => ({ workers: [], queue_depth: 0, oldest_queued_at: null, expired_leases: 0 }),
      { readMigrations: async () => ['0042_worker_heartbeats.sql'] },
    ));

    const result = await readHealth();

    expect(result.probes.migrations.state).toBe('FAILED');
  });

  it('serves cached probe results for 30 seconds and refreshes at expiry', async () => {
    let clock = 10_000;
    const snapshot = vi.fn(async () => ({
      workers: [{ worker_id: 'worker-a', heartbeat_at: new Date(clock).toISOString() }],
      queue_depth: 0,
      oldest_queued_at: null,
      expired_leases: 0,
      llm_last_probe: null,
      connectors: [],
    }));
    const readHealth = createPlatformHealthReader(dependencies(() => clock, snapshot));

    await readHealth();
    clock += 29_999;
    await readHealth();
    expect(snapshot).toHaveBeenCalledOnce();
    clock += 1;
    await readHealth();
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it('recovers at cache expiry after a restarted worker records a fresh heartbeat', async () => {
    let clock = Date.parse('2026-10-01T12:00:00.000Z');
    const stoppedWorker = {
      worker_id: 'worker-stopped',
      heartbeat_at: new Date(clock - 90_000).toISOString(),
    };
    let workers = [stoppedWorker];
    const snapshot = vi.fn(async () => ({
      workers,
      queue_depth: 0,
      oldest_queued_at: null,
      expired_leases: 0,
      llm_last_probe: { outcome: 'PASS' },
      connectors: [{ outcome: 'PASS' }],
    }));
    const readHealth = createPlatformHealthReader(dependencies(() => clock, snapshot));

    expect((await readHealth()).probes.workers.state).toBe('FAILED');
    clock += 15_000;
    workers = [
      stoppedWorker,
      { worker_id: 'worker-restarted', heartbeat_at: new Date(clock).toISOString() },
    ];
    expect((await readHealth()).probes.workers.state).toBe('FAILED');
    clock += 14_999;
    expect((await readHealth()).probes.workers.state).toBe('FAILED');
    expect(snapshot).toHaveBeenCalledOnce();
    clock += 1;

    const recovered = await readHealth();

    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(recovered.probes.workers.state).toBe('HEALTHY');
    expect(recovered.probes.workers.items).toHaveLength(2);
    expect(recovered.state).toBe('HEALTHY');
  });

  it('marks a timed-out dependency probe as failed without blocking other probes', async () => {
    vi.useFakeTimers();
    try {
      const observedAt = Date.parse('2026-10-01T12:00:00.000Z');
      const readHealth = createPlatformHealthReader(dependencies(
        () => observedAt,
        async () => ({ workers: [], queue_depth: 0, oldest_queued_at: null, expired_leases: 0, connectors: [] }),
        {
          timeoutMs: 5,
          database: () => new Promise<void>(() => undefined),
        },
      ));
      const pending = readHealth();
      await vi.advanceTimersByTimeAsync(5);
      const result = await pending;

      expect(result.probes.database.state).toBe('FAILED');
      expect(result.probes.api.state).toBe('HEALTHY');
    } finally {
      vi.useRealTimers();
    }
  });
});
