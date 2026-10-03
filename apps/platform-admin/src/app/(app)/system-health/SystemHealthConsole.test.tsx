import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SystemHealthConsole } from './SystemHealthConsole';

const healthPayload = {
  observed_at: '2026-10-01T12:00:00.000Z',
  state: 'FAILED',
  probes: {
    api: { state: 'HEALTHY' },
    database: { state: 'DEGRADED' },
    redis: { state: 'FAILED' },
    qdrant: { state: 'NOT_CHECKED' },
    workers: { state: 'HEALTHY', items: [{ worker_id: 'worker-a', heartbeat_at: '2026-10-01T12:00:00.000Z', age_seconds: 0 }] },
    queue: { state: 'HEALTHY', depth: 0, oldest_queued_age_seconds: null, expired_leases: 0 },
    migrations: { state: 'HEALTHY', applied_count: 42, latest_applied: '0042_worker_heartbeats.sql', applied: [] },
    llm: { state: 'NOT_CHECKED', last_probe: null },
    connectors: { state: 'NOT_CHECKED', companies: [] },
  },
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => healthPayload,
  })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('SystemHealthConsole', () => {
  it('renders Vietnamese labels for each health state', async () => {
    render(<SystemHealthConsole />);

    expect(await screen.findByRole('heading', { name: 'Tình trạng hệ thống' })).toBeTruthy();
    expect((await screen.findAllByText('Hoạt động')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Suy giảm').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Lỗi').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Chưa kiểm tra').length).toBeGreaterThan(0);
  });
});
