import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { TenantTransactionRunner } from './effect-reservations.js';
import { TenantGovernanceRepository } from './tenant-governance.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const UPDATED_AT = new Date('2026-09-23T00:00:00.000Z');
const CURRENT = {
  tenant_id: TENANT,
  require_distinct_approver: true,
  approval_expiry_hours: 72,
  takeover_lease_seconds: 300,
  version: 4,
  updated_at: UPDATED_AT,
};

describe('TenantGovernanceRepository', () => {
  it('reads the complete setting inside the supplied tenant transaction', async () => {
    const query = vi.fn(async () => ({ rows: [CURRENT] }));
    const client = { query } as unknown as PoolClient;
    const boundTenants: string[] = [];
    const runner: TenantTransactionRunner = async (tenant_id, work) => {
      boundTenants.push(tenant_id);
      return work(client);
    };

    const record = await new TenantGovernanceRepository(runner).get(TENANT);

    expect(boundTenants).toEqual([TENANT]);
    expect(record).toEqual({
      ...CURRENT,
      updated_at: UPDATED_AT.toISOString(),
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM agentos.tenant_governance_settings'),
      [TENANT],
    );
  });

  it('updates through one tenant transaction and appends the versioned config audit', async () => {
    const updatedAt = new Date('2026-09-24T00:00:00.000Z');
    const UPDATED = {
      ...CURRENT,
      require_distinct_approver: false,
      approval_expiry_hours: 48,
      takeover_lease_seconds: 180,
      version: 5,
      updated_at: updatedAt,
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FOR UPDATE')) return { rows: [CURRENT] };
      if (sql.startsWith('UPDATE')) return { rows: [UPDATED] };
      if (sql.includes('platform_append_audit')) return { rows: [{ event_id: 'audit-1' }] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const client = { query } as unknown as PoolClient;
    const boundTenants: string[] = [];
    const runner: TenantTransactionRunner = async (tenant_id, work) => {
      boundTenants.push(tenant_id);
      return work(client);
    };

    const record = await new TenantGovernanceRepository(runner).update(TENANT, {
      require_distinct_approver: false,
      approval_expiry_hours: 48,
      takeover_lease_seconds: 180,
      expected_version: 4,
      actor_kind: 'OPERATOR',
      actor_id: 'operator-1',
      correlation_id: 'corr-1',
    });

    expect(boundTenants).toEqual([TENANT]);
    expect(record).toEqual({ ...UPDATED, updated_at: updatedAt.toISOString() });
    expect(query.mock.calls.map(([sql]) => sql.includes('platform_append_audit') ? 'audit' : sql.startsWith('UPDATE') ? 'update' : 'read'))
      .toEqual(['read', 'update', 'audit']);
    expect(query.mock.calls[2]?.[0]).toContain('platform_append_audit');
  });

  it('refuses a stale version without updating or auditing', async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [CURRENT] }));
    const client = { query } as unknown as PoolClient;
    const runner: TenantTransactionRunner = async (_tenant_id, work) => work(client);

    await expect(new TenantGovernanceRepository(runner).update(TENANT, {
      require_distinct_approver: false,
      approval_expiry_hours: 48,
      takeover_lease_seconds: 180,
      expected_version: 3,
      actor_kind: 'OPERATOR',
      actor_id: 'operator-1',
      correlation_id: 'corr-1',
    })).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('FROM agentos.tenant_governance_settings');
  });

  it('returns null when the tenant has no settings row', async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as PoolClient;
    const runner: TenantTransactionRunner = async (_tenant_id, work) => work(client);

    await expect(new TenantGovernanceRepository(runner).get(TENANT)).resolves.toBeNull();
  });
});
