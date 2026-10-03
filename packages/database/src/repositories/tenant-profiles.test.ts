import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { TenantProfileRepository } from './tenant-profiles.js';

const before = {
  tenant_id: 'tenant-a',
  company_name: 'Acme',
  industry: null,
  locale: 'en-US',
  timezone: 'America/New_York',
  currency: 'USD',
  brand_profile: { voice: 'Helpful' },
  version: '3',
  updated_at: new Date('2026-01-01T00:00:00.000Z'),
};

const values = {
  company_name: 'Acme Updated',
  industry: null,
  locale: 'en-US',
  timezone: 'America/New_York',
  currency: 'USD',
  brand_profile: { voice: 'Helpful' },
};

function repository() {
  const updated = { ...before, ...values, version: '4', updated_at: new Date('2026-01-02T00:00:00.000Z') };
  const tenantIds: string[] = [];
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM agentos.tenants')) return { rows: [{ display_name: 'Acme' }] };
    if (sql.includes('SELECT agentos.platform_append_audit')) return { rows: [{ event_id: 'audit-event' }] };
    if (sql.includes('UPDATE agentos.tenant_profiles')) return { rows: [updated] };
    return { rows: [before] };
  });
  const client = { query } as unknown as PoolClient;
  const runner = async <T>(tenant_id: string, work: (transaction: PoolClient) => Promise<T>): Promise<T> => {
    tenantIds.push(tenant_id);
    return work(client);
  };
  return { repo: new TenantProfileRepository(runner), query, tenantIds };
}

describe('TenantProfileRepository', () => {
  it('reads the workspace display name inside the authenticated tenant scope', async () => {
    const { repo, query, tenantIds } = repository();
    expect(await repo.getDisplayName('tenant-a')).toBe('Acme');
    expect(tenantIds).toEqual(['tenant-a']);
    expect(query).toHaveBeenCalledWith('SELECT display_name FROM agentos.tenants WHERE tenant_id = $1', ['tenant-a']);
  });

  it('appends one config audit event in the profile transaction on change', async () => {
    const { repo, query } = repository();
    const result = await repo.update({
      tenant_id: 'tenant-a',
      values,
      expected_version: 3,
      actor_kind: 'OPERATOR',
      actor_id: 'operator-1',
      correlation_id: 'corr-profile-test',
    });

    expect(result).toMatchObject({ status: 'UPDATED', profile: { company_name: 'Acme Updated', version: 4 } });
    expect(query.mock.calls.filter(([sql]) => sql.includes('SELECT agentos.platform_append_audit'))).toHaveLength(1);
  });

  it('does not append audit when the stored profile values are unchanged', async () => {
    const { repo, query } = repository();
    const result = await repo.update({
      tenant_id: 'tenant-a',
      values: { ...values, company_name: 'Acme' },
      expected_version: 3,
      actor_kind: 'OPERATOR',
      actor_id: 'operator-1',
      correlation_id: 'corr-profile-test',
    });

    expect(result).toMatchObject({ status: 'UPDATED', profile: { company_name: 'Acme', version: 3 } });
    expect(query.mock.calls.filter(([sql]) => sql.includes('SELECT agentos.platform_append_audit'))).toHaveLength(0);
  });
});
