import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { TenantTransactionRunner } from './effect-reservations.js';
import { TenantGovernanceRepository } from './tenant-governance.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const UPDATED_AT = new Date('2026-09-23T00:00:00.000Z');

describe('TenantGovernanceRepository', () => {
  it('reads the setting inside the supplied tenant transaction', async () => {
    const query = vi.fn(async () => ({
      rows: [{ tenant_id: TENANT, require_distinct_approver: true, updated_at: UPDATED_AT }],
    }));
    const client = { query } as unknown as PoolClient;
    const boundTenants: string[] = [];
    const runner: TenantTransactionRunner = async (tenant_id, work) => {
      boundTenants.push(tenant_id);
      return work(client);
    };

    const record = await new TenantGovernanceRepository(runner).get(TENANT);

    expect(boundTenants).toEqual([TENANT]);
    expect(record).toEqual({
      tenant_id: TENANT,
      require_distinct_approver: true,
      updated_at: UPDATED_AT.toISOString(),
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM agentos.tenant_governance_settings'),
      [TENANT],
    );
  });

  it('returns null when the tenant has no settings row', async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as PoolClient;
    const runner: TenantTransactionRunner = async (_tenant_id, work) => work(client);

    await expect(new TenantGovernanceRepository(runner).get(TENANT)).resolves.toBeNull();
  });
});
