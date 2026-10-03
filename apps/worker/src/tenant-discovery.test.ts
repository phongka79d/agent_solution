import { describe, expect, it, vi } from 'vitest';

import { createTenantDiscovery, type ActiveTenantRecord } from './tenant-discovery.js';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

function tenant(tenant_id: string, enabled_domains: readonly string[]): ActiveTenantRecord {
  return { tenant_id, enabled_domains };
}

describe('createTenantDiscovery', () => {
  it('discovers a newly active tenant on the next refresh without rebuilding the worker', async () => {
    let rows: readonly ActiveTenantRecord[] = [tenant(TENANT_A, ['support'])];
    const repository = { listActiveTenants: vi.fn(async () => rows) };
    const discovery = createTenantDiscovery({ repository });

    await discovery.refresh();
    expect(discovery.tenantIds).toEqual([TENANT_A]);
    rows = [tenant(TENANT_A, ['support']), tenant(TENANT_B, ['sales'])];
    await discovery.refresh();

    expect(discovery.tenants).toEqual([
      tenant(TENANT_A, ['support']),
      tenant(TENANT_B, ['sales']),
    ]);
  });

  it('intersects tenant and domain debug filters with the database result', async () => {
    const repository = {
      listActiveTenants: vi.fn(async () => [
        tenant(TENANT_A, ['support', 'sales']),
        tenant(TENANT_B, ['marketing']),
      ]),
    };
    const discovery = createTenantDiscovery({
      repository,
      tenantIds: [TENANT_A],
      enabledDomains: ['sales'],
    });

    await discovery.refresh();

    expect(discovery.tenants).toEqual([tenant(TENANT_A, ['sales'])]);
  });

  it('keeps the last known tenant list and logs when discovery fails', async () => {
    const error = new Error('database unavailable');
    const onError = vi.fn();
    const listActiveTenants = vi.fn()
      .mockResolvedValueOnce([tenant(TENANT_A, ['support'])])
      .mockRejectedValueOnce(error);
    const discovery = createTenantDiscovery({
      repository: { listActiveTenants },
      onError,
    });

    await discovery.refresh();
    await expect(discovery.refresh()).resolves.toEqual([tenant(TENANT_A, ['support'])]);

    expect(discovery.tenantIds).toEqual([TENANT_A]);
    expect(onError).toHaveBeenCalledWith(error);
  });
});
